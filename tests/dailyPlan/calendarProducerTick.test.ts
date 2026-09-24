/**
 * A real calendar sync reaches the replan tick, with no row written by hand (#611).
 *
 * Every earlier tick test stored its `PlanningStateChange` row itself, because
 * nothing in production wrote one: a meeting landing on a scheduled task never
 * replanned anything. Here the only writer is the phone's busy route, the same
 * handler production runs, and the only reader is `runContinuousReplanTick`.
 *
 * Under the council's default (`always_require_confirmation`, #611 guards) the
 * outcome is an **offer**, never a new generation: the plan in force stays as
 * it is until the person accepts. The plan GET shows the offer, and when the
 * meeting goes away again the next sync announces that too and the tick
 * withdraws the offer (#636's withdrawal on facts), without recording a
 * rejection the person never made.
 *
 * The fixture is #604's: three half-hour tasks at 06:00, 06:30 and 07:00 UTC
 * (09:00–10:30 in Jerusalem), and a meeting that moves onto the first.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage, type MemoryStorageAdapter } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import { PLANNING_STATE_CHANGES, userCol, userDoc } from '../../lib/storage/paths.ts';
import { persistParticipantState } from '../../lib/services/mobile/participantState.ts';
import { applyCommand as applyDomainCommand, createEmptyDomainState } from '../../src/domain/stateMachine.ts';
import { buildAndStoreDailyPlan, claimDueDelivery, savePlanSettings } from '../../lib/services/dailyPlan/dailyPlanService.ts';
import { readStoredPlan, type StoredDailyPlan } from '../../lib/services/dailyPlan/planStore.ts';
import { runContinuousReplanTick } from '../../lib/services/dailyPlan/continuousReplanService.ts';
import { applyTrustAction } from '../../lib/pilot/pilotTrustStore.ts';
import { busyBlockId } from '../../lib/calendar/busyBlocks.ts';
import { intervalsOverlap } from '../../lib/planning/shared/time.ts';
import { installFakeAuth, tokenFor, uidFor } from '../support/fakeAuth.ts';
import { POST as busyPost } from '../../src/app/api/mobile/calendar/busy/route.ts';
import { GET as planGet } from '../../src/app/api/mobile/plans/[date]/route.ts';
import type { PlanningStateChange } from '../../src/contracts/v1/watcherContracts.ts';
import type { TimeInterval } from '../../src/contracts/v1/planningContracts.ts';

const BASE = 'http://127.0.0.1:4321';
const TZ = 'Asia/Jerusalem';
const DATE = '2026-09-15';
/** 09:00 in Jerusalem: past the 07:30 delivery. */
const MORNING = Date.parse('2026-09-15T06:00:00.000Z');
const TASKS = ['cmt_a', 'cmt_b', 'cmt_c'] as const;
const SOURCE = 'device:0b7e4a52-3d61-4c8f-9a2e-5f1d6c7b8a90';
/** The native event the phone reads; its block id hashes it with its start. */
const STANDUP = 'evt-standup';
/** Inside the day, after every task: overlaps nothing placed. */
const EVENING: TimeInterval = { startsAt: `${DATE}T16:00:00.000Z`, endsAt: `${DATE}T16:30:00.000Z` };
/** The first task's slot. */
const ON_TASK: TimeInterval = { startsAt: `${DATE}T06:00:00.000Z`, endsAt: `${DATE}T06:30:00.000Z` };
const WINDOW = { windowStart: `${DATE}T00:00:00.000Z`, windowEnd: '2026-10-13T00:00:00.000Z' };

function minutesAfterMorning(minutes: number): Date {
  return new Date(MORNING + minutes * 60_000);
}

function seedState() {
  let state = createEmptyDomainState();
  for (const id of TASKS) {
    state = applyDomainCommand(state, {
      type: 'CreateDraft',
      now: '2026-09-14T06:00:00.000Z',
      commitment: { id, kind: 'task', title: id, timeSpec: { kind: 'due_by', dueAt: null, remindAt: null, timezone: TZ } },
      draftStatus: 'pending_confirmation',
    }).newState;
    state = applyDomainCommand(state, {
      type: 'ConfirmCommitment', commitmentId: id, now: '2026-09-14T06:00:00.000Z', reminders: [],
    }).newState;
  }
  return state;
}

/** The morning plan, built by the real morning build, and calendar consent on. */
async function seedAccount(storage: StorageAdapter, uid: string): Promise<StoredDailyPlan> {
  await persistParticipantState(uid, seedState());
  const user = await storage.get<Record<string, unknown>>(userDoc(uid));
  await storage.set(userDoc(uid), { ...(user ?? {}), timezone: TZ, locale: 'en' });
  await savePlanSettings(uid, { enabled: true, deliveryLocalTime: '07:30' }, new Date('2026-09-14T12:00:00.000Z'), { storage });
  const claim = await claimDueDelivery(uid, new Date(MORNING), { storage });
  assert.ok(claim, 'fixture: the account must be due for a plan');
  await buildAndStoreDailyPlan(claim, { storage, now: () => new Date(MORNING) });
  await applyTrustAction(uid, { type: 'record_first_value', at: '2026-09-14T06:00:00.000Z' });
  await applyTrustAction(uid, { type: 'set_calendar_consent', granted: true, at: '2026-09-14T06:00:00.000Z' });
  const stored = await readStoredPlan(uid, DATE, storage);
  assert.ok(stored, 'fixture: the morning build stored no plan');
  const first = stored.plan.scheduled.find((item) => item.itemId === 'cmt_a');
  assert.ok(first && intervalsOverlap(first.reservedInterval, ON_TASK), `fixture: cmt_a must sit at 06:00, got ${JSON.stringify(first)}`);
  return stored;
}

interface World {
  readonly storage: MemoryStorageAdapter;
  readonly uid: string;
  /** Moves the wall clock the routes read. */
  setClock(at: Date): void;
}

async function withWorld(name: string, fn: (world: World) => Promise<void>): Promise<void> {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  const auth = installFakeAuth();
  // The routes read the wall clock, and an offer expires with its day (#611
  // guards): pinned inside the plan's own day.
  mock.timers.enable({ apis: ['Date'], now: MORNING });
  try {
    await fn({ storage, uid: uidFor(name), setClock: (at) => mock.timers.setTime(at.getTime()) });
  } finally {
    mock.timers.reset();
    auth.restore();
    resetStorageForTests();
  }
}

/** The phone's sync, through the production route: the standup at `at`, or no standup at all. */
async function phoneSync(uid: string, at: TimeInterval | null): Promise<string | null> {
  const blockId = at === null ? null : busyBlockId(SOURCE, STANDUP, at.startsAt);
  const response = await busyPost(new Request(`${BASE}/api/mobile/calendar/busy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', authorization: `Bearer ${tokenFor(uid)}` },
    body: JSON.stringify({
      sourceId: SOURCE,
      platform: 'ios',
      ...WINDOW,
      blocks: at === null ? [] : [{ blockId, startAt: at.startsAt, endAt: at.endsAt, allDay: false }],
    }),
  }));
  assert.equal(response.status, 200, await response.clone().text());
  return blockId;
}

async function pendingRows(storage: StorageAdapter, uid: string): Promise<PlanningStateChange[]> {
  return (await storage.list<PlanningStateChange>(userCol(uid, PLANNING_STATE_CHANGES))).map((row) => row.data);
}

async function planResponse(uid: string): Promise<{ proposal: { proposalId: string; causeChangeIds: string[] } | null }> {
  const response = await planGet(
    new Request(`${BASE}/api/mobile/plans/${DATE}`, { headers: { authorization: `Bearer ${tokenFor(uid)}` } }),
    { params: Promise.resolve({ date: DATE }) },
  );
  assert.equal(response.status, 200);
  return response.json();
}

test('a phone sync that moves a meeting onto a scheduled task becomes a stored offer at the next tick; removing it withdraws the offer', async () => {
  await withWorld('ProducerTickUser', async ({ storage, uid, setClock }) => {
    const before = await seedAccount(storage, uid);

    // The standup, somewhere harmless. It is announced, and the tick finds
    // nothing it contradicts.
    const evening = await phoneSync(uid, EVENING);
    assert.deepEqual((await pendingRows(storage, uid)).map((row) => row.entityId), [evening]);
    setClock(minutesAfterMorning(1));
    const quiet = await runContinuousReplanTick({ storage, now: minutesAfterMorning(1) });
    assert.equal(quiet.replanRequired, 0, JSON.stringify(quiet));
    assert.equal((await readStoredPlan(uid, DATE, storage))!.proposal ?? null, null);
    assert.deepEqual(await pendingRows(storage, uid), [], 'the tick drained what it judged');

    // An identical re-sync: nothing moved, nothing announced.
    await phoneSync(uid, EVENING);
    assert.deepEqual(await pendingRows(storage, uid), []);

    // The standup moves onto the first task. Its id hashes its start, so the
    // sync announces two changes: the evening id, now free, and the new one.
    setClock(minutesAfterMorning(5));
    const onTask = await phoneSync(uid, ON_TASK);
    const moved = await pendingRows(storage, uid);
    assert.deepEqual(moved.map((row) => row.entityId).sort(), [evening, onTask].sort());
    assert.ok(moved.every((row) => row.source === 'calendar'), 'rows the tick resolves per change (#605)');
    const arrival = moved.find((row) => row.entityId === onTask)!;

    setClock(minutesAfterMorning(6));
    const totals = await runContinuousReplanTick({ storage, now: minutesAfterMorning(6) });
    assert.equal(totals.replanRequired, 1, `the meeting on the task must reach the planner: ${JSON.stringify(totals)}`);
    assert.equal(totals.proposed, 1, JSON.stringify(totals));
    assert.equal(totals.autoApplied, 0, 'the default asks first: never a new generation');

    const offered = (await readStoredPlan(uid, DATE, storage))!;
    assert.equal(offered.generation, before.generation, 'the plan in force is untouched until the person accepts');
    assert.ok(offered.proposal, 'the offer must be stored');
    assert.equal(offered.proposal.userControlMode, 'always_require_confirmation');
    assert.deepEqual(offered.proposal.causeChangeIds, [arrival.changeId], 'the arrival is the cause; the freed evening slot is not');
    assert.deepEqual(offered.proposal.causeRefs, [{ changeId: arrival.changeId, source: 'calendar', entityId: onTask }]);
    const task = offered.proposal.plan.scheduled.find((item) => item.itemId === 'cmt_a');
    assert.ok(task, 'the offer still places the task');
    assert.ok(!intervalsOverlap(task.reservedInterval, ON_TASK), `the offer moves the task off the meeting: ${JSON.stringify(task)}`);
    assert.deepEqual(await pendingRows(storage, uid), []);

    const shown = await planResponse(uid);
    assert.equal(shown.proposal?.proposalId, offered.proposal.proposalId, 'the plan GET shows the offer');
    assert.deepEqual(shown.proposal?.causeChangeIds, [arrival.changeId]);

    // The standup is cancelled. The sync announces the freed time, and the
    // tick withdraws the offer: nothing on the day collides any more.
    setClock(minutesAfterMorning(10));
    await phoneSync(uid, null);
    assert.deepEqual((await pendingRows(storage, uid)).map((row) => row.entityId), [onTask]);
    setClock(minutesAfterMorning(11));
    const after = await runContinuousReplanTick({ storage, now: minutesAfterMorning(11) });
    assert.equal(after.withdrawn, 1, JSON.stringify(after));

    const withdrawn = (await readStoredPlan(uid, DATE, storage))!;
    assert.equal(withdrawn.proposal ?? null, null);
    assert.equal(withdrawn.generation, before.generation);
    assert.deepEqual(withdrawn.rejectedProposals ?? [], [], 'a withdrawal is not the person declining anything');
    assert.equal((await planResponse(uid)).proposal, null);
  });
});

/**
 * A storage that runs `between` after every write it passes on: the instants
 * at which a concurrent Cloud Run instance's tick could read a sync in flight.
 */
function tickingBetweenWrites(raw: MemoryStorageAdapter, between: () => Promise<void>): StorageAdapter {
  let inside = false;
  const after = async () => {
    if (inside) return;
    inside = true;
    try {
      await between();
    } finally {
      inside = false;
    }
  };
  return {
    get: (path) => raw.get(path),
    list: (path, options) => raw.list(path, options),
    listGroup: (id, options) => raw.listGroup(id, options),
    deleteTree: (path) => raw.deleteTree(path),
    async set(path, value) { await raw.set(path, value); await after(); },
    async delete(path) { await raw.delete(path); await after(); },
    async runTransaction(fn) { const result = await raw.runTransaction(fn); await after(); return result; },
  };
}

/*
 * The mid-sync case. A tick runs after every write the sync makes. A row the
 * tick could see before its block was written would resolve as a deleted
 * meeting, be judged `PLAN_STALE`, and be drained; the block would then land
 * with no row left to announce it, and the day would keep a task under a
 * meeting until tomorrow's build. Each block commits with its own row, so
 * that instant does not exist.
 */
test('a tick that runs in the middle of the sync never loses the meeting', async () => {
  await withWorld('ProducerMidSyncUser', async ({ storage, uid, setClock }) => {
    await seedAccount(storage, uid);
    await phoneSync(uid, EVENING);
    await runContinuousReplanTick({ storage, now: minutesAfterMorning(1) });
    assert.deepEqual(await pendingRows(storage, uid), []);

    setClock(minutesAfterMorning(5));
    const interleaved: string[] = [];
    setStorageForTests(tickingBetweenWrites(storage, async () => {
      const totals = await runContinuousReplanTick({ storage, now: minutesAfterMorning(5) });
      interleaved.push(JSON.stringify(totals));
    }));
    const onTask = await phoneSync(uid, ON_TASK);
    setStorageForTests(storage);
    assert.ok(interleaved.length >= 1, 'the sync must have had an instant for a tick to run in');

    setClock(minutesAfterMorning(6));
    await runContinuousReplanTick({ storage, now: minutesAfterMorning(6) });

    const stored = (await readStoredPlan(uid, DATE, storage))!;
    assert.ok(stored.proposal, `the meeting must have been offered for, by some tick. Interleaved: ${interleaved.join(' | ')}`);
    assert.ok(stored.proposal.causeRefs?.some((ref) => ref.entityId === onTask), 'and the offer names it');
    const task = stored.proposal.plan.scheduled.find((item) => item.itemId === 'cmt_a');
    assert.ok(task && !intervalsOverlap(task.reservedInterval, ON_TASK));
    assert.deepEqual(await pendingRows(storage, uid), []);
  });
});
