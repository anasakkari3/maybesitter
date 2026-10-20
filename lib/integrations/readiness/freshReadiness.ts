import type { ReadinessBand, ReadinessSnapshot, SubjectiveEnergyLevel } from '../../../src/contracts/v1/readinessContracts';
import { DEFAULT_READINESS_PLANNING_POLICY } from '../../planning/scheduler/readiness';
import { storedReadinessContext, type StoredReadinessContext } from '../../userState/userStateService';

export const M5B_READING_FUTURE_SKEW_MS = 5 * 60 * 1000;
export const M5B_SUBJECTIVE_FRESH_MS = 12 * 60 * 60 * 1000;
export const M5B_HEALTH_FRESH_MS = 36 * 60 * 60 * 1000;

export interface FreshReadiness {
  readonly source: 'check_in' | 'health' | 'none';
  readonly energy: SubjectiveEnergyLevel | null;
  readonly band: Exclude<ReadinessBand, 'unknown'> | null;
  readonly observedAt: string | null;
  readonly bufferMinutes: number;
  readonly staleReading: { readonly source: 'check_in' | 'health'; readonly observedAt: string } | null;
}

export interface ReadinessApplied {
  readonly source: FreshReadiness['source'];
  readonly energy: SubjectiveEnergyLevel | null;
  readonly band: FreshReadiness['band'];
  readonly bufferMinutesAdded: number;
  readonly observedAt: string | null;
}

export const NO_READINESS_APPLIED: ReadinessApplied = Object.freeze({
  source: 'none', energy: null, band: null, bufferMinutesAdded: 0, observedAt: null,
});

function timestampMs(value: string | undefined): number | null {
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? parsed : null;
}

function usable(timestamp: string, nowMs: number, freshForMs: number): boolean {
  const value = timestampMs(timestamp);
  return value !== null && value <= nowMs + M5B_READING_FUTURE_SKEW_MS && nowMs - value <= freshForMs;
}

function nonFuture(timestamp: string, nowMs: number): boolean {
  const value = timestampMs(timestamp);
  return value !== null && value <= nowMs + M5B_READING_FUTURE_SKEW_MS;
}

function energyBand(energy: SubjectiveEnergyLevel): Exclude<ReadinessBand, 'unknown'> {
  if (energy <= 2) return 'low';
  if (energy === 3) return 'steady';
  return 'high';
}

function healthBand(snapshot: ReadinessSnapshot): FreshReadiness['band'] {
  return snapshot.band === 'unknown' ? null : snapshot.band;
}

function bufferFor(band: FreshReadiness['band']): number {
  return band === 'low' ? DEFAULT_READINESS_PLANNING_POLICY.lowBandAfterBufferMinutes : 0;
}

export function resolveFreshReadiness(context: StoredReadinessContext | null | undefined, now: string | Date): FreshReadiness {
  const nowMs = now instanceof Date ? now.getTime() : timestampMs(now);
  if (nowMs === null || !Number.isFinite(nowMs)) return { ...NO_READINESS_APPLIED, bufferMinutes: 0, staleReading: null };
  const subjective = context?.currentSubjective ?? null;
  if (subjective && usable(subjective.observedAt, nowMs, M5B_SUBJECTIVE_FRESH_MS)) {
    const band = energyBand(subjective.energy);
    return { source: 'check_in', energy: subjective.energy, band, observedAt: subjective.observedAt, bufferMinutes: bufferFor(band), staleReading: null };
  }
  const recent = context?.recentReadiness ?? null;
  if (recent && usable(recent.computedAt, nowMs, M5B_HEALTH_FRESH_MS)) {
    const band = healthBand(recent);
    return { source: 'health', energy: null, band, observedAt: recent.computedAt, bufferMinutes: bufferFor(band), staleReading: null };
  }

  const stale = [
    ...(subjective && nonFuture(subjective.observedAt, nowMs) ? [{ source: 'check_in' as const, observedAt: subjective.observedAt }] : []),
    ...(recent && nonFuture(recent.computedAt, nowMs) ? [{ source: 'health' as const, observedAt: recent.computedAt }] : []),
    ...(context?.historicalInference && nonFuture(context.historicalInference.computedAt, nowMs)
      ? [{ source: 'health' as const, observedAt: context.historicalInference.computedAt }] : []),
  ].sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0] ?? null;
  return { source: 'none', energy: null, band: null, observedAt: null, bufferMinutes: 0, staleReading: stale };
}

export function freshReadinessInputs(context: StoredReadinessContext | null | undefined, now: string): Pick<StoredReadinessContext, 'currentSubjective' | 'recentReadiness' | 'historicalInference'> {
  const nowMs = timestampMs(now);
  const subjective = context?.currentSubjective ?? null;
  const recent = context?.recentReadiness ?? null;
  return {
    currentSubjective: subjective && nowMs !== null && usable(subjective.observedAt, nowMs, M5B_SUBJECTIVE_FRESH_MS) ? subjective : null,
    recentReadiness: recent && nowMs !== null && usable(recent.computedAt, nowMs, M5B_HEALTH_FRESH_MS) ? recent : null,
    historicalInference: null,
  };
}

export function resolvePlanReadiness(input: { readonly uid: string; readonly now: string; readonly userDocument: unknown }): { readonly readinessApplied: ReadinessApplied; readonly staleReading: FreshReadiness['staleReading'] } {
  const user = input.userDocument && typeof input.userDocument === 'object' ? input.userDocument as Record<string, unknown> : null;
  const fresh = resolveFreshReadiness(storedReadinessContext(user?.readinessContext, input.uid), input.now);
  return {
    readinessApplied: { source: fresh.source, energy: fresh.energy, band: fresh.band, bufferMinutesAdded: fresh.bufferMinutes, observedAt: fresh.observedAt },
    staleReading: fresh.staleReading,
  };
}

export function readingIsTooFarInFuture(timestamp: string, now: string): boolean {
  const value = timestampMs(timestamp);
  const nowMs = timestampMs(now);
  return value !== null && nowMs !== null && value > nowMs + M5B_READING_FUTURE_SKEW_MS;
}
