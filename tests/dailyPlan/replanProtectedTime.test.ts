/**
 * An automatic replan solves under the same protections the morning build
 * does (#585).
 *
 * `composeDailyPlan` re-injects #522's protections — and the readiness
 * buffers — before it calls the solver. `continuousReplanService` used to call
 * the solver on `buildDailyPlanInput`'s bare output, so every automatic replan
 * solved as if nothing were protected. Two things went wrong at once on the
 * auto-apply path: the protected block was moved, and the new generation's
 * blocks were reconciled from unprotected items, so the protection itself was
 * dropped from the document. On the review path the patch offered to the user
 * was solved the same way, and accepting it installed the move.
 *
 * Every case here goes through the real morning build, the real protection
 * mutation, a real busy block, and `processStateChangesForUser` — so what is
 * asserted is the stored document, not a hand-built request. The fixture is
 * three half-hour tasks at 06:00, 06:30 and 07:00 UTC; the middle one is
 * protected; a meeting lands on the first. Without protection the first task
 * takes the middle one's slot and everything slides by half an hour, which
 * the control case below proves, so the protected cases cannot pass by the
 * change simply not reaching the middle task.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import { userDoc } from '../../lib/storage/paths.ts';
import { persistParticipantState } from '../../lib/services/mobile/participantState.ts';
import { applyCommand as applyDomainCommand, createEmptyDomainState } from '../../src/domain/stateMachine.ts';
import {
  buildAndStoreDailyPlan,
  claimDueDelivery,
  savePlanSettings,
} from '../../lib/services/dailyPlan/dailyPlanService.ts';
import { readStoredPlan, type StoredDailyPlan } from '../../lib/services/dailyPlan/planStore.ts';
import { acceptPlanProposal, editPlan, setBlockProtection } from '../../lib/services/dailyPlan/planActions.ts';
import { processStateChangesForUser } from '../../lib/services/dailyPlan/continuousReplanService.ts';
import { replaceBusyBlocksAsFixture } from '../support/busyFixtures.ts';
import { saveNormalizedReadinessSnapshot, saveSubjectiveEnergyCheckIn } from '../../lib/userState/userStateService.ts';
import { ownershipOf, scheduleBlockId } from '../../src/contracts/v1/scheduleBlockContracts.ts';
import type { PlanningStateChange } from '../../src/contracts/v1/watcherContracts.ts';
import type { Plan, TimeInterval } from '../../src/contracts/v1/planningContracts.ts';
import type { ReplanPolicyConfig } from '../../src/contracts/v1/replanContracts.ts';
import {
  READINESS_CONTRACT_VERSION,
  READINESS_SCHEMA_VERSION,
  type ReadinessSnapshot,
} from '../../src/contracts/v1/readinessContracts.ts';

const TZ = 'Asia/Jerusalem';
const DATE = '2026-09-15';
/** 09:00 in Jerusalem: past the 07:30 delivery, and the moment the meeting lands. */
const MORNING = new Date('2026-09-15T06:00:00.000Z');
const TASKS = ['cmt_a', 'cmt_b', 'cmt_c'] as const;
const PROTECTED = 'cmt_b';
const PROTECTED_BLOCK = scheduleBlockId({ kind: 'commitment', id: PROTECTED });
/** The first task's slot, taken by a meeting after the plan was built. */
const MEETING: TimeInterval = { startsAt: `${DATE}T06:00:00.000Z`, endsAt: `${DATE}T06:30:00.000Z` };

/** Room for the whole unprotected slide (90 minutes), so the policy auto-applies. */
const AUTO_APPLY: Partial<ReplanPolicyConfig> = { userControlMode: 'automatic_time_only', maxAutoChurnMinutes: 240 };
const REVIEW: Partial<ReplanPolicyConfig> = { userControlMode: 'always_require_confirmation' };
/**
 * The mode that was the default until #611's council decision, with its own
 * default 60-minute budget. The drag cases below are about what the churn
 * budget is charged, which only this mode reads; under the default every
 * replan is a proposal, and asserting "proposed" there would prove nothing.
 */
const TIME_ONLY: Partial<ReplanPolicyConfig> = { userControlMode: 'automatic_time_only' };

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

function lowReadiness(uid: string): ReadinessSnapshot {
  const computedAt = '2026-09-15T05:00:00.000Z';
  return {
    version: READINESS_CONTRACT_VERSION,
    schemaVersion: READINESS_SCHEMA_VERSION,
    scopeId: uid,
    computedAt,
    windowStart: '2026-09-14T20:00:00.000Z',
    windowEnd: computedAt,
    band: 'low',
    score: 0.2,
    normalizedSignals: { restingHeartRate: 61, hrv: 42 },
    subjective: null,
    derived: { readinessBand: 'low', confidence: 0.8 },
    signals: [{
      signalId: 'healthkit-summary',
      source: { kind: 'healthkit' },
      metric: 'recovery',
      observedAt: computedAt,
      normalizedScore: 0.2,
      nativeValue: 42,
      nativeUnit: 'milliseconds',
      confidence: 0.8,
    }],
    sourceKinds: ['healthkit'],
    missingSourceKinds: ['health_connect', 'whoop', 'subjective'],
  };
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

/** One account with the morning's plan built and stored. */
async function seedAccount(
  storage: StorageAdapter,
  uid: string,
  options: { readiness?: ReadinessSnapshot } = {},
): Promise<StoredDailyPlan> {
  await persistParticipantState(uid, seedState());
  const user = await storage.get<Record<string, unknown>>(userDoc(uid));
  await storage.set(userDoc(uid), { ...(user ?? {}), timezone: TZ, locale: 'en' });
  if (options.readiness) {
    assert.equal(
      await saveNormalizedReadinessSnapshot(uid, options.readiness, { storage, now: MORNING.toISOString() }),
      'stored',
    );
  }
  await savePlanSettings(uid, { enabled: true, deliveryLocalTime: '07:30' }, new Date('2026-09-14T12:00:00.000Z'), { storage });
  const claim = await claimDueDelivery(uid, MORNING, { storage });
  assert.ok(claim, 'fixture: the account must be due for a plan');
  await buildAndStoreDailyPlan(claim, { storage, now: () => MORNING });
  const stored = await readStoredPlan(uid, DATE, storage);
  assert.ok(stored, 'fixture: the morning build stored no plan');
  return stored;
}

async function protectWhereItSits(storage: StorageAdapter, uid: string): Promise<void> {
  const outcome = await setBlockProtection(uid, DATE, {
    blockId: PROTECTED_BLOCK,
    ownership: 'protected_flexible',
    origin: 'user',
    maxShiftMinutes: null,
    preferredInterval: null,
  }, { storage, now: () => MORNING });
  assert.ok(outcome, 'fixture: the protection was not recorded');
}

/** The meeting a calendar sync writes, and the change row that announces it. */
async function meetingLands(
  storage: StorageAdapter,
  uid: string,
  meeting: TimeInterval = MEETING,
): Promise<PlanningStateChange> {
  await replaceBusyBlocksAsFixture(
    uid,
    'device:calendar-1',
    { startsAt: `${DATE}T00:00:00.000Z`, endsAt: `${DATE}T23:59:59.999Z` },
    [{
      blockId: 'busy-meeting',
      sourceId: 'device:calendar-1',
      sourceKind: 'device',
      startAt: meeting.startsAt,
      endAt: meeting.endsAt,
      allDay: false,
    }],
    { storage },
  );
  return {
    schemaVersion: 'planning-state-change-v1',
    changeId: 'chg-meeting',
    scopeId: uid,
    source: 'calendar',
    entityId: 'busy-meeting',
    occurredAt: MORNING.toISOString(),
    changedFields: ['interval', 'blocking'],
    beforeDigest: null,
    afterDigest: 'digest-meeting',
    provenanceRef: 'calendar:refresh-1',
  };
}

async function replan(
  storage: StorageAdapter,
  uid: string,
  policyConfig: Partial<ReplanPolicyConfig>,
  options: { meeting?: TimeInterval; now?: Date } = {},
) {
  const meeting = options.meeting ?? MEETING;
  const change = await meetingLands(storage, uid, meeting);
  return processStateChangesForUser(uid, {
    storage,
    now: options.now ?? MORNING,
    date: DATE,
    changes: [change],
    entityFactsByChangeId: new Map([[change.changeId, { interval: meeting, blocking: true }]]),
    policyConfig,
  });
}

function placementOf(plan: Plan, itemId: string): TimeInterval | null {
  return plan.scheduled.find((entry) => entry.itemId === itemId)?.interval ?? null;
}

/* ── The local path freezes work the change did not touch ───────── */

test('a local meeting conflict takes the incremental path and moves only the hit task', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_replan_unprotected';
    const before = await seedAccount(storage, uid);
    assert.deepEqual(placementOf(before.plan, PROTECTED), {
      startsAt: `${DATE}T06:30:00.000Z`,
      endsAt: `${DATE}T07:00:00.000Z`,
    }, 'fixture: the middle task must start at 06:30');

    const report = await replan(storage, uid, AUTO_APPLY);
    assert.equal(report.replanMode, 'incremental');
    assert.equal(report.pipelineResult.policyDecision?.action, 'auto_apply');
    assert.equal(report.planStored, true);

    const after = await readStoredPlan(uid, DATE, storage);
    assert.equal(after?.generation, 2);
    assert.notDeepEqual(placementOf(after!.plan, 'cmt_a'), placementOf(before.plan, 'cmt_a'));
    assert.deepEqual(placementOf(after!.plan, PROTECTED), placementOf(before.plan, PROTECTED));
    assert.deepEqual(placementOf(after!.plan, 'cmt_c'), placementOf(before.plan, 'cmt_c'));
  });
});

/* ── Auto-apply ──────────────────────────────────────────────────── */

test('an automatic replan leaves a protected block where it is, and keeps it protected', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_replan_protected_auto';
    const before = await seedAccount(storage, uid);
    const kept = placementOf(before.plan, PROTECTED);
    await protectWhereItSits(storage, uid);

    const report = await replan(storage, uid, AUTO_APPLY);
    assert.equal(report.pipelineResult.policyDecision?.action, 'auto_apply');
    assert.equal(report.planStored, true, 'the replan must have been written, or nothing was tested');

    const after = await readStoredPlan(uid, DATE, storage);
    assert.equal(after?.generation, 2);
    // The replan really happened: the task the meeting landed on moved.
    assert.notDeepEqual(placementOf(after!.plan, 'cmt_a'), placementOf(before.plan, 'cmt_a'));
    assert.deepEqual(placementOf(after!.plan, PROTECTED), kept, 'an automatic replan moved protected time');

    // And the new generation still says so. Reconciled from unprotected
    // items, the block came out with `protection: null`: the hour was not
    // only moved once, it stopped being protected for every replan after.
    const block = after!.blocks.find((entry) => entry.blockId === PROTECTED_BLOCK);
    assert.ok(block, 'the protected block is missing from the new generation');
    assert.equal(ownershipOf(block), 'protected_flexible');
    assert.deepEqual(block.protection?.preferredInterval, kept);
    assert.deepEqual(block.currentInterval, kept);
  });
});

test('a protected block the user dragged is measured from where they put it, not charged to the replan', async () => {
  // A drag re-anchors the protection on the block (`protectionAfterMove`) and
  // leaves `plan.scheduled` holding the planner's placement — the move lives
  // in `edits`. The replan solves from the anchor, so it keeps the block where
  // the person dragged it. Diffed against `plan.scheduled`, that looked like
  // the replan moving it 150 minutes: the churn budget was spent on the user's
  // own drag, the policy flipped to review, and the review screen offered the
  // person their own move back as the system's proposal.
  await withStorage(async (storage) => {
    const uid = 'user_replan_protected_dragged';
    await seedAccount(storage, uid);
    await protectWhereItSits(storage, uid);
    const dragged: TimeInterval = { startsAt: `${DATE}T09:00:00.000Z`, endsAt: `${DATE}T09:30:00.000Z` };
    assert.ok(await editPlan(uid, DATE, {
      moves: [{ itemId: PROTECTED, startsAt: dragged.startsAt, endsAt: dragged.endsAt }],
      removals: [],
    }, { storage, now: () => MORNING }));

    // The meeting lands on the third task, not on anything the user touched.
    const report = await replan(storage, uid, TIME_ONLY, {
      meeting: { startsAt: `${DATE}T07:00:00.000Z`, endsAt: `${DATE}T07:30:00.000Z` },
    });

    const diff = report.pipelineResult.diff;
    assert.ok(diff, 'the replan must have been diffed, or nothing was tested');
    const protectedChange = diff.changes.find((change) => change.itemId === PROTECTED);
    assert.equal(protectedChange?.kind, 'unchanged', 'the user\'s own drag was reported as a replan move');
    assert.equal(report.pipelineResult.policyDecision?.action, 'auto_apply', 'the user\'s drag spent the churn budget');

    const after = await readStoredPlan(uid, DATE, storage);
    assert.deepEqual(placementOf(after!.plan, PROTECTED), dragged);
  });
});

test('a local incremental replan freezes an unrelated user-edited block', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_replan_unprotected_dragged';
    await seedAccount(storage, uid);
    const dragged: TimeInterval = { startsAt: `${DATE}T09:00:00.000Z`, endsAt: `${DATE}T09:30:00.000Z` };
    assert.ok(await editPlan(uid, DATE, {
      moves: [{ itemId: PROTECTED, startsAt: dragged.startsAt, endsAt: dragged.endsAt }],
      removals: [],
    }, { storage, now: () => MORNING }));

    const report = await replan(storage, uid, TIME_ONLY, {
      meeting: { startsAt: `${DATE}T07:00:00.000Z`, endsAt: `${DATE}T07:30:00.000Z` },
    });
    assert.equal(report.replanMode, 'incremental');
    assert.deepEqual(placementOf(report.pipelineResult.newPlan!, PROTECTED), dragged);
    assert.deepEqual(placementOf(report.pipelineResult.basePlan!, PROTECTED), dragged);
    const change = report.pipelineResult.diff?.changes.find((entry) => entry.itemId === PROTECTED);
    assert.equal(change?.kind, 'unchanged');
    assert.equal(report.pipelineResult.policyDecision?.action, 'auto_apply');
  });
});

/* ── The review path ─────────────────────────────────────────────── */

test('a replan offered for review is solved under the protection, so accepting it keeps the hour', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_replan_protected_review';
    const before = await seedAccount(storage, uid);
    const kept = placementOf(before.plan, PROTECTED);
    await protectWhereItSits(storage, uid);

    const report = await replan(storage, uid, REVIEW);
    assert.equal(report.pipelineResult.policyDecision?.action, 'propose_for_review');

    const offered = await readStoredPlan(uid, DATE, storage);
    assert.ok(offered?.proposal, 'the review path must have stored a patch');
    assert.deepEqual(placementOf(offered.proposal.plan, PROTECTED), kept, 'the patch offered for review moves protected time');

    const accepted = await acceptPlanProposal(uid, DATE, { storage, now: () => MORNING });
    assert.ok(accepted);
    assert.deepEqual(placementOf(accepted.plan, PROTECTED), kept, 'accepting the patch moved protected time');
    const block = accepted.blocks.find((entry) => entry.blockId === PROTECTED_BLOCK);
    assert.equal(block && ownershipOf(block), 'protected_flexible');
    assert.deepEqual(block?.protection?.preferredInterval, kept);
  });
});

/* ── Readiness ───────────────────────────────────────────────────── */

test('an automatic replan keeps the readiness buffer the morning build gave every item', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_replan_low_readiness';
    const before = await seedAccount(storage, uid, { readiness: lowReadiness(uid) });
    // Fixture: the morning build did widen the buffers, or the replan has
    // nothing to be consistent with.
    assert.ok(before.constraints.items.every((item) => item.bufferAfterMinutes === 15));

    const report = await replan(storage, uid, REVIEW);
    const solved = report.pipelineResult.newPlan;
    assert.ok(solved, 'the replan must have produced a plan');
    assert.ok(solved.scheduled.length > 0);
    for (const entry of solved.scheduled) {
      const after = (Date.parse(entry.reservedInterval.endsAt) - Date.parse(entry.interval.endsAt)) / 60_000;
      // Without the projection the replan packs the day with no recovery gap,
      // and every one of those tighter placements shows up as churn in the
      // diff although nothing about the person changed.
      assert.equal(after, 15, `${entry.itemId} lost its readiness buffer in the replan`);
    }
  });
});

test('readiness is read at the replan\'s clock, not carried over from the morning', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_replan_readiness_changed';
    // Last night the person said they were full of energy. At the morning
    // build that statement is 11 hours old — still current — and outranks the
    // low wearable reading, so the morning plan has no recovery gap.
    await persistParticipantState(uid, seedState());
    assert.equal(await saveNormalizedReadinessSnapshot(uid, lowReadiness(uid), {
      storage, now: MORNING.toISOString(),
    }), 'stored');
    assert.equal(await saveSubjectiveEnergyCheckIn(uid, {
      energy: 5,
      observedAt: '2026-09-14T19:00:00.000Z',
    }, { storage, now: MORNING.toISOString() }), 'stored');
    const before = await seedAccount(storage, uid);
    assert.ok(before.constraints.items.every((item) => item.bufferAfterMinutes === 0), 'fixture: the check-in must win at the morning build');

    // By 07:30 the statement is past its 12 hours and the wearable is what is
    // known. A solve made now must add the gap; one that read readiness at the
    // time of the plan it replaces would not.
    const later = new Date('2026-09-15T07:30:00.000Z');
    const report = await replan(storage, uid, REVIEW, {
      now: later,
      meeting: { startsAt: `${DATE}T07:00:00.000Z`, endsAt: `${DATE}T07:30:00.000Z` },
    });
    assert.equal(report.replanMode, 'full_fallback', 'a global readiness delta must not be frozen out');
    const solved = report.pipelineResult.newPlan;
    assert.ok(solved && solved.scheduled.length > 0, 'the replan must have produced a plan');
    for (const entry of solved.scheduled) {
      const after = (Date.parse(entry.reservedInterval.endsAt) - Date.parse(entry.interval.endsAt)) / 60_000;
      assert.equal(after, 15, `${entry.itemId} was solved with the morning's readiness`);
    }
  });
});
