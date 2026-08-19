/**
 * The public surface of the deterministic scheduler (Sprint 07, issue #30).
 *
 * `schedulePlan` is the entry point named by the `planning` descriptor in
 * `src/contracts/v1/moduleContracts.ts`. Everything else exported here supports
 * the two claims a plan makes about itself: `planningInputDigest` is what makes
 * "these two plans came from the same request" checkable, and `diffPlans` is
 * what makes "and here is what changed" answerable.
 *
 * Window materialisation is deliberately absent from this surface. It was a
 * temporary `windows.ts` copy of #29's normalizer while #29 did not exist; the
 * integration deleted that file and `scheduler.ts` now calls
 * `lib/planning/constraints/normalize.ts`. A caller that wants absolute
 * intervals from a wall-clock window asks #29 for them, not #30 — re-exporting
 * the conversion here would put a second name on one piece of arithmetic and
 * invite exactly the duplicate that was just removed.
 *
 * ## Migration and rollback
 *
 * **Migration: none.** This track is additive. It adds files under
 * `lib/planning/scheduler/` and `tests/planning/`, and flips one descriptor in
 * `src/contracts/v1/moduleContracts.ts` from the Sprint 00 placeholder to
 * `implemented`. There is no schema change, no stored data, no route, no
 * background job, and no change to any existing module's behaviour. Nothing
 * calls `schedulePlan` in production yet: the descriptor is a descriptor, and
 * modules are reached through their own entry points rather than through that
 * table.
 *
 * **Rollback: `git revert` of the sprint merge, and nothing else.** There is no
 * data to migrate back because planning writes nothing —
 * `PLANNING_PERSISTENCE_POLICY.planCanPersist` is false and a plan is a
 * proposal about time, never canonical user state. The one visible effect of a
 * revert is that `INTELLIGENCE_MODULE_CONTRACTS.planning.execute` returns the
 * placeholder shape again; the assertion in
 * `tests/contract/intelligenceModuleBoundaries.test.ts` moves with it, which is
 * why the descriptor and its pin are edited by one track rather than two.
 *
 * **The one forward-looking obligation**, for as long as `windows.ts` is
 * present, is deleting it. It is a second copy of #29's window arithmetic,
 * written because #29 did not exist when this track was built, and it is meant
 * to be replaced by that normalizer at integration rather than left as a
 * fallback. It is not a rollback hazard — removing it changes no stored state —
 * but leaving it is the Sprint 06 gap: two copies of arithmetic that will not
 * disagree loudly, only on one Sunday in October. Once the swap has happened
 * this paragraph describes nothing, and
 * `tests/planning/schedulerBoundaries.test.ts` is what enforces the transition
 * in both directions rather than a note here being remembered.
 */

export { schedulePlan, comparePlanOrder } from './scheduler';
export {
  PLAN_INPUT_DIGEST_VERSION,
  canonicalPlanningInput,
  planningInputDigest,
} from './digest';
export { diffPlans } from './diff';
