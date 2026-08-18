/**
 * Candidate policies, and the difference between two of them (Sprint 05, #23).
 *
 * `DEFAULT_PRIORITY_POLICY` is frozen this sprint, and a shadow comparison
 * needs something to compare it *to*. That something is built here: a new
 * policy object derived from a base plus explicit overrides, carrying its own
 * version.
 *
 * Two things this module is deliberately not:
 *
 *  - **It is not a config swap.** Nothing here mutates the base; `derivePolicy`
 *    returns a new frozen object, and the shipped policy is unreachable from a
 *    shadow run. A candidate exists to be measured, not installed. Installing
 *    one is a separate, deliberate act that has to move `priorityPolicy.ts` and
 *    fail the policy-freeze test in review.
 *  - **It is not a search.** Choosing which candidate to try belongs to the
 *    calibration pipeline (#22). This module only constructs the one it is
 *    handed and reports how it differs.
 *
 * ## Why the delta is computed structurally rather than by diffing JSON
 *
 * `policyDelta` exists to answer one question for the cause split in
 * `shadowComparison.ts`: *which features did the tuning re-weight?* A JSON diff
 * would answer "these keys changed", which is not the same thing. `bandCap` and
 * `reasonBase` change scores without being about any feature; `importanceHigh`
 * is about exactly one. The mapping below is what turns a set of changed keys
 * into a set of changed features, and it is exhaustive by construction —
 * `WEIGHT_FEATURES` is typed over every key of `PriorityPolicy['weights']`, so
 * adding a weight to the contract without classifying it fails to compile.
 */
import type { PriorityPolicy, PriorityReason } from '../../../src/contracts/v1/priorityContracts';

export type PolicyWeightKey = keyof PriorityPolicy['weights'];

/** The four features the scorer actually weights. */
export type WeightedFeatureName = 'urgency' | 'importance' | 'lateness' | 'userPressure';

/**
 * Which feature each weight governs.
 *
 * Typed as a total record, so a new weight in the contract cannot be added
 * without deciding which feature it belongs to — the alternative is a weight
 * that silently governs nothing and can never make a disagreement read as
 * missing context.
 */
export const WEIGHT_FEATURES: Readonly<Record<PolicyWeightKey, WeightedFeatureName>> = Object.freeze({
  urgencyOverduePerHour: 'urgency',
  urgencyOverdueMax: 'urgency',
  urgencyDueSoonMax: 'urgency',
  importanceHigh: 'importance',
  importanceNormal: 'importance',
  latenessPerSnooze: 'lateness',
  latenessSnoozeMax: 'lateness',
  latenessPostponed: 'lateness',
  latenessDeferred: 'lateness',
  userPressureRecent: 'userPressure',
  userPressureStale: 'userPressure',
});

/** Emission order, so two runs over the same policies list keys identically. */
const WEIGHT_KEY_ORDER: readonly PolicyWeightKey[] = Object.freeze([
  'urgencyOverduePerHour',
  'urgencyOverdueMax',
  'urgencyDueSoonMax',
  'importanceHigh',
  'importanceNormal',
  'latenessPerSnooze',
  'latenessSnoozeMax',
  'latenessPostponed',
  'latenessDeferred',
  'userPressureRecent',
  'userPressureStale',
]);

const FEATURE_ORDER: readonly WeightedFeatureName[] = Object.freeze([
  'urgency',
  'importance',
  'lateness',
  'userPressure',
]);

const REASON_ORDER: readonly PriorityReason[] = Object.freeze(['overdue', 'due_soon', 'active', 'pending']);

export interface PolicyPerturbation {
  /** Required. A candidate that reused the base's version would produce scores that lie about which policy made them. */
  readonly version: string;
  readonly weights?: Partial<PriorityPolicy['weights']>;
  readonly reasonBase?: Partial<Record<PriorityReason, number>>;
  readonly bandCap?: number;
  readonly totalCap?: number;
}

/**
 * A new policy: the base, with the named overrides applied, under a new
 * version. Frozen for the same reason the default is — a shared object someone
 * mutates in place would change every comparison that already holds a reference
 * to it, and its version would stop describing it.
 */
export function derivePolicy(base: PriorityPolicy, perturbation: PolicyPerturbation): PriorityPolicy {
  if (typeof perturbation.version !== 'string' || perturbation.version.trim().length === 0) {
    throw new TypeError('derivePolicy: a candidate policy must carry a non-empty version');
  }

  return Object.freeze({
    version: perturbation.version,
    reasonBase: Object.freeze({ ...base.reasonBase, ...(perturbation.reasonBase ?? {}) }),
    bandCap: perturbation.bandCap ?? base.bandCap,
    totalCap: perturbation.totalCap ?? base.totalCap,
    weights: Object.freeze({ ...base.weights, ...(perturbation.weights ?? {}) }),
  });
}

export interface PolicyDelta {
  /** Weight keys whose values differ, in contract order. */
  readonly changedWeightKeys: readonly PolicyWeightKey[];
  /** Base scores and caps that differ. These govern no feature. */
  readonly changedStructuralKeys: readonly string[];
  /** The features the changed weights govern. The input to the cause split. */
  readonly changedFeatures: readonly WeightedFeatureName[];
  /** True when the two policies score identically, whatever their versions say. */
  readonly identical: boolean;
}

/**
 * What moved between two policies.
 *
 * `version` is deliberately excluded from `identical`: renaming a policy does
 * not change a single score, and a comparison that called that a difference
 * would report every rename as a potential regression.
 */
export function policyDelta(baseline: PriorityPolicy, candidate: PriorityPolicy): PolicyDelta {
  const changedWeightKeys = WEIGHT_KEY_ORDER.filter((key) => baseline.weights[key] !== candidate.weights[key]);

  const changedStructuralKeys: string[] = [];
  if (baseline.bandCap !== candidate.bandCap) changedStructuralKeys.push('bandCap');
  if (baseline.totalCap !== candidate.totalCap) changedStructuralKeys.push('totalCap');
  for (const reason of REASON_ORDER) {
    if (baseline.reasonBase[reason] !== candidate.reasonBase[reason]) {
      changedStructuralKeys.push(`reasonBase.${reason}`);
    }
  }

  const changedFeatures = FEATURE_ORDER.filter((feature) =>
    changedWeightKeys.some((key) => WEIGHT_FEATURES[key] === feature),
  );

  return {
    changedWeightKeys,
    changedStructuralKeys,
    changedFeatures,
    identical: changedWeightKeys.length === 0 && changedStructuralKeys.length === 0,
  };
}
