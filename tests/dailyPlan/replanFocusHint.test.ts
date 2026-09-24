/**
 * The automatic replan solves inside the focus window the morning build used
 * (#606).
 *
 * `composeDailyPlan` passes a kept focus window (`keptFocusWindow`, UC-3.16,
 * #202) to the planner when the routine names none. The replan assembled its
 * own request without it, so for such a user every replan fell back to the
 * default 08:00–20:00 window and repacked the whole day at "now". The diff then
 * charged that repacking to whichever change had triggered the replan.
 *
 * Every case drives `runContinuousReplanTick` on memory storage, as
 * `replanTickEntityFacts.test.ts` does: a real morning build, a real busy block
 * written through `replaceBusyBlocks`, a real change row. The meeting lands on
 * the *last* task only, so the first two are not what the change is about. They
 * must stay where the morning put them.
 *
 * The consent-off case is the other half of the gate. The request both solvers
 * build reads the hint through `keptFocusWindow`, which answers null without
 * personalization consent; a replan that read the window any other way would
 * move the day into it for a user who never agreed to that.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import { PLANNING_STATE_CHANGES, docIdForKey, userDoc, userSubDoc } from '../../lib/storage/paths.ts';
import { persistParticipantState } from '../../lib/services/mobile/participantState.ts';
import { applyCommand as applyDomainCommand, createEmptyDomainState } from '../../src/domain/stateMachine.ts';
import {
  buildAndStoreDailyPlan,
  claimDueDelivery,
  savePlanSettings,
} from '../../lib/services/dailyPlan/dailyPlanService.ts';
import { readStoredPlan, type StoredDailyPlan } from '../../lib/services/dailyPlan/planStore.ts';
import { runContinuousReplanTick } from '../../lib/services/dailyPlan/continuousReplanService.ts';
import { replaceBusyBlocks } from '../../lib/calendar/busyBlocks.ts';
import { createStorageRuntimeMemoryStore } from '../../lib/runtimeMemory/runtimeMemoryStore.ts';
import { setPersonalizationConsent } from '../../lib/consents/personalizationConsentService.ts';
import { PERSONALIZATION_CONSENT_VERSION } from '../../src/contracts/v1/consentContracts.ts';
import type { PlanningStateChange } from '../../src/contracts/v1/watcherContracts.ts';
import type { Plan, TimeInterval } from '../../src/contracts/v1/planningContracts.ts';

const TZ = 'Asia/Jerusalem';
const DATE = '2026-09-15';
/** 09:00 in Jerusalem (UTC+3): past the 07:30 delivery, and when the tick runs. */
const MORNING = new Date('2026-09-15T06:00:00.000Z');
const TASKS = ['cmt_a', 'cmt_b', 'cmt_c'] as const;
const CALENDAR = 'device:calendar-1';
/** The kept window, 13:00–16:00 local: 10:00–13:00 UTC. */
const HINT = { start: '13:00', end: '16:00' } as const;
const HINT_SPAN: TimeInterval = { startsAt: `${DATE}T10:00:00.000Z`, endsAt: `${DATE}T13:00:00.000Z` };

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

/** A focus window the user kept from an R1 suggestion, as `planningHint.test.ts` stores one. */
async function keepFocusWindow(storage: StorageAdapter, uid: string): Promise<void> {
  const at = '2026-09-14T06:00:00.000Z';
  await createStorageRuntimeMemoryStore(undefined, storage).put({
    scopeId: uid,
    kind: 'preference',
    content: `You often finish things between ${HINT.start} and ${HINT.end}.`,
    language: 'en',
    source: 'deterministic_rule',
    confidence: 0.7,
    observedAt: at,
    evidenceIds: ['ev1', 'ev2'],
    provenance: { origin: 'behaviour_rule', originRef: `R1_focus_window:${HINT.start}-${HINT.end}`, confirmedByUserAt: at },
  }, at);
}

/**
 * One account with a kept focus window, no routine, and the morning's plan
 * built through the real morning build.
 */
async function seedAccount(storage: StorageAdapter, uid: string, consent: 'granted' | 'declined'): Promise<StoredDailyPlan> {
  await persistParticipantState(uid, seedState());
  const user = await storage.get<Record<string, unknown>>(userDoc(uid));
  await storage.set(userDoc(uid), { ...(user ?? {}), timezone: TZ, locale: 'en' });
  await setPersonalizationConsent(uid, {
    state: consent,
    version: PERSONALIZATION_CONSENT_VERSION,
    at: new Date('2026-09-14T06:00:00.000Z'),
  }, { storage });
  await keepFocusWindow(storage, uid);
  await savePlanSettings(uid, { enabled: true, deliveryLocalTime: '07:30' }, new Date('2026-09-14T12:00:00.000Z'), { storage });
  const claim = await claimDueDelivery(uid, MORNING, { storage });
  assert.ok(claim, 'fixture: the account must be due for a plan');
  await buildAndStoreDailyPlan(claim, { storage, now: () => MORNING });
  const stored = await readStoredPlan(uid, DATE, storage);
  assert.ok(stored, 'fixture: the morning build stored no plan');
  return stored;
}

async function meetingLandsOn(storage: StorageAdapter, uid: string, interval: TimeInterval): Promise<void> {
  await replaceBusyBlocks(
    uid,
    CALENDAR,
    { startsAt: `${DATE}T00:00:00.000Z`, endsAt: '2026-09-17T00:00:00.000Z' },
    [{
      blockId: 'busy-meeting',
      sourceId: CALENDAR,
      sourceKind: 'device' as const,
      startAt: interval.startsAt,
      endAt: interval.endsAt,
      allDay: false,
    }],
    { storage },
  );
  const change: PlanningStateChange = {
    schemaVersion: 'planning-state-change-v1',
    changeId: 'chg-meeting',
    scopeId: uid,
    source: 'calendar',
    entityId: 'busy-meeting',
    occurredAt: MORNING.toISOString(),
    changedFields: ['interval', 'blocking'],
    beforeDigest: null,
    afterDigest: 'digest-busy-meeting',
    provenanceRef: 'calendar:refresh-1',
  };
  await storage.set(userSubDoc(uid, PLANNING_STATE_CHANGES, docIdForKey(change.changeId)), change);
}

function placementOf(plan: Plan, itemId: string): TimeInterval {
  const interval = plan.scheduled.find((entry) => entry.itemId === itemId)?.interval;
  assert.ok(interval, `${itemId} must be scheduled`);
  return interval;
}

function inside(interval: TimeInterval, span: TimeInterval): boolean {
  return Date.parse(interval.startsAt) >= Date.parse(span.startsAt) && Date.parse(interval.endsAt) <= Date.parse(span.endsAt);
}

/** The plan the tick produced: the new generation when applied, the patch when proposed. */
function outcomePlan(before: StoredDailyPlan, after: StoredDailyPlan): Plan {
  if (after.proposal) return after.proposal.plan;
  assert.ok(after.generation > before.generation, 'the tick must have produced a generation or a proposal');
  return after.plan;
}

test('a replan for a user with a kept focus window leaves the untouched items where the morning placed them, inside the window', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_focus_hint';
    const before = await seedAccount(storage, uid, 'granted');
    for (const id of TASKS) {
      assert.ok(inside(placementOf(before.plan, id), HINT_SPAN), `fixture: the morning build must place ${id} inside the kept window`);
    }

    // A meeting on the last task only. The first two are not what it is about.
    await meetingLandsOn(storage, uid, placementOf(before.plan, 'cmt_c'));

    const totals = await runContinuousReplanTick({ storage, now: MORNING });
    assert.equal(totals.replanRequired, 1, `the tick must reach the planner: ${JSON.stringify(totals)}`);
    assert.equal(totals.failed, 0);

    const after = await readStoredPlan(uid, DATE, storage);
    assert.ok(after);
    const replanned = outcomePlan(before, after);
    for (const id of ['cmt_a', 'cmt_b'] as const) {
      assert.deepEqual(
        placementOf(replanned, id),
        placementOf(before.plan, id),
        `${id} was untouched by the meeting and must stay where the morning build placed it`,
      );
    }
    const moved = placementOf(replanned, 'cmt_c');
    assert.notDeepEqual(moved, placementOf(before.plan, 'cmt_c'), 'the task under the meeting must move');
    assert.ok(inside(moved, HINT_SPAN), `the moved task must stay inside the kept window, got ${JSON.stringify(moved)}`);
  });
});

test('without personalization consent the replan does not read the kept focus window either', async () => {
  await withStorage(async (storage) => {
    const uid = 'user_focus_hint_no_consent';
    const before = await seedAccount(storage, uid, 'declined');
    for (const id of TASKS) {
      assert.ok(!inside(placementOf(before.plan, id), HINT_SPAN), `fixture: without consent the morning build must ignore the window (${id})`);
    }

    await meetingLandsOn(storage, uid, placementOf(before.plan, 'cmt_c'));

    const totals = await runContinuousReplanTick({ storage, now: MORNING });
    assert.equal(totals.replanRequired, 1, `the tick must reach the planner: ${JSON.stringify(totals)}`);
    assert.equal(totals.failed, 0);

    const after = await readStoredPlan(uid, DATE, storage);
    assert.ok(after);
    const replanned = outcomePlan(before, after);
    for (const id of ['cmt_a', 'cmt_b'] as const) {
      assert.deepEqual(placementOf(replanned, id), placementOf(before.plan, id), `${id} must not move`);
    }
    for (const id of TASKS) {
      assert.ok(
        !inside(placementOf(replanned, id), HINT_SPAN),
        `a user who has not consented must not have ${id} moved into the kept window`,
      );
    }
  });
});
