import type { Commitment, Reminder } from '../../src/domain/stateMachine';

export type AgendaScoringReason = 'overdue' | 'due_soon' | 'pending' | 'active';

export interface AgendaScoringInput {
  commitment: Commitment;
  reminders: readonly Reminder[];
  reason: AgendaScoringReason;
  now: Date;
  relevantTimes: readonly string[];
  dueSoonWindowMs: number;
}

const SCORE_CAP = 9_999;
const REASON_BASE_SCORE: Record<AgendaScoringReason, number> = {
  overdue: 7_000,
  due_soon: 5_000,
  active: 3_000,
  pending: 1_000,
};
const REASON_BAND_CAP = 999;
const RECENT_IGNORED_WINDOW_MS = 24 * 60 * 60 * 1_000;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function importanceScore(commitment: Commitment): number {
  if (commitment.priority.level === 'high') return 180;
  if (commitment.priority.level === 'normal') return 80;
  return 0;
}

function overdueDurationScore(times: readonly string[], nowMs: number): number {
  const overdueTimes = times
    .map(parseTime)
    .filter((time): time is number => time !== null && time < nowMs)
    .sort((a, b) => a - b);
  if (overdueTimes.length === 0) return 0;

  const hoursOverdue = (nowMs - overdueTimes[0]) / (60 * 60 * 1_000);
  return clamp(Math.round(hoursOverdue * 6), 0, 420);
}

function timeRemainingScore(times: readonly string[], nowMs: number, dueSoonWindowMs: number): number {
  const upcomingTimes = times
    .map(parseTime)
    .filter((time): time is number => time !== null && time >= nowMs)
    .sort((a, b) => a - b);
  if (upcomingTimes.length === 0 || dueSoonWindowMs <= 0) return 0;

  const remainingMs = clamp(upcomingTimes[0] - nowMs, 0, dueSoonWindowMs);
  const closeness = 1 - remainingMs / dueSoonWindowMs;
  return clamp(Math.round(closeness * 420), 0, 420);
}

function repeatedDelayScore(commitment: Commitment, reminders: readonly Reminder[]): number {
  const snoozedCount = reminders.filter((reminder) => reminder.status === 'snoozed').length;
  const snoozeBoost = clamp(snoozedCount * 90, 0, 270);
  const postponedBoost = commitment.currentAckState === 'postponed' || commitment.postponedUntil ? 160 : 0;
  const deferredBoost = commitment.status === 'deferred' ? 80 : 0;
  return snoozeBoost + postponedBoost + deferredBoost;
}

function latestIgnoredAt(commitment: Commitment, reminders: readonly Reminder[]): number | null {
  const ignoredTimes = reminders
    .filter((reminder) => reminder.status === 'ignored')
    .map((reminder) => parseTime(reminder.updatedAt) || parseTime(reminder.deliveredAt) || parseTime(reminder.createdAt))
    .filter((time): time is number => time !== null)
    .sort((a, b) => b - a);

  if (ignoredTimes.length > 0) return ignoredTimes[0];
  return commitment.currentAckState === 'ignored' ? parseTime(commitment.updatedAt) : null;
}

function ignoredScore(commitment: Commitment, reminders: readonly Reminder[], nowMs: number): number {
  const ignoredAt = latestIgnoredAt(commitment, reminders);
  if (!ignoredAt) return 0;
  return nowMs - ignoredAt <= RECENT_IGNORED_WINDOW_MS ? 240 : 120;
}

function reasonTimeScore(input: AgendaScoringInput, nowMs: number): number {
  if (input.reason === 'overdue') return overdueDurationScore(input.relevantTimes, nowMs);
  if (input.reason === 'due_soon') {
    return timeRemainingScore(input.relevantTimes, nowMs, input.dueSoonWindowMs);
  }
  return 0;
}

export function calculateAgendaUrgencyScore(input: AgendaScoringInput): number {
  const nowMs = input.now.getTime();
  const rawBandScore =
    reasonTimeScore(input, nowMs) +
    importanceScore(input.commitment) +
    repeatedDelayScore(input.commitment, input.reminders) +
    ignoredScore(input.commitment, input.reminders, nowMs);
  const bandScore = clamp(rawBandScore, 0, REASON_BAND_CAP);

  return clamp(REASON_BASE_SCORE[input.reason] + bandScore, 0, SCORE_CAP);
}
