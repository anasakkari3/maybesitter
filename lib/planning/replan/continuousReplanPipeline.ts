/**
 * Continuous replanning pipeline coordinator (#523, slice 2).
 *
 * Implements the complete pipeline:
 * normalized state change → ImpactEvaluator → {NO_EFFECT | PLAN_STALE | REPLAN_REQUIRED}
 *   → deduped enqueue → canonical planner → PlanDiff → policy/user-control layer.
 *
 * ── Invariants ─────────────────────────────────────────────────────
 *
 *  - Pure: no ambient clock, no storage, no direct network calls. Takes `now`
 *    and caller-supplied `planner` function.
 *  - Reuses the canonical `schedulePlan` solver via the injected planner closure.
 *  - Reuses the canonical `PlanDiff` from `diffPlans`.
 *  - Maps plan status directly to the `UserPlanStatus` of `UserStateProjection`
 *    without inventing a new user state model.
 *  - Reuses `coalescePlanningStateChanges` from slice 1 for burst deduplication.
 */

import type { Plan, PlanDiff } from '../../../src/contracts/v1/planningContracts';
import type { PlanningStateChange } from '../../../src/contracts/v1/watcherContracts';
import type { UserPlanStatus } from '../../../src/contracts/v1/userStateProjectionContracts';
import {
  CONTINUOUS_REPLAN_POLICY,
  type ChangedEntityFacts,
  type ContinuousReplanPipelineResult,
  type PlanImpact,
  type PlanImpactView,
  type ReplanPolicyConfig,
  type ReplanQueueEntry,
  type ReplanRequest,
} from '../../../src/contracts/v1/replanContracts';
import { diffPlans } from '../scheduler/diff';
import { compareByCodePoint } from '../shared/compare';
import { coalescePlanningStateChanges } from './coalescing';
import { enqueueReplanRequest } from './dedupQueue';
import { combineImpactDecisions, evaluateStateChangeImpact } from './impactEvaluator';
import { evaluateReplanPolicy } from './replanPolicy';

export interface ContinuousReplanPipelineInput {
  readonly changes: readonly PlanningStateChange[];
  readonly planView: PlanImpactView | null;
  readonly entityFacts: ChangedEntityFacts | null;
  readonly basePlan: Plan | null;
  /**
   * The canonical planner solve. Receives the accumulated cause change IDs.
   */
  readonly planner: (causeChangeIds: readonly string[]) => { plan: Plan; diff?: PlanDiff };
  readonly policyConfig?: Partial<ReplanPolicyConfig>;
  readonly queueState?: readonly ReplanQueueEntry[];
  readonly scopeId: string;
  readonly date: string;
  readonly now: string;
  readonly requestId?: string;
  readonly baseGeneration?: number;
}

export function executeContinuousReplanPipeline(
  input: ContinuousReplanPipelineInput,
): ContinuousReplanPipelineResult {
  const {
    changes,
    planView,
    entityFacts,
    basePlan,
    planner,
    scopeId,
    date,
    now,
  } = input;

  const fullPolicyConfig: ReplanPolicyConfig = {
    userControlMode: input.policyConfig?.userControlMode ?? CONTINUOUS_REPLAN_POLICY.defaultUserControlMode,
    maxAutoChurnMinutes: input.policyConfig?.maxAutoChurnMinutes ?? CONTINUOUS_REPLAN_POLICY.defaultMaxAutoChurnMinutes,
    replanOnStale: input.policyConfig?.replanOnStale ?? CONTINUOUS_REPLAN_POLICY.replanOnStaleDefault,
  };

  // Step 1: Burst coalescing & Impact Evaluation
  const coalesced = coalescePlanningStateChanges(changes);

  let primaryImpact: PlanImpact;
  if (coalesced.length === 0) {
    primaryImpact = Object.freeze({
      changeId: 'none',
      scopeId,
      decision: 'NO_EFFECT',
      reason: 'digests_unchanged',
    });
  } else {
    const impacts = coalesced.map((group) =>
      evaluateStateChangeImpact({
        change: group.representative,
        plan: planView,
        entity: entityFacts,
      }),
    );

    const overallDecision = combineImpactDecisions(impacts);
    // Select the representative impact matching the overall decision (highest severity)
    primaryImpact = impacts.find((imp) => imp.decision === overallDecision) ?? impacts[0]!;
  }

  // Step 2: Decision Branching
  if (primaryImpact.decision === 'NO_EFFECT') {
    return Object.freeze({
      scopeId,
      date,
      impact: primaryImpact,
      enqueued: false,
      queueEntry: null,
      basePlan,
      newPlan: null,
      diff: null,
      policyDecision: null,
      planStatus: planView ? 'accepted' : 'none',
    });
  }

  if (primaryImpact.decision === 'PLAN_STALE' && !fullPolicyConfig.replanOnStale) {
    // In continuous replanning, PLAN_STALE marks the plan as stale in the user's state
    // without triggering an intrusive replan by default.
    return Object.freeze({
      scopeId,
      date,
      impact: primaryImpact,
      enqueued: false,
      queueEntry: null,
      basePlan,
      newPlan: null,
      diff: null,
      policyDecision: null,
      planStatus: 'stale',
    });
  }

  // Step 3: Deduped enqueue
  const allChangeIds = Array.from(new Set(changes.map((c) => c.changeId))).sort(compareByCodePoint);

  const request: ReplanRequest = {
    requestId: input.requestId ?? `replan-${date}-${scopeId}`,
    scopeId,
    date,
    trigger: primaryImpact.reason === 'overlaps_scheduled_block' ? 'event_impact' : 'stale_refresh',
    causeChangeIds: Object.freeze(allChangeIds),
    enqueuedAt: now,
    priority: 'immediate',
    status: 'in_progress',
    baseGeneration: input.baseGeneration,
  };

  const { entry } = enqueueReplanRequest(input.queueState ?? [], request);

  // Step 4: Canonical planner
  const plannerOutput = planner(entry.request.causeChangeIds);
  const newPlan = plannerOutput.plan;

  // Step 5: PlanDiff (using canonical diffPlans)
  const diff =
    plannerOutput.diff ??
    (basePlan ? diffPlans(basePlan, newPlan) : diffPlans(newPlan, newPlan));

  // Step 6: Policy / user-control layer
  const policyDecision = evaluateReplanPolicy(diff, fullPolicyConfig);

  // Step 7: Map policy action to user plan status projection
  let planStatus: UserPlanStatus;
  switch (policyDecision.action) {
    case 'auto_apply':
      planStatus = 'accepted';
      break;
    case 'propose_for_review':
      planStatus = 'proposed';
      break;
    case 'discard':
      planStatus = basePlan ? 'accepted' : 'none';
      break;
  }

  return Object.freeze({
    scopeId,
    date,
    impact: primaryImpact,
    enqueued: true,
    queueEntry: entry,
    basePlan,
    newPlan,
    diff,
    policyDecision,
    planStatus,
  });
}
