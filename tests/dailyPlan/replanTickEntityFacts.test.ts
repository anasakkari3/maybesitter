/**
 * The scheduled replan tick can replan (#605).
 *
 * `runContinuousReplanTick` handed the pipeline its change rows and no
 * post-change facts, so no change could ever earn `REPLAN_REQUIRED`. Rule 6 of
 * the impact evaluator needs an interval and a blocking flag, and with no facts
 * every change fell to rule 7's `PLAN_STALE`. `replanOnStale` defaults to
 * false, so the pipeline stopped before the planner and the rows were drained.
 * Every earlier test of auto-apply or review called `processStateChangesForUser`
 * directly and supplied the facts by hand.
 *
 * Every case here drives the tick itself: a real morning build, a real busy
 * block written through `replaceBusyBlocks`, and a real change row in
 * `planningStateChanges`. Nothing is passed to the service by hand. The fixture
 * is #604's: three half-hour tasks at 06:00, 06:30 and 07:00 UTC, with a
 * meeting landing on the first.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage, type MemoryStorageAdapter } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import { PLANNING_STATE_CHANGES, docIdForKey, userCol, userDoc, userSubDoc } from '../../lib/storage/paths.ts';
import { persistParticipantState } from '../../lib/services/mobile/participantState.ts';
import { applyCommand as applyDomainCommand, createEmptyDomainState } from '../../src/domain/stateMachine.ts';
import {
  buildAndStoreDailyPlan,
  claimDueDelivery,
  savePlanSettings,
} from '../../lib/services/dailyPlan/dailyPlanService.ts';
import { planPath, readStoredPlan, type StoredDailyPlan } from '../../lib/services/dailyPlan/planStore.ts';
import {
  acceptPlan,
  acceptPlanProposal,
  dismissPlan,
  editPlan,
  effectiveSchedule,
  setBlockProtection,
} from '../../lib/services/dailyPlan/planActions.ts';
import { intervalsOverlap } from '../../lib/planning/shared/time.ts';
import { runContinuousReplanTick } from '../../lib/services/dailyPlan/continuousReplanService.ts';
import { factsOfBusyBlock, resolveChangedEntityFacts } from '../../lib/services/dailyPlan/changedEntityFacts.ts';
import { replaceBusyBlocks } from '../../lib/calendar/busyBlocks.ts';
import { ownershipOf, scheduleBlockId } from '../../src/contracts/v1/scheduleBlockContracts.ts';
import type { PlanningStateChange } from '../../src/contracts/v1/watcherContracts.ts';
import type { Plan, PlannedItem, TimeInterval } from '../../src/contracts/v1/planningContracts.ts';

const TZ = 'Asia/Jerusalem';
const DATE = '2026-09-15';
/** 09:00 in Jerusalem: past the 07:30 delivery, and the moment the tick runs. */
const MORNING = new Date('2026-09-15T06:00:00.000Z');
const TASKS = ['cmt_a', 'cmt_b', 'cmt_c'] as const;
const PROTECTED = 'cmt_b';
const PROTECTED_BLOCK = scheduleBlockId({ kind: 'commitment', id: PROTECTED });
const CALENDAR = 'device:calendar-1';
/** The first task's slot, taken by a meeting after the plan was built. */
const MEETING: TimeInterval = { startsAt: `${DATE}T06:00:00.000Z`, endsAt: `${DATE}T06:30:00.000Z` };
/** Inside today's horizon, after every scheduled task: overlaps nothing placed. */
const EVENING: TimeInterval = { startsAt: `${DATE}T16:00:00.000Z`, endsAt: `${DATE}T17:00:00.000Z` };
/** Tomorrow: outside the plan's horizon entirely. */
const TOMORROW: TimeInterval = { startsAt: '2026-09-16T06:00:00.000Z', endsAt: '2026-09-16T06:30:00.000Z' };

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

async function withStorage(fn: (storage: StorageAdapter) => Promise<void>): Promise<void> {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  try {
    await fn(storage);
  } finally {
    resetStorageForTests();
  }
}

/** One account with the morning's plan built and stored, through the real morning build. */
async function seedAccount(
  storage: StorageAdapter,
  uid: string,
  planSettings: Record<string, unknown> = {},
): Promise<StoredDailyPlan> {
  await persistParticipantState(uid, seedState());
  const user = await storage.get<Record<string, unknown>>(userDoc(uid));
  await storage.set(userDoc(uid), { ...(user ?? {}), timezone: TZ, locale: 'en' });
  await savePlanSettings(uid, { enabled: true, deliveryLocalTime: '07:30' }, new Date('2026-09-14T12:00:00.000Z'), { storage });
  const claim = await claimDueDelivery(uid, MORNING, { storage });
  assert.ok(claim, 'fixture: the account must be due for a plan');
  await buildAndStoreDailyPlan(claim, { storage, now: () => MORNING });
  if (Object.keys(planSettings).length > 0) {
    const doc = await storage.get<Record<string, unknown>>(userDoc(uid));
    await storage.set(userDoc(uid), { ...doc, planSettings: { ...(doc?.planSettings as object), ...planSettings } });
  }
  const stored = await readStoredPlan(uid, DATE, storage);
  assert.ok(stored, 'fixture: the morning build stored no plan');
  return stored;
}

interface BlockSpec {
  readonly blockId: string;
  readonly interval: TimeInterval;
  readonly allDay?: boolean;
}

/** What a calendar sync writes: the source's current blocks, replaced as a set. */
async function syncCalendar(storage: StorageAdapter, uid: string, blocks: readonly BlockSpec[]): Promise<void> {
  await replaceBusyBlocks(
    uid,
    CALENDAR,
    { startsAt: `${DATE}T00:00:00.000Z`, endsAt: '2026-09-17T00:00:00.000Z' },
    blocks.map((block) => ({
      blockId: block.blockId,
      sourceId: CALENDAR,
      sourceKind: 'device' as const,
      startAt: block.interval.startsAt,
      endAt: block.interval.endsAt,
      allDay: block.allDay ?? false,
    })),
    { storage },
  );
}

function calendarChange(uid: string, changeId: string, entityId: string, changedFields = ['interval', 'blocking']): PlanningStateChange {
  return {
    schemaVersion: 'planning-state-change-v1',
    changeId,
    scopeId: uid,
    source: 'calendar',
    entityId,
    occurredAt: MORNING.toISOString(),
    changedFields,
    beforeDigest: null,
    afterDigest: `digest-${entityId}`,
    provenanceRef: 'calendar:refresh-1',
  };
}

/** The change row, stored where a producer stores it and where the tick drains it from. */
async function storeChange(storage: StorageAdapter, uid: string, change: PlanningStateChange): Promise<void> {
  await storage.set(userSubDoc(uid, PLANNING_STATE_CHANGES, docIdForKey(change.changeId)), change);
}

async function pendingChanges(storage: StorageAdapter, uid: string): Promise<number> {
  return (await storage.list(userCol(uid, PLANNING_STATE_CHANGES))).length;
}

function placementOf(plan: Plan, itemId: string): TimeInterval | null {
  return plan.scheduled.find((entry) => entry.itemId === itemId)?.interval ?? null;
}

/** The plan the tick produced: the new generation when applied, the patch when proposed. */
function outcomePlan(stored: StoredDailyPlan): Plan | null {
  if (stored.proposal) return stored.proposal.plan;
  return stored.generation > 1 ? stored.plan : null;
}

const ZERO = { examined: 0, replanRequired: 0, autoApplied: 0, proposed: 0, stale: 0, noEffect: 0, failed: 0, skipped: 0 };

/* ── The headline: a meeting on a scheduled task earns a replan ───── */

test('the tick replans a stored change whose busy block overlaps a scheduled task, and persists the outcome', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_tick_overlap';
    const before = await seedAccount(storage, uid);
    await syncCalendar(storage, uid, [{ blockId: 'busy-meeting', interval: MEETING }]);
    await storeChange(storage, uid, calendarChange(uid, 'chg-meeting', 'busy-meeting'));

    const totals = await runContinuousReplanTick({ storage, now: MORNING });

    assert.equal(totals.examined, 1);
    assert.equal(totals.replanRequired, 1, `the tick must reach the planner: ${JSON.stringify(totals)}`);
    assert.equal(totals.stale, 0);
    assert.equal(totals.failed, 0);
    assert.equal(totals.autoApplied + totals.proposed, 1, 'the policy must have acted on the replan');

    const after = await readStoredPlan(uid, DATE, storage);
    assert.ok(after);
    // The default policy (automatic_time_only, 60-minute budget) decides between
    // applying and proposing; whichever it chose must be what was stored.
    if (totals.autoApplied === 1) {
      assert.equal(after.generation, before.generation + 1);
      assert.deepEqual(after.causeChangeIds, ['chg-meeting']);
    } else {
      assert.equal(after.generation, before.generation, 'a proposal never replaces the generation');
      assert.ok(after.proposal, 'the proposed patch must be stored');
      assert.deepEqual(after.proposal.causeChangeIds, ['chg-meeting']);
    }
    const replanned = outcomePlan(after)!;
    const first = placementOf(replanned, 'cmt_a');
    assert.ok(first, 'the replan must still place the task');
    assert.ok(
      Date.parse(first.endsAt) <= Date.parse(MEETING.startsAt) || Date.parse(first.startsAt) >= Date.parse(MEETING.endsAt),
      `the replan must move the task off the meeting, got ${JSON.stringify(first)}`,
    );

    assert.equal(await pendingChanges(storage, uid), 0, 'the processed change is drained');
  });
});

/* ── Protected time survives the real tick (#585 through #604's seams) ── */

test('a protected block stays where it sits through the tick\'s replan', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_tick_protected';
    await seedAccount(storage, uid);
    const protectedAt = placementOf((await readStoredPlan(uid, DATE, storage))!.plan, PROTECTED);
    assert.ok(protectedAt, 'fixture: the protected task must be scheduled');
    const outcome = await setBlockProtection(uid, DATE, {
      blockId: PROTECTED_BLOCK,
      ownership: 'protected_flexible',
      origin: 'user',
      maxShiftMinutes: null,
      preferredInterval: null,
    }, { storage, now: () => MORNING });
    assert.ok(outcome, 'fixture: the protection was not recorded');

    await syncCalendar(storage, uid, [{ blockId: 'busy-meeting', interval: MEETING }]);
    await storeChange(storage, uid, calendarChange(uid, 'chg-meeting', 'busy-meeting'));

    const totals = await runContinuousReplanTick({ storage, now: MORNING });
    assert.equal(totals.replanRequired, 1, JSON.stringify(totals));

    const after = await readStoredPlan(uid, DATE, storage);
    const replanned = outcomePlan(after!);
    assert.ok(replanned, 'the tick must have produced a generation or a proposal');
    assert.deepEqual(placementOf(replanned, PROTECTED), protectedAt, 'the protected task must not move');
    if (after!.generation > 1) {
      const block = after!.blocks?.find((entry) => entry.blockId === PROTECTED_BLOCK);
      assert.equal(block && ownershipOf(block), 'protected_flexible', 'the new generation must keep the protection');
    }
  });
});

/* ── What must NOT replan ─────────────────────────────────────────── */

test('a metadata-only calendar change is NO_EFFECT and is drained', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_tick_metadata';
    const before = await seedAccount(storage, uid);
    await syncCalendar(storage, uid, [{ blockId: 'busy-meeting', interval: MEETING }]);
    await storeChange(storage, uid, calendarChange(uid, 'chg-title', 'busy-meeting', ['title', 'description']));

    const totals = await runContinuousReplanTick({ storage, now: MORNING });
    assert.deepEqual(totals, { ...ZERO, examined: 1, noEffect: 1 });
    const after = await readStoredPlan(uid, DATE, storage);
    assert.equal(after!.generation, before.generation);
    assert.equal(after!.proposal ?? null, null);
    assert.equal(await pendingChanges(storage, uid), 0);
  });
});

test('a busy block outside the plan\'s horizon is NO_EFFECT', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_tick_tomorrow';
    await seedAccount(storage, uid);
    await syncCalendar(storage, uid, [{ blockId: 'busy-tomorrow', interval: TOMORROW }]);
    await storeChange(storage, uid, calendarChange(uid, 'chg-tomorrow', 'busy-tomorrow'));

    const totals = await runContinuousReplanTick({ storage, now: MORNING });
    assert.deepEqual(totals, { ...ZERO, examined: 1, noEffect: 1 });
    assert.equal(await pendingChanges(storage, uid), 0);
  });
});

test('a change whose busy block is gone (deleted, or never synced) never earns a replan', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_tick_missing';
    const before = await seedAccount(storage, uid);
    // No block with this id exists: the meeting was deleted before the tick ran.
    await syncCalendar(storage, uid, []);
    await storeChange(storage, uid, calendarChange(uid, 'chg-gone', 'busy-meeting'));

    const totals = await runContinuousReplanTick({ storage, now: MORNING });
    assert.equal(totals.replanRequired, 0);
    assert.equal(totals.stale, 1, 'a freed slot is a planner input that moved, not a contradiction');
    const after = await readStoredPlan(uid, DATE, storage);
    assert.equal(after!.generation, before.generation);
    assert.equal(after!.proposal ?? null, null);
    assert.equal(await pendingChanges(storage, uid), 0);
  });
});

test('an all-day entry on the same day does not earn a replan, because the planner does not treat it as busy', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_tick_all_day';
    await seedAccount(storage, uid);
    await syncCalendar(storage, uid, [{
      blockId: 'busy-holiday',
      interval: { startsAt: `${DATE}T00:00:00.000Z`, endsAt: '2026-09-16T00:00:00.000Z' },
      allDay: true,
    }]);
    await storeChange(storage, uid, calendarChange(uid, 'chg-holiday', 'busy-holiday'));

    const totals = await runContinuousReplanTick({ storage, now: MORNING });
    assert.equal(totals.replanRequired, 0, JSON.stringify(totals));
  });
});

/* ── One tick, several changes: each is judged on its own entity ───── */

test('two changes in one tick are judged on their own blocks, and only the overlapping one is named as the cause', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_tick_batch';
    await seedAccount(storage, uid);
    await syncCalendar(storage, uid, [
      { blockId: 'busy-meeting', interval: MEETING },
      { blockId: 'busy-evening', interval: EVENING },
    ]);
    await storeChange(storage, uid, calendarChange(uid, 'chg-meeting', 'busy-meeting'));
    await storeChange(storage, uid, calendarChange(uid, 'chg-evening', 'busy-evening'));

    const totals = await runContinuousReplanTick({ storage, now: MORNING });
    assert.equal(totals.replanRequired, 1, JSON.stringify(totals));

    const after = await readStoredPlan(uid, DATE, storage);
    const causes = after!.proposal ? after!.proposal.causeChangeIds : after!.causeChangeIds;
    assert.deepEqual(causes, ['chg-meeting'], 'the evening block overlaps nothing and must not be blamed');
    assert.equal(await pendingChanges(storage, uid), 0, 'both changes are drained');
  });
});

test('a monitor firing that shares a tick with a real overlap is not blamed for the replan (#527)', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_tick_watcher';
    await seedAccount(storage, uid);
    await syncCalendar(storage, uid, [{ blockId: 'busy-meeting', interval: MEETING }]);
    await storeChange(storage, uid, calendarChange(uid, 'chg-meeting', 'busy-meeting'));
    await storeChange(storage, uid, {
      schemaVersion: 'planning-state-change-v1',
      changeId: 'watcher:fire-1',
      scopeId: uid,
      source: 'watcher',
      entityId: 'wat_flight',
      occurredAt: MORNING.toISOString(),
      changedFields: ['digest'],
      beforeDigest: 'd-0',
      afterDigest: 'd-1',
      provenanceRef: 'aviationstack:flight-1',
    });

    const totals = await runContinuousReplanTick({ storage, now: MORNING });
    assert.equal(totals.replanRequired, 1, JSON.stringify(totals));
    const after = await readStoredPlan(uid, DATE, storage);
    const causes = after!.proposal ? after!.proposal.causeChangeIds : after!.causeChangeIds;
    assert.deepEqual(causes, ['chg-meeting']);
  });
});

/* ── Accounts, the switch, repetition, failure ───────────────────── */

test('facts are resolved in the tick\'s own account: another account\'s identical block id does not replan this one', async () => {
  await withStorage(async (storage) => {
    const mine = 'user_tick_mine';
    const theirs = 'user_tick_theirs';
    const minePlan = await seedAccount(storage, mine);
    await seedAccount(storage, theirs);
    // Only the other account holds a block with this id.
    await syncCalendar(storage, theirs, [{ blockId: 'busy-meeting', interval: MEETING }]);
    await storeChange(storage, mine, calendarChange(mine, 'chg-meeting', 'busy-meeting'));

    const totals = await runContinuousReplanTick({ storage, now: MORNING });
    assert.equal(totals.replanRequired, 0, JSON.stringify(totals));
    const after = await readStoredPlan(mine, DATE, storage);
    assert.equal(after!.generation, minePlan.generation);
    assert.equal(after!.proposal ?? null, null);
  });
});

test('a change row naming another account\'s scope is not replanned here', async () => {
  await withStorage(async (storage) => {
    const mine = 'user_tick_scope_mine';
    await seedAccount(storage, mine);
    await syncCalendar(storage, mine, [{ blockId: 'busy-meeting', interval: MEETING }]);
    await storeChange(storage, mine, calendarChange('user_somebody_else', 'chg-foreign', 'busy-meeting'));

    const totals = await runContinuousReplanTick({ storage, now: MORNING });
    assert.equal(totals.replanRequired, 0, JSON.stringify(totals));
  });
});

test('with continuous replanning switched off the tick drains the change and replans nothing', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_tick_off';
    const before = await seedAccount(storage, uid, { continuousReplanEnabled: false });
    await syncCalendar(storage, uid, [{ blockId: 'busy-meeting', interval: MEETING }]);
    await storeChange(storage, uid, calendarChange(uid, 'chg-meeting', 'busy-meeting'));

    const totals = await runContinuousReplanTick({ storage, now: MORNING });
    assert.deepEqual(totals, { ...ZERO, examined: 1, skipped: 1 });
    const after = await readStoredPlan(uid, DATE, storage);
    assert.equal(after!.generation, before.generation);
    assert.equal(after!.proposal ?? null, null);
    assert.equal(await pendingChanges(storage, uid), 0);
  });
});

test('a re-delivered change after an automatic replan does not apply twice', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_tick_repeat';
    await seedAccount(storage, uid);
    // A meeting on the last task: a 30-minute shift, inside the default churn
    // budget, so the default policy applies it without asking.
    const onLast: TimeInterval = { startsAt: `${DATE}T07:00:00.000Z`, endsAt: `${DATE}T07:30:00.000Z` };
    await syncCalendar(storage, uid, [{ blockId: 'busy-late', interval: onLast }]);
    const change = calendarChange(uid, 'chg-late', 'busy-late');
    await storeChange(storage, uid, change);

    const first = await runContinuousReplanTick({ storage, now: MORNING });
    assert.equal(first.autoApplied, 1, `fixture: the default policy must auto-apply here: ${JSON.stringify(first)}`);
    const once = await readStoredPlan(uid, DATE, storage);
    assert.equal(once!.generation, 2);

    // The same change, delivered again (a producer retry, a replayed sync).
    await storeChange(storage, uid, change);
    const second = await runContinuousReplanTick({ storage, now: new Date(MORNING.getTime() + 5 * 60_000) });
    assert.equal(second.replanRequired, 0, `the task already left the meeting: ${JSON.stringify(second)}`);
    assert.equal(second.autoApplied, 0);
    const twice = await readStoredPlan(uid, DATE, storage);
    assert.equal(twice!.generation, 2, 'the same change must not produce a second generation');
    assert.equal(await pendingChanges(storage, uid), 0);
  });
});

test('when the tick fails for an account, its change rows stay for the next tick to retry', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_tick_retry';
    await seedAccount(storage, uid);
    await syncCalendar(storage, uid, [{ blockId: 'busy-meeting', interval: MEETING }]);
    await storeChange(storage, uid, calendarChange(uid, 'chg-meeting', 'busy-meeting'));

    // A storage outage on the first busy-block read only, which is the fact
    // resolution itself. Every later read would succeed, so this pins that
    // resolution fails the run before anything is written or drained.
    let busyReads = 0;
    const failing: StorageAdapter = Object.create(storage);
    failing.list = async (path: string, options?: unknown) => {
      if (path.endsWith('/busyBlocks') && busyReads++ === 0) throw new Error('UNAVAILABLE');
      return storage.list(path, options as never);
    };
    const before = await readStoredPlan(uid, DATE, storage);
    const totals = await runContinuousReplanTick({ storage: failing, now: MORNING });
    assert.equal(totals.failed, 1, JSON.stringify(totals));
    assert.equal(busyReads, 1, 'the run must stop at the failed resolution');
    assert.equal(await pendingChanges(storage, uid), 1, 'a failed run must not drain what it did not process');
    const untouched = await readStoredPlan(uid, DATE, storage);
    assert.equal(untouched!.generation, before!.generation);
    assert.equal(untouched!.proposal ?? null, null, 'nothing is written before the facts are known');

    const retried = await runContinuousReplanTick({ storage, now: MORNING });
    assert.equal(retried.replanRequired, 1, JSON.stringify(retried));
    assert.equal(await pendingChanges(storage, uid), 0);
  });
});

/* ── The resolver itself: per change, own account, nothing raw ──────── */

test('the resolver hands the planner an interval and a boolean, and nothing from the calendar source', () => {
  const facts = factsOfBusyBlock({
    blockId: 'busy-meeting',
    sourceId: CALENDAR,
    sourceKind: 'device',
    startAt: MEETING.startsAt,
    endAt: MEETING.endsAt,
    allDay: false,
  });
  assert.deepEqual(facts, { interval: MEETING, blocking: true });
  assert.deepEqual(Object.keys(facts).sort(), ['blocking', 'interval']);
  assert.ok(!JSON.stringify(facts).includes('device'), 'no source id or kind may reach the planning contracts');

  assert.deepEqual(factsOfBusyBlock(null), { interval: null, blocking: false }, 'a vanished block occupies no time');
  const allDay = factsOfBusyBlock({
    blockId: 'busy-holiday', sourceId: CALENDAR, sourceKind: 'device',
    startAt: `${DATE}T00:00:00.000Z`, endAt: '2026-09-16T00:00:00.000Z', allDay: true,
  });
  assert.equal(allDay.blocking, false, 'all-day is not busy to the planner, so it is not blocking here');
});

test('the resolver judges every change on its own entity, reads only its own account, and resolves non-calendar sources to null', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_resolver';
    await syncCalendar(storage, uid, [
      { blockId: 'busy-meeting', interval: MEETING },
      { blockId: 'busy-evening', interval: EVENING },
    ]);
    const read: string[] = [];
    const spying: StorageAdapter = Object.create(storage);
    spying.list = async (path: string, options?: unknown) => {
      read.push(path);
      return storage.list(path, options as never);
    };
    const watcher: PlanningStateChange = { ...calendarChange(uid, 'chg-watcher', 'wat_1', ['digest']), source: 'watcher' };
    const facts = await resolveChangedEntityFacts(uid, [
      calendarChange(uid, 'chg-meeting', 'busy-meeting'),
      calendarChange(uid, 'chg-evening', 'busy-evening'),
      calendarChange(uid, 'chg-gone', 'busy-deleted'),
      calendarChange('user_other', 'chg-foreign', 'busy-meeting'),
      watcher,
    ], { storage: spying });

    assert.deepEqual(facts.get('chg-meeting'), { interval: MEETING, blocking: true });
    assert.deepEqual(facts.get('chg-evening'), { interval: EVENING, blocking: true });
    assert.deepEqual(facts.get('chg-gone'), { interval: null, blocking: false });
    assert.equal(facts.get('chg-foreign'), null, 'a row naming another scope is never resolved here');
    assert.equal(facts.get('chg-watcher'), null, 'a watcher firing is not a span of time');
    assert.ok(read.every((path) => path.startsWith(`users/${uid}/`)), `read outside the account: ${read.join(', ')}`);
  });
});

test('two blocks sharing one id resolve to null rather than to whichever was listed first', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_resolver_ambiguous';
    await syncCalendar(storage, uid, [{ blockId: 'busy-shared', interval: MEETING }]);
    await replaceBusyBlocks(
      uid,
      'device:calendar-2',
      { startsAt: `${DATE}T00:00:00.000Z`, endsAt: '2026-09-17T00:00:00.000Z' },
      [{ blockId: 'busy-shared', sourceId: 'device:calendar-2', sourceKind: 'device', startAt: EVENING.startsAt, endAt: EVENING.endsAt, allDay: false }],
      { storage },
    );
    const facts = await resolveChangedEntityFacts(uid, [calendarChange(uid, 'chg-shared', 'busy-shared')], { storage });
    assert.equal(facts.get('chg-shared'), null);
  });
});

/* ── #610: the tick over a plan the person has touched ─────────────
 *
 * Every case below drives `runContinuousReplanTick` on the #604 fixture under
 * the default policy (`automatic_time_only`, 60-minute budget). A concurrent
 * action is injected one of two ways: right after the tick has read the plan
 * (the window a real solve spends), through the real action; or from the
 * memory adapter's before-commit hook, as the raw write that action makes,
 * landing between the plan write's own read and its commit.
 */

/** A meeting on the last task: a 30-minute shift, which the default policy applies without asking. */
const ON_LAST: TimeInterval = { startsAt: `${DATE}T07:00:00.000Z`, endsAt: `${DATE}T07:30:00.000Z` };

function move(itemId: string, startsAt: string) {
  // `endsAt === startsAt` is how the edit route says "keep the planner's length".
  return { itemId, startsAt, endsAt: startsAt };
}

/** Runs `competing` once, right after the tick reads the plan and before it writes anything. */
function racingAfterPlanRead(
  storage: StorageAdapter,
  uid: string,
  competing: () => Promise<unknown>,
): { storage: StorageAdapter; fired: () => boolean } {
  const plan = planPath(uid, DATE);
  let fired = false;
  const racing: StorageAdapter = Object.create(storage);
  racing.get = async <T>(path: string): Promise<T | null> => {
    const snapshot = await storage.get<T>(path);
    if (path === plan && !fired) {
      fired = true;
      await competing();
    }
    return snapshot;
  };
  return { storage: racing, fired: () => fired };
}

/**
 * Makes `rewrite` land inside the tick's plan-write transaction, after its read
 * and before its commit, on the first attempt only. The tick opens no other
 * transaction, so the hook is armed for the whole tick.
 */
function rewriteAtCommit(
  storage: StorageAdapter,
  uid: string,
  rewrite: (current: StoredDailyPlan) => StoredDailyPlan,
): { fired: () => boolean; disarm: () => void } {
  const memory = storage as MemoryStorageAdapter;
  let fired = false;
  memory.setBeforeCommitHookForTests(async ({ attempt }) => {
    if (attempt !== 1 || fired) return;
    const current = await storage.get<StoredDailyPlan>(planPath(uid, DATE));
    if (!current) return;
    fired = true;
    await storage.set(planPath(uid, DATE), rewrite(current));
  });
  return { fired: () => fired, disarm: () => memory.setBeforeCommitHookForTests(null) };
}

/** No two items of one visible day share an instant. */
function assertNoDoubleBooking(items: readonly PlannedItem[], label: string): void {
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      assert.ok(
        !intervalsOverlap(items[i]!.interval, items[j]!.interval),
        `${label}: ${items[i]!.itemId} and ${items[j]!.itemId} share time: ${JSON.stringify(items.map((item) => [item.itemId, item.interval.startsAt]))}`,
      );
    }
  }
}

function visibleIds(stored: StoredDailyPlan): string[] {
  return effectiveSchedule(stored).map((item) => item.itemId);
}

/* AC 1 — a concurrent edit, dismissal or protection change is never erased. */

test('#610 AC1: a removal made while the tick solves survives auto-apply, and the change waits for the next tick', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_610_edit_race';
    await seedAccount(storage, uid);
    await syncCalendar(storage, uid, [{ blockId: 'busy-late', interval: ON_LAST }]);
    await storeChange(storage, uid, calendarChange(uid, 'chg-late', 'busy-late'));

    const race = racingAfterPlanRead(storage, uid, () =>
      editPlan(uid, DATE, { moves: [], removals: ['cmt_a'] }, { storage, now: () => MORNING }));
    await runContinuousReplanTick({ storage: race.storage, now: MORNING });
    assert.ok(race.fired(), 'fixture: the removal must have raced the tick');

    const raced = await readStoredPlan(uid, DATE, storage);
    assert.deepEqual(raced!.edits.removals, ['cmt_a'], 'the removal made during the run must not be erased');
    assert.ok(!visibleIds(raced!).includes('cmt_a'), 'the removed task must not come back onto the day');
    assert.equal(raced!.generation, 1, 'a replan solved against the unedited plan must not be installed over the edit');
    assert.equal(await pendingChanges(storage, uid), 1, 'a change whose outcome was not stored must not be drained');

    // The next tick judges the change against the edited day and applies it there.
    const retried = await runContinuousReplanTick({ storage, now: MORNING });
    assert.equal(retried.autoApplied, 1, JSON.stringify(retried));
    const applied = await readStoredPlan(uid, DATE, storage);
    assert.equal(applied!.generation, 2);
    assert.deepEqual(applied!.edits.removals, ['cmt_a'], 'the new generation keeps the removal');
    assert.ok(!visibleIds(applied!).includes('cmt_a'));
    const removedBlock = applied!.blocks.find((entry) => entry.source.id === 'cmt_a');
    assert.equal(removedBlock?.currentInterval, null, 'the new generation\'s blocks mirror the kept removal');
    assert.deepEqual(applied!.causeChangeIds, ['chg-late']);
    assert.equal(await pendingChanges(storage, uid), 0);
  });
});

test('#610 AC1: on a plan already edited, and written before blocks existed, a second removal during the run survives', async () => {
  // Isolates the edits comparison. The status does not move (edited → edited)
  // and there are no blocks to differ, so the edits are the only thing that
  // shows the plan changed under the run.
  await withStorage(async (storage) => {
    const uid = 'user_610_edit_legacy';
    await seedAccount(storage, uid);
    await editPlan(uid, DATE, { moves: [], removals: ['cmt_b'] }, { storage, now: () => MORNING });
    const { blocks: _dropped, ...legacy } = (await readStoredPlan(uid, DATE, storage))!;
    await storage.set(planPath(uid, DATE), legacy);
    await syncCalendar(storage, uid, [{ blockId: 'busy-late', interval: ON_LAST }]);
    await storeChange(storage, uid, calendarChange(uid, 'chg-late', 'busy-late'));

    const race = racingAfterPlanRead(storage, uid, () =>
      editPlan(uid, DATE, { moves: [], removals: ['cmt_b', 'cmt_a'] }, { storage, now: () => MORNING }));
    await runContinuousReplanTick({ storage: race.storage, now: MORNING });
    assert.ok(race.fired(), 'fixture: the removal must have raced the tick');

    const raced = await readStoredPlan(uid, DATE, storage);
    assert.deepEqual(raced!.edits.removals, ['cmt_b', 'cmt_a'], 'the removal made during the run must not be erased');
    assert.equal(raced!.generation, 1);
    assert.equal(await pendingChanges(storage, uid), 1);
  });
});

test('#610 AC1+AC3: a dismissal landing inside the auto-apply write is not undone', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_610_dismiss_commit';
    await seedAccount(storage, uid);
    await syncCalendar(storage, uid, [{ blockId: 'busy-late', interval: ON_LAST }]);
    await storeChange(storage, uid, calendarChange(uid, 'chg-late', 'busy-late'));

    // Exactly what `dismissPlan` writes, landing between the write's read and its commit.
    const hook = rewriteAtCommit(storage, uid, (current) => ({
      ...current, status: 'dismissed', updatedAt: MORNING.toISOString(), proposal: null,
    }));
    try {
      await runContinuousReplanTick({ storage, now: MORNING });
    } finally {
      hook.disarm();
    }
    assert.ok(hook.fired(), 'fixture: the dismissal must have landed inside the write');

    const after = await readStoredPlan(uid, DATE, storage);
    assert.equal(after!.status, 'dismissed', 'a background run must not bring a dismissed plan back');
    assert.equal(after!.generation, 1);
    assert.equal(after!.proposal ?? null, null);
    assert.equal(await pendingChanges(storage, uid), 1, 'the lost write must not drain the change');
  });
});

test('#610 AC3: a dismissal landing inside the proposal write gets no patch', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_610_dismiss_propose';
    await seedAccount(storage, uid);
    // The first task's slot: a 90-minute cascade, which the default policy proposes.
    await syncCalendar(storage, uid, [{ blockId: 'busy-meeting', interval: MEETING }]);
    await storeChange(storage, uid, calendarChange(uid, 'chg-meeting', 'busy-meeting'));

    const hook = rewriteAtCommit(storage, uid, (current) => ({
      ...current, status: 'dismissed', updatedAt: MORNING.toISOString(), proposal: null,
    }));
    let totals;
    try {
      totals = await runContinuousReplanTick({ storage, now: MORNING });
    } finally {
      hook.disarm();
    }
    assert.ok(hook.fired(), 'fixture: the dismissal must have landed inside the write');
    assert.equal(totals.proposed, 1, `fixture: the default policy must propose here: ${JSON.stringify(totals)}`);

    const after = await readStoredPlan(uid, DATE, storage);
    assert.equal(after!.status, 'dismissed');
    assert.equal(after!.proposal ?? null, null, 'a dismissed day must not be patched');
    assert.equal(await pendingChanges(storage, uid), 1);
  });
});

test('#610 AC1: a protection declared while the tick solves is not erased by auto-apply', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_610_protect_race';
    await seedAccount(storage, uid);
    await syncCalendar(storage, uid, [{ blockId: 'busy-late', interval: ON_LAST }]);
    await storeChange(storage, uid, calendarChange(uid, 'chg-late', 'busy-late'));
    const lastBlock = scheduleBlockId({ kind: 'commitment', id: 'cmt_c' });

    const race = racingAfterPlanRead(storage, uid, () => setBlockProtection(uid, DATE, {
      blockId: lastBlock,
      ownership: 'protected_flexible',
      origin: 'user',
      maxShiftMinutes: null,
      preferredInterval: null,
    }, { storage, now: () => MORNING }));
    await runContinuousReplanTick({ storage: race.storage, now: MORNING });
    assert.ok(race.fired(), 'fixture: the protection must have raced the tick');

    const after = await readStoredPlan(uid, DATE, storage);
    const block = after!.blocks.find((entry) => entry.blockId === lastBlock);
    assert.equal(block && ownershipOf(block), 'protected_flexible', 'the protection declared during the run must survive');
    assert.equal(after!.generation, 1, 'a solve that never saw the protection must not be installed');
    assert.equal(await pendingChanges(storage, uid), 1);
  });
});

/* AC 2 — auto-apply never puts two items in one interval of the visible day. */

test('#610 AC2: auto-apply over a user-moved plan does not double-book the visible day', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_610_moved';
    await seedAccount(storage, uid);
    // The person moves the middle task to 07:30: visible a@06:00, c@07:00, b@07:30.
    await editPlan(uid, DATE, { moves: [move('cmt_b', `${DATE}T07:30:00.000Z`)], removals: [] }, { storage, now: () => MORNING });
    // A meeting lands on c. The solve places a@06:00, b@07:15, c@07:45: on the
    // visible day that is b -15 and c +45, inside the 60-minute budget.
    const spanning: TimeInterval = { startsAt: `${DATE}T06:45:00.000Z`, endsAt: `${DATE}T07:15:00.000Z` };
    await syncCalendar(storage, uid, [{ blockId: 'busy-span', interval: spanning }]);
    await storeChange(storage, uid, calendarChange(uid, 'chg-span', 'busy-span'));

    const totals = await runContinuousReplanTick({ storage, now: MORNING });
    assert.equal(totals.autoApplied, 1, `fixture: the default policy must auto-apply here: ${JSON.stringify(totals)}`);

    const after = await readStoredPlan(uid, DATE, storage);
    assert.equal(after!.generation, 2);
    assertNoDoubleBooking(effectiveSchedule(after!), 'the visible day after auto-apply');
    for (const item of effectiveSchedule(after!)) {
      assert.ok(!intervalsOverlap(item.interval, spanning), `${item.itemId} must be off the meeting`);
    }
    assert.deepEqual(after!.edits.moves, [], 'a move validated against the old placement is not carried onto the new one');
    assert.equal(after!.status, 'proposed', 'with its only edit gone the plan is what it was before the edit: never accepted');
  });
});

/* AC 3 — a dismissed plan is never replanned or patched; `proposed` is not flipped. */

test('#610 AC3: a dismissed day is neither replanned nor patched, and its changes wait for the day to come back', async () => {
  await withStorage(async (storage) => {
    const applying = 'user_610_dismissed_apply';
    const proposing = 'user_610_dismissed_propose';
    for (const uid of [applying, proposing]) {
      await seedAccount(storage, uid);
      await dismissPlan(uid, DATE, { storage, now: () => MORNING });
    }
    await syncCalendar(storage, applying, [{ blockId: 'busy-late', interval: ON_LAST }]);
    await storeChange(storage, applying, calendarChange(applying, 'chg-late', 'busy-late'));
    await syncCalendar(storage, proposing, [{ blockId: 'busy-meeting', interval: MEETING }]);
    await storeChange(storage, proposing, calendarChange(proposing, 'chg-meeting', 'busy-meeting'));

    const totals = await runContinuousReplanTick({ storage, now: MORNING });
    assert.deepEqual(totals, { ...ZERO, examined: 2, skipped: 2 });
    for (const uid of [applying, proposing]) {
      const after = await readStoredPlan(uid, DATE, storage);
      assert.equal(after!.status, 'dismissed', `${uid}: the dismissal stands`);
      assert.equal(after!.generation, 1, `${uid}: no new generation`);
      assert.equal(after!.proposal ?? null, null, `${uid}: no patch`);
      assert.equal(await pendingChanges(storage, uid), 1, `${uid}: nothing was decided about the change`);
    }

    // The person takes the day back: the held change is replanned then.
    await acceptPlan(applying, DATE, { storage, now: () => MORNING });
    const later = await runContinuousReplanTick({ storage, now: MORNING });
    assert.equal(later.autoApplied, 1, JSON.stringify(later));
    assert.equal(later.skipped, 1, 'the other day is still dismissed');
    const back = await readStoredPlan(applying, DATE, storage);
    assert.equal(back!.generation, 2);
    assert.equal(back!.status, 'accepted');
    assert.equal(await pendingChanges(storage, applying), 0);
  });
});

test('#610 AC3: a plan the person has not accepted stays proposed through a background auto-apply', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_610_proposed';
    const before = await seedAccount(storage, uid);
    assert.equal(before.status, 'proposed', 'fixture: the morning plan is waiting for the person');
    await syncCalendar(storage, uid, [{ blockId: 'busy-late', interval: ON_LAST }]);
    await storeChange(storage, uid, calendarChange(uid, 'chg-late', 'busy-late'));

    const totals = await runContinuousReplanTick({ storage, now: MORNING });
    assert.equal(totals.autoApplied, 1, JSON.stringify(totals));
    const after = await readStoredPlan(uid, DATE, storage);
    assert.equal(after!.generation, 2);
    assert.equal(after!.status, 'proposed', 'a background run must not accept a plan on the person\'s behalf');
    assert.equal(after!.acceptedAt, null);
  });
});

/* AC 4 — the impact view is the visible day. */

test('#610 AC4: a meeting on the slot of a task the person removed does not earn a replan', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_610_removed_slot';
    await seedAccount(storage, uid);
    await editPlan(uid, DATE, { moves: [], removals: ['cmt_a'] }, { storage, now: () => MORNING });
    await syncCalendar(storage, uid, [{ blockId: 'busy-meeting', interval: MEETING }]);
    await storeChange(storage, uid, calendarChange(uid, 'chg-meeting', 'busy-meeting'));

    const totals = await runContinuousReplanTick({ storage, now: MORNING });
    assert.equal(totals.replanRequired, 0, `nothing visible sits under the meeting: ${JSON.stringify(totals)}`);
    assert.equal(totals.stale, 1);
    const after = await readStoredPlan(uid, DATE, storage);
    assert.equal(after!.generation, 1, 'no generation may name this meeting as its cause');
    assert.equal(after!.proposal ?? null, null);
    assert.equal(await pendingChanges(storage, uid), 0);
  });
});

test('#610 AC4: a meeting on a task the person moved earns a replan that takes the task off it', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_610_moved_slot';
    await seedAccount(storage, uid);
    await editPlan(uid, DATE, { moves: [move('cmt_a', `${DATE}T07:30:00.000Z`)], removals: [] }, { storage, now: () => MORNING });
    const onMoved: TimeInterval = { startsAt: `${DATE}T07:30:00.000Z`, endsAt: `${DATE}T08:00:00.000Z` };
    await syncCalendar(storage, uid, [{ blockId: 'busy-moved', interval: onMoved }]);
    await storeChange(storage, uid, calendarChange(uid, 'chg-moved', 'busy-moved'));

    const totals = await runContinuousReplanTick({ storage, now: MORNING });
    assert.equal(totals.replanRequired, 1, `the moved task sits under the meeting: ${JSON.stringify(totals)}`);
    assert.equal(totals.autoApplied + totals.proposed, 1, `the replan must produce an outcome: ${JSON.stringify(totals)}`);

    const after = await readStoredPlan(uid, DATE, storage);
    // What the person would see once the outcome is in force: a new generation
    // as stored, or the patch as accepting it installs it (moves dropped,
    // removals kept — there are none here).
    const outcome = after!.proposal ? after!.proposal.plan.scheduled : effectiveSchedule(after!);
    const causes = after!.proposal ? after!.proposal.causeChangeIds : after!.causeChangeIds;
    assert.deepEqual(causes, ['chg-moved']);
    const placed = outcome.find((item) => item.itemId === 'cmt_a');
    assert.ok(placed, 'the task must still be placed');
    assert.ok(!intervalsOverlap(placed.interval, onMoved), `the task must leave the meeting, got ${JSON.stringify(placed.interval)}`);
  });
});

/* AC 5 — a change is drained only when its outcome was stored. */

test('#610 AC5: when an older patch is accepted during the run, the new change is not drained and is replanned next tick', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_610_patch_race';
    await seedAccount(storage, uid);
    // A first meeting earns a patch (a@06:30, b@07:00, c@07:30) that waits for review.
    await syncCalendar(storage, uid, [{ blockId: 'busy-meeting', interval: MEETING }]);
    await storeChange(storage, uid, calendarChange(uid, 'chg-meeting', 'busy-meeting'));
    const first = await runContinuousReplanTick({ storage, now: MORNING });
    assert.equal(first.proposed, 1, `fixture: ${JSON.stringify(first)}`);

    // A second meeting lands at 07:00, where that patch would put b.
    await syncCalendar(storage, uid, [
      { blockId: 'busy-meeting', interval: MEETING },
      { blockId: 'busy-late', interval: ON_LAST },
    ]);
    await storeChange(storage, uid, calendarChange(uid, 'chg-late', 'busy-late'));
    // While the tick solves for it, the person accepts the older patch.
    const race = racingAfterPlanRead(storage, uid, () => acceptPlanProposal(uid, DATE, { storage, now: () => MORNING }));
    await runContinuousReplanTick({ storage: race.storage, now: MORNING });
    assert.ok(race.fired(), 'fixture: the acceptance must have raced the tick');

    const accepted = await readStoredPlan(uid, DATE, storage);
    assert.equal(accepted!.generation, 2, 'fixture: the older patch is in force');
    assert.ok(
      effectiveSchedule(accepted!).some((item) => intervalsOverlap(item.interval, ON_LAST)),
      'fixture: the accepted patch was solved before the second meeting and sits under it',
    );
    assert.equal(await pendingChanges(storage, uid), 1, 'a change the winning write never saw must not be drained');

    const retried = await runContinuousReplanTick({ storage, now: MORNING });
    assert.equal(retried.replanRequired, 1, JSON.stringify(retried));
    const after = await readStoredPlan(uid, DATE, storage);
    const outcome = after!.proposal ? after!.proposal.plan.scheduled : effectiveSchedule(after!);
    const causes = after!.proposal ? after!.proposal.causeChangeIds : after!.causeChangeIds;
    assert.deepEqual(causes, ['chg-late']);
    assert.ok(!outcome.some((item) => intervalsOverlap(item.interval, ON_LAST)), 'the replan must clear the second meeting');
    assert.equal(await pendingChanges(storage, uid), 0);
  });
});
