/**
 * Applying an incremental plan patch (#524, slice 3): the stale-generation
 * guard at the persistence boundary.
 *
 * `planIncrementalPatch` computes a patch against a particular plan state;
 * this module is where such a patch meets the stored plan. The issue's rule
 * is that a patch applies only while the stored plan is still the generation
 * it was computed from, with the input digest to match — and that otherwise
 * the patch is recomputed from the newest state, never forced over it.
 *
 * ── Why the check lives in a transaction ─────────────────────────────
 *
 * A guard that reads the plan, compares generations, and then writes would be
 * an in-memory assertion about a state that can change between the read and
 * the write — two replan ticks race, or a phone edits while the job runs. The
 * comparison therefore happens inside `replaceStoredPlanIfBaseMatches`'s
 * transaction, which re-reads the document under the storage lock and refuses
 * the write unless generation *and* base input digest both still match. This
 * module's own read exists only to give the caller's `computePatch` a current
 * base to work from; it decides nothing about whether the write may land.
 *
 * ── Recompute, not retry ─────────────────────────────────────────────
 *
 * `computePatch` is a callback rather than a precomputed patch for exactly
 * this reason. When the guarded write reports that the base moved, the loop
 * reads the newest stored plan and asks the caller to compute the patch again
 * against *it* — the same change statement, a newer base — instead of
 * re-offering the stale patch. The loop is bounded (`maxAttempts`): a base
 * that keeps moving under every attempt is reported as `stale_base` with
 * nothing written, which is the refusal the issue asks for, and a plan that
 * is gone is `no_stored_plan`, which is the caller's cue to build rather
 * than patch.
 *
 * Canonical-write rules are unchanged: the document written here is a plan
 * proposal under `users/{uid}/plans/{date}`, same as any regeneration. Nothing
 * in this module touches a commitment.
 */

import type { StorageAdapter } from '../../storage';
import { IncrementalReplanError } from '../../planning/incremental/freezeResolve';
import type { IncrementalPlanPatch } from '../../../src/contracts/v1/incrementalReplanContracts';
import {
  appendPlanEvent,
  readStoredPlan,
  replaceStoredPlanIfBaseMatches,
  type StoredDailyPlan,
} from './planStore';

/**
 * How many times an apply may recompute against a moved base before refusing.
 * Three, not one: the first failure is the ordinary race (a concurrent tick
 * landed first), and refusing immediately would make every race a full
 * recompute for the caller. Beyond a small bound the base is simply hot, and
 * the honest answer is to say so rather than to keep a scheduler spinning
 * against it.
 */
export const DEFAULT_INCREMENTAL_APPLY_ATTEMPTS = 3;

/**
 * The patch and the stored-plan document it becomes, computed against one
 * specific stored plan.
 *
 * Produced by the caller's `computePatch` for the `StoredDailyPlan` it was
 * handed: `patch.baseGeneration` is that plan's generation, `document` is the
 * next generation with the patch's plan in it. The service checks this
 * consistency itself, because a patch computed against anything else is a
 * caller bug that the guarded write would otherwise report as an ordinary
 * race — recomputed forever and never applied.
 */
export interface ComputedIncrementalPatch {
  readonly patch: IncrementalPlanPatch;
  readonly document: StoredDailyPlan;
}

export interface ApplyIncrementalPlanPatchInput {
  /** The instant of the apply, for the plan ledger. Passed in, never read. */
  readonly at: string;
  /**
   * Computes the patch against the stored plan it is given. Called once per
   * attempt — again after every stale refusal, against the newest state, per
   * the issue's "recompute from newest state".
   */
  readonly computePatch: (current: StoredDailyPlan) => ComputedIncrementalPatch;
  readonly maxAttempts?: number;
}

export type ApplyIncrementalPlanPatchResult =
  | {
    readonly applied: true;
    readonly attempts: number;
    readonly stored: StoredDailyPlan;
    readonly patch: IncrementalPlanPatch;
  }
  | {
    readonly applied: false;
    readonly attempts: number;
    /** `stale_base` = the base kept moving; `no_stored_plan` = nothing to patch. */
    readonly reason: 'stale_base' | 'no_stored_plan';
  };

export async function applyIncrementalPlanPatch(
  uid: string,
  date: string,
  input: ApplyIncrementalPlanPatchInput,
  storage?: StorageAdapter,
): Promise<ApplyIncrementalPlanPatchResult> {
  const maxAttempts = input.maxAttempts ?? DEFAULT_INCREMENTAL_APPLY_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new IncrementalReplanError(`maxAttempts must be a positive integer, received ${String(maxAttempts)}`);
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const current = await readStoredPlan(uid, date, storage);
    if (current === null) {
      return { applied: false, attempts: attempt, reason: 'no_stored_plan' };
    }

    const computed = input.computePatch(current);
    if (computed.patch.baseGeneration !== current.generation
      || computed.patch.resultGeneration !== computed.document.generation
      || computed.document.generation !== current.generation + 1
      || computed.document.date !== current.date) {
      // Not a race — the patch does not describe the state it was computed
      // from, and no re-read will change that. Loud, not retried.
      throw new IncrementalReplanError(
        'the patch was not computed from the plan state it was handed: '
          + `base ${String(computed.patch.baseGeneration)} vs generation ${String(current.generation)}, `
          + `result ${String(computed.patch.resultGeneration)} vs document ${String(computed.document.generation)}`,
      );
    }

    const stored = await replaceStoredPlanIfBaseMatches(
      uid,
      computed.document,
      { generation: current.generation, inputDigest: current.inputDigest },
      storage,
    );
    if (stored !== null) {
      await appendPlanEvent(
        uid,
        {
          type: 'plan_regenerated',
          date,
          at: input.at,
          generation: stored.generation,
          inputDigest: stored.inputDigest,
        },
        storage,
      );
      return { applied: true, attempts: attempt, stored, patch: computed.patch };
    }
    // The base moved between the read and the guarded write. Loop: read the
    // newest state and recompute against it, per the issue. Retrying the same
    // patch would be the overwrite the guard exists to prevent.
  }

  return { applied: false, attempts: maxAttempts, reason: 'stale_base' };
}
