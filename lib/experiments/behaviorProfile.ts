import type { Commitment, DomainState } from '../../src/domain/stateMachine';

/**
 * Lightweight per-user behavior summary for the personalized arm. It is a count of the
 * user's own closed commitments held on their device — no cross-user data, no model
 * training, and nothing derived from message content.
 */
export interface BehaviorProfile {
  observations: number;
  overallCompletionRate: number;
  completionRateByKind: Record<string, number>;
  completionsByHour: Record<number, number>;
}

/** Below this many closed commitments the profile is not usable and the arm must fall back. */
export const MINIMUM_PROFILE_OBSERVATIONS = 3;

function hourIn(timestamp: string, timezone: string): number | null {
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return null;
  try {
    const hour = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: timezone }).format(new Date(parsed));
    const value = Number(hour);
    return Number.isInteger(value) ? value % 24 : null;
  } catch {
    return null;
  }
}

export function localHour(now: Date, timezone: string): number | null {
  return hourIn(now.toISOString(), timezone);
}

export function buildBehaviorProfile(state: DomainState, timezone: string): BehaviorProfile {
  const closed = Object.values(state.commitments).filter((item) => item.completedAt !== null || item.droppedAt !== null);
  const completedCount = closed.filter((item) => item.completedAt !== null).length;
  const byKind = new Map<string, { closed: number; completed: number }>();
  const completionsByHour: Record<number, number> = {};

  for (const commitment of closed) {
    const bucket = byKind.get(commitment.kind) || { closed: 0, completed: 0 };
    bucket.closed += 1;
    if (commitment.completedAt !== null) {
      bucket.completed += 1;
      const hour = hourIn(commitment.completedAt, timezone);
      if (hour !== null) completionsByHour[hour] = (completionsByHour[hour] || 0) + 1;
    }
    byKind.set(commitment.kind, bucket);
  }

  return {
    observations: closed.length,
    overallCompletionRate: closed.length ? completedCount / closed.length : 0,
    completionRateByKind: Object.fromEntries(Array.from(byKind, ([kind, bucket]) => [kind, bucket.completed / bucket.closed])),
    completionsByHour,
  };
}

export function profileIsUsable(profile: BehaviorProfile): boolean {
  return profile.observations >= MINIMUM_PROFILE_OBSERVATIONS;
}

/** Hours at which this user has historically completed more than one commitment. */
export function preferredHours(profile: BehaviorProfile): number[] {
  return Object.entries(profile.completionsByHour)
    .filter(([, count]) => count > 1)
    .map(([hour]) => Number(hour))
    .sort((left, right) => left - right);
}

export function kindAffinity(profile: BehaviorProfile, kind: Commitment['kind']): number {
  const rate = profile.completionRateByKind[kind];
  if (rate === undefined) return 0;
  return Number((rate - profile.overallCompletionRate).toFixed(4));
}
