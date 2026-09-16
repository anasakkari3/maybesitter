import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFootballDataProvider, normalizeMatch } from '../../lib/football/footballDataProvider.ts';
import type { Fixture } from '../../src/contracts/v1/fixtureContracts.ts';

/**
 * What this file actually reads out of the fixture payload -- not the vendor's
 * full match shape (that belongs to `normalizeMatch`, on the far side of the
 * provider seam; see `fixtureContracts.ts`'s header). Typing `PAYLOAD` at all,
 * rather than leaving it as the `any` that `JSON.parse` returns, is what lets
 * every `.map`/`.filter`/`.find` below infer its own callback parameters
 * instead of each one needing its own explicit annotation.
 */
interface RawMatchRow {
  readonly id: number;
  readonly _malformed?: unknown;
}
interface RawMatchesPayload {
  readonly matches: readonly RawMatchRow[];
}

const PAYLOAD = JSON.parse(
  readFileSync(new URL('./payloads/barcelona-matches.json', import.meta.url), 'utf8'),
) as RawMatchesPayload;

test('statuses map onto the contract', () => {
  // A type predicate, not `.filter(Boolean)`: passing the `Boolean`
  // constructor narrows nothing -- TypeScript's inferred-predicate support
  // covers a locally analysable function body, not the built-in `Boolean`
  // used as a callback -- so `f` stayed `Fixture | null` and `f.status`
  // below was a possibly-null access. See the same `(x): x is T => ...`
  // pattern in `lib/priority/priorityFeatures.ts` and elsewhere in `lib/`.
  const byStatus = PAYLOAD.matches
    .map(normalizeMatch)
    .filter((f): f is Fixture => f !== null)
    .map((f) => f.status);
  // `Array.from`, not `[...new Set(...)]`: `tsconfig.json` targets `es5`
  // without `downlevelIteration`, so spreading a `Set` needs this form.
  assert.deepEqual(Array.from(new Set(byStatus)).sort(), ['cancelled', 'finished', 'postponed', 'scheduled']);
});

test('malformed matches are skipped, not fatal -- and it is the marked rows that are skipped', () => {
  // One bad row in a response must not cost the user the rest of them.
  // Checked by id, not just by count: a bug that skipped a valid row while
  // accepting a row marked `_malformed` would balance the totals and pass a
  // cardinality-only check. Comparing the two id sets catches that.
  const malformedIds = new Set(
    PAYLOAD.matches
      .filter((match: { _malformed?: unknown }) => match._malformed !== undefined)
      .map((match: { id: number }) => match.id),
  );
  assert.ok(malformedIds.size >= 2, 'fixture should exercise more than one skip reason');

  const normalizedIds = new Set(
    PAYLOAD.matches
      .map((raw: { id: number }) => [raw.id, normalizeMatch(raw)] as const)
      .filter(([, fixture]) => fixture !== null)
      .map(([id]) => id),
  );
  const expectedIds = new Set(
    PAYLOAD.matches.map((match: { id: number }) => match.id).filter((id: number) => !malformedIds.has(id)),
  );

  assert.deepEqual(normalizedIds, expectedIds);
});

test('an unrecognised status yields null, never a silently-defaulted "scheduled"', () => {
  // Guards the rule itself (`STATUS_MAP[rawStatus] ?? 'scheduled'` would pass
  // every other test in this file, including the skip-count test above,
  // since that test only cares that the row is skipped -- not why). A
  // regression here is exactly the failure the spec names: an evening
  // blocked for a game that was never actually scheduled to be played.
  const unrecognised = PAYLOAD.matches.find(
    (match: { _malformed?: unknown }) => match._malformed === 'unrecognised status',
  );
  assert.ok(unrecognised, 'fixture should include a row whose status this adapter does not recognise');
  assert.equal(normalizeMatch(unrecognised), null);
});

test('kickoff is kept as a UTC instant', () => {
  const fixture = normalizeMatch(PAYLOAD.matches[0]);
  // `normalizeMatch` returns `Fixture | null` -- `assert.ok` is declared
  // `asserts value`, so this narrows `fixture` to `Fixture` for the line
  // below rather than casting past the possibility it is null.
  assert.ok(fixture, 'the first payload row should normalize');
  assert.match(fixture.kickoffUtc, /Z$/);
});

test('no api key means the provider says so rather than pretending', async () => {
  // `env: {}` is an explicit "nothing exported here", not an accident of
  // whatever the ambient shell happens to have set. Without this, the test's
  // result would depend on the machine it runs on rather than the code.
  const provider = createFootballDataProvider({ env: {} });
  await assert.rejects(
    () => provider.listFixtures('81', { fromIso: '2026-09-16', toIso: '2026-11-15' }),
    /FOOTBALL_DATA_API_KEY/,
  );
});

test('the request carries the key and the window', async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const provider = createFootballDataProvider({
    apiKey: 'k',
    fetchImpl: (async (url, init) => {
      calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response(JSON.stringify(PAYLOAD), { status: 200 });
    }) as typeof fetch,
  });
  await provider.listFixtures('81', { fromIso: '2026-09-16', toIso: '2026-11-15' });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /teams\/81\/matches/);
  assert.match(calls[0].url, /dateFrom=2026-09-16/);
  assert.equal(calls[0].headers['X-Auth-Token'], 'k');
});

test('a 5xx rejects and does not return an empty list', async () => {
  // An empty list is indistinguishable from "this club has no matches", which
  // the sync would treat as a reason to cancel somebody's evening.
  const provider = createFootballDataProvider({
    apiKey: 'k',
    fetchImpl: (async () => new Response('', { status: 503 })) as typeof fetch,
  });
  await assert.rejects(() => provider.listFixtures('81', { fromIso: '2026-09-16', toIso: '2026-11-15' }));
});

test('a 2xx with no matches array rejects rather than pretending the club has none', async () => {
  // Same failure as the 5xx case, arriving through a different door: a 200
  // whose body this adapter cannot read is not the same fact as "no
  // fixtures in this window" (that fact is `matches: []`, handled fine
  // elsewhere). Defaulting an unreadable envelope to an empty list would let
  // the sync clear somebody's evening on the strength of a response this
  // code never actually understood.
  const provider = createFootballDataProvider({
    apiKey: 'k',
    fetchImpl: (async () => new Response(JSON.stringify({ filters: {} }), { status: 200 })) as typeof fetch,
  });
  await assert.rejects(() => provider.listFixtures('81', { fromIso: '2026-09-16', toIso: '2026-11-15' }));
});
