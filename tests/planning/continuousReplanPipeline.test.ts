/**
 * Continuous replanning pipeline tests (#523, slice 2).
 *
 * Exercises the end-to-end pipeline:
 * normalized state change → ImpactEvaluator → {NO_EFFECT | PLAN_STALE | REPLAN_REQUIRED}
 *   → deduped enqueue → canonical planner → PlanDiff → policy/user-control layer.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLANNING_CONTRACT_VERSION,
  PLANNING_SCHEMA_VERSION,
  type Plan,
  type PlannedItem,
  type PlanningHorizon,
  type TimeInterval,
} from '../../src/contracts/v1/planningContracts';
import type { PlanningStateChange } from '../../src/contracts/v1/watcherContracts';
import {
  executeContinuousReplanPipeline,
  enqueueReplanRequest,
  dequeueNextReplanRequest,
  evaluateReplanPolicy,
  computeDiffChurnMinutes,
} from '../../lib/planning/replan';
import { diffPlans } from '../../lib/planning/scheduler/diff';

const SCOPE_ID = 'test-user-1';
const DATE = '2026-11-09';
const NOW = '2026-11-09T08:00:00.000Z';

function interval(startsAt: string, endsAt: string): TimeInterval {
  return { startsAt, endsAt };
}

function horizon(startsAt = '2026-11-09T00:00:00.000Z', endsAt = '2026-11-09T23:59:59.999Z'): PlanningHorizon {
  return { startsAt, endsAt };
}

function planned(itemId: string, startsAt: string, endsAt: string): PlannedItem {
  return {
    itemId,
    interval: interval(startsAt, endsAt),
    reservedInterval: interval(startsAt, endsAt),
  };
}

function samplePlan(scheduled: PlannedItem[]): Plan {
  return {
    version: PLANNING_CONTRACT_VERSION,
    schema: PLANNING_SCHEMA_VERSION,
    scopeId: `${SCOPE_ID}:${DATE}`,
    horizon: horizon(),
    scheduled,
    unscheduled: [],
    constraintReasons: [],
    inputDigest: 'digest-base',
  };
}

function change(overrides: Partial<PlanningStateChange> = {}): PlanningStateChange {
  return {
    schemaVersion: 'planning-state-change-v1',
    changeId: overrides.changeId ?? 'chg-1',
    scopeId: overrides.scopeId ?? SCOPE_ID,
    source: overrides.source ?? 'calendar',
    entityId: overrides.entityId ?? 'evt-1',
    occurredAt: overrides.occurredAt ?? NOW,
    changedFields: overrides.changedFields ?? ['interval'],
    beforeDigest: overrides.beforeDigest ?? 'digest-before',
    afterDigest: overrides.afterDigest ?? 'digest-after',
    provenanceRef: overrides.provenanceRef ?? 'test:ref',
  };
}

/* ── Pure dedup queue tests ──────────────────────────────────────── */

test('enqueueReplanRequest coalesces multiple changes for the same scope and date', () => {
  const req1 = {
    requestId: 'req-1',
    scopeId: SCOPE_ID,
    date: DATE,
    trigger: 'event_impact' as const,
    causeChangeIds: ['chg-1'],
    enqueuedAt: '2026-11-09T08:00:00.000Z',
    priority: 'background' as const,
    status: 'enqueued' as const,
  };

  const { queue: q1, entry: e1, deduped: d1 } = enqueueReplanRequest([], req1);
  assert.equal(d1, false);
  assert.equal(q1.length, 1);
  assert.equal(e1.deduplicatedCount, 1);

  const req2 = {
    requestId: 'req-2',
    scopeId: SCOPE_ID,
    date: DATE,
    trigger: 'event_impact' as const,
    causeChangeIds: ['chg-2', 'chg-3'],
    enqueuedAt: '2026-11-09T08:00:10.000Z',
    priority: 'immediate' as const,
    status: 'enqueued' as const,
  };

  const { queue: q2, entry: e2, deduped: d2 } = enqueueReplanRequest(q1, req2);
  assert.equal(d2, true);
  assert.equal(q2.length, 1);
  assert.equal(e2.deduplicatedCount, 2);
  // Causes are merged and sorted
  assert.deepEqual(e2.request.causeChangeIds, ['chg-1', 'chg-2', 'chg-3']);
  // Priority escalated to immediate
  assert.equal(e2.request.priority, 'immediate');
});

test('dequeueNextReplanRequest orders by priority, then enqueuedAt', () => {
  const req1 = {
    requestId: 'req-bg',
    scopeId: SCOPE_ID,
    date: '2026-11-09',
    trigger: 'event_impact' as const,
    causeChangeIds: ['chg-1'],
    enqueuedAt: '2026-11-09T08:00:00.000Z',
    priority: 'background' as const,
    status: 'enqueued' as const,
  };

  const req2 = {
    requestId: 'req-imm',
    scopeId: SCOPE_ID,
    date: '2026-11-10',
    trigger: 'event_impact' as const,
    causeChangeIds: ['chg-2'],
    enqueuedAt: '2026-11-09T08:05:00.000Z',
    priority: 'immediate' as const,
    status: 'enqueued' as const,
  };

  let queue = enqueueReplanRequest([], req1).queue;
  queue = enqueueReplanRequest(queue, req2).queue;

  const { next, remaining } = dequeueNextReplanRequest(queue);
  assert.ok(next);
  assert.equal(next.request.requestId, 'req-imm', 'immediate request should dequeue first');
  assert.equal(remaining.length, 1);
});

/* ── Policy evaluation tests ─────────────────────────────────────── */

test('evaluateReplanPolicy discards when diff has no changes', () => {
  const base = samplePlan([planned('item-1', '2026-11-09T09:00:00.000Z', '2026-11-09T10:00:00.000Z')]);
  const diff = diffPlans(base, base);
  const decision = evaluateReplanPolicy(diff, { userControlMode: 'automatic_time_only' });
  assert.equal(decision.action, 'discard');
  assert.equal(decision.reason, 'no_changes');
});

test('evaluateReplanPolicy auto-applies minor time shift under automatic_time_only', () => {
  const base = samplePlan([planned('item-1', '2026-11-09T09:00:00.000Z', '2026-11-09T10:00:00.000Z')]);
  const next = samplePlan([planned('item-1', '2026-11-09T09:15:00.000Z', '2026-11-09T10:15:00.000Z')]);
  const diff = diffPlans(base, next);

  assert.equal(computeDiffChurnMinutes(diff), 15);
  const decision = evaluateReplanPolicy(diff, { userControlMode: 'automatic_time_only', maxAutoChurnMinutes: 60 });
  assert.equal(decision.action, 'auto_apply');
  assert.equal(decision.reason, 'time_shift_within_threshold');
});

test('evaluateReplanPolicy proposes for review when churn exceeds threshold', () => {
  const base = samplePlan([planned('item-1', '2026-11-09T09:00:00.000Z', '2026-11-09T10:00:00.000Z')]);
  const next = samplePlan([planned('item-1', '2026-11-09T11:00:00.000Z', '2026-11-09T12:00:00.000Z')]);
  const diff = diffPlans(base, next);

  assert.equal(computeDiffChurnMinutes(diff), 120);
  const decision = evaluateReplanPolicy(diff, { userControlMode: 'automatic_time_only', maxAutoChurnMinutes: 60 });
  assert.equal(decision.action, 'propose_for_review');
  assert.equal(decision.reason, 'churn_exceeded_threshold');
});

test('evaluateReplanPolicy proposes for review when item is removed', () => {
  const base = samplePlan([
    planned('item-1', '2026-11-09T09:00:00.000Z', '2026-11-09T10:00:00.000Z'),
    planned('item-2', '2026-11-09T10:00:00.000Z', '2026-11-09T11:00:00.000Z'),
  ]);
  const next = samplePlan([
    planned('item-1', '2026-11-09T09:00:00.000Z', '2026-11-09T10:00:00.000Z'),
  ]);
  const diff = diffPlans(base, next);
  const decision = evaluateReplanPolicy(diff, { userControlMode: 'automatic_time_only' });
  assert.equal(decision.action, 'propose_for_review');
  assert.equal(decision.reason, 'contains_removals');
});

test('evaluateReplanPolicy proposes for review when item is added under automatic_time_only', () => {
  const base = samplePlan([planned('item-1', '2026-11-09T09:00:00.000Z', '2026-11-09T10:00:00.000Z')]);
  const next = samplePlan([
    planned('item-1', '2026-11-09T09:00:00.000Z', '2026-11-09T10:00:00.000Z'),
    planned('item-2', '2026-11-09T10:00:00.000Z', '2026-11-09T11:00:00.000Z'),
  ]);
  const diff = diffPlans(base, next);
  const decision = evaluateReplanPolicy(diff, { userControlMode: 'automatic_time_only' });
  assert.equal(decision.action, 'propose_for_review');
  assert.equal(decision.reason, 'contains_additions');
});

test('always_require_confirmation mode always proposes for review', () => {
  const base = samplePlan([planned('item-1', '2026-11-09T09:00:00.000Z', '2026-11-09T10:00:00.000Z')]);
  const next = samplePlan([planned('item-1', '2026-11-09T09:05:00.000Z', '2026-11-09T10:05:00.000Z')]);
  const diff = diffPlans(base, next);
  const decision = evaluateReplanPolicy(diff, { userControlMode: 'always_require_confirmation' });
  assert.equal(decision.action, 'propose_for_review');
  assert.equal(decision.reason, 'user_requires_confirmation');
});

test('silent_auto mode auto-applies even when churn is high', () => {
  const base = samplePlan([planned('item-1', '2026-11-09T09:00:00.000Z', '2026-11-09T10:00:00.000Z')]);
  const next = samplePlan([planned('item-1', '2026-11-09T14:00:00.000Z', '2026-11-09T15:00:00.000Z')]);
  const diff = diffPlans(base, next);
  const decision = evaluateReplanPolicy(diff, { userControlMode: 'silent_auto', maxAutoChurnMinutes: 30 });
  assert.equal(decision.action, 'auto_apply');
  assert.equal(decision.reason, 'time_shift_within_threshold');
});

/* ── End-to-end continuous replan pipeline tests ──────────────────── */

test('pipeline: non-planning metadata change results in NO_EFFECT and zero planner calls', () => {
  let plannerCalls = 0;
  const base = samplePlan([planned('item-1', '2026-11-09T09:00:00.000Z', '2026-11-09T10:00:00.000Z')]);
  const planView = { scopeId: SCOPE_ID, horizon: horizon(), scheduled: base.scheduled };

  const result = executeContinuousReplanPipeline({
    changes: [change({ changedFields: ['title', 'description'] })],
    planView,
    entityFactsByChangeId: new Map([['chg-1', { interval: interval('2026-11-09T09:30:00.000Z', '2026-11-09T10:30:00.000Z'), blocking: true }]]),
    basePlan: base,
    planner: () => {
      plannerCalls += 1;
      return { plan: base };
    },
    scopeId: SCOPE_ID,
    date: DATE,
    now: NOW,
  });

  assert.equal(plannerCalls, 0, 'metadata change must trigger zero planner calls');
  assert.equal(result.impact.decision, 'NO_EFFECT');
  assert.equal(result.impact.reason, 'non_planning_fields_only');
  assert.equal(result.enqueued, false);
  assert.equal(result.newPlan, null);
  assert.equal(result.planStatus, 'accepted');
});

test('pipeline: PLAN_STALE flags plan status without replan by default', () => {
  let plannerCalls = 0;
  const base = samplePlan([planned('item-1', '2026-11-09T09:00:00.000Z', '2026-11-09T10:00:00.000Z')]);
  const planView = { scopeId: SCOPE_ID, horizon: horizon(), scheduled: base.scheduled };

  // An input changed (e.g. deadline changed) but it overlaps nothing scheduled
  const result = executeContinuousReplanPipeline({
    changes: [change({ changedFields: ['deadlineAt'] })],
    planView,
    entityFactsByChangeId: new Map([['chg-1', { interval: interval('2026-11-09T15:00:00.000Z', '2026-11-09T16:00:00.000Z'), blocking: false }]]),
    basePlan: base,
    planner: () => {
      plannerCalls += 1;
      return { plan: base };
    },
    scopeId: SCOPE_ID,
    date: DATE,
    now: NOW,
  });

  assert.equal(plannerCalls, 0, 'PLAN_STALE should not invoke planner by default');
  assert.equal(result.impact.decision, 'PLAN_STALE');
  assert.equal(result.enqueued, false);
  assert.equal(result.planStatus, 'stale');
});

test('pipeline: PLAN_STALE invokes planner when replanOnStale is true', () => {
  let plannerCalls = 0;
  const base = samplePlan([planned('item-1', '2026-11-09T09:00:00.000Z', '2026-11-09T10:00:00.000Z')]);
  const planView = { scopeId: SCOPE_ID, horizon: horizon(), scheduled: base.scheduled };

  const result = executeContinuousReplanPipeline({
    changes: [change({ changedFields: ['deadlineAt'] })],
    planView,
    entityFactsByChangeId: new Map(),
    basePlan: base,
    planner: () => {
      plannerCalls += 1;
      return { plan: base };
    },
    policyConfig: { replanOnStale: true },
    scopeId: SCOPE_ID,
    date: DATE,
    now: NOW,
  });

  assert.equal(plannerCalls, 1);
  assert.equal(result.enqueued, true);
});

test('pipeline: REPLAN_REQUIRED enqueues, plans, diffs, and auto-applies minor shift', () => {
  let plannerCalls = 0;
  const base = samplePlan([planned('item-1', '2026-11-09T09:00:00.000Z', '2026-11-09T10:00:00.000Z')]);
  const planView = { scopeId: SCOPE_ID, horizon: horizon(), scheduled: base.scheduled };

  // New blocking event lands directly on item-1's slot: 09:00-09:30
  const blockingCollision = {
    interval: interval('2026-11-09T09:00:00.000Z', '2026-11-09T09:30:00.000Z'),
    blocking: true,
  };

  // Planner shifts item-1 to 09:30-10:30 (30 min shift)
  const solved = samplePlan([planned('item-1', '2026-11-09T09:30:00.000Z', '2026-11-09T10:30:00.000Z')]);

  const result = executeContinuousReplanPipeline({
    changes: [change({ changedFields: ['interval', 'blocking'] })],
    planView,
    entityFactsByChangeId: new Map([['chg-1', blockingCollision]]),
    basePlan: base,
    planner: (causes) => {
      plannerCalls += 1;
      assert.deepEqual(causes, ['chg-1']);
      return { plan: solved };
    },
    policyConfig: { userControlMode: 'automatic_time_only', maxAutoChurnMinutes: 60 },
    scopeId: SCOPE_ID,
    date: DATE,
    now: NOW,
  });

  assert.equal(plannerCalls, 1);
  assert.equal(result.impact.decision, 'REPLAN_REQUIRED');
  assert.equal(result.impact.reason, 'overlaps_scheduled_block');
  assert.equal(result.enqueued, true);
  assert.ok(result.queueEntry);
  assert.ok(result.diff);
  assert.equal(result.diff.changes.length, 1);
  assert.equal(result.diff.changes[0]!.kind, 'moved');
  assert.ok(result.policyDecision);
  assert.equal(result.policyDecision.action, 'auto_apply');
  assert.equal(result.policyDecision.reason, 'time_shift_within_threshold');
  assert.equal(result.planStatus, 'accepted');
});

test('pipeline: REPLAN_REQUIRED with excessive churn escalates to propose_for_review', () => {
  const base = samplePlan([planned('item-1', '2026-11-09T09:00:00.000Z', '2026-11-09T10:00:00.000Z')]);
  const planView = { scopeId: SCOPE_ID, horizon: horizon(), scheduled: base.scheduled };

  const blockingCollision = {
    interval: interval('2026-11-09T09:00:00.000Z', '2026-11-09T10:00:00.000Z'),
    blocking: true,
  };

  // Planner moves item-1 to 14:00 (300 min shift)
  const solved = samplePlan([planned('item-1', '2026-11-09T14:00:00.000Z', '2026-11-09T15:00:00.000Z')]);

  const result = executeContinuousReplanPipeline({
    changes: [change({ changedFields: ['interval'] })],
    planView,
    entityFactsByChangeId: new Map([['chg-1', blockingCollision]]),
    basePlan: base,
    planner: () => ({ plan: solved }),
    policyConfig: { userControlMode: 'automatic_time_only', maxAutoChurnMinutes: 60 },
    scopeId: SCOPE_ID,
    date: DATE,
    now: NOW,
  });

  assert.equal(result.impact.decision, 'REPLAN_REQUIRED');
  assert.equal(result.policyDecision?.action, 'propose_for_review');
  assert.equal(result.policyDecision?.reason, 'churn_exceeded_threshold');
  assert.equal(result.planStatus, 'proposed');
});

test('pipeline: is deterministic with identical output across runs', () => {
  const base = samplePlan([planned('item-1', '2026-11-09T09:00:00.000Z', '2026-11-09T10:00:00.000Z')]);
  const planView = { scopeId: SCOPE_ID, horizon: horizon(), scheduled: base.scheduled };
  const input = {
    changes: [change({ changedFields: ['interval'] })],
    planView,
    entityFactsByChangeId: new Map([['chg-1', { interval: interval('2026-11-09T09:00:00.000Z', '2026-11-09T09:30:00.000Z'), blocking: true }]]),
    basePlan: base,
    planner: () => ({ plan: samplePlan([planned('item-1', '2026-11-09T09:30:00.000Z', '2026-11-09T10:30:00.000Z')]) }),
    scopeId: SCOPE_ID,
    date: DATE,
    now: NOW,
  };

  assert.deepEqual(executeContinuousReplanPipeline(input), executeContinuousReplanPipeline(input));
});
