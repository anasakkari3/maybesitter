import {
  type Plan,
  type PlanDiff,
  type PlanQualityMetrics,
  type PlanningConfig,
  type PlanningConstraints,
} from '../../../src/contracts/v1/planningContracts';
import { computePlanQualityMetrics } from '../evaluation/metrics';
import { diffPlans, planningInputDigest, schedulePlan } from '../scheduler';

export const TIMEFOLD_SHADOW_POLICY = Object.freeze({
  canonicalPlanner: 'schedulePlan',
  shadowOnly: true,
  candidateMayPersist: false,
  candidateMayTriggerActions: false,
  rawUserContentInReport: false,
});

export interface TimefoldShadowSolver {
  solve(input: {
    readonly constraints: PlanningConstraints;
    readonly config: PlanningConfig;
    readonly inputDigest: string;
  }): Promise<Plan>;
}

export interface TimefoldShadowReport {
  readonly status: 'compared' | 'candidate_rejected' | 'solver_failed';
  readonly inputDigest: string;
  readonly baseline: PlanQualityMetrics;
  readonly candidate: PlanQualityMetrics | null;
  readonly candidateVsBaseline: PlanDiff | null;
  readonly issues: readonly string[];
}

function sameHorizon(left: Plan['horizon'], right: Plan['horizon']): boolean {
  return left.startsAt === right.startsAt && left.endsAt === right.endsAt;
}

function candidateIssues(
  candidate: Plan,
  constraints: PlanningConstraints,
  inputDigest: string,
): readonly string[] {
  const issues: string[] = [];
  if (candidate.scopeId !== constraints.scopeId) issues.push('scope_mismatch');
  if (!sameHorizon(candidate.horizon, constraints.horizon)) issues.push('horizon_mismatch');
  if (candidate.inputDigest !== inputDigest) issues.push('input_digest_mismatch');

  const expected = new Set(constraints.items.map((item) => item.itemId));
  const observed = new Map<string, number>();
  for (const item of candidate.scheduled) {
    observed.set(item.itemId, (observed.get(item.itemId) ?? 0) + 1);
    const start = Date.parse(item.reservedInterval.startsAt);
    const end = Date.parse(item.reservedInterval.endsAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      issues.push('invalid_reserved_interval');
    }
  }
  for (const item of candidate.unscheduled) {
    observed.set(item.itemId, (observed.get(item.itemId) ?? 0) + 1);
  }
  for (const itemId of Array.from(expected)) {
    if ((observed.get(itemId) ?? 0) !== 1) issues.push('item_partition_invalid');
  }
  for (const itemId of Array.from(observed.keys())) {
    if (!expected.has(itemId)) issues.push('unknown_item');
  }

  const reservations = candidate.scheduled
    .map((item) => ({
      startsAt: Date.parse(item.reservedInterval.startsAt),
      endsAt: Date.parse(item.reservedInterval.endsAt),
    }))
    .filter((interval) => Number.isFinite(interval.startsAt) && Number.isFinite(interval.endsAt))
    .sort((left, right) => left.startsAt - right.startsAt);
  for (let index = 1; index < reservations.length; index += 1) {
    if (reservations[index].startsAt < reservations[index - 1].endsAt) {
      issues.push('overlapping_reservations');
      break;
    }
  }

  return Object.freeze(Array.from(new Set(issues)).sort());
}

export async function runTimefoldShadowExperiment(input: {
  readonly constraints: PlanningConstraints;
  readonly config: PlanningConfig;
  readonly availableMinutes: number;
  readonly solver: TimefoldShadowSolver;
}): Promise<TimefoldShadowReport> {
  const digest = planningInputDigest(input.constraints, input.config);
  const baselinePlan = schedulePlan(input.constraints, input.config);
  const baseline = computePlanQualityMetrics({
    plan: baselinePlan,
    availableMinutes: input.availableMinutes,
  });

  let candidatePlan: Plan;
  try {
    candidatePlan = await input.solver.solve({
      constraints: input.constraints,
      config: input.config,
      inputDigest: digest,
    });
  } catch {
    return {
      status: 'solver_failed',
      inputDigest: digest,
      baseline,
      candidate: null,
      candidateVsBaseline: null,
      issues: Object.freeze(['solver_failed']),
    };
  }

  const issues = candidateIssues(candidatePlan, input.constraints, digest);
  if (issues.length > 0) {
    return {
      status: 'candidate_rejected',
      inputDigest: digest,
      baseline,
      candidate: null,
      candidateVsBaseline: null,
      issues,
    };
  }

  return {
    status: 'compared',
    inputDigest: digest,
    baseline,
    candidate: computePlanQualityMetrics({
      plan: candidatePlan,
      previousPlan: baselinePlan,
      availableMinutes: input.availableMinutes,
    }),
    candidateVsBaseline: diffPlans(baselinePlan, candidatePlan),
    issues,
  };
}
