import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFootballDataProvider, normalizeMatch } from '../../lib/football/footballDataProvider.ts';

const PAYLOAD = JSON.parse(readFileSync(new URL('./payloads/barcelona-matches.json', import.meta.url), 'utf8'));

test('statuses map onto the contract', () => {
  const byStatus = PAYLOAD.matches.map(normalizeMatch).filter(Boolean).map((f) => f.status);
  assert.deepEqual([...new Set(byStatus)].sort(), ['cancelled', 'finished', 'postponed', 'scheduled']);
});

test('malformed matches are skipped, not fatal', () => {
  // One bad row in a response must not cost the user the rest of them.
  // Derived from the fixture's own `_malformed` markers rather than a
  // hardcoded `- 1`, so a third malformed row added later fails loudly here
  // instead of silently passing a stale count.
  const malformed = PAYLOAD.matches.filter((match: { _malformed?: unknown }) => match._malformed !== undefined);
  assert.ok(malformed.length >= 2, 'fixture should exercise more than one skip reason');

  const all = PAYLOAD.matches.map(normalizeMatch);
  assert.equal(all.filter((fixture: unknown) => fixture === null).length, malformed.length);
  assert.equal(all.filter(Boolean).length, PAYLOAD.matches.length - malformed.length);
});

test('kickoff is kept as a UTC instant', () => {
  const fixture = normalizeMatch(PAYLOAD.matches[0]);
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
