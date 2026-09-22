/**
 * Incremental replanning (#524).
 *
 * Slice 1 is the impact closure — steps 1–2, which blocks a patch may touch.
 * Slice 2 is the pipeline over it: steps 3–6, freeze the rest, re-solve only
 * the impacted set, assemble and validate the complete plan, diff it.
 * Slice 3 is steps 7–8: deterministic neighborhood widening before any
 * escalation, and the full-replan fallback with the reason taxonomy the
 * ladder can actually reach.
 *
 * The stale-generation apply guard lives at the persistence boundary, not
 * here: `replaceStoredPlanIfBaseMatches` in `lib/services/dailyPlan/planStore.ts`,
 * driven by `applyIncrementalPlanPatch` in
 * `lib/services/dailyPlan/incrementalPlanApply.ts`.
 */
export * from './impactClosure';
export * from './freezeResolve';
export * from './neighborhoodExpansion';
