/**
 * How a missed piece of work is tried again (lane E4, owner answer of
 * 2026-11-13 to spec item 4).
 *
 * «واحد على خمسة → واحد على أربعة» was an example, not a formula. The rule is:
 * when work is missed, the app proposes a real, workable new plan for it, and
 * the plan changes the approach when the old one failed. This module is the
 * "changes the approach" half, and it is pure: the miss history and the free
 * slots come in, the approach and the sessions go out. No model is asked, and
 * no clock is read — `now` is an input — so the same history and the same
 * calendar always give the same proposal.
 *
 * The approach is chosen from the miss history only:
 *
 *   - **first miss** — the person chose that time of day, so the work keeps it
 *     and only moves to the next free slot there (any time of day when that
 *     part of the day has no room);
 *   - **missed again in the same part of the day** — a second miss in the same
 *     slot means a different slot: that part of the day is avoided;
 *   - **missed again, at different times** — the work is split into two
 *     smaller pieces on two days (a piece of at least 15 minutes); when it is
 *     already too short to split, the time of day changes instead;
 *   - **a deadline close by** (within 72 hours) — the work starts at the
 *     earliest free slot, and every session must end before the deadline.
 *
 * Each proposal says in one line what changed and why: `reason` names the why,
 * `changes` the what, and the phone words both from a template.
 */

export type DayPart = 'morning' | 'afternoon' | 'evening';
export type RescheduleReason = 'first_miss' | 'same_time_again' | 'missed_again' | 'deadline_near';
export type RescheduleChange = 'new_time' | 'other_time_of_day' | 'smaller_pieces' | 'earlier_start';

export interface MissRecord {
  /** When the missed session was meant to start. Also the miss's identity. */
  readonly startsAt: string;
  readonly durationMinutes: number;
  readonly dayPart: DayPart;
}

export interface RescheduleApproach {
  readonly reason: RescheduleReason;
  readonly changes: readonly RescheduleChange[];
  readonly sessions: 1 | 2;
  readonly minutesEach: number;
  /** Parts of the day the sessions must not start in. */
  readonly avoidDayParts: readonly DayPart[];
  /** The part of the day tried first; any part is the fallback. */
  readonly preferDayPart: DayPart | null;
  readonly missCount: number;
}

export interface Interval { readonly startsAt: string; readonly endsAt: string }

const MINUTE = 60_000;
const DEADLINE_NEAR_MS = 72 * 3_600_000;
const MIN_PIECE_MINUTES = 15;
/** Work this long or longer is split on a repeated miss; shorter is not cut into crumbs. */
const SPLIT_FROM_MINUTES = 30;

function localHour(iso: string, timezone: string): number {
  const text = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
  return Number(text.slice(0, 2));
}

export function localDateOf(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

/** Before noon is the morning, noon to five the afternoon, the rest the evening. */
export function dayPartOf(iso: string, timezone: string): DayPart {
  const hour = localHour(iso, timezone);
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  return 'evening';
}

/** The history with the current miss in it once, oldest first. */
export function withMiss(history: readonly MissRecord[], current: MissRecord): MissRecord[] {
  const all = history.some((miss) => miss.startsAt === current.startsAt) ? [...history] : [...history, current];
  return all.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}

export function chooseApproach(input: {
  current: MissRecord;
  history: readonly MissRecord[];
  deadlineAt: string | null;
  now: string;
  /** False for work whose length nobody stated: it changes time of day instead of being split. */
  splittable?: boolean;
}): RescheduleApproach {
  const all = withMiss(input.history, input.current);
  const missCount = all.length;
  const minutes = Math.max(MIN_PIECE_MINUTES, Math.round(input.current.durationMinutes));
  const counts = new Map<DayPart, number>();
  for (const miss of all) counts.set(miss.dayPart, (counts.get(miss.dayPart) ?? 0) + 1);

  const deadlineNear = input.deadlineAt !== null
    && Date.parse(input.deadlineAt) - Date.parse(input.now) <= DEADLINE_NEAR_MS;
  const sameTimeAgain = (counts.get(input.current.dayPart) ?? 0) >= 2;
  const split = (input.splittable ?? true) && missCount >= 2 && minutes >= SPLIT_FROM_MINUTES;
  // Every repeated miss changes something. Too short to split and never
  // missed twice in one part of the day: the time of day is what changes.
  const otherTime = sameTimeAgain || (missCount >= 2 && !split);
  const avoid = (['morning', 'afternoon', 'evening'] as const).filter((part) => (counts.get(part) ?? 0) >= 2
    || (otherTime && part === input.current.dayPart));

  const changes: RescheduleChange[] = [];
  if (deadlineNear) changes.push('earlier_start');
  if (otherTime) changes.push('other_time_of_day');
  if (split) changes.push('smaller_pieces');
  if (changes.length === 0) changes.push('new_time');

  const reason: RescheduleReason = deadlineNear ? 'deadline_near'
    : sameTimeAgain ? 'same_time_again'
      : missCount >= 2 ? 'missed_again'
        : 'first_miss';

  return {
    reason,
    changes,
    sessions: split ? 2 : 1,
    minutesEach: split ? Math.max(MIN_PIECE_MINUTES, Math.ceil(minutes / 2 / 5) * 5) : minutes,
    avoidDayParts: avoid,
    preferDayPart: missCount === 1 && !deadlineNear ? input.current.dayPart : null,
    missCount,
  };
}

/**
 * The sessions, from free slots already found and checked by the free-slot
 * engine (`slots` is every free start for `minutesEach`, in time order).
 *
 * The first session is the earliest slot in the preferred part of the day,
 * else the earliest slot in any allowed part. A second session goes on a later
 * day — two pieces on one day are the same block with a gap — in the first
 * session's part of the day when that day has room there. With a deadline,
 * every session ends by it. `null` when no workable plan fits: the proposal is
 * then not made at all, rather than made without the change it promised.
 */
export function pickSessions(
  slots: readonly Interval[],
  approach: RescheduleApproach,
  options: { timezone: string; deadlineAt: string | null },
): Interval[] | null {
  const allowed = slots.filter((slot) => !approach.avoidDayParts.includes(dayPartOf(slot.startsAt, options.timezone))
    && (options.deadlineAt === null || Date.parse(slot.endsAt) <= Date.parse(options.deadlineAt)));
  if (allowed.length === 0) return null;
  const first = (approach.preferDayPart
    ? allowed.find((slot) => dayPartOf(slot.startsAt, options.timezone) === approach.preferDayPart)
    : undefined) ?? allowed[0]!;
  if (approach.sessions === 1) return [first];
  const firstDay = localDateOf(first.startsAt, options.timezone);
  const firstPart = dayPartOf(first.startsAt, options.timezone);
  const later = allowed.filter((slot) => localDateOf(slot.startsAt, options.timezone) > firstDay);
  if (later.length === 0) return null;
  const nextDay = localDateOf(later[0]!.startsAt, options.timezone);
  const onNextDay = later.filter((slot) => localDateOf(slot.startsAt, options.timezone) === nextDay);
  const second = onNextDay.find((slot) => dayPartOf(slot.startsAt, options.timezone) === firstPart) ?? onNextDay[0]!;
  return [first, second];
}

/** The minutes an interval lasts. */
export function minutesOf(interval: Interval): number {
  return Math.round((Date.parse(interval.endsAt) - Date.parse(interval.startsAt)) / MINUTE);
}
