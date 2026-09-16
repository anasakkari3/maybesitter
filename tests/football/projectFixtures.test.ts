// tests/football/projectFixtures.test.ts
/**
 * Fixtures become commitments, and stay the commitments they became.
 *
 * The row that matters most is the last one. A user who dismisses Saturday's
 * match and finds it back on Sunday morning has been told their choice does
 * not count, and a dismissal a sync can undo is worse than no dismissal.
 *
 * ── Why this reads through participantState, not commandService ──────────
 * The brief this test was drafted from imported `getCommandServiceState`, a
 * process-global, user-less `DomainState` whose own `configureCommandService`
 * refuses to run on Cloud Run (see commandService.ts's header) -- and whose
 * *readers* are deliberately unguarded, which would have let this projection
 * pass every test here while writing a nightly job's commitments into a
 * global nobody asked for the moment it ran in production. The launch path
 * for a real user's data is `lib/services/mobile/participantState.ts`, keyed
 * by uid, transactional and durable -- so `commitments()` below reads one
 * user's state from there instead.
 *
 * ── Why there is no `origin` assertion here ───────────────────────────────
 * An earlier task added `Commitment.origin` and withdrew it (see
 * `src/domain/stateMachine.ts` and the "Withdraw Commitment.origin" commit):
 * a sealed annotation corpus checksums the whole serialised commitment, and
 * the field moved it. Provenance lives entirely on the `ExternalTaskReference`
 * this module writes -- `linkedCommitmentId` is how a fixture commitment is
 * known to be one this projection owns.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { upsertFixtures } from '../../lib/football/fixtureStore.ts';
import { setFollowedClubs } from '../../lib/football/followedClubs.ts';
import { projectFixturesForUser, dismissFixtureCommitment } from '../../lib/football/projectFixtures.ts';
import { readParticipantState } from '../../lib/services/mobile/participantState.ts';
import { fixtureContentHash, FIXTURE_CONTRACT_VERSION, FIXTURE_SCHEMA_VERSION } from '../../src/contracts/v1/fixtureContracts.ts';

const NOW = '2026-10-01T09:00:00.000Z';

// Same helper as tests/football/fixtureStore.test.ts, copied rather than
// imported across test files (see that file for the convention).
function fixture(id: string, kickoffUtc: string, over: Partial<Record<string, unknown>> = {}) {
  const core = {
    provider: 'football-data', providerMatchId: id, competition: 'PD',
    homeTeamId: '81', awayTeamId: '86', homeTeamName: 'FC Barcelona',
    awayTeamName: 'Real Madrid CF', kickoffUtc, status: 'scheduled', venue: null,
    ...over,
  };
  return { ...core, version: FIXTURE_CONTRACT_VERSION, schemaVersion: FIXTURE_SCHEMA_VERSION, contentHash: fixtureContentHash(core as never) };
}

// Reads one user's commitments from durable, uid-scoped state -- not the
// process-global `commandService` state the brief's draft used. See the
// module header for why that distinction is load-bearing.
async function commitments() {
  const state = await readParticipantState('u1');
  return Object.values(state.commitments);
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
  const [c] = await commitments();
  assert.equal(c.status, 'active');
  assert.equal(c.timeSpec.kind, 'scheduled_event');
  assert.equal(c.timeSpec.dueAt, '2026-10-25T19:00:00.000Z');
  assert.equal(c.timeSpec.endAt, '2026-10-25T21:00:00.000Z');
});

test('projecting twice does not create two commitments', async () => {
  await upsertFixtures([fixture('1', '2026-10-25T19:00:00.000Z')]);
  await projectFixturesForUser('u1', NOW);
  const tally = await projectFixturesForUser('u1', NOW);
  assert.deepEqual(tally, { created: 0, updated: 0, cancelled: 0, skipped: 1 });
  assert.equal((await commitments()).length, 1);
});

test('a moved kickoff moves the commitment instead of adding one', async () => {
  await upsertFixtures([fixture('1', '2026-10-25T19:00:00.000Z')]);
  await projectFixturesForUser('u1', NOW);
  await upsertFixtures([fixture('1', '2026-10-26T17:00:00.000Z')]);
  const tally = await projectFixturesForUser('u1', NOW);
  assert.equal(tally.updated, 1);
  const after = await commitments();
  assert.equal(after.length, 1);
  assert.equal(after[0].timeSpec.dueAt, '2026-10-26T17:00:00.000Z');
  assert.equal(after[0].timeSpec.endAt, '2026-10-26T19:00:00.000Z');
});

test('a cancelled match drops the commitment', async () => {
  await upsertFixtures([fixture('1', '2026-10-25T19:00:00.000Z')]);
  await projectFixturesForUser('u1', NOW);
  await upsertFixtures([fixture('1', '2026-10-25T19:00:00.000Z', { status: 'cancelled' })]);
  const tally = await projectFixturesForUser('u1', NOW);
  assert.equal(tally.cancelled, 1);
  assert.equal((await commitments())[0].status, 'dropped');
});

test('a dismissed match is never brought back', async () => {
  await upsertFixtures([fixture('1', '2026-10-25T19:00:00.000Z')]);
  await projectFixturesForUser('u1', NOW);
  const [created] = await commitments();
  await dismissFixtureCommitment('u1', created.id, NOW);
  const tally = await projectFixturesForUser('u1', NOW);
  assert.equal(tally.created, 0);
  assert.equal((await commitments()).filter((c) => c.status !== 'dropped').length, 0);
});

test('a dismissed match stays dismissed even when it moves', async () => {
  // The hash changes, so the "unchanged" shortcut does not apply and the
  // update path is reached. detachedAt has to be checked before it, not after.
  await upsertFixtures([fixture('1', '2026-10-25T19:00:00.000Z')]);
  await projectFixturesForUser('u1', NOW);
  const [created] = await commitments();
  await dismissFixtureCommitment('u1', created.id, NOW);
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
  const [c] = await commitments();
  assert.equal(c.timeSpec.dueAt, '2026-10-25T22:00:00.000Z');
  assert.equal(c.timeSpec.endAt, '2026-10-26T00:00:00.000Z');
  assert.equal(c.timeSpec.allDay, false);
});
