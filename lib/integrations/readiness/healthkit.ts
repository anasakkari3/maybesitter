import {
  READINESS_CONTRACT_VERSION,
  READINESS_SCHEMA_VERSION,
  type ReadinessSignal,
  type ReadinessSnapshot,
} from '../../../src/contracts/v1/readinessContracts';

export interface HealthKitSleepReading {
  readonly observedAt: string;
  readonly sleepStart: string | null;
  readonly sleepEnd: string | null;
  readonly totalSleepMinutes: number | null;
}

export interface HealthKitHeartReading {
  readonly observedAt: string;
  readonly restingHeartRate: number | null;
  readonly hrvMilliseconds: number | null;
}

export interface HealthKitActivityReading {
  readonly observedAt: string;
  readonly stepCount: number | null;
}

export interface HealthKitReadinessSnapshotInput {
  readonly scopeId: string;
  readonly computedAt: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly sleep?: HealthKitSleepReading | null;
  readonly heart?: HealthKitHeartReading | null;
  readonly activity?: HealthKitActivityReading | null;
}

function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function minutesBetween(start: string | null | undefined, end: string | null | undefined): number | null {
  if (!start || !end) return null;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  return Math.round((endMs - startMs) / 60_000);
}

function sleepScore(minutes: number | null | undefined): number | null {
  if (!isFiniteNumber(minutes) || minutes <= 0) return null;
  return clamp01(minutes / 480);
}

function activityLoad(stepCount: number | null | undefined): number | null {
  if (!isFiniteNumber(stepCount) || stepCount < 0) return null;
  return clamp01(stepCount / 10_000);
}

function bandFor(score: number | null): ReadinessSnapshot['band'] {
  if (score === null) return 'unknown';
  if (score < 0.34) return 'low';
  if (score < 0.67) return 'steady';
  return 'high';
}

const HEALTHKIT_SOURCE: ReadinessSignal['source'] = Object.freeze({
  kind: 'healthkit',
});

export function buildHealthKitReadinessSnapshot(input: HealthKitReadinessSnapshotInput): ReadinessSnapshot {
  const signals: ReadinessSignal[] = [];
  const sleepMinutes = input.sleep?.totalSleepMinutes ?? minutesBetween(input.sleep?.sleepStart, input.sleep?.sleepEnd);
  const normalizedSleep = sleepScore(sleepMinutes);
  const recentActivityLoad = activityLoad(input.activity?.stepCount);

  if (input.sleep) {
    signals.push({
      signalId: 'healthkit-sleep',
      source: HEALTHKIT_SOURCE,
      metric: 'sleep',
      observedAt: input.sleep.observedAt,
      normalizedScore: normalizedSleep,
      nativeValue: sleepMinutes,
      nativeUnit: 'minutes',
      confidence: normalizedSleep === null ? 0 : 0.75,
    });
  }

  if (input.heart && isFiniteNumber(input.heart.restingHeartRate)) {
    signals.push({
      signalId: 'healthkit-resting-heart-rate',
      source: HEALTHKIT_SOURCE,
      metric: 'heart_rate',
      observedAt: input.heart.observedAt,
      normalizedScore: null,
      nativeValue: input.heart.restingHeartRate,
      nativeUnit: 'beats_per_minute',
      confidence: 0.7,
    });
  }

  if (input.heart && isFiniteNumber(input.heart.hrvMilliseconds)) {
    signals.push({
      signalId: 'healthkit-hrv',
      source: HEALTHKIT_SOURCE,
      metric: 'hrv',
      observedAt: input.heart.observedAt,
      normalizedScore: null,
      nativeValue: input.heart.hrvMilliseconds,
      nativeUnit: 'milliseconds',
      confidence: 0.7,
    });
  }

  if (input.activity) {
    signals.push({
      signalId: 'healthkit-steps',
      source: HEALTHKIT_SOURCE,
      metric: 'steps',
      observedAt: input.activity.observedAt,
      normalizedScore: recentActivityLoad,
      nativeValue: input.activity.stepCount,
      nativeUnit: 'count',
      confidence: recentActivityLoad === null ? 0 : 0.65,
    });
  }

  const score = normalizedSleep;
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
      ...(sleepMinutes !== null && sleepMinutes !== undefined ? { sleepDurationMinutes: sleepMinutes } : {}),
      ...(input.sleep?.sleepStart ? { sleepStart: input.sleep.sleepStart } : {}),
      ...(input.sleep?.sleepEnd ? { sleepEnd: input.sleep.sleepEnd } : {}),
      ...(input.heart?.restingHeartRate !== null && input.heart?.restingHeartRate !== undefined
        ? { restingHeartRate: input.heart.restingHeartRate }
        : {}),
      ...(input.heart?.hrvMilliseconds !== null && input.heart?.hrvMilliseconds !== undefined
        ? { hrv: input.heart.hrvMilliseconds }
        : {}),
      ...(recentActivityLoad !== null ? { recentActivityLoad } : {}),
    },
    subjective: null,
    derived: {
      readinessBand: band,
      confidence: score === null ? null : signals.length > 0 ? 0.72 : null,
    },
    signals,
    sourceKinds: signals.length > 0 ? ['healthkit'] : [],
    missingSourceKinds: signals.length > 0 ? [] : ['healthkit'],
  };
}
