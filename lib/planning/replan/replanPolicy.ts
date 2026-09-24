/**
 * Continuous replanning policy and user-control layer (#523, slice 2).
 *
 * Evaluates what should happen to a newly computed plan based on its diff against
 * the current plan and the user's control mode.
 *
 * ── User control modes and safety ──────────────────────────────────
 *
 * The product principle is "narrow and test" while keeping the user in control:
 *
 *  - Under `automatic_time_only`: minor time shifts within a tight churn budget
 *    are applied automatically to keep the schedule realistic. But if an item
 *    is dropped (`removed`), a new commitment is added (`added`), or churn
 *    exceeds `maxAutoChurnMinutes`, the policy refuses to overwrite silently and
 *    escalates to `propose_for_review`.
 *  - Under `always_require_confirmation`: every replan is staged as a proposal
 *    requiring explicit confirmation. **The default** since #611's council
 *    decision (2026-09-24), and the only mode any account reaches today.
 *  - Under `silent_auto`: applies autonomously even with large churn, intended
 *    for fully autonomous operation.
 *
 * Pure: no clock, no persistence, no side effects.
 */

import type { PlanDiff } from '../../../src/contracts/v1/planningContracts';
import {
  CONTINUOUS_REPLAN_POLICY,
  type ReplanPolicyAction,
  type ReplanPolicyConfig,
  type ReplanPolicyDecision,
  type ReplanPolicyReason,
} from '../../../src/contracts/v1/replanContracts';

/** Computes the total absolute shift in minutes across all moved items in a diff. */
export function computeDiffChurnMinutes(diff: PlanDiff): number {
  let churn = 0;
  for (const change of diff.changes) {
    if (change.kind === 'moved') {
      churn += Math.abs(change.shiftMinutes);
    }
  }
  return churn;
}

export function evaluateReplanPolicy(
  diff: PlanDiff,
  config: ReplanPolicyConfig,
): ReplanPolicyDecision {
  const mode = config.userControlMode;

  const decision = (action: ReplanPolicyAction, reason: ReplanPolicyReason): ReplanPolicyDecision =>
    Object.freeze({
      action,
      reason,
      userControlMode: mode,
      diff,
    });

  // Rule 1: No actual changes (empty diff or every item is unchanged).
  const hasStructuralChange = diff.changes.some((change) => change.kind !== 'unchanged');
  if (!hasStructuralChange) {
    return decision('discard', 'no_changes');
  }

  // Rule 2: User explicitly requested confirmation on every replan.
  if (mode === 'always_require_confirmation') {
    return decision('propose_for_review', 'user_requires_confirmation');
  }

  // Rule 3: Any removed item means a commitment was dropped or pushed past horizon.
  // Never drop work silently.
  if (diff.changes.some((change) => change.kind === 'removed')) {
    return decision('propose_for_review', 'contains_removals');
  }

  // Rule 4: New items scheduled. Under automatic_time_only, adding work to a person's
  // day requires their review.
  if (mode === 'automatic_time_only' && diff.changes.some((change) => change.kind === 'added')) {
    return decision('propose_for_review', 'contains_additions');
  }

  // Rule 5: Churn threshold. Too many moved minutes in a day creates disorientation.
  const churnMinutes = computeDiffChurnMinutes(diff);
  const maxChurn = config.maxAutoChurnMinutes ?? CONTINUOUS_REPLAN_POLICY.defaultMaxAutoChurnMinutes;
  if (mode !== 'silent_auto' && churnMinutes > maxChurn) {
    return decision('propose_for_review', 'churn_exceeded_threshold');
  }

  // Rule 6: Feasible time shift within bounds.
  return decision('auto_apply', 'time_shift_within_threshold');
}

