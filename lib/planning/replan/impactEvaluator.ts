/**
 * The ImpactEvaluator (#523, slice 1).
 *
 * One pure function: a normalized `PlanningStateChange`, the current plan
 * reduced to a `PlanImpactView`, and the changed entity's post-change facts go
 * in; a `PlanImpact` comes out. No clock, no randomness, no storage, no
 * scheduler — the same inputs always produce the same decision, which is what
 * makes the decision safe to dedupe and to audit.
 *
 * ── The rules, in the order they apply ─────────────────────────────
 *
 * Each rule is stated next to the code that implements it, because the order
 * is the semantics:
 *
 *  1. **Digests unchanged → NO_EFFECT.** The digests hash normalized
 *     planner-facing state (see `replanContracts`), so equality means the
 *     planner's input did not move — the WHOOP-payload example from the issue.
 *  2. **Only known non-planning fields → NO_EFFECT.** A description edit
 *     cannot move an interval. This rule precedes every geometric check on
 *     purpose: the evaluator judges *the change*, and a metadata edit that
 *     happens to describe an already-overlapping event is still a metadata
 *     edit — the overlap was reported by the change that created it.
 *  3. **No current plan → NO_EFFECT.** Nothing exists for the change to make
 *     stale; a first plan is built, not replanned.
 *  4. **Different scope → NO_EFFECT.** A plan answers its own scope only.
 *  5. **Interval outside the horizon → NO_EFFECT.** An event next week cannot
 *     move today's placements or today's capacity.
 *  6. **Blocking interval overlapping a scheduled block's reserved interval →
 *     REPLAN_REQUIRED.** The one tier that directly invalidates a placement,
 *     and the only one that ever justifies a replan request downstream.
 *  7. **Everything else → PLAN_STALE.** A planner input moved (a cancellation
 *     freed capacity, a deadline shifted, a band changed, a field nobody
 *     recognises was declared) but no placement is directly contradicted.
 *     Conservative by design: the fall-through is the safe answer, never the
 *     dismissive one.
 *
 * Rules 1–5 are the `NO_EFFECT` half of the issue's acceptance criterion
 * ("non-planning metadata changes trigger zero planner calls"); rules 6–7
 * are the half that can never silently drop a real change.
 */

import type { PlanningStateChange } from '../../../src/contracts/v1/watcherContracts';
import {
  NON_PLANNING_CHANGE_FIELDS,
  type ChangedEntityFacts,
  type PlanImpact,
  type PlanImpactDecision,
  type PlanImpactView,
} from '../../../src/contracts/v1/replanContracts';
import { intervalsOverlap } from '../shared/time';

export interface ImpactEvaluationInput {
  readonly change: PlanningStateChange;
  /** The current plan in the change's scope; null when none exists. */
  readonly plan: PlanImpactView | null;
  /**
   * The changed entity's post-change time facts, when the source occupies
   * time. Null for non-temporal sources (readiness, habit policy, watcher).
   */
  readonly entity: ChangedEntityFacts | null;
}

const NON_PLANNING_FIELDS: ReadonlySet<string> = new Set(NON_PLANNING_CHANGE_FIELDS);

/** Severity order, so a burst's verdict is the maximum of its members'. */
const DECISION_SEVERITY: Readonly<Record<PlanImpactDecision, number>> = {
  NO_EFFECT: 0,
  PLAN_STALE: 1,
  REPLAN_REQUIRED: 2,
};

export function evaluateStateChangeImpact(input: ImpactEvaluationInput): PlanImpact {
  const { change, plan, entity } = input;

  const answer = (decision: PlanImpact['decision'], reason: PlanImpact['reason']): PlanImpact =>
    Object.freeze({ changeId: change.changeId, scopeId: change.scopeId, decision, reason });

  // Rule 1 — the normalized planner input did not move.

  // Rule 1 — the normalized planner input did not move.
  if (change.beforeDigest !== null && change.beforeDigest === change.afterDigest) {
    return answer('NO_EFFECT', 'digests_unchanged');
  }

  // Rule 2 — every declared field is known non-planning metadata. An empty
  // `changedFields` deliberately does not qualify: a change that declares
  // nothing has told us nothing, and silence is not metadata.
  if (change.changedFields.length > 0
    && change.changedFields.every((field) => NON_PLANNING_FIELDS.has(field))) {
    return answer('NO_EFFECT', 'non_planning_fields_only');
  }

  // Rule 3 — there is no plan for the change to affect.
  if (plan === null) return answer('NO_EFFECT', 'no_current_plan');

  // Rule 4 — a plan answers its own scope.
  if (plan.scopeId !== change.scopeId) return answer('NO_EFFECT', 'different_scope');

  // Rule 5 — the entity's span never enters the window this plan covers.
  const interval = entity?.interval ?? null;
  if (interval !== null && !intervalsOverlap(interval, plan.horizon)) {
    return answer('NO_EFFECT', 'outside_horizon');
  }

  // Rule 6 — the one direct contradiction: new blocking time on top of a
  // placement the current plan makes. Reserved intervals, per PlanImpactView.
  if (entity !== null && entity.blocking && interval !== null
    && plan.scheduled.some((placed) => intervalsOverlap(interval, placed.reservedInterval))) {
    return answer('REPLAN_REQUIRED', 'overlaps_scheduled_block');
  }

  // Rule 7 — a planner input moved; nothing above could clear it.
  return answer('PLAN_STALE', 'planner_input_changed');
}

/**
 * The verdict of a set of impacts: the most severe decision any member
 * earned. `NO_EFFECT` over an empty set, for the reason
 * `computePlanQualityMetrics` gives its own empty denominators — the question
 * has a correct answer, and a caller that had to branch on absence would
 * branch forever.
 */
export function combineImpactDecisions(impacts: readonly PlanImpact[]): PlanImpactDecision {
  let decision: PlanImpactDecision = 'NO_EFFECT';
  for (const impact of impacts) {
    if (DECISION_SEVERITY[impact.decision] > DECISION_SEVERITY[decision]) {
      decision = impact.decision;
    }
  }
  return decision;
}
