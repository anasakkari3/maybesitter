// tests/football/syncFixtures.test.ts
//
// The nightly sync (football fixtures MVP, Task 9). See syncFixtures.ts's
// module header for the three decisions this task made beyond the brief:
// a time budget with resumable, least-recently-synced-first ordering
// (instead of a flat 6-second-spaced walk that blows the scheduler's 60s
// attempt deadline), an honest accounting of what overlapping runs still
// cost even with that budget, and wiring `projectFixturesForUser` with its
// first real caller.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { setFollowedClubs } from '../../lib/football/followedClubs.ts';
import {
  REQUEST_SPACING_MS,
  syncFollowedClubs,
  type SyncReport,
} from '../../lib/football/syncFixtures.ts';
import { listFixturesForTeam } from '../../lib/football/fixtureStore.ts';
import { fixtureContentHash, FIXTURE_CONTRACT_VERSION, FIXTURE_SCHEMA_VERSION, type Fixture, type FixtureCore } from '../../src/contracts/v1/fixtureContracts.ts';
import { runFootballSyncJob } from '../../lib/jobs/internalJobs.ts';
import { readParticipantState } from '../../lib/services/mobile/participantState.ts';

const NOW = '2026-10-01T09:00:00.000Z';
const noSleep = async () => {};

/** Copied from tests/football/fixtureStore.test.ts's own helper -- see that file's comment for why `over` is typed against `FixtureCore`. */
function fixture(id: string, kickoffUtc: string, over: Partial<FixtureCore> = {}): Fixture {
  const core: FixtureCore = {
    provider: 'football-data', providerMatchId: id, competition: 'PD',
    homeTeamId: '81', awayTeamId: '86', homeTeamName: 'FC Barcelona',
    awayTeamName: 'Real Madrid CF', kickoffUtc, status: 'scheduled', venue: null,
    ...over,
  };
  return { ...core, version: FIXTURE_CONTRACT_VERSION, schemaVersion: FIXTURE_SCHEMA_VERSION, contentHash: fixtureContentHash(core) };
}

/**
 * `onCall`, when given, runs after each fetch is recorded -- the budget tests
 * use it to advance a fake clock by a fixed amount per request, standing in
 * for the wall-clock time a real network fetch would actually spend (the
 * in-memory fake here is otherwise instantaneous, so a budget check would
 * never see elapsed time pass without this).
 */
function providerReturning(byTeam: Record<string, unknown[]>, calls: string[] = [], onCall?: () => void) {
  return {
    name: 'fake',
    async listFixtures(teamId: string) {
      calls.push(teamId);
      onCall?.();
      const rows = byTeam[teamId];
      if (!rows) throw new Error(`no such team ${teamId}`);
      return rows as never;
    },
  };
}

test.beforeEach(() => setStorageForTests(createMemoryStorage()));
test.afterEach(() => resetStorageForTests());

// ---------------------------------------------------------------------------
// The brief's five guarantees.
// ---------------------------------------------------------------------------

test('only clubs somebody follows are fetched', async () => {
  // The curated list has fifteen clubs. Fetching all of them nightly spends
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
  assert.equal(report.failures[0]?.clubId, 'barcelona');
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
  assert.equal(REQUEST_SPACING_MS, sleeps[0]);
});

// ---------------------------------------------------------------------------
// Decision 1: a time budget, and resumable, least-recently-synced-first
// ordering -- proven by breaking each half in turn.
// ---------------------------------------------------------------------------

test('a tick that runs out of budget stops early and says so', async () => {
  await setFollowedClubs('u1', ['barcelona', 'liverpool'], NOW);
  const calls: string[] = [];
  let clock = 0;
  // Each fetch "costs" 700ms of wall-clock time; a 500ms budget affords
  // exactly one request before the next iteration's check trips.
  const provider = providerReturning({ '81': [], '64': [] }, calls, () => { clock += 700; });
  const report: SyncReport = await syncFollowedClubs({
    provider,
    now: NOW,
    clock: () => clock,
    sleep: noSleep,
    budgetMs: 500,
  });
  assert.deepEqual(calls, ['81']);
  assert.equal(report.attempted, 1);
  assert.equal(report.stoppedBy, 'budget');
  assert.equal(report.clubs, 2, 'both followed clubs are still candidates, even the one the budget deferred');
});

test('a full budget drains the whole followed list in one tick', async () => {
  await setFollowedClubs('u1', ['barcelona', 'liverpool'], NOW);
  const report = await syncFollowedClubs({
    provider: providerReturning({ '81': [], '64': [] }),
    now: NOW,
    sleep: noSleep,
    budgetMs: 45_000,
  });
  assert.equal(report.attempted, 2);
  assert.equal(report.stoppedBy, 'drained');
});

test('a club that sorts last is not starved forever: consecutive ticks rotate through the whole list', async () => {
  // This is the defect the budget change exists to avoid: without
  // least-recently-synced-first ordering, a budget that only fits one club
  // per tick would fetch the same first club every single night and never
  // reach the rest of the followed list.
  //
  // Alphabetically: barcelona < juventus < liverpool. Ties (including "never
  // synced") break alphabetically, so a club just attempted (whose
  // `lastSyncedAt` becomes `NOW`) sorts *after* every club still on `null` --
  // that is the whole mechanism under test, so the expected order below
  // follows strictly from it, not from an arbitrary follow order.
  await setFollowedClubs('u1', ['barcelona', 'liverpool', 'juventus'], NOW);
  const calls: string[] = [];
  let clock = 0;
  const provider = providerReturning({ '81': [], '64': [], '109': [] }, calls, () => { clock += 700; });
  const budgetMs = 500; // affords exactly one request per tick

  const tick1 = await syncFollowedClubs({ provider, now: NOW, sleep: noSleep, clock: () => clock, budgetMs });
  assert.equal(tick1.stoppedBy, 'budget');
  assert.deepEqual(calls, ['81'], 'never-synced clubs tie-break alphabetically: barcelona first');

  clock = 0; // a fresh tick gets its own budget window, same as runJobsTick's `started`
  const tick2 = await syncFollowedClubs({ provider, now: NOW, sleep: noSleep, clock: () => clock, budgetMs });
  assert.deepEqual(calls, ['81', '109'], 'tick 2 must pick up juventus (next alphabetically among the untouched pair), not re-fetch barcelona');
  assert.equal(tick2.attempted, 1);

  clock = 0;
  const tick3 = await syncFollowedClubs({ provider, now: NOW, sleep: noSleep, clock: () => clock, budgetMs });
  assert.deepEqual(calls, ['81', '109', '64'], 'tick 3 finally reaches liverpool -- nothing is starved');
  assert.equal(tick3.attempted, 1);
});

test('a club is marked synced even when its fetch fails, so a chronic failure does not block rotation', async () => {
  // If a failing club's "last synced" timestamp never advanced, it would sort
  // first forever and a persistently-broken club would starve every other
  // followed club of budget, one tick at a time.
  await setFollowedClubs('u1', ['barcelona', 'liverpool'], NOW);
  const calls: string[] = [];
  let clock = 0;
  const failing = {
    name: 'flaky',
    async listFixtures(teamId: string) {
      calls.push(teamId);
      clock += 700;
      if (teamId === '81') throw new Error('503');
      return [] as never;
    },
  };
  const budgetMs = 500;

  const tick1 = await syncFollowedClubs({ provider: failing, now: NOW, sleep: noSleep, clock: () => clock, budgetMs });
  assert.deepEqual(calls, ['81']);
  assert.equal(tick1.failures.length, 1);

  clock = 0;
  await syncFollowedClubs({ provider: failing, now: NOW, sleep: noSleep, clock: () => clock, budgetMs });
  assert.deepEqual(calls, ['81', '64'], 'tick 2 moves on to liverpool instead of retrying barcelona immediately');
});

// ---------------------------------------------------------------------------
// Decision 3: the job wires `projectFixturesForUser` (its first real caller).
// ---------------------------------------------------------------------------

test('a missing API key reports the feature as off, and throws nothing', async () => {
  const report = await runFootballSyncJob({ env: {} });
  assert.deepEqual(report, { enabled: false });
});

test('the job fetches fixtures and turns them into a commitment for a follower', async () => {
  await setFollowedClubs('u1', ['barcelona'], NOW);
  const provider = providerReturning({ '81': [fixture('1', '2026-10-25T19:00:00.000Z')] });
  const report = await runFootballSyncJob({ env: { FOOTBALL_DATA_API_KEY: 'k' }, provider, sleep: noSleep, now: new Date(NOW) });
  assert.equal(report.enabled, true);
  assert.equal(report.sync?.written, 1);
  assert.equal(report.projection?.users, 1);
  assert.equal(report.projection?.created, 1);

  const state = await readParticipantState('u1');
  const commitments = Object.values(state.commitments);
  assert.equal(commitments.length, 1);
  assert.equal(commitments[0]?.status, 'active');
});
