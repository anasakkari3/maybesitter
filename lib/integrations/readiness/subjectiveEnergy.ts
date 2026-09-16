import {
  READINESS_CONTRACT_VERSION,
  READINESS_SCHEMA_VERSION,
  type ReadinessBand,
  type ReadinessSignal,
  type ReadinessSnapshot,
  type SubjectiveEnergyLevel,
} from '../../../src/contracts/v1/readinessContracts';

export interface SubjectiveEnergyCheckIn {
  readonly energy: SubjectiveEnergyLevel;
  readonly observedAt: string;
}

export interface ReadinessResolutionInput {
  readonly scopeId: string;
  readonly now: string;
  readonly currentSubjective?: SubjectiveEnergyCheckIn | null;
  readonly recentReadiness?: ReadinessSnapshot | null;
  readonly historicalInference?: ReadinessSnapshot | null;
  readonly subjectiveFreshForMs?: number;
  readonly readinessFreshForMs?: number;
}

export interface ReadinessResolution {
  readonly snapshot: ReadinessSnapshot | null;
  readonly selectedSource: 'current_subjective' | 'recent_readiness' | 'historical_inference' | 'none';
  readonly freshness: 'fresh' | 'stale' | 'missing';
}

const DEFAULT_SUBJECTIVE_FRESH_FOR_MS = 12 * 60 * 60 * 1000;
const DEFAULT_READINESS_FRESH_FOR_MS = 36 * 60 * 60 * 1000;

function ageMs(timestamp: string, now: string): number | null {
  const observedMs = Date.parse(timestamp);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(observedMs) || !Number.isFinite(nowMs)) return null;
  return Math.max(0, nowMs - observedMs);
}

function isFresh(timestamp: string, now: string, freshForMs: number): boolean {
  const age = ageMs(timestamp, now);
  return age !== null && age <= freshForMs;
}

function subjectiveScore(energy: SubjectiveEnergyLevel): number {
  return (energy - 1) / 4;
}

function readinessBand(score: number): ReadinessBand {
  if (score < 0.34) return 'low';
  if (score < 0.67) return 'steady';
  return 'high';
}

function subjectiveSignal(checkIn: SubjectiveEnergyCheckIn): ReadinessSignal {
  const score = subjectiveScore(checkIn.energy);
  return {
    signalId: 'subjective-energy-current',
    source: { kind: 'subjective' },
    metric: 'subjective_energy',
    observedAt: checkIn.observedAt,
    normalizedScore: score,
    nativeValue: checkIn.energy,
    nativeUnit: 'score_0_1',
    confidence: 1,
  };
}

function withCurrentSubjective(
  scopeId: string,
  now: string,
  checkIn: SubjectiveEnergyCheckIn,
  base: ReadinessSnapshot | null,
): ReadinessSnapshot {
  const score = subjectiveScore(checkIn.energy);
  const band = readinessBand(score);
  const baseSignals = base?.signals.filter((signal) => signal.source.kind !== 'subjective') ?? [];
  const sourceKinds = Array.from(new Set([...(base?.sourceKinds ?? []), 'subjective' as const]));
  return {
    version: READINESS_CONTRACT_VERSION,
    schemaVersion: READINESS_SCHEMA_VERSION,
    scopeId,
    computedAt: now,
    windowStart: base?.windowStart ?? checkIn.observedAt,
    windowEnd: base?.windowEnd ?? now,
    band,
    score,
    normalizedSignals: { ...(base?.normalizedSignals ?? {}) },
    subjective: checkIn,
    derived: {
      readinessBand: band,
      confidence: 1,
    },
    signals: [...baseSignals, subjectiveSignal(checkIn)],
    sourceKinds,
    missingSourceKinds: (base?.missingSourceKinds ?? []).filter((kind) => kind !== 'subjective'),
  };
}

export function resolveReadinessForUserState(input: ReadinessResolutionInput): ReadinessResolution {
  const subjectiveFreshForMs = input.subjectiveFreshForMs ?? DEFAULT_SUBJECTIVE_FRESH_FOR_MS;
  const readinessFreshForMs = input.readinessFreshForMs ?? DEFAULT_READINESS_FRESH_FOR_MS;
  const subjective = input.currentSubjective;

  if (subjective && isFresh(subjective.observedAt, input.now, subjectiveFreshForMs)) {
    const base = input.recentReadiness ?? input.historicalInference ?? null;
    return {
      snapshot: withCurrentSubjective(input.scopeId, input.now, subjective, base),
      selectedSource: 'current_subjective',
      freshness: 'fresh',
    };
  }

  if (
    input.recentReadiness
    && isFresh(input.recentReadiness.computedAt, input.now, readinessFreshForMs)
  ) {
    return {
      snapshot: input.recentReadiness,
      selectedSource: 'recent_readiness',
      freshness: 'fresh',
    };
  }

  if (input.historicalInference) {
    return {
      snapshot: input.historicalInference,
      selectedSource: 'historical_inference',
      freshness: 'stale',
    };
  }

  return { snapshot: null, selectedSource: 'none', freshness: 'missing' };
}

export const SUBJECTIVE_ENERGY_POLICY = Object.freeze({
  scale: Object.freeze([1, 2, 3, 4, 5] as const),
  currentUserStatementWins: true,
  medicalInterpretationAllowed: false,
  persistsCheckIn: false,
});
