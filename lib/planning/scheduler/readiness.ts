import type {
  PlanningConstraints,
  PlanningItem,
} from '../../../src/contracts/v1/planningContracts';
import type {
  ReadinessBand,
  ReadinessSnapshot,
} from '../../../src/contracts/v1/readinessContracts';

export interface ReadinessPlanningPolicy {
  readonly lowBandAfterBufferMinutes: number;
  readonly steadyBandAfterBufferMinutes: number;
  readonly highBandAfterBufferMinutes: number;
  readonly unknownBandAfterBufferMinutes: number;
}

export const DEFAULT_READINESS_PLANNING_POLICY: ReadinessPlanningPolicy = Object.freeze({
  lowBandAfterBufferMinutes: 15,
  steadyBandAfterBufferMinutes: 0,
  highBandAfterBufferMinutes: 0,
  unknownBandAfterBufferMinutes: 0,
});

function policyWithDefaults(policy: Partial<ReadinessPlanningPolicy> | undefined): ReadinessPlanningPolicy {
  return {
    ...DEFAULT_READINESS_PLANNING_POLICY,
    ...policy,
  };
}

function nonNegativeFiniteMinutes(value: number, field: keyof ReadinessPlanningPolicy): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative finite minute count, received ${String(value)}`);
  }
  return value;
}

export function readinessPlanningBufferAfterMinutes(
  readiness: ReadinessSnapshot | null,
  policy?: Partial<ReadinessPlanningPolicy>,
): number {
  const resolved = policyWithDefaults(policy);
  const byBand: Record<ReadinessBand, number> = {
    low: resolved.lowBandAfterBufferMinutes,
    steady: resolved.steadyBandAfterBufferMinutes,
    high: resolved.highBandAfterBufferMinutes,
    unknown: resolved.unknownBandAfterBufferMinutes,
  };
  const band = readiness?.band ?? 'unknown';
  return nonNegativeFiniteMinutes(byBand[band], `${band}BandAfterBufferMinutes` as keyof ReadinessPlanningPolicy);
}

function applyBufferAfter(item: PlanningItem, additionalMinutes: number): PlanningItem {
  return {
    ...item,
    bufferAfterMinutes: item.bufferAfterMinutes + additionalMinutes,
  };
}

export function projectReadinessIntoPlanningConstraints(
  constraints: PlanningConstraints,
  readiness: ReadinessSnapshot | null,
  policy?: Partial<ReadinessPlanningPolicy>,
): PlanningConstraints {
  const additionalBufferAfterMinutes = readinessPlanningBufferAfterMinutes(readiness, policy);
  if (additionalBufferAfterMinutes === 0 || constraints.items.length === 0) return constraints;

  return {
    ...constraints,
    items: constraints.items.map((item) => applyBufferAfter(item, additionalBufferAfterMinutes)),
  };
}
