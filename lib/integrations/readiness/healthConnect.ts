import {
  READINESS_CONTRACT_VERSION,
  READINESS_SCHEMA_VERSION,
  type ReadinessSignal,
  type ReadinessSnapshot,
} from '../../../src/contracts/v1/readinessContracts';

export interface HealthConnectSleepSessionReading {
  readonly observedAt: string;
  readonly sleepStart: string | null;
  readonly sleepEnd: string | null;
  readonly totalSleepMinutes: number | null;
}

export interface HealthConnectHeartReading {
  readonly observedAt: string;
  readonly restingHeartRate: number | null;
  readonly hrvMilliseconds: number | null;
}

export interface HealthConnectStepsReading {
  readonly observedAt: string;
  readonly count: number | null;
}

export interface HealthConnectReadinessSnapshotInput {
  readonly scopeId: string;
  readonly computedAt: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly sleep?: HealthConnectSleepSessionReading | null;
  readonly heart?: HealthConnectHeartReading | null;
  readonly steps?: HealthConnectStepsReading | null;
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

function stepLoad(count: number | null | undefined): number | null {
  if (!isFiniteNumber(count) || count < 0) return null;
  return clamp01(count / 10_000);
}

function bandFor(score: number | null): ReadinessSnapshot['band'] {
  if (score === null) return 'unknown';
  if (score < 0.34) return 'low';
  if (score < 0.67) return 'steady';
  return 'high';
}

const HEALTH_CONNECT_SOURCE: ReadinessSignal['source'] = Object.freeze({
  kind: 'health_connect',
});

export function buildHealthConnectReadinessSnapshot(
  input: HealthConnectReadinessSnapshotInput,
): ReadinessSnapshot {
  const signals: ReadinessSignal[] = [];
  const sleepMinutes = input.sleep?.totalSleepMinutes ?? minutesBetween(input.sleep?.sleepStart, input.sleep?.sleepEnd);
  const normalizedSleep = sleepScore(sleepMinutes);
  const recentActivityLoad = stepLoad(input.steps?.count);

  if (input.sleep) {
    signals.push({
      signalId: 'health-connect-sleep',
      source: HEALTH_CONNECT_SOURCE,
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
      signalId: 'health-connect-resting-heart-rate',
      source: HEALTH_CONNECT_SOURCE,
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
      signalId: 'health-connect-hrv',
      source: HEALTH_CONNECT_SOURCE,
      metric: 'hrv',
      observedAt: input.heart.observedAt,
      normalizedScore: null,
      nativeValue: input.heart.hrvMilliseconds,
      nativeUnit: 'milliseconds',
      confidence: 0.7,
    });
  }

  if (input.steps) {
    signals.push({
      signalId: 'health-connect-steps',
      source: HEALTH_CONNECT_SOURCE,
      metric: 'steps',
      observedAt: input.steps.observedAt,
      normalizedScore: recentActivityLoad,
      nativeValue: input.steps.count,
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
    sourceKinds: signals.length > 0 ? ['health_connect'] : [],
    missingSourceKinds: signals.length > 0 ? [] : ['health_connect'],
  };
}
