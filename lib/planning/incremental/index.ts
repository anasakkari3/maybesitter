/**
 * Incremental replanning (#524).
 *
 * Slice 1 is the impact closure — steps 1–2, which blocks a patch may touch.
 * Slice 2 is the pipeline over it: steps 3–6, freeze the rest, re-solve only
 * the impacted set, assemble and validate the complete plan, diff it.
 *
 * Steps 7–8 remain the deliberate follow-up: widening the neighborhood before
 * escalating, the fallback taxonomy that goes with it, and the
 * stale-generation apply guard. `freezeResolve.ts` takes the blunt escalation
 * in the meantime and says so in the patch it returns.
 */
export * from './impactClosure';
export * from './freezeResolve';
