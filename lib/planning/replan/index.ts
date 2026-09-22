/**
 * The #523 slice-1 replanning modules: the impact evaluator and burst
 * coalescing. Both are pure; the pipeline that enqueues, replans, diffs and
 * applies policy is the deliberate follow-up slice and is not here.
 */
export * from './impactEvaluator';
export * from './coalescing';
