/**
 * Event-driven continuous replanning (#523).
 *
 * Implements the continuous replanning pipeline:
 * normalized state change → ImpactEvaluator → {NO_EFFECT | PLAN_STALE | REPLAN_REQUIRED}
 *   → deduped enqueue → canonical planner → PlanDiff → policy/user-control layer.
 */
export * from './impactEvaluator';
export * from './coalescing';
export * from './replanPolicy';
export * from './dedupQueue';
export * from './continuousReplanPipeline';
