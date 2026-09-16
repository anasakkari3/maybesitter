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
import { getRef, putRef, putRefCarryingForwardDetachment } from '../../lib/football/externalTaskRefStore.ts';
import { applyParticipantCommands, persistParticipantState, readParticipantState } from '../../lib/services/mobile/participantState.ts';
import { upsertDevice } from '../../lib/push/deviceRegistry.ts';
import { fixtureContentHash, FIXTURE_CONTRACT_VERSION, FIXTURE_SCHEMA_VERSION, type Fixture, type FixtureCore } from '../../src/contracts/v1/fixtureContracts.ts';

const NOW = '2026-10-01T09:00:00.000Z';

// Same helper as tests/football/fixtureStore.test.ts, copied rather than
// imported across test files (see that file for the convention).
//
// `over` is `Partial<FixtureCore>`, not `Partial<Record<string, unknown>>`:
// spreading an index-signature-typed object over a literal widens every
// property it could override, including `status`, from the literal
// `'scheduled'` to plain `string` -- wide enough that a typo like
// `{ status: 'cancelled ' }` (a stray trailing space) would have compiled.
// Typing `over` against the real contract keeps every override checked
// against `FixtureStatus`, and gives this helper a real `Fixture` return
// type instead of `fixtureContentHash(core as never)` casting past it.
function fixture(id: string, kickoffUtc: string, over: Partial<FixtureCore> = {}): Fixture {
  const core: FixtureCore = {
    provider: 'football-data', providerMatchId: id, competition: 'PD',
    homeTeamId: '81', awayTeamId: '86', homeTeamName: 'FC Barcelona',
    awayTeamName: 'Real Madrid CF', kickoffUtc, status: 'scheduled', venue: null,
    ...over,
  };
  return { ...core, version: FIXTURE_CONTRACT_VERSION, schemaVersion: FIXTURE_SCHEMA_VERSION, contentHash: fixtureContentHash(core) };
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
  // #415: no catalog category fits a match, so it is left uncategorised.
  assert.equal(c.category, null);
  assert.equal(c.categorySource, 'inferred');
});

test('a fixture ref follows the normalised external task reference rule (#417)', async () => {
  await upsertFixtures([fixture('1', '2026-10-25T19:00:00.000Z')]);
  await projectFixturesForUser('u1', NOW);
  const ref = await getRef('u1', 'football-data:1');
  assert.ok(ref);
  // The provider lives in identity.provider and the vendor's own id in
  // identity.externalId; taskRefId is `${provider}:${externalId}`, exactly as
  // normalizeExternalTaskReference builds it for every other task provider.
  assert.equal(ref.identity.provider, 'football-data');
  assert.equal(ref.identity.externalId, '1');
  assert.equal(ref.taskRefId, `${ref.identity.provider}:${ref.identity.externalId}`);
  assert.equal(ref.schemaVersion, 'external-task-v1');
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

test('following both sides of a derby gets one commitment, not two', async () => {
  // The default fixture() helper's homeTeamId/awayTeamId ('81'/'86') are
  // barcelona/real-madrid respectively (see data/footballClubs.json) -- so
  // following both clubs means this one match comes back once from each
  // club's listFixturesForTeam query. The guarantee this test pins is the
  // same ref-lookup-before-create check that makes projecting the same club
  // twice a no-op (see the "projecting twice" test above): the second club's
  // occurrence of this fixture finds the ref the first one just wrote, sees
  // an unchanged contentHash, and skips -- so this is a real invariant of
  // `projectOneFixture`, not merely a side effect of `projectFixturesForUser`
  // merging fixtures across clubs before projecting (which exists to avoid
  // redundant work, not to hold this guarantee up by itself).
  await setFollowedClubs('u1', ['barcelona', 'real-madrid'], NOW);
  await upsertFixtures([fixture('1', '2026-10-25T19:00:00.000Z')]);
  const tally = await projectFixturesForUser('u1', NOW);
  assert.equal(tally.created, 1, 'one match followed from both sides is still one commitment');
  assert.equal((await commitments()).length, 1);
});

test('a user who follows nobody gets nothing', async () => {
  await setFollowedClubs('u1', [], NOW);
  await upsertFixtures([fixture('1', '2026-10-25T19:00:00.000Z')]);
  assert.deepEqual(await projectFixturesForUser('u1', NOW), { created: 0, updated: 0, cancelled: 0, skipped: 0 });
});

test('a fixture kicking off before the window start is not projected', async () => {
  // Renamed from "a finished match in the past is not projected": that name
  // claimed to test status filtering, but the kickoff falls before `NOW`, so
  // `listFixturesForTeam`'s window excludes it before `projectOneFixture`
  // ever sees its status -- this passes for a fixture in any status, which
  // `'scheduled'` here makes explicit rather than letting `'finished'` imply
  // this is a status test. `'a finished match in the future window is not
  // projected'` below is the actual status-filtering test for `finished`.
  await upsertFixtures([fixture('1', '2026-09-20T19:00:00.000Z')]);
  assert.equal((await projectFixturesForUser('u1', NOW)).created, 0);
});

test('a finished match in the future window is not projected', async () => {
  // The status check, isolated from the window check above: a kickoff well
  // inside the projection window, but already `finished`. Without
  // `finished` in `NON_HOLDING_STATUSES`, this would create an ordinary
  // active commitment for a match whose result is already known.
  await upsertFixtures([fixture('1', '2026-10-25T19:00:00.000Z', { status: 'finished' })]);
  const tally = await projectFixturesForUser('u1', NOW);
  assert.equal(tally.created, 0);
  assert.deepEqual(tally, { created: 0, updated: 0, cancelled: 0, skipped: 1 });
});

test('a postponed match drops the commitment', async () => {
  // football-data.org keeps a postponed match's old kickoff until a new one
  // is announced -- so an unhandled postponement is not "nothing blocked",
  // it is "the wrong evening blocked, for a match not being played that
  // night." Same treatment as a cancelled match: drop what exists.
  await upsertFixtures([fixture('1', '2026-10-25T19:00:00.000Z')]);
  await projectFixturesForUser('u1', NOW);
  await upsertFixtures([fixture('1', '2026-10-25T19:00:00.000Z', { status: 'postponed' })]);
  const tally = await projectFixturesForUser('u1', NOW);
  assert.equal(tally.cancelled, 1, 'postponed drops share the cancelled counter -- see ProjectionTally\'s doc comment');
  assert.equal((await commitments())[0].status, 'dropped');
});

test('a postponed match that is later rescheduled creates a new commitment', async () => {
  // The return journey: a postponement is usually followed by a new date,
  // not a permanent cancellation. The ref that the postponement's Drop left
  // behind still points at the now-dropped commitment -- this pins that the
  // rescheduled match gets a fresh, active commitment rather than silently
  // vanishing (which is what happened before this fix round: the update
  // branch tried to `UpdateCommitment` the dropped one and the domain layer
  // threw `InvalidStateTransitionError`, which `projectFixturesForUser`
  // would previously not have caught).
  await upsertFixtures([fixture('1', '2026-10-25T19:00:00.000Z')]);
  await projectFixturesForUser('u1', NOW);
  await upsertFixtures([fixture('1', '2026-10-25T19:00:00.000Z', { status: 'postponed' })]);
  await projectFixturesForUser('u1', NOW);
  assert.equal((await commitments())[0].status, 'dropped', 'sanity: the postponement did drop it');

  await upsertFixtures([fixture('1', '2026-11-02T20:00:00.000Z', { status: 'scheduled' })]);
  const tally = await projectFixturesForUser('u1', NOW);
  assert.equal(tally.created, 1, 'the rescheduled match comes back as a new commitment');

  const all = await commitments();
  assert.equal(all.length, 2, 'the dropped commitment stays; a second, active one is added');
  const active = all.find((c) => c.status === 'active');
  assert.ok(active, 'the rescheduled match is active');
  assert.equal(active.timeSpec.dueAt, '2026-11-02T20:00:00.000Z');
  const dropped = all.find((c) => c.status === 'dropped');
  assert.ok(dropped, 'the postponed commitment is still on record, still dropped');
});

test('a completed fixture commitment is not resurrected by a later content change', async () => {
  // Round 2's fallback caught InvalidStateTransitionError and always
  // recreated -- but UpdateCommitment's allowed-status list excludes
  // completed and archived too, not just dropped, and all three throw the
  // same error. A user who marks a match's commitment done (nothing about
  // this feature stops them -- Complete is an ordinary domain command) must
  // not get it handed back as new, active work because the provider
  // corrected an unrelated detail afterwards and the contentHash moved.
  await upsertFixtures([fixture('1', '2026-10-25T19:00:00.000Z')]);
  await projectFixturesForUser('u1', NOW);
  const [created] = await commitments();
  await applyParticipantCommands('u1', [{ type: 'Complete', commitmentId: created.id, now: NOW }]);
  assert.equal((await commitments())[0].status, 'completed', 'sanity: the commitment really is completed');

  // Same match, corrected kickoff -- changes the contentHash without going
  // through cancelled/postponed/finished, which is what forces this fixture
  // into the update branch (and its catch) rather than the status branch.
  await upsertFixtures([fixture('1', '2026-10-25T20:00:00.000Z')]);
  const tally = await projectFixturesForUser('u1', NOW);
  assert.deepEqual(tally, { created: 0, updated: 0, cancelled: 0, skipped: 1 });

  const all = await commitments();
  assert.equal(all.length, 1, 'no second commitment was created');
  assert.equal(all[0].status, 'completed');
  assert.equal(all[0].timeSpec.dueAt, '2026-10-25T19:00:00.000Z', 'the completed commitment was not touched either');
});

test('an archived fixture commitment is not resurrected by a later content change', async () => {
  // `archived` has no producing command in the domain today (grep
  // src/domain/stateMachine.ts: it is checked in several places but no
  // transition ever sets it) -- so unlike `completed` above, this simulates
  // it directly through participantState's own state-writing path rather
  // than pretending a command exists that doesn't. The point is the same:
  // this status is excluded from UpdateCommitment's allowed list exactly
  // like `dropped` and `completed` are, and must get the same "do nothing"
  // treatment, not "recreate it" or "surface an error".
  await upsertFixtures([fixture('1', '2026-10-25T19:00:00.000Z')]);
  await projectFixturesForUser('u1', NOW);
  const [created] = await commitments();
  const state = await readParticipantState('u1');
  state.commitments[created.id] = { ...state.commitments[created.id], status: 'archived' };
  await persistParticipantState('u1', state);
  assert.equal((await commitments())[0].status, 'archived', 'sanity: the forced state took');

  await upsertFixtures([fixture('1', '2026-10-25T20:00:00.000Z')]);
  const tally = await projectFixturesForUser('u1', NOW);
  assert.deepEqual(tally, { created: 0, updated: 0, cancelled: 0, skipped: 1 });

  const all = await commitments();
  assert.equal(all.length, 1, 'no second commitment was created');
  assert.equal(all[0].status, 'archived');
  assert.equal(all[0].timeSpec.dueAt, '2026-10-25T19:00:00.000Z', 'the archived commitment was not touched either');
});

test('a dismissed match stays dismissed through postponement and reschedule', async () => {
  // The three-way interaction: detachedAt has to keep winning even when the
  // fixture passes through a non-holding status on its way to a new date --
  // not just when it moves directly, which 'a dismissed match stays
  // dismissed even when it moves' already covers.
  await upsertFixtures([fixture('1', '2026-10-25T19:00:00.000Z')]);
  await projectFixturesForUser('u1', NOW);
  const [created] = await commitments();
  await dismissFixtureCommitment('u1', created.id, NOW);

  await upsertFixtures([fixture('1', '2026-10-25T19:00:00.000Z', { status: 'postponed' })]);
  let tally = await projectFixturesForUser('u1', NOW);
  assert.deepEqual(tally, { created: 0, updated: 0, cancelled: 0, skipped: 1 }, 'postponement does not un-dismiss it');

  await upsertFixtures([fixture('1', '2026-11-02T20:00:00.000Z', { status: 'scheduled' })]);
  tally = await projectFixturesForUser('u1', NOW);
  assert.deepEqual(tally, { created: 0, updated: 0, cancelled: 0, skipped: 1 }, 'nor does the reschedule that follows it');

  assert.equal((await commitments()).filter((c) => c.status !== 'dropped').length, 0);
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

// ── Task 11: the dismiss/sync race ──────────────────────────────────────
//
// `task-8-report.md`'s "Fix round 3" section proved this race exists and
// left it unfixed because neither `projectFixturesForUser` nor
// `dismissFixtureCommitment` had a caller yet. `task-11-report.md`'s
// "Decision 3" section confirmed both now do (the nightly job, and the
// mobile `DELETE` route) and deferred the actual fix as its own piece of
// work: "a transactional read-modify-write spanning both
// `projectOneFixture` and `dismissFixtureCommitment`". These two tests are
// that work's proof, simulated deterministically rather than by timing --
// no `setTimeout`, no real concurrency, no flake.

test('a dismissal landing mid-recreate wins the race, not the sync', async () => {
  // The exact production race: branch 5's "recreate" path (the postponement
  // return journey) decides "this InvalidStateTransitionError means the
  // postponement came back" purely from the linked commitment's status
  // being `dropped` -- which is also exactly what a *dismissal* leaves
  // behind, via `dismissFixtureCommitment`'s own `Drop`. If a dismissal's
  // `detachedAt` write lands after this recreate has already decided to go
  // ahead but before it commits, the pre-Task-11 code wrote a brand-new
  // **active** commitment and clobbered the ref's `detachedAt` back to
  // `null` via `buildRef`'s fresh construction -- reviving a match the user
  // had just dismissed, silently, with the DELETE request having already
  // returned 200.
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  await setFollowedClubs('u1', ['barcelona'], NOW);

  // 1. An ordinary active commitment.
  await upsertFixtures([fixture('1', '2026-10-25T19:00:00.000Z')]);
  await projectFixturesForUser('u1', NOW);

  // 2. A genuine postponement drops it. Not simulated -- a real,
  // already-committed prior run, exactly the state branch 5's "recreate"
  // path exists to handle correctly.
  await upsertFixtures([fixture('1', '2026-10-25T19:00:00.000Z', { status: 'postponed' })]);
  await projectFixturesForUser('u1', NOW);
  assert.equal((await commitments())[0].status, 'dropped', 'sanity: the postponement really dropped it');

  // 3. The match is rescheduled -- the fixture this run's `projectOneFixture`
  // will try to "recreate" a commitment for.
  await upsertFixtures([fixture('1', '2026-11-02T20:00:00.000Z', { status: 'scheduled' })]);

  // The interleaving: fires once, after the recreate transaction's own
  // reads (including its transactional re-read of the ref -- see
  // `updateCommitmentForFixtureGuarded` in `projectFixtures.ts`) but before
  // it commits (`memoryAdapter.ts`'s header on `setBeforeCommitHookForTests`:
  // "runs between a transaction's last read and its commit check"). A
  // plain, non-transactional write, exactly like `dismissFixtureCommitment`'s
  // own (real) ref write -- not a call to `dismissFixtureCommitment` itself,
  // which would deadlock here: its `applyParticipantCommands` call opens a
  // *second* storage transaction while this one's FIFO lock
  // (`memoryAdapter.ts`'s `acquire`) is still held by the transaction whose
  // hook is currently running.
  let fired = false;
  storage.setBeforeCommitHookForTests(async () => {
    if (fired) return;
    fired = true;
    const stale = await getRef('u1', 'football-data:1');
    await putRef('u1', { ...stale!, linkState: 'detached', detachedAt: NOW, updatedAt: NOW });
  });

  let tally;
  try {
    tally = await projectFixturesForUser('u1', NOW);
  } finally {
    storage.setBeforeCommitHookForTests(null);
  }

  assert.equal(fired, true, 'the interleaving actually landed inside the guarded transaction');
  assert.deepEqual(tally, { created: 0, updated: 0, cancelled: 0, skipped: 1 }, 'the race is skipped, not silently resurrected');

  const all = await commitments();
  assert.equal(all.filter((c) => c.status === 'active').length, 0, 'no active commitment exists');
  assert.equal(all.length, 1, 'no second commitment was created either');

  const ref = await getRef('u1', 'football-data:1');
  assert.ok(ref?.detachedAt, 'the reference still shows the dismissal');
});

test('a stale ref write never clears a detachedAt set after it was read', async () => {
  // `putRefCarryingForwardDetachment` is branch 2's (dropping a commitment
  // for a fixture that stopped holding time) half of the same fix -- see
  // `externalTaskRefStore.ts`'s header on that function. This is the basic,
  // no-concurrency-machinery version: build the exact call branch 2 makes --
  // spreading a *stale* copy of the ref, read before a concurrent dismissal
  // landed -- and confirm the write it produces does not undo a dismissal
  // that had already fully landed by the time this function's own
  // transaction opened. The test below this one covers the narrower window
  // this one does not: a dismissal landing *during* this function's own
  // transaction.
  await upsertFixtures([fixture('1', '2026-10-25T19:00:00.000Z')]);
  await projectFixturesForUser('u1', NOW);
  const externalId = 'football-data:1';

  // What `projectOneFixture`'s own top-of-function `getRef` would have seen,
  // before anything else happened this run.
  const stale = await getRef('u1', externalId);
  assert.equal(stale?.detachedAt, null, 'sanity: not dismissed yet');

  // The concurrent dismissal: `dismissFixtureCommitment`'s own real,
  // non-transactional ref write, landing in the gap after `stale` was read.
  await putRef('u1', { ...stale!, linkState: 'detached', detachedAt: NOW, updatedAt: NOW });

  // Branch 2's actual call shape, built from `stale` -- the copy that does
  // not know about the dismissal above.
  await putRefCarryingForwardDetachment('u1', {
    ...stale,
    fingerprint: stale!.fingerprint,
    lastSyncedAt: NOW,
    updatedAt: NOW,
  });

  const after = await getRef('u1', externalId);
  assert.ok(after?.detachedAt, 'the concurrent dismissal was not undone by the stale write');
});

test('a dismissal landing mid-write on the drop path is not undone', async () => {
  // Round 1 of this fix: `putRefCarryingForwardDetachment` used to re-read
  // the ref immediately before writing, but as two separate,
  // unsynchronised calls (`storage.get` then `storage.set`) -- so a
  // dismissal landing in the gap between *those* two calls was still
  // silently overwritten, the identical failure the create/update paths'
  // transactional guard exists to prevent, just moved into a smaller
  // window. `externalTaskRefStore.ts`'s header calls this out by name. This
  // test is what the test above cannot be: a dismissal landing *during*
  // `putRefCarryingForwardDetachment`'s own transaction, the same
  // `setBeforeCommitHookForTests` interleaving
  // `'a dismissal landing mid-recreate wins the race, not the sync'` uses
  // for the create/update paths, now that this function has a transaction
  // to hang it on.
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  await setFollowedClubs('u1', ['barcelona'], NOW);

  await upsertFixtures([fixture('1', '2026-10-25T19:00:00.000Z')]);
  await projectFixturesForUser('u1', NOW);
  const externalId = 'football-data:1';
  const before = await getRef('u1', externalId);
  assert.equal(before?.detachedAt, null, 'sanity: not dismissed yet');

  // The interleaving: fires once, after `putRefCarryingForwardDetachment`'s
  // own transactional `tx.get` but before it commits -- a plain,
  // non-transactional write, exactly like `dismissFixtureCommitment`'s own
  // ref write (not a call to `dismissFixtureCommitment` itself, which has
  // no commitment left to drop here and would in general risk the same
  // nested-transaction deadlock the create/update paths' own test avoids).
  let fired = false;
  storage.setBeforeCommitHookForTests(async () => {
    if (fired) return;
    fired = true;
    const stale = await getRef('u1', externalId);
    await putRef('u1', { ...stale!, linkState: 'detached', detachedAt: NOW, updatedAt: NOW });
  });

  try {
    await putRefCarryingForwardDetachment('u1', {
      ...before!,
      fingerprint: before!.fingerprint,
      lastSyncedAt: NOW,
      updatedAt: NOW,
    });
  } finally {
    storage.setBeforeCommitHookForTests(null);
  }

  assert.equal(fired, true, 'the interleaving actually landed inside the transaction');
  const after = await getRef('u1', externalId);
  assert.ok(after?.detachedAt, 'the reference still shows the dismissal');
});

// Task 12: requirement 3 ("the match goes on the phone calendar") has no
// implementation task on the claim that #185's `deviceCalendarSync.reconcile`
// already writes every eligible commitment with no football-specific code --
// because a fixture commitment is, on the wire, an ordinary commitment. The
// mobile-side half of that proof (`mobile/src/features/calendar/__tests__/
// fixtureCommitmentSync.test.ts`) shows `draftFor`/`decide` treat one
// correctly *if handed one*. This is the other half: proof that a projected
// fixture commitment is actually present in the exact lists
// `/api/mobile/commitments/today` and `/upcoming` serve, which is what
// `subjectsFromCache` (and therefore `reconcile`) reads on the client. If
// either route, or `listTodayRanked`/`listUpcomingRanked` underneath it, ever
// grew a filter that excluded a fixture-projected commitment, this is the
// test that would catch it.
test('a projected fixture commitment reaches listUpcomingRanked -- the list the mobile /upcoming route (and reconcile) reads', async () => {
  await upsertFixtures([fixture('1', '2026-10-25T19:00:00.000Z')]);
  await projectFixturesForUser('u1', NOW);
  const [created] = await commitments();

  const { listUpcomingRanked } = await import('../../lib/services/mobile/commitmentService.ts');
  const upcoming = await listUpcomingRanked({ now: new Date(NOW), participantId: 'u1' });
  const found = upcoming.items.find((item) => item.id === created.id);
  assert.ok(found, 'the fixture commitment must be present in the exact list the mobile /upcoming route serves');
  assert.equal(found?.timeSpec.dueAt, '2026-10-25T19:00:00.000Z');
  // calendarEligibleIds is what deviceCalendarSync's server-side counterpart
  // (the orphan computation) uses to decide "still eligible for a calendar
  // entry" -- a fixture commitment must be in it too, not just in `items`.
  assert.ok(upcoming.calendarEligibleIds.has(created.id));
});

// ── Final review C1: every surface showed "Football fixture" ────────────
//
// The device calendar, Today/Upcoming and the collision warning all print
// `commitment.title`. A title that names no team is a calendar full of
// identical rows nobody can tell apart, so the projection writes the match
// itself into the title, in the user's language where the club is curated.

test('a projected match is titled with its two teams, not a placeholder', async () => {
  await upsertFixtures([fixture('1', '2026-10-25T19:00:00.000Z')]);
  await projectFixturesForUser('u1', NOW);
  const [c] = await commitments();
  // No stored language for u1: English, from the curated club list.
  assert.equal(c.title, 'FC Barcelona – Real Madrid CF');
});

test('the title uses the curated name in the language the user\'s phone registered', async () => {
  await upsertDevice('u1', {
    installationId: '9b2f6a1e-3c4d-4e5f-8a6b-7c8d9e0f1a2b', fcmToken: 'x'.repeat(40), platform: 'ios',
    appVersion: '1.0.0', locale: 'ar', timezone: 'Asia/Jerusalem', pushPermission: 'granted',
  }, NOW);
  await upsertFixtures([fixture('1', '2026-10-25T19:00:00.000Z')]);
  await projectFixturesForUser('u1', NOW);
  const [c] = await commitments();
  assert.equal(c.title, 'برشلونة – ريال مدريد');
});

test('an uncurated opponent keeps the provider name, and a corrected name renames the commitment', async () => {
  await upsertFixtures([fixture('1', '2026-10-25T19:00:00.000Z', { awayTeamId: '999', awayTeamName: 'Girona FC' })]);
  await projectFixturesForUser('u1', NOW);
  assert.equal((await commitments())[0].title, 'FC Barcelona – Girona FC');

  await upsertFixtures([fixture('1', '2026-10-25T19:00:00.000Z', { awayTeamId: '999', awayTeamName: 'Girona Futbol Club' })]);
  const tally = await projectFixturesForUser('u1', NOW);
  assert.equal(tally.updated, 1);
  const all = await commitments();
  assert.equal(all.length, 1);
  assert.equal(all[0].title, 'FC Barcelona – Girona Futbol Club');
});

test('a match already projected is renamed when the account\'s language changes, with nothing else moving', async () => {
  await upsertFixtures([fixture('1', '2026-10-25T19:00:00.000Z')]);
  await projectFixturesForUser('u1', NOW);
  assert.equal((await commitments())[0].title, 'FC Barcelona – Real Madrid CF');
  // The fixture's content hash is unchanged -- only the language is new.
  const tally = await projectFixturesForUser('u1', NOW, { language: 'he' });
  assert.equal(tally.updated, 1);
  const all = await commitments();
  assert.equal(all.length, 1);
  assert.equal(all[0].title, 'ברצלונה – ריאל מדריד');
  assert.equal(all[0].timeSpec.dueAt, '2026-10-25T19:00:00.000Z');
});
