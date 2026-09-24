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
  /**
   * Each change's own post-change facts, keyed by `changeId` (#605).
   *
   * A coalesced group is judged on its representative's entry. That is sound
   * because a group's members share scope, source, entity and `afterDigest`
   * (`coalescing.ts`'s burst key), so they describe one entity in one state. An absent key is null: the change is
   * judged on its digests and fields alone.
   *
   * This replaced a single `entityFacts` applied to every group in the batch.
   * It had no honest value for a batch of two different entities: whatever was
   * passed, one change was judged by another's interval.
   */
  readonly entityFactsByChangeId: ReadonlyMap<string, ChangedEntityFacts | null>;
  readonly basePlan: Plan | null;
  /**
   * The day the pending, unanswered proposal would install, or null when
   * nothing is on offer (#611 guards).
   *
   * Each change is judged against this as well as against `planView`. A patch
   * is solved against the calendar as it stood then, and a meeting that lands
   * where the patch would put a task overlaps nothing the person has on their
   * day yet: judged against `planView` alone it is `PLAN_STALE`, is drained,
   * and leaves the patch acceptable with a task under the meeting. So a
   * change's verdict is the more severe of its two, and one that is severe
   * only against the offer is recorded as `overlaps_proposed_block`.
   *
   * While an offer is pending, `PLAN_STALE` re-solves as well, whatever
   * `replanOnStale` says. The offer was solved against inputs that have just
   * moved, and re-solving is the only way to learn whether it still holds: the
   * service then replaces it, keeps it (the same placement), or withdraws it
   * (the day needs no change any more). Without an offer, `replanOnStale`
   * decides as before.
   */
  readonly pendingView?: PlanImpactView | null;
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

const SEVERITY: Readonly<Record<PlanImpact['decision'], number>> = { NO_EFFECT: 0, PLAN_STALE: 1, REPLAN_REQUIRED: 2 };

/**
 * One change's verdict, judged against the visible day and against the
 * pending offer (#611 guards): the more severe of the two.
 *
 * The day's verdict wins a tie, so a change that contradicts both is still
 * recorded as contradicting the person's day. Only the offer's overlap is
 * renamed: every other reason the evaluator gives depends on the change alone
 * or on the horizon, which the two views share, so it reads the same against
 * either.
 */
function moreSevere(againstDay: PlanImpact, againstOffer: PlanImpact): PlanImpact {
  if (SEVERITY[againstOffer.decision] <= SEVERITY[againstDay.decision]) return againstDay;
  if (againstOffer.reason !== 'overlaps_scheduled_block') return againstOffer;
  return Object.freeze({ ...againstOffer, reason: 'overlaps_proposed_block' as const });
}

export function executeContinuousReplanPipeline(
  input: ContinuousReplanPipelineInput,
): ContinuousReplanPipelineResult {
  const {
    changes,
    planView,
    entityFactsByChangeId,
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
  /**
   * Each coalesced group's own verdict, kept beside the group it judged.
   *
   * The pipeline has always computed these and thrown all but one away. They
   * are retained now because `impactingChangeIds` is derived from them, and
   * deriving it anywhere else would mean evaluating the same changes a second
   * time — two answers to one question, free to drift.
   */
  let groupImpacts: readonly { readonly changeIds: readonly string[]; readonly impact: PlanImpact }[] = [];
  if (coalesced.length === 0) {
    primaryImpact = Object.freeze({
      changeId: 'none',
      scopeId,
      decision: 'NO_EFFECT',
      reason: 'digests_unchanged',
    });
  } else {
    const pendingView = input.pendingView ?? null;
    groupImpacts = coalesced.map((group) => {
      const entity = entityFactsByChangeId.get(group.representative.changeId) ?? null;
      const againstDay = evaluateStateChangeImpact({ change: group.representative, plan: planView, entity });
      return {
        changeIds: group.changeIds,
        impact: pendingView === null
          ? againstDay
          : moreSevere(againstDay, evaluateStateChangeImpact({ change: group.representative, plan: pendingView, entity })),
      };
    });
    const impacts = groupImpacts.map((entry) => entry.impact);

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
      impactingChangeIds: Object.freeze([]),
      basePlan,
      newPlan: null,
      diff: null,
      policyDecision: null,
      planStatus: planView ? 'accepted' : 'none',
    });
  }

  // An offer on the table re-solves on a stale verdict too; see `pendingView`.
  const offerPending = (input.pendingView ?? null) !== null;
  if (primaryImpact.decision === 'PLAN_STALE' && !fullPolicyConfig.replanOnStale && !offerPending) {
    // In continuous replanning, PLAN_STALE marks the plan as stale in the user's state
    // without triggering an intrusive replan by default.
    return Object.freeze({
      scopeId,
      date,
      impact: primaryImpact,
      enqueued: false,
      queueEntry: null,
      impactingChangeIds: Object.freeze([]),
      basePlan,
      newPlan: null,
      diff: null,
      policyDecision: null,
      planStatus: 'stale',
    });
  }

  // Step 3: Deduped enqueue
  const allChangeIds = Array.from(new Set(changes.map((c) => c.changeId))).sort(compareByCodePoint);

  /**
   * The subset that actually earned the replan, for attribution (#527, AC 2).
   *
   * `allChangeIds` above is the whole batch and stays that way: it is what the
   * request subsumes, and the queue, the planner closure and the dedupe all
   * keep reading exactly what they read before. This narrower set is derived
   * beside it and used by nothing in this pipeline.
   */
  const impactingChangeIds = Object.freeze(
    Array.from(
      new Set(
        groupImpacts
          .filter((entry) => entry.impact.decision === primaryImpact.decision)
          .flatMap((entry) => entry.changeIds),
      ),
    ).sort(compareByCodePoint),
  );

  const request: ReplanRequest = {
    requestId: input.requestId ?? `replan-${date}-${scopeId}`,
    scopeId,
    date,
    trigger: primaryImpact.reason === 'overlaps_scheduled_block' || primaryImpact.reason === 'overlaps_proposed_block'
      ? 'event_impact'
      : 'stale_refresh',
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
    impactingChangeIds,
    basePlan,
    newPlan,
    diff,
    policyDecision,
    planStatus,
  });
}
