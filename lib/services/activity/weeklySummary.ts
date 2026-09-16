/**
 * The calm weekly summary (UC-3.15, #201).
 *
 * ── What it is not ───────────────────────────────────────────────
 *
 * #201 fixes this and the decision is the feature: no streak, no percentage,
 * no "missed" or "overdue" count, no badge that can be lost, no rank, and
 * nothing here ever triggers a notification. Three positive counts and a list
 * of one-time Moments. A week where all three are zero is a quiet week, and
 * the client says so in words rather than printing "0 completed".
 *
 * ── Moments come from the counter, the counts from the window ────
 *
 * `moments` is read from `users/{uid}/stats/activity`, which only ever moves
 * forward (see activityStats). That is what makes "you have finished ten
 * things" survive the user deleting three of them — a Moment derived from the
 * items that still exist would be withdrawn the moment somebody tidied up.
 *
 * The three counts are genuinely about this week and are read from the week's
 * events, so they are as true as the log. `keptCount` additionally needs the
 * commitment's priority and its time, which live on the commitment: an item
 * deleted since cannot be counted, and that is stated rather than guessed.
 *
 * ── Week boundaries ──────────────────────────────────────────────
 *
 * Sunday for Arabic and Hebrew, Monday for English, in the user's own zone.
 * The conversion from a local midnight to an instant goes through
 * `lib/planning/shared/time`, which is the one place in this repository that
 * owns DST arithmetic — on the two days a year the offset moves, a week that
 * starts at "midnight minus the offset I happen to have now" is an hour wrong
 * and silently drops or double-counts an item.
 */
import {
  instantFromResolution,
  resolveLocalTime,
  toEpochMs,
  toInstant,
  weekdayAt,
  wallClockAt,
} from '../../planning/shared/time';
import type { UserLocale } from '../../storage/userDocument';
import { localDayKey, normalizeTimezone } from '../mobile/time';
import type { DomainEventRecord } from '../mobile/eventLog';

export type MomentId =
  | 'first_capture'
  | 'first_done'
  | 'first_plan_accepted'
  | 'done_10'
  | 'done_25'
  | 'done_50'
  | 'done_100';

export interface Moment {
  id: MomentId;
  reachedAt: string;
}

export interface WeeklySummary {
  /** The local calendar date the week starts on, `YYYY-MM-DD`. */
  weekStart: string;
  completedCount: number;
  /** Local days in the week on which a plan was accepted (#194's ledger). */
  plannedDaysCount: number;
  /** Must/Should items due this week and finished within a day of their time. */
  keptCount: number;
  moments: Moment[];
}

/** How long after its own time an item still counts as kept. */
export const KEPT_GRACE_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_DAYS = 7;

const WEEK_START_DAY: Readonly<Record<UserLocale, number>> = Object.freeze({
  ar: 0,
  he: 0,
  en: 1,
});

export function weekStartDayFor(locale: UserLocale | null | undefined): number {
  return locale ? WEEK_START_DAY[locale] ?? WEEK_START_DAY.en : WEEK_START_DAY.ar;
}

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isWeekStartKey(value: unknown): value is string {
  return typeof value === 'string' && DATE_KEY.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`));
}

/**
 * The first instant of a local calendar day.
 *
 * A day that begins inside a DST gap — Brazil used to spring forward at
 * midnight — has no 00:00, so the day begins when the clock resumes. Returning
 * the naive reading there would put the boundary an hour before the day
 * actually started.
 */
export function localDayStartInstant(dateKey: string, timezone: string): string {
  const match = DATE_KEY.exec(dateKey);
  if (!match) throw new Error(`weekStart must be YYYY-MM-DD, not ${JSON.stringify(dateKey)}`);
  const parts = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), hour: 0, minute: 0 };
  const resolution = resolveLocalTime(parts, normalizeTimezone(timezone));
  if (resolution.kind === 'gap') return resolution.resumesAt;
  // A fold takes the earlier of the two readings: the day started the first
  // time the clock said midnight, not the second.
  return instantFromResolution(resolution, 'earliest') ?? toInstant(Date.UTC(parts.year, parts.month - 1, parts.day));
}

/** The local date `days` after `dateKey`, by wall clock rather than by 24 h. */
export function addLocalDays(dateKey: string, days: number, timezone: string): string {
  const zone = normalizeTimezone(timezone);
  // Noon, not midnight: a day whose midnight falls in a DST gap still has a
  // noon, and adding whole days from it never lands on the missing hour.
  const noon = toEpochMs(localDayStartInstant(dateKey, zone)) + DAY_MS / 2;
  return localDayKey(toInstant(noon + days * DAY_MS), zone);
}

/** The local date the user's current week began on. */
export function currentWeekStart(now: Date, timezone: string, locale: UserLocale | null): string {
  const zone = normalizeTimezone(timezone);
  const startDay = weekStartDayFor(locale);
  const today = weekdayAt(now.getTime(), zone);
  const back = (today - startDay + WEEK_DAYS) % WEEK_DAYS;
  return addLocalDays(localDayKey(now, zone), -back, zone);
}

export interface WeekWindow {
  weekStart: string;
  fromInclusive: string;
  toExclusive: string;
}

export function weekWindow(weekStart: string, timezone: string): WeekWindow {
  const zone = normalizeTimezone(timezone);
  return {
    weekStart,
    fromInclusive: localDayStartInstant(weekStart, zone),
    toExclusive: localDayStartInstant(addLocalDays(weekStart, WEEK_DAYS, zone), zone),
  };
}

/** Only what this summary reads off a commitment. */
export interface SummaryCommitment {
  priority: { level: string };
  timeSpec: { dueAt: string | null; remindAt: string | null };
}

export interface SummaryInput {
  window: WeekWindow;
  timezone: string;
  events: readonly DomainEventRecord[];
  commitmentsById: ReadonlyMap<string, SummaryCommitment>;
  stats: {
    doneTotal: number;
    firstCaptureAt: string | null;
    firstDoneAt: string | null;
    firstPlanAcceptedAt: string | null;
    doneMilestonesAt: Record<string, string>;
  };
}

/** Must and Should. "Nice" is not something the product asks anyone to keep. */
const KEPT_LEVELS = new Set(['high', 'normal']);

export function summariseWeek(input: SummaryInput): WeeklySummary {
  const { window, events, commitmentsById } = input;
  const zone = normalizeTimezone(input.timezone);
  const from = toEpochMs(window.fromInclusive);
  const to = toEpochMs(window.toExclusive);

  let completedCount = 0;
  let keptCount = 0;
  const planDays = new Set<string>();

  for (const event of events) {
    const at = Date.parse(event.at);
    if (!Number.isFinite(at) || at < from || at >= to) continue;

    if (event.type === 'plan_accepted') {
      planDays.add(localDayKey(event.at, zone));
      continue;
    }
    if (event.type !== 'commitment_completed') continue;

    completedCount += 1;
    if (wasKept(event, commitmentsById, from, to, at)) keptCount += 1;
  }

  return {
    weekStart: window.weekStart,
    completedCount,
    plannedDaysCount: planDays.size,
    keptCount,
    moments: momentsFrom(input.stats),
  };
}

/**
 * Whether a completion counts as keeping something that mattered.
 *
 * Must or Should, with a time of its own inside this week, finished by that
 * time plus a day. An item whose commitment has since been deleted is not
 * counted: its priority and its time are gone, and counting it as kept would
 * be a guess dressed as a fact. `keptCount` is a count of the week, not a
 * Moment, so unlike the Moments it is allowed to depend on what still exists.
 */
function wasKept(
  event: DomainEventRecord,
  commitmentsById: ReadonlyMap<string, SummaryCommitment>,
  from: number,
  to: number,
  completedAt: number,
): boolean {
  const commitmentId = typeof event.aggregateId === 'string' ? event.aggregateId : '';
  const commitment = commitmentsById.get(commitmentId);
  if (!commitment) return false;
  if (!KEPT_LEVELS.has(commitment.priority?.level ?? '')) return false;

  const own = commitment.timeSpec?.dueAt ?? commitment.timeSpec?.remindAt ?? null;
  if (!own) return false;
  const due = Date.parse(own);
  if (!Number.isFinite(due) || due < from || due >= to) return false;

  return completedAt <= due + KEPT_GRACE_MS;
}

/**
 * Every Moment this account has reached, oldest first.
 *
 * Cumulative on purpose: the list is the same list next week plus whatever was
 * added, and it never shortens. A "moments reached this week" list would make
 * last week's first completion disappear, which is the same withdrawal #201
 * forbids in a different costume.
 */
export function momentsFrom(stats: SummaryInput['stats']): Moment[] {
  const moments: Moment[] = [];
  if (stats.firstCaptureAt) moments.push({ id: 'first_capture', reachedAt: stats.firstCaptureAt });
  if (stats.firstDoneAt) moments.push({ id: 'first_done', reachedAt: stats.firstDoneAt });
  if (stats.firstPlanAcceptedAt) {
    moments.push({ id: 'first_plan_accepted', reachedAt: stats.firstPlanAcceptedAt });
  }
  for (const threshold of [10, 25, 50, 100] as const) {
    const reachedAt = stats.doneMilestonesAt?.[String(threshold)];
    if (typeof reachedAt === 'string' && reachedAt) {
      moments.push({ id: `done_${threshold}` as MomentId, reachedAt });
    }
  }
  return moments.sort((left, right) =>
    left.reachedAt === right.reachedAt
      ? left.id.localeCompare(right.id)
      : left.reachedAt < right.reachedAt ? -1 : 1);
}

/** Exported for the tests that assert the week boundary rather than the data. */
export function localWallClock(instant: string, timezone: string): { year: number; month: number; day: number; hour: number; minute: number } {
  return wallClockAt(toEpochMs(instant), normalizeTimezone(timezone));
}
