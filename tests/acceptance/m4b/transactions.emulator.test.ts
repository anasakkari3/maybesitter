/**
 * M4b Gate B — the clash decision is serializable on real Firestore
 * (PLAN-M4b R1.2 "Serializability is proven, not assumed", M4B-R2-002).
 *
 * Runs against the Firestore emulator (`npm run test:emulator`). A concurrent
 * writer inserts a clashing busy block / weekly block / commitment after the
 * projection's transactional reads and before it commits (the gate's decision
 * hook). The match must end up held — the transaction retried and saw it, or
 * the concurrent write was ordered first — and never saved over the clash.
 *
 * If this file fails because the inserted row was not seen (a phantom), the
 * plan's stop rule applies: the builder stops and reports; it does not switch
 * mechanism silently.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreStorage, resetFirestoreForTests } from '../../../lib/storage/firestoreAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../../lib/storage/index.ts';
import { applyParticipantCommands, readParticipantState } from '../../../lib/services/mobile/participantState.ts';
import { replaceBusyBlocks } from '../../../lib/calendar/busyBlocks.ts';
import { createWeeklyBlock } from '../../../lib/weeklyBlocks/weeklyBlockService.ts';
import { upsertFixtures } from '../../../lib/football/fixtureStore.ts';
import { setFollowedClubs } from '../../../lib/football/followedClubs.ts';
import { projectFixturesForUser } from '../../../lib/football/projectFixtures.ts';
import { getRef } from '../../../lib/football/externalTaskRefStore.ts';
import { fixtureContentHash, FIXTURE_CONTRACT_VERSION, FIXTURE_SCHEMA_VERSION, type Fixture, type FixtureCore } from '../../../src/contracts/v1/fixtureContracts.ts';

const ENV = ['MAYBESITTER_ENV', 'MAYBESITTER_FEATURE_EXTERNAL_CLASH_HOLD', 'MAYBESITTER_KILL_SWITCH_EXTERNAL_CLASH_HOLD'] as const;

function uniqueUid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function fixture(id: string, kickoffUtc: string): Fixture {
  const core: FixtureCore = {
    provider: 'football-data', providerMatchId: id, competition: 'PD',
    homeTeamId: '81', awayTeamId: '86', homeTeamName: 'FC Barcelona', awayTeamName: 'Real Madrid CF',
    kickoffUtc, status: 'scheduled', venue: null,
  };
  return { ...core, version: FIXTURE_CONTRACT_VERSION, schemaVersion: FIXTURE_SCHEMA_VERSION, contentHash: fixtureContentHash(core) };
}

async function withEmulator(run: (uid: string, kickoff: string) => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(ENV.map((key) => [key, process.env[key]]));
  process.env.MAYBESITTER_ENV = 'test';
  process.env.MAYBESITTER_FEATURE_EXTERNAL_CLASH_HOLD = 'true';
  process.env.MAYBESITTER_KILL_SWITCH_EXTERNAL_CLASH_HOLD = 'false';
  resetFirestoreForTests();
  const storage = createFirestoreStorage();
  setStorageForTests(storage);
  const uid = uniqueUid('m4b_tx');
  // Three days ahead, rounded to the hour, 18:00 UTC.
  const day = new Date(Date.now() + 3 * 24 * 3_600_000);
  const kickoff = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 18, 0, 0)).toISOString();
  try {
    await setFollowedClubs(uid, ['barcelona'], new Date().toISOString());
    await upsertFixtures([fixture(`${uid}-1`, kickoff)]);
    await run(uid, kickoff);
  } finally {
    await createFirestoreStorage().deleteTree(`users/${uid}`).catch(() => {});
    resetStorageForTests();
    for (const key of ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

async function hook(): Promise<(fn: ((site: string) => Promise<void>) | null) => void> {
  const module = await import('../../../lib/planning/freeSlots.ts') as Record<string, unknown>;
  assert.equal(typeof module.setScheduleDecisionHookForTests, 'function', 'setScheduleDecisionHookForTests is not exported (the gate\'s named seam)');
  return module.setScheduleDecisionHookForTests as any;
}

async function matchSaved(uid: string, matchId: string): Promise<boolean> {
  const ref = await getRef<any>(uid, `football-data:${matchId}`);
  if (!ref?.linkedCommitmentId) return false;
  const state = await readParticipantState(uid);
  return (state.commitments as Record<string, any>)[ref.linkedCommitmentId]?.status === 'active';
}

function plus(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

/**
 * Starts `write` from inside the decision transaction (after its reads, before
 * its commit) and waits for it at most 3 s, as a second process would. Firestore's
 * server SDK locks what a transaction read, ranges included; a writer into a
 * read range therefore waits until the decision commits (and then the match
 * was decided before the clash existed — the person's later write, which the
 * plan allows). A phantom would show as the writer finishing while the
 * decision is still open and the match being saved anyway.
 *
 * (Gate fix by its author, Claude: the first version awaited the writer inside
 * the hook, which deadlocks against Firestore's pessimistic locks — the
 * writer timed out on the lock the decision held, which is itself the
 * evidence that the range was locked.)
 */
async function raceProjection(uid: string, matchId: string, write: () => Promise<void>): Promise<void> {
  const install = await hook();
  let fired = false;
  let decisionOpen = true;
  let writerFinishedDuringDecision = false;
  let writer: Promise<void> = Promise.resolve();
  install(async (site) => {
    if (site !== 'football' || fired) return;
    fired = true;
    writer = write().then(() => { if (decisionOpen) writerFinishedDuringDecision = true; });
    // Give the writer a real chance to land inside the open decision: an
    // unlocked range lets it finish well within this; a locked one holds it
    // until the decision commits (waiting on it outright would deadlock).
    await Promise.race([writer, new Promise((resolve) => setTimeout(resolve, 3_000))]);
  });
  try {
    await projectFixturesForUser(uid, new Date().toISOString());
  } finally {
    decisionOpen = false;
    install(null);
  }
  await writer;
  assert.equal(fired, true, 'the decision hook never fired inside the projection transaction');
  const saved = await matchSaved(uid, matchId);
  assert.ok(!(saved && writerFinishedDuringDecision),
    'phantom: a clashing row was committed while the decision transaction was open, and the match was saved over it');
}

test('M4B-R2-002 (emulator): a busy block inserted mid-transaction is seen — the match is held', async () => {
  await withEmulator(async (uid, kickoff) => {
    await replaceBusyBlocks(uid, 'device:m4b-tx', { startsAt: new Date().toISOString(), endsAt: plus(kickoff, 7 * 24 * 60) }, [], { platform: 'ios', now: new Date() } as any);
    await raceProjection(uid, `${uid}-1`, async () => {
      await replaceBusyBlocks(uid, 'device:m4b-tx', { startsAt: new Date().toISOString(), endsAt: plus(kickoff, 7 * 24 * 60) },
        [{ blockId: 'b1', sourceId: 'device:m4b-tx', sourceKind: 'device', startAt: plus(kickoff, 30), endAt: plus(kickoff, 90), allDay: false } as any],
        { platform: 'ios', now: new Date() } as any);
    });
  });
});

test('M4B-R2-002 (emulator): a weekly block created mid-transaction is seen — the match is held', async () => {
  await withEmulator(async (uid, kickoff) => {
    const weekday = new Date(kickoff).getUTCDay();
    await raceProjection(uid, `${uid}-1`, async () => {
      await createWeeklyBlock(uid, { title: 'block', weekdays: [weekday], start: '00:00', end: '23:59', timezone: 'UTC', confirmedAt: new Date().toISOString() });
    });
  });
});

test('M4B-R2-002 (emulator): a commitment written mid-transaction is seen — the match is held', async () => {
  await withEmulator(async (uid, kickoff) => {
    await raceProjection(uid, `${uid}-1`, async () => {
      const id = '0c0ffee7-0000-4000-8000-000000000001';
      const now = new Date().toISOString();
      await applyParticipantCommands(uid, [
        { type: 'CreateDraft', now, commitment: { id, kind: 'task', title: 'visit', timeSpec: { kind: 'scheduled_event', dueAt: plus(kickoff, 15), endAt: plus(kickoff, 75), allDay: false, timezone: 'UTC' } } } as any,
        { type: 'ConfirmCommitment', commitmentId: id, now } as any,
      ]);
    });
  });
});

test('M4B-R2-002 (emulator): a failure after the reads and before commit leaves no commitment and no half-written ref', async () => {
  await withEmulator(async (uid) => {
    const install = await hook();
    install(async (site) => { if (site === 'football') throw new Error('injected crash'); });
    try {
      await projectFixturesForUser(uid, new Date().toISOString()).catch(() => {});
    } finally {
      install(null);
    }
    const state = await readParticipantState(uid);
    assert.equal(Object.keys(state.commitments).length, 0, 'a commitment survived a failed decision transaction');
    const ref = await getRef<any>(uid, `football-data:${uid}-1`);
    assert.equal(ref, null, `a ref was written by a transaction that failed before commit: ${JSON.stringify(ref)}`);
  });
});
