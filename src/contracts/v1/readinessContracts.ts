/**
 * Normalized readiness contracts.
 *
 * Readiness is context, not medical advice and not a planner-specific score.
 * Native sources such as HealthKit, Health Connect, WHOOP, and a subjective
 * check-in can contribute signals, but the snapshot keeps those signals in a
 * common vocabulary so consumers do not branch on provider-specific fields.
 */

import { MODULE_CONTRACT_VERSION } from './moduleContracts';
import type { ContextProviderKind } from './integrationConnectionContracts';

export const READINESS_CONTRACT_VERSION = MODULE_CONTRACT_VERSION;
export const READINESS_SCHEMA_VERSION = 'readiness-v1' as const;

export const READINESS_SOURCE_KINDS = Object.freeze([
  'healthkit',
  'health_connect',
  'whoop',
  'subjective',
] as const);

export type ReadinessSourceKind = (typeof READINESS_SOURCE_KINDS)[number];

export type ReadinessMetricKind =
  | 'sleep'
  | 'recovery'
  | 'strain'
  | 'heart_rate'
  | 'hrv'
  | 'steps'
  | 'subjective_energy';

export type ReadinessValueUnit =
  | 'score_0_1'
  | 'minutes'
  | 'count'
  | 'beats_per_minute'
  | 'milliseconds'
  | 'label';

export type ReadinessBand = 'unknown' | 'low' | 'steady' | 'high';
export type SubjectiveEnergyLevel = 1 | 2 | 3 | 4 | 5;

export interface ReadinessSourceRef {
  readonly kind: ReadinessSourceKind;
  /** Optional link to a normalized integration connection record. */
  readonly provider?: ContextProviderKind;
  readonly connectionId?: string;
}

export interface ReadinessSignal {
  readonly signalId: string;
  readonly source: ReadinessSourceRef;
  readonly metric: ReadinessMetricKind;
  readonly observedAt: string;
  /**
   * Common 0..1 scale when the source can be normalized. Absent means the
   * source is still useful context but should not be averaged as a score.
   */
  readonly normalizedScore: number | null;
  readonly nativeValue: number | string | null;
  readonly nativeUnit: ReadinessValueUnit;
  /** 0..1 inclusive confidence in the normalized interpretation. */
  readonly confidence: number;
}

export interface ReadinessNormalizedSignals {
  readonly sleepDurationMinutes?: number;
  readonly sleepStart?: string;
  readonly sleepEnd?: string;
  readonly restingHeartRate?: number;
  readonly hrv?: number;
  readonly recentActivityLoad?: number;
}

export interface SubjectiveReadinessInput {
  readonly energy?: SubjectiveEnergyLevel;
  readonly observedAt: string;
}

export interface DerivedReadiness {
  readonly readinessBand: ReadinessBand;
  /** 0..1 inclusive. Null means there was not enough current signal. */
  readonly confidence: number | null;
}

export interface ReadinessSnapshot {
  readonly version: typeof READINESS_CONTRACT_VERSION;
  readonly schemaVersion: typeof READINESS_SCHEMA_VERSION;
  readonly scopeId: string;
  readonly computedAt: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly band: ReadinessBand;
  readonly score: number | null;
  readonly normalizedSignals: ReadinessNormalizedSignals;
  readonly subjective: SubjectiveReadinessInput | null;
  readonly derived: DerivedReadiness;
  readonly signals: readonly ReadinessSignal[];
  readonly sourceKinds: readonly ReadinessSourceKind[];
  readonly missingSourceKinds: readonly ReadinessSourceKind[];
}

export const READINESS_BOUNDARY_POLICY = Object.freeze({
  medicalClaimsAllowed: false,
  providerSpecificPlannerFieldsAllowed: false,
  writesCanonicalUserState: false,
});
