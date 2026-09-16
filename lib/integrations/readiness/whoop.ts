import {
  READINESS_CONTRACT_VERSION,
  READINESS_SCHEMA_VERSION,
  type ReadinessSignal,
  type ReadinessSnapshot,
} from '../../../src/contracts/v1/readinessContracts';

export interface WhoopRecoveryReading {
  readonly observedAt: string;
  /** WHOOP recovery percentage on the native 0..100 scale. */
  readonly recoveryScore: number | null;
  readonly restingHeartRate: number | null;
  readonly hrvMilliseconds: number | null;
}

export interface WhoopSleepReading {
  readonly observedAt: string;
  readonly sleepStart: string | null;
  readonly sleepEnd: string | null;
  readonly totalSleepMinutes: number | null;
}

export interface WhoopStrainReading {
  readonly observedAt: string;
  /** WHOOP strain on the native 0..21 scale. */
  readonly strainScore: number | null;
}

export interface WhoopReadinessSnapshotInput {
  readonly scopeId: string;
  readonly computedAt: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly connectionId?: string | null;
  readonly recovery?: WhoopRecoveryReading | null;
  readonly sleep?: WhoopSleepReading | null;
  readonly strain?: WhoopStrainReading | null;
}

function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function scoreFromPercent(value: number | null | undefined): number | null {
  if (!isFiniteNumber(value)) return null;
  return clamp01(value / 100);
}

function sleepScore(minutes: number | null | undefined): number | null {
  if (!isFiniteNumber(minutes) || minutes <= 0) return null;
  return clamp01(minutes / 480);
}

function strainLoad(strainScore: number | null | undefined): number | null {
  if (!isFiniteNumber(strainScore)) return null;
  return clamp01(strainScore / 21);
}

function minutesBetween(start: string | null | undefined, end: string | null | undefined): number | null {
  if (!start || !end) return null;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  return Math.round((endMs - startMs) / 60_000);
}

function bandFor(score: number | null): ReadinessSnapshot['band'] {
  if (score === null) return 'unknown';
  if (score < 0.34) return 'low';
  if (score < 0.67) return 'steady';
  return 'high';
}

function whoopSource(connectionId: string | null | undefined): ReadinessSignal['source'] {
  return {
    kind: 'whoop',
    provider: 'whoop',
    connectionId: connectionId ?? undefined,
  };
}

export function buildWhoopReadinessSnapshot(input: WhoopReadinessSnapshotInput): ReadinessSnapshot {
  const signals: ReadinessSignal[] = [];
  const source = whoopSource(input.connectionId);
  const recoveryScore = scoreFromPercent(input.recovery?.recoveryScore);
  const sleepMinutes = input.sleep?.totalSleepMinutes ?? minutesBetween(input.sleep?.sleepStart, input.sleep?.sleepEnd);
  const normalizedSleep = sleepScore(sleepMinutes);
  const recentActivityLoad = strainLoad(input.strain?.strainScore);

  if (input.recovery) {
    signals.push({
      signalId: 'whoop-recovery',
      source,
      metric: 'recovery',
      observedAt: input.recovery.observedAt,
      normalizedScore: recoveryScore,
      nativeValue: input.recovery.recoveryScore,
      nativeUnit: 'score_0_1',
      confidence: recoveryScore === null ? 0 : 0.9,
    });
  }

  if (input.sleep) {
    signals.push({
      signalId: 'whoop-sleep',
      source,
      metric: 'sleep',
      observedAt: input.sleep.observedAt,
      normalizedScore: normalizedSleep,
      nativeValue: sleepMinutes,
      nativeUnit: 'minutes',
      confidence: normalizedSleep === null ? 0 : 0.75,
    });
  }

  if (input.recovery && isFiniteNumber(input.recovery.restingHeartRate)) {
    signals.push({
      signalId: 'whoop-resting-heart-rate',
      source,
      metric: 'heart_rate',
      observedAt: input.recovery.observedAt,
      normalizedScore: null,
      nativeValue: input.recovery.restingHeartRate,
      nativeUnit: 'beats_per_minute',
      confidence: 0.75,
    });
  }

  if (input.recovery && isFiniteNumber(input.recovery.hrvMilliseconds)) {
    signals.push({
      signalId: 'whoop-hrv',
      source,
      metric: 'hrv',
      observedAt: input.recovery.observedAt,
      normalizedScore: null,
      nativeValue: input.recovery.hrvMilliseconds,
      nativeUnit: 'milliseconds',
      confidence: 0.75,
    });
  }

  if (input.strain) {
    signals.push({
      signalId: 'whoop-strain',
      source,
      metric: 'strain',
      observedAt: input.strain.observedAt,
      normalizedScore: recentActivityLoad,
      nativeValue: input.strain.strainScore,
      nativeUnit: 'score_0_1',
      confidence: recentActivityLoad === null ? 0 : 0.75,
    });
  }

  const score = recoveryScore ?? normalizedSleep;
  const band = bandFor(score);

  return {
    version: READINESS_CONTRACT_VERSION,
    schemaVersion: READINESS_SCHEMA_VERSION,
    scopeId: input.scopeId,
    computedAt: input.computedAt,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    band,
    score,
    normalizedSignals: {
      sleepDurationMinutes: sleepMinutes ?? undefined,
      sleepStart: input.sleep?.sleepStart ?? undefined,
      sleepEnd: input.sleep?.sleepEnd ?? undefined,
      restingHeartRate: input.recovery?.restingHeartRate ?? undefined,
      hrv: input.recovery?.hrvMilliseconds ?? undefined,
      recentActivityLoad: recentActivityLoad ?? undefined,
    },
    subjective: null,
    derived: {
      readinessBand: band,
      confidence: score === null ? null : signals.length > 0 ? 0.8 : null,
    },
    signals,
    sourceKinds: signals.length > 0 ? ['whoop'] : [],
    missingSourceKinds: signals.length > 0 ? [] : ['whoop'],
  };
}
