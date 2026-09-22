/**
 * Incremental replanning contracts (#524, slice 1): the patch.
 *
 * The issue's pipeline is: identify directly affected blocks → expand through
 * hard dependency edges → freeze the rest → re-solve only the impacted set →
 * validate → diff → widen the neighborhood deterministically on infeasibility →
 * escalate to a full replan only when widening is exhausted. This file
 * contracts the artifact that pipeline produces — the `IncrementalPlanPatch`.
 * The stale-generation guard the fields below enable lives at the apply
 * boundary (`lib/services/dailyPlan/incrementalPlanApply.ts`), not in the
 * contract.
 *
 * ── Nothing here is a second diff ──────────────────────────────────
 *
 * `diff` is the canonical `PlanDiff` from `planningContracts` (#30), carried
 * as-is. The issue is explicit: PlanDiff already exists, churnMinutes already
 * exists, use them, do not create PlanDiffV2. The patch adds *provenance and
 * scope* around that diff — which generation it applies to, which changes
 * caused it, which blocks were allowed to move — and adds nothing to the diff
 * vocabulary itself.
 *
 * ── The frozen invariant ───────────────────────────────────────────
 *
 * `impactedBlockIds` and `frozenBlockIds` are a partition of the plan's
 * blocks: every block is in exactly one. A frozen block's placement must
 * remain byte-identical between base and result generations — the issue's
 * stated invariant — and the follow-up slice enforces that by entering frozen
 * blocks as fixed constraints, not by trusting the solver to leave them alone.
 *
 * ── Concurrency ────────────────────────────────────────────────────
 *
 * `baseGeneration` + the base input digest are the apply-time guard the issue
 * contracts: a patch applies only while the stored plan is still the
 * generation it was computed from. The guard itself lives in the apply path
 * (`replaceStoredPlanIfBaseMatches`, driven by `applyIncrementalPlanPatch`);
 * the fields exist so the patch computed today is checkable at the
 * persistence boundary tomorrow.
 */

import { MODULE_CONTRACT_VERSION } from './moduleContracts';
import type { PlanDiff } from './planningContracts';

export const INCREMENTAL_REPLAN_CONTRACT_VERSION = MODULE_CONTRACT_VERSION;
export const INCREMENTAL_PLAN_PATCH_SCHEMA_VERSION = 'incremental-plan-patch-v1' as const;

/**
 * How the result was produced.
 *
 *  - `incremental` — the impact closure as first computed was re-solved
 *    feasibly; frozen blocks never entered the solver as movable work.
 *  - `expanded_incremental` — the first closure had no feasible patch, so the
 *    neighborhood was widened (step 7) and the wider set was re-solved. The
 *    widened membership is visible in `impactedBlockIds`; the mode records
 *    that widening happened.
 *  - `full_fallback` — expansion still could not place the closure, and the
 *    whole plan was regenerated (step 8). `frozenBlockIds` is empty by
 *    definition: nothing was frozen. `fallbackReason` says why, as a code —
 *    the audit trail the #523 lane set the pattern for.
 */
export const INCREMENTAL_PATCH_MODES = Object.freeze([
  'incremental',
  'expanded_incremental',
  'full_fallback',
] as const);

export type IncrementalPatchMode = (typeof INCREMENTAL_PATCH_MODES)[number];

/**
 * One incremental replan, as a patch against a specific plan generation.
 *
 * `causeChangeIds` ties the patch to the normalized `PlanningStateChange`s
 * (#523) that triggered it — ids only, since the change contract is
 * content-free and the patch inherits that rule.
 */
export interface IncrementalPlanPatch {
  readonly schemaVersion: typeof INCREMENTAL_PLAN_PATCH_SCHEMA_VERSION;
  readonly scopeId: string;
  /** The generation of the plan this patch was computed against. */
  readonly baseGeneration: number;
  /** The generation the plan has once this patch applies. */
  readonly resultGeneration: number;
  readonly causeChangeIds: readonly string[];
  /** Blocks the solver was asked to re-place. Sorted by blockId. */
  readonly impactedBlockIds: readonly string[];
  /** Blocks entered as fixed constraints; byte-identical placement. Sorted. */
  readonly frozenBlockIds: readonly string[];
  /** The canonical plan diff (#30) between base and result. */
  readonly diff: PlanDiff;
  readonly mode: IncrementalPatchMode;
  /** Why the mode escalated past `incremental`; null when it did not. */
  readonly fallbackReason: string | null;
}

export const INCREMENTAL_REPLAN_POLICY = Object.freeze({
  /** The issue's invariant: a frozen block's placement cannot drift. */
  frozenBlocksByteIdentical: true,
  /** A patch computed against a stale generation is recomputed, never applied. */
  staleGenerationPatchApplicable: false,
  /** The diff is #30's PlanDiff; no second diff vocabulary exists. */
  newDiffContractCreated: false,
  /** Patching re-places blocks; it never edits canonical Commitments. */
  commitmentWritesAllowed: false,
  /** Every instant and id arrives as input; the closure reads no clock. */
  ambientClockAllowed: false,
});
