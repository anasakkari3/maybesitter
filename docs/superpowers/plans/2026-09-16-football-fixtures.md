# Football Fixtures as Commitments — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user who follows a club gets every one of that club's matches as a commitment that holds its own time — blocking the planner, writing to their calendar, and warning them when they book over it.

**Architecture:** Fixtures are fetched once per club (never per user), stored in a shared collection, and projected into per-user commitments through the `ExternalTaskReference` provenance shape so a moved match updates rather than duplicates and a dismissed match is never resurrected. Everything downstream — blocking, calendar, reminders — is existing commitment machinery.

**Tech Stack:** TypeScript, Next.js App Router, Firestore via `lib/storage` adapter, `node:test` (server), Jest + React Native Testing Library (mobile), i18next (ar/he/en).

**Spec:** `docs/superpowers/specs/2026-09-16-football-fixtures-design.md`

## Global Constraints

- **Branch/worktree:** `feat/football-fixtures` at `code/s3-football-fixtures`. Other lanes are live in sibling worktrees; do not touch `main`.
- **`npm test` is an explicit file list, not a glob.** Every new server test file MUST be appended to the `test` script in `package.json` in the same commit that creates it, or it passes by never running.
- **Half-open intervals.** `[start, end)`, strict `<` on both sides, zero-length intersects nothing. Use `intervalsOverlap` from `lib/planning/shared/time.ts`. Never write a third implementation.
- **No provider-specific fields on domain types.** `EXTERNAL_TASK_BOUNDARY_POLICY.providerSpecificTaskFieldsAllowed` is `false`. Provider details live on the `ExternalTaskReference`.
- **No ambient clock in pure modules.** Pure planning/projection modules take `now` as an argument. `PLANNING_PERSISTENCE_POLICY.noAmbientClock`.
- **Timezones:** kickoffs are stored as UTC instants. Never compute a UTC offset on device — Hermes shapes `Intl.DateTimeFormat` `longOffset` differently and has returned a zero offset.
- **Match block length:** `FIXTURE_BLOCK_MINUTES = 120`.
- **Horizon:** fixtures are synced for a rolling 60 days.
- **Rate limit:** football-data.org free tier allows 10 requests/minute. Requests are sequential and spaced.
- **Copy exists in three languages** — `mobile/src/i18n/locales/{ar,he,en}.json`. A key added to one must be added to all three.

---

### Task 1: The planner reads the end time it is given

This is a bug fix that precedes the feature. `TimeSpec.endAt` exists (added by #185) and `mobile/src/features/calendar/eventDraft.ts` already honours it, but `buildDailyPlanInput` never reads it — so a commitment with a real end is blocked at 30 minutes by the planner while the calendar shows its true length. The two surfaces disagree today.

**Files:**
- Modify: `lib/services/dailyPlan/buildDailyPlan.ts:317-329`
- Test: `tests/dailyPlan/fixedEventDuration.test.ts` (create)
- Modify: `package.json` (test file list)

**Interfaces:**
- Consumes: `Commitment`, `TimeSpec` from `src/domain/stateMachine.ts`; `DEFAULT_FIXED_EVENT_MINUTES` (existing export).
- Produces: nothing new. Behaviour change only.

- [ ] **Step 1: Write the failing test**

```ts
// tests/dailyPlan/fixedEventDuration.test.ts
/**
 * A pinned commitment blocks the time it actually takes (#185's `endAt`).
 *
 * The planner used to block `DEFAULT_FIXED_EVENT_MINUTES` for every pinned
 * commitment regardless of its end, which put the second half of any two-hour
 * event back on the market while the device calendar showed it as busy.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDailyPlanInput, DEFAULT_FIXED_EVENT_MINUTES } from '../../lib/services/dailyPlan/buildDailyPlan.ts';
import { normalizeStoredTimeSpec, type Commitment } from '../../src/domain/stateMachine.ts';

function commitmentAt(id: string, dueAt: string, endAt: string | null): Commitment {
  return {
    id,
    kind: 'task',
    title: id,
    description: null,
    person: null,
    status: 'active',
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureLevel: 'none' },
    timeSpec: normalizeStoredTimeSpec({ kind: 'scheduled_event', dueAt, endAt, timezone: 'Asia/Jerusalem' }),
    currentAckState: 'not_seen',
    postponedUntil: null,
    createdAt: dueAt,
    updatedAt: dueAt,
    confirmedAt: dueAt,
    completedAt: null,
    droppedAt: null,
  };
}

const ARGS = {
  uid: 'u1',
  date: '2026-09-19',
  timezone: 'Asia/Jerusalem',
  profile: undefined as never,
  busyBlocks: [],
};

test('an end time is the length of the blocking event', () => {
  const input = buildDailyPlanInput({
    ...ARGS,
    commitments: [commitmentAt('match', '2026-09-19T19:00:00.000Z', '2026-09-19T21:00:00.000Z')],
  });
  const event = input.constraints.fixedEvents.find((e) => e.sourceCommitmentId === 'match');
  assert.ok(event, 'the pinned commitment should produce a fixed event');
  assert.equal(event.interval.endsAt, '2026-09-19T21:00:00.000Z');
});

test('no end time still blocks the default', () => {
  const input = buildDailyPlanInput({
    ...ARGS,
    commitments: [commitmentAt('call', '2026-09-19T19:00:00.000Z', null)],
  });
  const event = input.constraints.fixedEvents.find((e) => e.sourceCommitmentId === 'call');
  assert.ok(event);
  const minutes = (Date.parse(event.interval.endsAt) - Date.parse(event.interval.startsAt)) / 60_000;
  assert.equal(minutes, DEFAULT_FIXED_EVENT_MINUTES);
});

test('an end that is not after its start falls back to the default', () => {
  // The domain refuses this, so it can only arrive from a hand-edited document.
  // The planner must not emit a zero-length or inverted blocking interval:
  // `intervalsOverlap` treats a zero-length interval as intersecting nothing,
  // so such an event would block nothing while looking like it blocks.
  const input = buildDailyPlanInput({
    ...ARGS,
    commitments: [commitmentAt('bad', '2026-09-19T19:00:00.000Z', '2026-09-19T19:00:00.000Z')],
  });
  const event = input.constraints.fixedEvents.find((e) => e.sourceCommitmentId === 'bad');
  assert.ok(event);
  const minutes = (Date.parse(event.interval.endsAt) - Date.parse(event.interval.startsAt)) / 60_000;
  assert.equal(minutes, DEFAULT_FIXED_EVENT_MINUTES);
});
```

Note: `profile` is typed `as never` above only to keep this snippet short — when writing the real file, build a `UserRoutineProfile` the way `tests/dailyPlan/*.test.ts` already does and copy that helper rather than inventing one.

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx node --no-warnings --loader ./scripts/ts-resolver.mjs --import ./tests/support/isolateProcess.mjs --test tests/dailyPlan/fixedEventDuration.test.ts`

Expected: the first test FAILS — `endsAt` is 19:30, not 21:00. The second and third PASS already.

- [ ] **Step 3: Make the planner read `endAt`**

In `buildDailyPlan.ts`, replace the hardcoded end in `fromCommitments`:

```ts
/**
 * How long a pinned commitment occupies.
 *
 * `endAt` when the commitment names one and it is strictly after the start —
 * the same half-open rule the domain validates on write and `eventDraft.ts`
 * applies on the device calendar. Anything else is the default: a zero-length
 * or inverted interval would be a blocking event that `intervalsOverlap`
 * reports as intersecting nothing, which is a block that silently does not
 * block.
 */
function fixedEndFor(commitment: Commitment, start: Instant): Instant {
  const endAt = commitment.timeSpec.endAt;
  if (endAt) {
    const end = Date.parse(endAt);
    if (Number.isFinite(end) && end > toEpochMs(start)) return new Date(end).toISOString();
  }
  return new Date(toEpochMs(start) + DEFAULT_FIXED_EVENT_MINUTES * MS_PER_MINUTE).toISOString();
}
```

and use it:

```ts
    return [{
      eventId: `commitment:${commitment.id}`,
      interval: { startsAt: start, endsAt: fixedEndFor(commitment, start) },
      sourceCommitmentId: commitment.id,
      blocking: true,
    }];
```

- [ ] **Step 4: Run the test and watch it pass**

Run the same command. Expected: 3 passing.

- [ ] **Step 5: Register the test file and run the full suite**

Append `tests/dailyPlan/fixedEventDuration.test.ts` to the `test` script's file list in `package.json`, then:

Run: `npm test`
Expected: the whole suite green. If a planning test now fails, it is asserting the old 30-minute behaviour on a commitment that has an `endAt` — read it before changing it, and say so in the commit.

- [ ] **Step 6: Commit**

```bash
git add lib/services/dailyPlan/buildDailyPlan.ts tests/dailyPlan/fixedEventDuration.test.ts package.json
git commit -m "The planner blocks the time a commitment actually takes

#185 gave TimeSpec an endAt and the device calendar honours it. The planner
never read it, so a two-hour commitment was blocked for thirty minutes and the
remaining ninety were offered back as free time -- while the same commitment
showed its full length in the user's calendar. Two surfaces, one commitment,
different answers.

An end that is not strictly after its start falls back to the default rather
than being trusted. intervalsOverlap reports a zero-length interval as
intersecting nothing, so an inverted range would have produced a blocking
event that blocks nothing and looks like it does.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The fixture contract and the provider seam

**Files:**
- Create: `src/contracts/v1/fixtureContracts.ts`
- Test: `tests/contract/fixtureContracts.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `MODULE_CONTRACT_VERSION` from `src/contracts/v1/moduleContracts.ts`.
- Produces:
  - `type FixtureStatus = 'scheduled' | 'postponed' | 'cancelled' | 'finished'`
  - `interface Fixture { version; schemaVersion; provider: string; providerMatchId: string; competition: string; homeTeamId: string; awayTeamId: string; homeTeamName: string; awayTeamName: string; kickoffUtc: string; status: FixtureStatus; venue: string | null; contentHash: string }`
  - `interface FixtureProvider { readonly name: string; listFixtures(providerTeamId: string, window: { fromIso: string; toIso: string }): Promise<readonly Fixture[]> }`
  - `const FIXTURE_BLOCK_MINUTES = 120`
  - `function fixtureContentHash(f: Omit<Fixture, 'contentHash' | 'version' | 'schemaVersion'>): string`

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/fixtureContracts.test.ts
/**
 * What the product is allowed to know about a football match.
 *
 * The boundary is deliberately narrow: an interval, two team names, a
 * competition and a status. No score, no lineup, no minute-by-minute. The
 * product cares about a match as a claim on somebody's evening, and a contract
 * that cannot express a score cannot leak one into a commitment title.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureContentHash, FIXTURE_BLOCK_MINUTES } from '../../src/contracts/v1/fixtureContracts.ts';

const BASE = {
  provider: 'football-data',
  providerMatchId: '419471',
  competition: 'PD',
  homeTeamId: '81',
  awayTeamId: '86',
  homeTeamName: 'FC Barcelona',
  awayTeamName: 'Real Madrid CF',
  kickoffUtc: '2026-10-25T19:00:00.000Z',
  status: 'scheduled' as const,
  venue: 'Camp Nou',
};

test('a match blocks two hours', () => {
  assert.equal(FIXTURE_BLOCK_MINUTES, 120);
});

test('the same match hashes the same way twice', () => {
  assert.equal(fixtureContentHash(BASE), fixtureContentHash({ ...BASE }));
});

test('a moved kickoff changes the hash', () => {
  const moved = { ...BASE, kickoffUtc: '2026-10-26T19:00:00.000Z' };
  assert.notEqual(fixtureContentHash(BASE), fixtureContentHash(moved));
});

test('a postponement changes the hash', () => {
  assert.notEqual(fixtureContentHash(BASE), fixtureContentHash({ ...BASE, status: 'postponed' }));
});

test('key order does not change the hash', () => {
  // The hash decides whether a user's commitment is rewritten tonight. If it
  // depended on the order a provider happened to serialise its JSON, every
  // fixture would look changed on some responses and unchanged on others.
  const reordered = Object.fromEntries(Object.entries(BASE).reverse()) as typeof BASE;
  assert.equal(fixtureContentHash(BASE), fixtureContentHash(reordered));
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx node --no-warnings --loader ./scripts/ts-resolver.mjs --import ./tests/support/isolateProcess.mjs --test tests/contract/fixtureContracts.test.ts`
Expected: FAIL — cannot resolve `src/contracts/v1/fixtureContracts.ts`.

- [ ] **Step 3: Write the contract**

Create `src/contracts/v1/fixtureContracts.ts`. `fixtureContentHash` must sort keys before hashing (that is what the last test pins):

```ts
import { createHash } from 'node:crypto';
import { MODULE_CONTRACT_VERSION } from './moduleContracts';

export const FIXTURE_CONTRACT_VERSION = MODULE_CONTRACT_VERSION;
export const FIXTURE_SCHEMA_VERSION = 'fixture-v1' as const;

/** A match occupies two hours: ninety minutes plus the interval and stoppage. */
export const FIXTURE_BLOCK_MINUTES = 120;

export type FixtureStatus = 'scheduled' | 'postponed' | 'cancelled' | 'finished';

export interface FixtureCore {
  readonly provider: string;
  readonly providerMatchId: string;
  readonly competition: string;
  readonly homeTeamId: string;
  readonly awayTeamId: string;
  readonly homeTeamName: string;
  readonly awayTeamName: string;
  /** UTC instant. Never a local time: see the timezone constraint. */
  readonly kickoffUtc: string;
  readonly status: FixtureStatus;
  readonly venue: string | null;
}

export interface Fixture extends FixtureCore {
  readonly version: typeof FIXTURE_CONTRACT_VERSION;
  readonly schemaVersion: typeof FIXTURE_SCHEMA_VERSION;
  readonly contentHash: string;
}

export interface FixtureWindow {
  readonly fromIso: string;
  readonly toIso: string;
}

/**
 * The vendor seam. Everything above this line is ours; everything below knows
 * about HTTP, API keys and one company's JSON.
 */
export interface FixtureProvider {
  readonly name: string;
  listFixtures(providerTeamId: string, window: FixtureWindow): Promise<readonly Fixture[]>;
}

export function fixtureContentHash(core: FixtureCore): string {
  const sorted = Object.keys(core).sort().map((key) => [key, (core as Record<string, unknown>)[key]]);
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}
```

- [ ] **Step 4: Run the test and watch it pass**

Same command. Expected: 5 passing.

- [ ] **Step 5: Register and commit**

```bash
# append tests/contract/fixtureContracts.test.ts to package.json's test list first
npm test
git add src/contracts/v1/fixtureContracts.ts tests/contract/fixtureContracts.test.ts package.json
git commit -m "A contract that can describe a match but not a score

The product cares about a fixture as a claim on somebody's evening, so the
boundary carries an interval, two names, a competition and a status, and
nothing else. A contract with no field for a score cannot put one in a
commitment title by accident.

The content hash sorts its keys. It decides whether a user's commitment gets
rewritten tonight, and one that depended on a provider's serialisation order
would report the same match as changed and unchanged on alternating responses.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The football-data.org adapter

**Files:**
- Create: `lib/football/footballDataProvider.ts`
- Create: `tests/football/payloads/barcelona-matches.json` (recorded, trimmed response)
- Test: `tests/football/footballDataProvider.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `Fixture`, `FixtureProvider`, `FixtureWindow`, `fixtureContentHash` (Task 2).
- Produces: `createFootballDataProvider(deps?: { apiKey?: string; fetchImpl?: typeof fetch }): FixtureProvider`, and `normalizeMatch(raw: unknown): Fixture | null`.

**Recorded payloads, never live calls.** A test that hits the real API fails during an international break, on a rate limit, and in CI without a secret — three red builds that mean nothing about this code.

- [ ] **Step 1: Record the payload**

Create `tests/football/payloads/barcelona-matches.json` holding a trimmed football-data.org `/v4/teams/81/matches` response with four matches: one `SCHEDULED`, one `POSTPONED`, one `CANCELLED`, one `FINISHED`, plus one malformed entry with a missing `utcDate`. Real field names (`id`, `utcDate`, `status`, `competition.code`, `homeTeam.id`, `homeTeam.name`, `awayTeam.id`, `awayTeam.name`, `venue`).

- [ ] **Step 2: Write the failing test**

```ts
// tests/football/footballDataProvider.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFootballDataProvider, normalizeMatch } from '../../lib/football/footballDataProvider.ts';

const PAYLOAD = JSON.parse(readFileSync(new URL('./payloads/barcelona-matches.json', import.meta.url), 'utf8'));

test('statuses map onto the contract', () => {
  const byStatus = PAYLOAD.matches.map(normalizeMatch).filter(Boolean).map((f) => f.status);
  assert.deepEqual([...new Set(byStatus)].sort(), ['cancelled', 'finished', 'postponed', 'scheduled']);
});

test('a malformed match is skipped, not fatal', () => {
  // One bad row in a response must not cost the user the other nineteen.
  const all = PAYLOAD.matches.map(normalizeMatch);
  assert.ok(all.includes(null));
  assert.equal(all.filter(Boolean).length, PAYLOAD.matches.length - 1);
});

test('kickoff is kept as a UTC instant', () => {
  const fixture = normalizeMatch(PAYLOAD.matches[0]);
  assert.match(fixture.kickoffUtc, /Z$/);
});

test('no api key means the provider says so rather than pretending', async () => {
  const provider = createFootballDataProvider({ apiKey: undefined });
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
```

- [ ] **Step 3: Run and watch it fail**

Run: `npx node --no-warnings --loader ./scripts/ts-resolver.mjs --import ./tests/support/isolateProcess.mjs --test tests/football/footballDataProvider.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the adapter**

`normalizeMatch` returns `null` for anything it cannot read — a missing id, an unparseable `utcDate`, a missing team. `listFixtures` throws on a non-2xx and on a missing key. Status map: `SCHEDULED`/`TIMED`/`IN_PLAY`/`PAUSED` → `scheduled`, `POSTPONED`/`SUSPENDED` → `postponed`, `CANCELLED` → `cancelled`, `FINISHED`/`AWARDED` → `finished`. Unknown status → `null` (skip), never a silent default.

- [ ] **Step 5: Run and watch it pass**

Expected: 6 passing.

- [ ] **Step 6: Register and commit**

```bash
npm test
git add lib/football tests/football package.json
git commit -m "One company's JSON, kept on one side of a seam

Recorded payloads, not live calls: a test that asks football-data.org for
Barcelona's fixtures goes red during an international break, on a rate limit,
and in any CI run without the secret, and none of those are this code being
wrong.

A malformed match is skipped rather than fatal -- one bad row must not cost
the user the other nineteen -- but a 5xx rejects rather than returning an
empty list, because an empty list is indistinguishable from 'this club has no
matches', and the sync would read that as permission to clear somebody's
evening.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The curated club list

**Files:**
- Create: `data/footballClubs.json`
- Create: `lib/football/clubs.ts`
- Test: `tests/football/clubs.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `interface Club { clubId: string; providerTeamId: string; competition: string; names: { ar: string; he: string; en: string } }`, `listClubs(): readonly Club[]`, `clubById(clubId: string): Club | null`.

Names are carried in all three languages rather than taken from the provider, which serves one. An Arabic UI showing "FC Barcelona" in Latin script next to Arabic commitments reads as breakage.

- [ ] **Step 1: Write the failing test**

```ts
// tests/football/clubs.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { listClubs, clubById } from '../../lib/football/clubs.ts';

test('the list is not empty and Barcelona is in it', () => {
  assert.ok(listClubs().length >= 12);
  assert.ok(listClubs().some((c) => c.clubId === 'barcelona'));
});

test('every club names itself in all three languages', () => {
  for (const club of listClubs()) {
    for (const lang of ['ar', 'he', 'en'] as const) {
      assert.ok(club.names[lang]?.trim(), `${club.clubId} is missing its ${lang} name`);
    }
  }
});

test('club ids are unique', () => {
  const ids = listClubs().map((c) => c.clubId);
    assert.equal(new Set(ids).size, ids.length);
});

test('provider team ids are unique', () => {
  // Two clubs pointing at one provider id would project one club's fixtures
  // onto the other's followers, and nothing downstream would notice.
  const ids = listClubs().map((c) => c.providerTeamId);
  assert.equal(new Set(ids).size, ids.length);
});

test('an unknown club id is null, not a throw', () => {
  assert.equal(clubById('not-a-club'), null);
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx node --no-warnings --loader ./scripts/ts-resolver.mjs --import ./tests/support/isolateProcess.mjs --test tests/football/clubs.test.ts`

- [ ] **Step 3: Write the data and the loader**

`data/footballClubs.json` — at least 12 clubs inside competitions the free tier covers (`PD`, `PL`, `CL`, `SA`, `BL1`, `FL1`). Example row:

```json
{
  "clubId": "barcelona",
  "providerTeamId": "81",
  "competition": "PD",
  "names": { "ar": "برشلونة", "he": "ברצלונה", "en": "FC Barcelona" }
}
```

`lib/football/clubs.ts` reads the JSON once, validates each row (all four fields present, three names non-empty) and **throws at module load** if a row is malformed. A silently dropped club is a user whose team never syncs and no error anywhere.

- [ ] **Step 4: Run and watch it pass** — 5 passing.

- [ ] **Step 5: Register and commit**

```bash
npm test
git add data/footballClubs.json lib/football/clubs.ts tests/football/clubs.test.ts package.json
git commit -m "A curated club list that can say its own name in Arabic

The provider serves one language. An Arabic interface listing 'FC Barcelona'
in Latin script beside Arabic commitments does not read as data, it reads as
the app being broken, so the three names travel with the club.

A malformed row throws at load rather than being dropped. A quietly skipped
club is somebody whose team simply never appears, with no error anywhere to
explain why.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Storage paths and the shared fixture store

**Files:**
- Modify: `lib/storage/paths.ts`
- Create: `lib/football/fixtureStore.ts`
- Test: `tests/football/fixtureStore.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `getStorage`, `StorageAdapter` from `lib/storage`; `Fixture` (Task 2).
- Produces, in `paths.ts`: `export const FIXTURES = 'fixtures'`, `export const FOOTBALL_FOLLOWS = 'footballFollows'`, `export const EXTERNAL_TASK_REFS = 'externalTaskRefs'`, `export function fixtureDoc(provider: string, matchId: string): string`.
- Produces, in `fixtureStore.ts`: `upsertFixtures(fixtures: readonly Fixture[]): Promise<{ written: number; unchanged: number }>`, `listFixturesForTeam(providerTeamId: string, window: FixtureWindow): Promise<readonly Fixture[]>`.

**The fixture collection is top-level, not under `users/{uid}`** — it is one shared copy of public information, not one person's data, and duplicating it per user is the per-user fetch this design rejected. `firestore.rules` already denies clients everything outside `/users/{uid}`, so no rules change is needed; confirm this in the test rather than assuming it.

- [ ] **Step 1: Write the failing test**

```ts
// tests/football/fixtureStore.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { fixtureDoc } from '../../lib/storage/paths.ts';
import { upsertFixtures, listFixturesForTeam } from '../../lib/football/fixtureStore.ts';
import { fixtureContentHash, FIXTURE_CONTRACT_VERSION, FIXTURE_SCHEMA_VERSION } from '../../src/contracts/v1/fixtureContracts.ts';

function fixture(id: string, kickoffUtc: string, over: Partial<Record<string, unknown>> = {}) {
  const core = {
    provider: 'football-data', providerMatchId: id, competition: 'PD',
    homeTeamId: '81', awayTeamId: '86', homeTeamName: 'FC Barcelona',
    awayTeamName: 'Real Madrid CF', kickoffUtc, status: 'scheduled', venue: null,
    ...over,
  };
  return { ...core, version: FIXTURE_CONTRACT_VERSION, schemaVersion: FIXTURE_SCHEMA_VERSION, contentHash: fixtureContentHash(core as never) };
}

test.beforeEach(() => setStorageForTests(createMemoryStorage()));
test.afterEach(() => resetStorageForTests());

test('a fixture is stored once per provider match id', async () => {
  await upsertFixtures([fixture('1', '2026-10-25T19:00:00.000Z')]);
  await upsertFixtures([fixture('1', '2026-10-25T19:00:00.000Z')]);
  const found = await listFixturesForTeam('81', { fromIso: '2026-10-01', toIso: '2026-11-01' });
  assert.equal(found.length, 1);
});

test('an unchanged fixture is not rewritten', async () => {
  // Rewriting every fixture nightly would make every commitment look changed,
  // and the projection would reschedule reminders nobody asked to move.
  await upsertFixtures([fixture('1', '2026-10-25T19:00:00.000Z')]);
  const second = await upsertFixtures([fixture('1', '2026-10-25T19:00:00.000Z')]);
  assert.deepEqual(second, { written: 0, unchanged: 1 });
});

test('a moved kickoff is written', async () => {
  await upsertFixtures([fixture('1', '2026-10-25T19:00:00.000Z')]);
  const second = await upsertFixtures([fixture('1', '2026-10-26T19:00:00.000Z')]);
  assert.deepEqual(second, { written: 1, unchanged: 0 });
});

test('a team listing includes away matches', async () => {
  await upsertFixtures([fixture('2', '2026-10-25T19:00:00.000Z', { homeTeamId: '86', awayTeamId: '81' })]);
  const found = await listFixturesForTeam('81', { fromIso: '2026-10-01', toIso: '2026-11-01' });
  assert.equal(found.length, 1, 'a club plays half its matches away from home');
});

test('fixtures live outside the user tree', () => {
  assert.ok(!fixtureDoc('football-data', '1').startsWith('users/'));
});

test('firestore rules deny clients the fixture collection', () => {
  // The catch-all denies everything not under /users/{uid}. This test exists so
  // that a future rules edit that opens a new top-level path has to look here.
  const rules = readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8');
  assert.ok(/match \/\{any=\*\*\} \{\s*allow read, write: if false;/.test(rules));
  assert.ok(!/match \/fixtures/.test(rules));
});
```

- [ ] **Step 2: Run and watch it fail**

- [ ] **Step 3: Implement paths and the store**

Add the three collection constants to `paths.ts`, each with a comment saying why it is its own collection, in the style of the ones already there. `fixtureDoc` uses `docIdForKey(`${provider}:${matchId}`)` so a provider id containing a slash cannot escape its collection.

`upsertFixtures` reads each existing document and compares `contentHash` before writing, returning the `{ written, unchanged }` tally.

`listFixturesForTeam` queries `where homeTeamId == id` and `where awayTeamId == id` and merges — a club plays half its matches away, and a single equality filter would silently halve the season.

- [ ] **Step 4: Run and watch it pass** — 6 passing.

- [ ] **Step 5: Register and commit**

```bash
npm test
git add lib/storage/paths.ts lib/football/fixtureStore.ts tests/football/fixtureStore.test.ts package.json
git commit -m "Fixtures stored once for everyone, not once per follower

A fixture is public information about a football match, not one person's data,
so it lives in a top-level collection and a thousand Barcelona followers cost
one row. The alternative is the per-user fetch this design rejected, and the
free tier runs out of requests at a few dozen users.

An unchanged fixture is not rewritten. A nightly blind write would make every
fixture look changed to the projection, which would reschedule reminders
nobody asked to move.

A team's matches are read from both the home and away sides. One equality
filter would have quietly returned half a season.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: A commitment knows it was not typed by a person

**Files:**
- Modify: `src/domain/stateMachine.ts` (`Commitment`, `CreateDraft`, the `CreateDraft` reducer case, `normalizeStoredCommitment`)
- Test: `tests/domain/commitmentOrigin.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `export type CommitmentOrigin = 'user' | 'external_feed'`; `Commitment.origin: CommitmentOrigin`; optional `CreateDraft.commitment.origin`.

`CommitmentKind` is **not** extended with `'event'`. Only `pressureService.ts:524` branches on kind today, and nothing in this feature would read a new variant — a variant nothing branches on is a variant that drifts out of date. `origin` is the distinction the feature actually uses: skip confirmation, allow the source to update it, and remember a dismissal.

- [ ] **Step 1: Write the failing test**

```ts
// tests/domain/commitmentOrigin.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyDomainState, reduce, normalizeStoredCommitment } from '../../src/domain/stateMachine.ts';

const NOW = '2026-09-16T09:00:00.000Z';

test('a commitment is the user\'s unless it says otherwise', () => {
  const { newState } = reduce(createEmptyDomainState(), {
    type: 'CreateDraft', now: NOW,
    commitment: { id: 'c1', kind: 'task', title: 'Call the dentist' },
  });
  assert.equal(newState.commitments.c1.origin, 'user');
});

test('a feed can say a commitment is its own', () => {
  const { newState } = reduce(createEmptyDomainState(), {
    type: 'CreateDraft', now: NOW,
    commitment: { id: 'c2', kind: 'task', title: 'Barcelona v Real Madrid', origin: 'external_feed' },
  });
  assert.equal(newState.commitments.c2.origin, 'external_feed');
});

test('a commitment stored before this field reads as the user\'s', () => {
  // Every commitment written before today was typed by a person. Reading a
  // missing field as external_feed would hand the sync permission to rewrite
  // and delete commitments it never created.
  const stored = normalizeStoredCommitment({ id: 'old', kind: 'task', title: 'x', status: 'active' } as never);
  assert.equal(stored.origin, 'user');
});

test('an unrecognised stored origin reads as the user\'s', () => {
  const stored = normalizeStoredCommitment({ id: 'odd', kind: 'task', title: 'x', status: 'active', origin: 'whatever' } as never);
  assert.equal(stored.origin, 'user');
});
```

- [ ] **Step 2: Run and watch it fail**

- [ ] **Step 3: Add the field**

Add `origin` to `Commitment`, default `'user'` in the `CreateDraft` case, and complete it in `normalizeStoredCommitment` with `origin === 'external_feed' ? 'external_feed' : 'user'` — an explicit allow-list, matching how `allDay` is normalized (`=== true`, never `!!`) and for the same reason.

- [ ] **Step 4: Run and watch it pass** — 4 passing.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`. Any test that constructs a `Commitment` literal now fails to typecheck. Fix by adding `origin: 'user'`, not by making the field optional.

- [ ] **Step 6: Commit**

```bash
git add src/domain/stateMachine.ts tests/domain/commitmentOrigin.test.ts package.json
git commit -m "A commitment that knows it was not typed by a person

A fixture commitment skips confirmation, may be rewritten when the match
moves, and must stay dismissed once the user dismisses it. All three need the
domain to know the row did not come from a human.

Read back, a missing origin is the user's. Every commitment written before
today was typed by somebody, and defaulting the other way would hand a sync
job permission to rewrite and delete commitments it never created. An
unrecognised value reads the same way, for the same reason allDay is
normalised with === true rather than a truthiness check.

CommitmentKind stays as it is. Only one place branches on it, nothing in this
feature would read a new variant, and a variant nothing reads is one that
drifts out of date.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Which clubs a user follows

**Files:**
- Create: `lib/football/followedClubs.ts`
- Test: `tests/football/followedClubs.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `getFollowedClubs(uid: string): Promise<readonly string[]>`, `setFollowedClubs(uid: string, clubIds: readonly string[], now: string): Promise<readonly string[]>`, `listFollowedClubIdsAcrossUsers(): Promise<readonly string[]>`.

Stored at `userSubDoc(uid, FOOTBALL_FOLLOWS, 'clubs')` as `{ clubIds: string[], updatedAt: string }`. An array from day one: the MVP screen may be simple, but the alternative is a migration to add a second club later for no saving now.

- [ ] **Step 1: Write the failing test**

```ts
// tests/football/followedClubs.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { getFollowedClubs, setFollowedClubs, listFollowedClubIdsAcrossUsers } from '../../lib/football/followedClubs.ts';

const NOW = '2026-09-16T09:00:00.000Z';

test.beforeEach(() => setStorageForTests(createMemoryStorage()));
test.afterEach(() => resetStorageForTests());

test('following nothing is an empty list, not an error', async () => {
  assert.deepEqual(await getFollowedClubs('u1'), []);
});

test('a follow round-trips', async () => {
  await setFollowedClubs('u1', ['barcelona'], NOW);
  assert.deepEqual(await getFollowedClubs('u1'), ['barcelona']);
});

test('more than one club is supported', async () => {
  await setFollowedClubs('u1', ['barcelona', 'liverpool'], NOW);
  assert.deepEqual([...await getFollowedClubs('u1')].sort(), ['barcelona', 'liverpool']);
});

test('an unknown club id is rejected', async () => {
  // The id is a document key for the sync. Accepting one the curated list does
  // not contain means a nightly job asking a provider about nothing, for ever.
  await assert.rejects(() => setFollowedClubs('u1', ['not-a-club'], NOW), /unknown club/i);
});

test('duplicates collapse', async () => {
  await setFollowedClubs('u1', ['barcelona', 'barcelona'], NOW);
  assert.deepEqual(await getFollowedClubs('u1'), ['barcelona']);
});

test('the sync can ask which clubs have any follower at all', async () => {
  await setFollowedClubs('u1', ['barcelona'], NOW);
  await setFollowedClubs('u2', ['barcelona', 'liverpool'], NOW);
  assert.deepEqual([...await listFollowedClubIdsAcrossUsers()].sort(), ['barcelona', 'liverpool']);
});
```

- [ ] **Step 2: Run and watch it fail**

- [ ] **Step 3: Implement**

`listFollowedClubIdsAcrossUsers` uses `listGroup(FOOTBALL_FOLLOWS)` — the collection-group read is what lets the sync fetch only clubs somebody actually follows.

- [ ] **Step 4: Run and watch it pass** — 6 passing.

- [ ] **Step 5: Register and commit**

```bash
npm test
git add lib/football/followedClubs.ts tests/football/followedClubs.test.ts package.json
git commit -m "Followed clubs, as a list from the first day

The MVP screen offers a short curated list and most people will pick one club.
Storing one club anyway would buy nothing now and cost a data migration the
first time somebody wants their national team as well.

An unknown club id is refused at the door. Accepted, it would become a
document key the nightly sync carries for ever, asking a provider about a team
that does not exist.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: The projection — fixtures become commitments

This is the heart of the feature and the task most worth reviewing slowly.

**Files:**
- Create: `lib/football/externalTaskRefStore.ts`
- Create: `lib/football/projectFixtures.ts`
- Test: `tests/football/projectFixtures.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `Fixture`, `FIXTURE_BLOCK_MINUTES` (Task 2); `listFixturesForTeam` (Task 5); `CommitmentOrigin` (Task 6); `getFollowedClubs` (Task 7); `applyCommand` from `lib/services/commandService.ts`; `ExternalTaskReference` from `src/contracts/v1/externalTaskContracts.ts`.
- Produces:
  - `externalTaskRefStore`: `getRef(uid, externalId)`, `putRef(uid, ref)`, `listRefs(uid)`.
  - `projectFixturesForUser(uid: string, now: string): Promise<ProjectionTally>` where `ProjectionTally = { created: number; updated: number; cancelled: number; skipped: number }`.
  - `dismissFixtureCommitment(uid: string, commitmentId: string, now: string): Promise<void>`.

**The table this task implements.** Each row is a test.

| Situation | Action |
|---|---|
| No ref for `(uid, matchId)` | Create commitment `status: 'active'`, `origin: 'external_feed'`, `timeSpec.endAt = kickoff + 120min`; create ref |
| Ref exists, `contentHash` unchanged | Nothing |
| Ref exists, kickoff moved | `UpdateCommitment` with the new `timeSpec`; store the new hash |
| Fixture `status: 'cancelled'` | Drop the commitment |
| Ref has `detachedAt` set | **Never recreate** |

- [ ] **Step 1: Write the failing test**

```ts
// tests/football/projectFixtures.test.ts
/**
 * Fixtures become commitments, and stay the commitments they became.
 *
 * The row that matters most is the last one. A user who dismisses Saturday's
 * match and finds it back on Sunday morning has been told their choice does
 * not count, and a dismissal a sync can undo is worse than no dismissal.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { upsertFixtures } from '../../lib/football/fixtureStore.ts';
import { setFollowedClubs } from '../../lib/football/followedClubs.ts';
import { projectFixturesForUser, dismissFixtureCommitment } from '../../lib/football/projectFixtures.ts';
import { getCommandServiceState } from '../../lib/services/commandService.ts';

const NOW = '2026-10-01T09:00:00.000Z';
// Build fixtures with the same helper as tests/football/fixtureStore.test.ts;
// copy it into this file rather than importing across test files.

function commitments() {
  return Object.values(getCommandServiceState().commitments);
}

test.beforeEach(async () => {
  setStorageForTests(createMemoryStorage());
  await setFollowedClubs('u1', ['barcelona'], NOW);
});
test.afterEach(() => resetStorageForTests());

test('a fixture becomes an active commitment that blocks two hours', async () => {
  await upsertFixtures([fixture('1', '2026-10-25T19:00:00.000Z')]);
  const tally = await projectFixturesForUser('u1', NOW);
  assert.equal(tally.created, 1);
  const [c] = commitments();
  assert.equal(c.status, 'active');
  assert.equal(c.origin, 'external_feed');
  assert.equal(c.timeSpec.kind, 'scheduled_event');
  assert.equal(c.timeSpec.dueAt, '2026-10-25T19:00:00.000Z');
  assert.equal(c.timeSpec.endAt, '2026-10-25T21:00:00.000Z');
});

test('projecting twice does not create two commitments', async () => {
  await upsertFixtures([fixture('1', '2026-10-25T19:00:00.000Z')]);
  await projectFixturesForUser('u1', NOW);
  const tally = await projectFixturesForUser('u1', NOW);
  assert.deepEqual(tally, { created: 0, updated: 0, cancelled: 0, skipped: 1 });
  assert.equal(commitments().length, 1);
});

test('a moved kickoff moves the commitment instead of adding one', async () => {
  await upsertFixtures([fixture('1', '2026-10-25T19:00:00.000Z')]);
  await projectFixturesForUser('u1', NOW);
  await upsertFixtures([fixture('1', '2026-10-26T17:00:00.000Z')]);
  const tally = await projectFixturesForUser('u1', NOW);
  assert.equal(tally.updated, 1);
  assert.equal(commitments().length, 1);
  assert.equal(commitments()[0].timeSpec.dueAt, '2026-10-26T17:00:00.000Z');
  assert.equal(commitments()[0].timeSpec.endAt, '2026-10-26T19:00:00.000Z');
});

test('a cancelled match drops the commitment', async () => {
  await upsertFixtures([fixture('1', '2026-10-25T19:00:00.000Z')]);
  await projectFixturesForUser('u1', NOW);
  await upsertFixtures([fixture('1', '2026-10-25T19:00:00.000Z', { status: 'cancelled' })]);
  const tally = await projectFixturesForUser('u1', NOW);
  assert.equal(tally.cancelled, 1);
  assert.equal(commitments()[0].status, 'dropped');
});

test('a dismissed match is never brought back', async () => {
  await upsertFixtures([fixture('1', '2026-10-25T19:00:00.000Z')]);
  await projectFixturesForUser('u1', NOW);
  await dismissFixtureCommitment('u1', commitments()[0].id, NOW);
  const tally = await projectFixturesForUser('u1', NOW);
  assert.equal(tally.created, 0);
  assert.equal(commitments().filter((c) => c.status !== 'dropped').length, 0);
});

test('a dismissed match stays dismissed even when it moves', async () => {
  // The hash changes, so the "unchanged" shortcut does not apply and the
  // update path is reached. detachedAt has to be checked before it, not after.
  await upsertFixtures([fixture('1', '2026-10-25T19:00:00.000Z')]);
  await projectFixturesForUser('u1', NOW);
  await dismissFixtureCommitment('u1', commitments()[0].id, NOW);
  await upsertFixtures([fixture('1', '2026-10-26T17:00:00.000Z')]);
  const tally = await projectFixturesForUser('u1', NOW);
  assert.deepEqual(tally, { created: 0, updated: 0, cancelled: 0, skipped: 1 });
});

test('a user who follows nobody gets nothing', async () => {
  await setFollowedClubs('u1', [], NOW);
  await upsertFixtures([fixture('1', '2026-10-25T19:00:00.000Z')]);
  assert.deepEqual(await projectFixturesForUser('u1', NOW), { created: 0, updated: 0, cancelled: 0, skipped: 0 });
});

test('a finished match in the past is not projected', async () => {
  await upsertFixtures([fixture('1', '2026-09-20T19:00:00.000Z', { status: 'finished' })]);
  assert.equal((await projectFixturesForUser('u1', NOW)).created, 0);
});

test('a late kickoff lands on the local day it is played on', async () => {
  // 22:00 UTC is 01:00 the next morning in Asia/Jerusalem. The commitment is
  // stored as the instant either way; this pins that nothing in the projection
  // rounds, floors or reformats it into a different day on the way through.
  await upsertFixtures([fixture('1', '2026-10-25T22:00:00.000Z')]);
  await projectFixturesForUser('u1', NOW);
  const [c] = commitments();
  assert.equal(c.timeSpec.dueAt, '2026-10-25T22:00:00.000Z');
  assert.equal(c.timeSpec.endAt, '2026-10-26T00:00:00.000Z');
  assert.equal(c.timeSpec.allDay, false);
});
```

Note on #413: mobile Jest does not pin `TZ`, so a timezone-dependent test there
is only red on CI. This test is a server test under `node:test` and states its
instants explicitly, which is why it belongs here rather than in the app.

- [ ] **Step 2: Run and watch it fail**

- [ ] **Step 3: Implement the ref store, then the projection**

Order inside `projectFixturesForUser`, and the order is the point:

1. Load the user's followed clubs; return the zero tally if empty.
2. For each club, `listFixturesForTeam` over `[now, now + 60 days]`.
3. For each fixture, load the ref by `externalId = ${provider}:${providerMatchId}`.
4. **`detachedAt` first.** Before the hash comparison, before the status branch. A dismissed match whose kickoff moved reaches the update path otherwise, and a dismissal a sync can undo is not a dismissal.
5. Then `status === 'cancelled'` → drop.
6. Then `contentHash` equal → skip.
7. Then create or update.

The commitment title is built from the club names in the user's language at **read** time, not baked in at projection time — a user who switches the app to Hebrew should not keep a screen of Arabic fixture titles. Store `homeTeamName`/`awayTeamName` on the ref and render in the UI layer.

Creation is `CreateDraft` followed immediately by `ConfirmCommitment`: following the club was the confirmation, and routing 50 matches a season through a confirmation queue is the outcome the owner explicitly rejected.

- [ ] **Step 4: Run and watch it pass** — 8 passing.

- [ ] **Step 5: Register and commit**

```bash
npm test
git add lib/football/externalTaskRefStore.ts lib/football/projectFixtures.ts tests/football/projectFixtures.test.ts package.json
git commit -m "Fixtures become commitments, and stay the ones they became

Every branch here exists because a nightly job that writes to somebody's
calendar gets to be wrong once before they stop trusting it.

detachedAt is checked first, ahead of the hash comparison and the status
branch. A dismissed match whose kickoff later moves has a changed hash, so any
later check would let the update path resurrect it -- and a user who dismisses
Saturday's match and finds it back on Sunday has been told their choice does
not count.

Team names are stored on the reference and rendered at read time rather than
baked into the title. Somebody who switches the app to Hebrew should not be
left with a screen of fixture titles in the language they left.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: The nightly sync

**Files:**
- Create: `lib/football/syncFixtures.ts`
- Modify: `lib/jobs/internalJobs.ts` (register the handler)
- Test: `tests/football/syncFixtures.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `FixtureProvider` (Task 2), `listClubs`/`clubById` (Task 4), `upsertFixtures` (Task 5), `listFollowedClubIdsAcrossUsers` (Task 7).
- Produces: `syncFollowedClubs(deps: { provider: FixtureProvider; now: string; sleep?: (ms: number) => Promise<void> }): Promise<SyncReport>` where `SyncReport = { clubs: number; fetched: number; written: number; failures: Array<{ clubId: string; reason: string }> }`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/football/syncFixtures.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { setFollowedClubs } from '../../lib/football/followedClubs.ts';
import { syncFollowedClubs } from '../../lib/football/syncFixtures.ts';
import { listFixturesForTeam } from '../../lib/football/fixtureStore.ts';

const NOW = '2026-10-01T09:00:00.000Z';
const noSleep = async () => {};

function providerReturning(byTeam: Record<string, unknown[]>, calls: string[] = []) {
  return {
    name: 'fake',
    async listFixtures(teamId: string) {
      calls.push(teamId);
      const rows = byTeam[teamId];
      if (!rows) throw new Error(`no such team ${teamId}`);
      return rows as never;
    },
  };
}

test.beforeEach(() => setStorageForTests(createMemoryStorage()));
test.afterEach(() => resetStorageForTests());

test('only clubs somebody follows are fetched', async () => {
  // The curated list has a dozen clubs. Fetching all of them nightly spends
  // the free tier on teams no user has ever chosen.
  await setFollowedClubs('u1', ['barcelona'], NOW);
  const calls: string[] = [];
  await syncFollowedClubs({ provider: providerReturning({ '81': [] }, calls), now: NOW, sleep: noSleep });
  assert.deepEqual(calls, ['81']);
});

test('one club is fetched once however many follow it', async () => {
  await setFollowedClubs('u1', ['barcelona'], NOW);
  await setFollowedClubs('u2', ['barcelona'], NOW);
  await setFollowedClubs('u3', ['barcelona'], NOW);
  const calls: string[] = [];
  await syncFollowedClubs({ provider: providerReturning({ '81': [] }, calls), now: NOW, sleep: noSleep });
  assert.equal(calls.length, 1);
});

test('one club failing does not stop the others', async () => {
  await setFollowedClubs('u1', ['barcelona', 'liverpool'], NOW);
  const report = await syncFollowedClubs({
    provider: providerReturning({ '64': [] }), // liverpool only; barcelona throws
    now: NOW, sleep: noSleep,
  });
  assert.equal(report.failures.length, 1);
  assert.equal(report.clubs, 2);
});

test('a failed fetch leaves what was already stored', async () => {
  // A 503 must never be read as "this club has no matches". Clearing somebody's
  // evening because a third party had a bad minute is the worst failure here.
  await setFollowedClubs('u1', ['barcelona'], NOW);
  await syncFollowedClubs({ provider: providerReturning({ '81': [fixture('1', '2026-10-25T19:00:00.000Z')] }), now: NOW, sleep: noSleep });
  await syncFollowedClubs({ provider: { name: 'down', listFixtures: async () => { throw new Error('503'); } }, now: NOW, sleep: noSleep });
  assert.equal((await listFixturesForTeam('81', { fromIso: '2026-10-01', toIso: '2026-11-01' })).length, 1);
});

test('requests are spaced', async () => {
  await setFollowedClubs('u1', ['barcelona', 'liverpool'], NOW);
  const sleeps: number[] = [];
  await syncFollowedClubs({
    provider: providerReturning({ '81': [], '64': [] }),
    now: NOW,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(sleeps.length, 1, 'one gap between two requests');
  assert.ok(sleeps[0] >= 6000, 'ten requests a minute is one every six seconds');
});
```

`fixture` builds a normalized `Fixture`; copy the helper used in Task 5's test.

- [ ] **Step 2: Run and watch it fail**

- [ ] **Step 3: Implement the sync, then register the job**

Sequential, with `sleep(6000)` between requests (10/min). Each club is wrapped in its own try/catch that records `{ clubId, reason }` and continues. A failure never deletes.

In `lib/jobs/internalJobs.ts`, add the handler alongside the existing ones, following the shape `participantJobHandler` uses. It constructs the real provider from `FOOTBALL_DATA_API_KEY` and, if the key is absent, returns a report saying the feature is off — it does not throw, and it does not log a stack trace every night on an install that never enabled football.

- [ ] **Step 4: Run and watch it pass** — 5 passing.

- [ ] **Step 5: Register and commit**

```bash
npm test
git add lib/football/syncFixtures.ts lib/jobs/internalJobs.ts tests/football/syncFixtures.test.ts package.json
git commit -m "Sync per club, spaced, and never destructive on failure

A thousand Barcelona followers are one request. Clubs nobody follows are not
fetched at all -- the curated list is a menu, not a work queue -- and requests
are spaced six seconds apart because the free tier allows ten a minute.

A failed fetch records a failure and leaves every stored fixture alone. The
tempting shape, replacing a club's fixtures with whatever came back, reads a
503 as 'this club has no matches' and clears somebody's evening because a
third party had a bad minute.

A missing API key reports the feature as off rather than throwing a stack
trace every night on an install that never turned football on.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: The collision warning

**Files:**
- Create: `lib/services/timeCollision.ts`
- Modify: `src/app/api/mobile/capture/confirm/route.ts` and `src/app/api/commitment/create/route.ts` (include the warning in the response)
- Test: `tests/football/timeCollision.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `intervalsOverlap` from `lib/planning/shared/time.ts`; `Commitment` from `src/domain/stateMachine.ts`; `DEFAULT_FIXED_EVENT_MINUTES` from `lib/services/dailyPlan/buildDailyPlan.ts`.
- Produces: `findCollisions(candidate: { dueAt: string; endAt: string | null }, against: readonly Commitment[]): readonly CollisionWarning[]` where `CollisionWarning = { commitmentId: string; title: string; startsAt: string; endsAt: string; origin: CommitmentOrigin }`.

It **warns, it does not refuse.** The user is allowed to book over a match; they are not allowed to do it without knowing.

- [ ] **Step 1: Write the failing test**

```ts
// tests/football/timeCollision.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { findCollisions } from '../../lib/services/timeCollision.ts';
// `commitmentAt` is the helper from tests/dailyPlan/fixedEventDuration.test.ts;
// copy it into this file.

const MATCH = commitmentAt('match', '2026-10-25T19:00:00.000Z', '2026-10-25T21:00:00.000Z');

test('a commitment inside a match collides', () => {
  const found = findCollisions({ dueAt: '2026-10-25T20:00:00.000Z', endAt: null }, [MATCH]);
  assert.equal(found.length, 1);
  assert.equal(found[0].commitmentId, 'match');
});

test('a commitment that ends exactly when the match starts does not collide', () => {
  // Half-open intervals: back-to-back is not a clash. Warning here would train
  // people to ignore the warning.
  const found = findCollisions({ dueAt: '2026-10-25T18:00:00.000Z', endAt: '2026-10-25T19:00:00.000Z' }, [MATCH]);
  assert.deepEqual(found, []);
});

test('a commitment that starts exactly when the match ends does not collide', () => {
  const found = findCollisions({ dueAt: '2026-10-25T21:00:00.000Z', endAt: null }, [MATCH]);
  assert.deepEqual(found, []);
});

test('a candidate with no end is measured at the default length', () => {
  // 20:45 + 30 minutes crosses 21:00, so it overlaps; 21:00 + 30 does not.
  assert.equal(findCollisions({ dueAt: '2026-10-25T20:45:00.000Z', endAt: null }, [MATCH]).length, 1);
});

test('an unscheduled commitment cannot be collided with', () => {
  const floating = commitmentAt('todo', '2026-10-25T19:00:00.000Z', null);
  floating.timeSpec = { ...floating.timeSpec, kind: 'due_by' };
  assert.deepEqual(findCollisions({ dueAt: '2026-10-25T19:30:00.000Z', endAt: null }, [floating]), []);
});

test('a dropped commitment cannot be collided with', () => {
  const dropped = commitmentAt('gone', '2026-10-25T19:00:00.000Z', '2026-10-25T21:00:00.000Z');
  dropped.status = 'dropped';
  assert.deepEqual(findCollisions({ dueAt: '2026-10-25T20:00:00.000Z', endAt: null }, [dropped]), []);
});

test('the warning names what was collided with', () => {
  // "This clashes with something" is not usable. The user needs to know it is
  // the match, so they can decide which of the two they actually meant.
  const [warning] = findCollisions({ dueAt: '2026-10-25T20:00:00.000Z', endAt: null }, [MATCH]);
  assert.equal(warning.title, 'match');
  assert.equal(warning.startsAt, '2026-10-25T19:00:00.000Z');
  assert.equal(warning.endsAt, '2026-10-25T21:00:00.000Z');
});
```

- [ ] **Step 2: Run and watch it fail**

- [ ] **Step 3: Implement**

`findCollisions` filters to `status` in `['active','deferred']` and `timeSpec.kind === 'scheduled_event'`, derives each interval with the same `endAt`-or-default rule Task 1 put in the planner (extract that helper into `lib/services/timeCollision.ts` and have `buildDailyPlan.ts` import it, so the two cannot drift), and calls `intervalsOverlap`.

- [ ] **Step 4: Run and watch it pass** — 7 passing, and the Task 1 tests still pass after the helper moves.

- [ ] **Step 5: Wire it into the create responses**

Both routes return the existing body plus `collisions: CollisionWarning[]`. Adding a field is backward-compatible; the mobile schema in Task 11 makes it optional so an older client keeps working.

- [ ] **Step 6: Register and commit**

```bash
npm test
git add lib/services/timeCollision.ts lib/services/dailyPlan/buildDailyPlan.ts src/app/api tests/football/timeCollision.test.ts package.json
git commit -m "Tell them it clashes; do not decide for them

The user is allowed to book over Saturday's match. They are not allowed to do
it without being told, which is a warning on the response and not a refusal.

Back-to-back is not a clash. The half-open convention is already fixed for the
product and this reuses intervalsOverlap rather than adding a third copy of it
-- and a warning that fires when a meeting ends exactly as the match kicks off
is a warning people learn to dismiss without reading.

The interval helper now lives beside the collision check and the planner
imports it. Two answers to 'how long is this commitment' in two files is how
the planner and the calendar came to disagree in the first place.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: The mobile surface

**Files:**
- Create: `src/app/api/mobile/football/route.ts` (GET clubs + follows, PUT follows)
- Create: `mobile/src/api/schemas/football.ts`
- Create: `mobile/src/api/endpoints/football.ts`
- Create: `mobile/src/features/settings/FootballSettingsScreen.tsx`
- Modify: `mobile/src/i18n/locales/{ar,he,en}.json`
- Modify: the settings list that renders `NotificationsSettingsScreen` etc., to add the new row
- Test: `mobile/src/features/settings/__tests__/FootballSettingsScreen.test.tsx`, `tests/football/footballRoute.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `listClubs` (Task 4), `getFollowedClubs`/`setFollowedClubs` (Task 7), `projectFixturesForUser` (Task 8).
- Produces: `GET /api/mobile/football` → `{ success: true, clubs: Club[], followedClubIds: string[] }`; `PUT /api/mobile/football` with `{ clubIds: string[] }` → the same shape.

**RNTL v14 notes for whoever writes the screen test:** `render()` returns a Promise — `await` it. `fireEvent` calls must be awaited too; an un-awaited event makes later renders mount nothing, and the test passes while asserting on an empty tree.

- [ ] **Step 1: Write the failing route test**

```ts
// tests/football/footballRoute.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { GET, PUT } from '../../src/app/api/mobile/football/route.ts';

test.beforeEach(() => setStorageForTests(createMemoryStorage()));
test.afterEach(() => resetStorageForTests());

test('the list is served with the follows', async () => {
  const body = await (await GET(authedRequest('GET'))).json();
  assert.equal(body.success, true);
  assert.ok(body.clubs.length >= 12);
  assert.deepEqual(body.followedClubIds, []);
});

test('a follow is saved and read back', async () => {
  await PUT(authedRequest('PUT', { clubIds: ['barcelona'] }));
  const body = await (await GET(authedRequest('GET'))).json();
  assert.deepEqual(body.followedClubIds, ['barcelona']);
});

test('an unknown club is a 400, not a 500', async () => {
  const res = await PUT(authedRequest('PUT', { clubIds: ['not-a-club'] }));
  assert.equal(res.status, 400);
});

test('each club carries a name in every supported language', async () => {
  const body = await (await GET(authedRequest('GET'))).json();
  for (const club of body.clubs) {
    for (const lang of ['ar', 'he', 'en']) assert.ok(club.names[lang]);
  }
});
```

`authedRequest` builds a `Request` with whatever auth header the other `tests/mobile/*` route tests use — copy that helper, do not invent one.

- [ ] **Step 2: Run and watch it fail**

- [ ] **Step 3: Write the route, the zod schemas and the endpoint functions**

Follow `mobile/src/api/schemas/calendar.ts` and `endpoints/calendar.ts` exactly: a zod schema per response, `apiRequest` with `schema:`. Add `collisions: collisionWarningSchema.array().optional()` to the commitment-create response schema so Task 10's new field is parsed when present and ignored when not.

- [ ] **Step 4: Write the screen and its test**

The screen lists clubs with the name in the current language, a toggle per club, and the provider attribution the free tier requires. Saving calls `PUT` and then triggers a projection so the user's first match appears without waiting for the nightly job.

```tsx
// mobile/src/features/settings/__tests__/FootballSettingsScreen.test.tsx
import { render, fireEvent, screen } from '@testing-library/react-native';
import { FootballSettingsScreen } from '../FootballSettingsScreen';

// RNTL v14: render() and fireEvent are async here. An un-awaited event leaves
// later renders mounting nothing, and the assertions then pass against an
// empty tree -- a green test that checked nothing.

test('a club shows the name for the active language', async () => {
  await render(<FootballSettingsScreen onBack={() => {}} />, { wrapper: arabicWrapper });
  expect(await screen.findByText('برشلونة')).toBeTruthy();
});

test('following a club saves it', async () => {
  const put = jest.fn().mockResolvedValue({ success: true, clubs: [], followedClubIds: ['barcelona'] });
  await render(<FootballSettingsScreen onBack={() => {}} />, { wrapper: wrapperWith({ putFollowedClubs: put }) });
  await fireEvent.press(await screen.findByTestId('football-club-barcelona'));
  expect(put).toHaveBeenCalledWith(['barcelona']);
});

test('the provider attribution is on screen', async () => {
  // The free tier requires it. A compliance obligation that lives only in a
  // code comment is one nobody notices when the screen is redesigned.
  await render(<FootballSettingsScreen onBack={() => {}} />, { wrapper: arabicWrapper });
  expect(await screen.findByTestId('football-attribution')).toBeTruthy();
});
```

`arabicWrapper` / `wrapperWith` are this repo's existing test wrappers — find them in `mobile/src/features/settings/__tests__/` and reuse; do not write new ones.

- [ ] **Step 4b: Per-match dismissal**

The opt-out the design rests on. Without it, "the user chooses" is only true once, at follow time.

- Route: `DELETE /api/mobile/football/fixtures/{commitmentId}` → calls `dismissFixtureCommitment` (Task 8).
- UI: a dismiss action on a commitment whose `origin` is `external_feed`. A user-typed commitment must not offer it — it deletes through a path that also writes `detachedAt`, which is meaningless for a commitment no feed owns.

```ts
// add to tests/football/footballRoute.test.ts
test('dismissing is remembered, not just applied', async () => {
  await PUT(authedRequest('PUT', { clubIds: ['barcelona'] }));
  // ... project one fixture, then:
  await DELETE(authedRequest('DELETE'), { params: { commitmentId } });
  const refs = await listRefs('u1');
  assert.ok(refs[0].detachedAt, 'a dismissal that leaves no detachedAt is undone by the next sync');
});

test('a user-typed commitment cannot be dismissed through this route', async () => {
  const res = await DELETE(authedRequest('DELETE'), { params: { commitmentId: userTypedId } });
  assert.equal(res.status, 404);
});
```

- [ ] **Step 5: Add all copy to all three locales**

Keys: `footballTitle`, `footballBody`, `footballFollowing`, `footballAttribution`, `footballCollision`. A key present in `en.json` but missing from `ar.json` renders the key name to an Arabic-speaking user.

- [ ] **Step 6: Run both suites**

Run: `npm test`
Run: `cd mobile && npx jest src/features/settings --no-cache`

`--no-cache` is not optional: the Expo/Jest cache in this repo both invents stale failures and hides real new ones.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/mobile/football mobile/src tests/football/footballRoute.test.ts package.json
git commit -m "Pick a club, in the language the app is already speaking

The screen renders each club's name from the curated list rather than from the
provider, so an Arabic interface says برشلونة and a Hebrew one says ברצלונה
instead of both saying FC Barcelona in Latin script.

Saving projects immediately rather than waiting for the nightly job. Following
a club and seeing an empty screen until tomorrow morning reads as the feature
not working.

The commitment-create response's new collisions field is optional in the
schema, so a client built before this change keeps parsing the response.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

---

### Task 12: Verify the calendar requirement rather than assuming it

Requirement 3 has **no implementation task**, which is a claim this plan has to prove rather than assert. #185's `deviceCalendarSync.reconcile` runs over the commitments the app is already holding, so a fixture commitment should become a calendar event with no football-specific code — and Task 1 gave it the right length.

An untested "it just works" is how a feature ships missing its third requirement.

**Files:**
- Test: `mobile/src/features/calendar/__tests__/fixtureCommitmentSync.test.ts`

- [ ] **Step 1: Write the test**

```ts
// A commitment with origin external_feed and a two-hour range must produce the
// same calendar event as any other commitment. If reconcile ever grows a filter
// on origin, this is what catches it.
test('a fixture commitment becomes a two-hour calendar event', () => {
  const draft = eventDraftFor(fixtureCommitment({
    dueAt: '2026-10-25T19:00:00.000Z',
    endAt: '2026-10-25T21:00:00.000Z',
    origin: 'external_feed',
  }));
  expect(draft.endDate.getTime() - draft.startDate.getTime()).toBe(120 * 60 * 1000);
  expect(draft.allDay).toBe(false);
});

test('reconcile does not skip feed commitments', () => {
  const plan = reconcilePlan({ commitments: [fixtureCommitment({ /* ... */ })], links: [] });
  expect(plan.toCreate).toHaveLength(1);
});
```

Use the real exported names from `mobile/src/features/calendar/eventDraft.ts` and `deviceCalendarSync.ts` — read them first; the names above are descriptive, not assumed.

- [ ] **Step 2: Run it**

Run: `cd mobile && npx jest src/features/calendar --no-cache`

If it fails, requirement 3 is **not** free and this plan is missing a task. Stop and report that rather than working around it.

- [ ] **Step 3: Commit**

```bash
git add mobile/src/features/calendar/__tests__/fixtureCommitmentSync.test.ts
git commit -m "Prove the calendar requirement instead of assuming it

Requirement 3 has no implementation task: #185's reconcile runs over the
commitments the app already holds, so a fixture commitment should become a
calendar event by itself. That is a claim, and an unproven claim is how a
feature ships missing one of its four requirements.

If reconcile ever grows a filter on origin, this is the test that fails.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## What this plan does not build

Named so nobody thinks they were forgotten:

- **Inferred priority (spec phase 2).** Raising fixture priority once the user has kept N matches in a row. It operates on the priority engine and is worth shipping only against real dismissal data, which this plan is what produces.
- **Reminder delivery.** The decision path works; `expo-notifications` is still on the unmerged `s3-196-184-notifications` branch.
- **ICS feed.** `/api/calendar.ics` reads the legacy `Item` model; bridging it is separate work.
- **Free-text club search.** The owner chose a curated list for the MVP.
