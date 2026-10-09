/**
 * Free time on a day (M4a R003/R004): the gaps between what occupies it.
 *
 * ── The same rule the server uses ────────────────────────────────
 *
 * What occupies time is the server's rule (`fixedStartOf` / `fixedEndFor`,
 * `lib/services/timeCollision.ts`), read off the row's *effective* placement:
 *
 *   1. a saved week-plan slot, `startsAt`–`endsAt`;
 *   2. a postponement, from `postponedUntil` for its `endAt` when that is
 *      later, else 30 minutes;
 *   3. its own time: a scheduled event or a timed window, for its `endAt` or
 *      30 minutes. A plain deadline names when it is due, not when it is
 *      done, and an all-day item names a day, not an hour: neither occupies
 *      the clock.
 *
 * Busy blocks and weekly fixed blocks occupy exactly their interval, and an
 * all-day busy block occupies no clock time either.
 *
 * ── Instants, not minutes ────────────────────────────────────────
 *
 * Every boundary is an absolute instant: the local day's start and end in the
 * person's zone, and its waking window. A day across a clock change is then
 * 23 or 25 hours without anything here knowing, and a block that runs past
 * midnight is clipped to each day it touches rather than to the day it began.
 */
import { instantForLocalDateTime, localDateTimeFor } from '../capture/localInstant';
import { shiftDayKey } from '../../i18n/format';

/** Occupied or free time, in epoch milliseconds, `[start, end)`. */
export interface Interval {
  readonly start: number;
  readonly end: number;
}

/** A free stretch of the day. */
export type Gap = Interval;

/** The server's `DEFAULT_FIXED_EVENT_MINUTES`. */
export const DEFAULT_OCCUPY_MINUTES = 30;
/** The shortest gap worth naming (PLAN R003). */
export const MIN_GAP_MINUTES = 30;
/** The shortest gap «الكل» draws as a quiet row between items (PLAN R003). */
export const QUIET_ROW_MINUTES = 60;
/** The waking day when the routine profile names no sleep (PLAN R003). */
export const DEFAULT_DAY_WINDOW = { start: '08:00', end: '22:00' } as const;

const MINUTE = 60_000;

/** The fields of a commitment that decide whether, and when, it occupies time. */
export interface OccupancyInput {
  readonly kind: string | null;
  readonly dueAt: string | null;
  readonly remindAt?: string | null;
  readonly endAt: string | null;
  readonly allDay: boolean;
  readonly postponedUntil: string | null;
  /** A saved week-plan slot, when a saved day holds it. */
  readonly saved: { readonly startsAt: string; readonly endsAt: string | null } | null;
}

function parse(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** `fixedEndFor`: its own end when that is after the start, else 30 minutes. */
function endFor(start: number, endAt: string | null): number {
  const end = parse(endAt);
  return end !== null && end > start ? end : start + DEFAULT_OCCUPY_MINUTES * MINUTE;
}

/** The interval a commitment occupies, or null when it occupies no clock time. */
export function occupancyOf(input: OccupancyInput): Interval | null {
  if (input.saved) {
    const start = parse(input.saved.startsAt);
    if (start === null) return null;
    return { start, end: endFor(start, input.saved.endsAt) };
  }
  const postponed = parse(input.postponedUntil);
  if (postponed !== null) return { start: postponed, end: endFor(postponed, input.endAt) };
  if (input.allDay) return null;
  if (input.kind === 'scheduled_event') {
    const start = parse(input.dueAt) ?? parse(input.remindAt);
    return start === null ? null : { start, end: endFor(start, input.endAt) };
  }
  // A timed window (`isTimedWindow`): a due-by with an end, done between the two.
  if (input.kind === 'due_by' && input.dueAt && input.endAt) {
    const start = parse(input.dueAt);
    return start === null ? null : { start, end: endFor(start, input.endAt) };
  }
  return null;
}

/**
 * The first instant of local day `key` in `timeZone`.
 *
 * Usually its 00:00. Where the clocks jump forward at midnight (Chile's spring,
 * M4A-REV-002) there is no 00:00, and resolving it lands an hour early, on the
 * previous day; where they fall back at midnight it can land on the second of
 * two 00:00s. So the guess is checked against what it formats back to and
 * moved to the first instant whose local date is `key`.
 */
function startOfLocalDay(key: string, timeZone: string): number {
  const dateOf = (ms: number) => localDateTimeFor(new Date(ms), timeZone).slice(0, 10);
  const COARSE = 15 * MINUTE;
  // Real discontinuities reach three hours (Antarctica/Casey fell back from
  // 02:59 to 00:00 on 2019-03-17, M4A-R2-REV-003), so the search covers a
  // whole day each way, coarsely, then the last quarter hour minute by minute.
  let ms = instantForLocalDateTime(`${key}T00:00`, timeZone)!.getTime();
  for (let step = 0; step < 96 && dateOf(ms) < key; step += 1) ms += COARSE;
  for (let step = 0; step < 96 && dateOf(ms - COARSE) === key; step += 1) ms -= COARSE;
  for (let step = 0; step < 15 && dateOf(ms - MINUTE) === key; step += 1) ms -= MINUTE;
  return ms;
}

/** The local day `key` (`YYYY-MM-DD`) in `timeZone`, as absolute instants. */
export function dayBounds(key: string, timeZone: string): Interval {
  return { start: startOfLocalDay(key, timeZone), end: startOfLocalDay(shiftDayKey(key, 1), timeZone) };
}

function clockMinutes(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function at(key: string, minutes: number, timeZone: string): number {
  const day = Math.floor(minutes / (24 * 60));
  const rest = minutes - day * 24 * 60;
  const hh = String(Math.floor(rest / 60)).padStart(2, '0');
  const mm = String(rest % 60).padStart(2, '0');
  return instantForLocalDateTime(`${shiftDayKey(key, day)}T${hh}:${mm}`, timeZone)!.getTime();
}

/**
 * The waking parts of day `key`: the day less the routine's sleep, or
 * 08:00–22:00 when the profile names none. A sleep that crosses midnight
 * (23:00–07:00) takes the morning and the late evening; one inside the day
 * (02:00–10:00) leaves both ends awake.
 */
export function dayWindow(key: string, timeZone: string, sleep: { start: string; end: string } | null): Interval[] {
  const day = dayBounds(key, timeZone);
  const from = sleep ? clockMinutes(sleep.start) : null;
  const to = sleep ? clockMinutes(sleep.end) : null;
  if (from === null || to === null || from === to) {
    return [{ start: at(key, clockMinutes(DEFAULT_DAY_WINDOW.start)!, timeZone), end: at(key, clockMinutes(DEFAULT_DAY_WINDOW.end)!, timeZone) }];
  }
  // Sleep periods touching this day: the one that starts yesterday evening and
  // the one that starts today, each as instants.
  const sleeps: Interval[] = [];
  for (const offset of [-1, 0]) {
    const startMinute = offset * 24 * 60 + from;
    const endMinute = startMinute + ((to - from + 24 * 60) % (24 * 60));
    sleeps.push({ start: at(key, startMinute, timeZone), end: at(key, endMinute, timeZone) });
  }
  return subtract([day], sleeps);
}

/** `from` less every interval of `cut`, in order. */
export function subtract(from: readonly Interval[], cut: readonly Interval[]): Interval[] {
  const merged = mergeIntervals(cut);
  const out: Interval[] = [];
  for (const piece of from) {
    let cursor = piece.start;
    for (const block of merged) {
      if (block.end <= cursor) continue;
      if (block.start >= piece.end) break;
      if (block.start > cursor) out.push({ start: cursor, end: Math.min(block.start, piece.end) });
      cursor = Math.max(cursor, block.end);
      if (cursor >= piece.end) break;
    }
    if (cursor < piece.end) out.push({ start: cursor, end: piece.end });
  }
  return out;
}

/** Sorted, with overlapping and touching intervals joined. */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals.filter((i) => i.end > i.start).slice().sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const interval of sorted) {
    const last = out[out.length - 1];
    if (last && interval.start <= last.end) out[out.length - 1] = { start: last.start, end: Math.max(last.end, interval.end) };
    else out.push({ ...interval });
  }
  return out;
}

/**
 * The free gaps of one day, at least 30 minutes each, in order.
 *
 * `occupied` may hold anything that intersects the day; it is clipped. The
 * evaluated time is the day, inside `window` (its waking parts), from `now`
 * onward when `now` falls on or before the day's end.
 */
export function freeGaps(
  occupied: readonly Interval[],
  day: Interval,
  window: readonly Interval[],
  now: number,
): Gap[] {
  const evaluated = evaluatedInterval(day, now);
  if (!evaluated) return [];
  const inWindow = window
    .map((piece) => ({ start: Math.max(piece.start, evaluated.start), end: Math.min(piece.end, evaluated.end) }))
    .filter((piece) => piece.end > piece.start);
  return subtract(inWindow, occupied)
    .filter((gap) => gap.end - gap.start >= MIN_GAP_MINUTES * MINUTE);
}

/** The part of the day still ahead: `[max(dayStart, now), dayEnd)`, or null once it is over. */
export function evaluatedInterval(day: Interval, now: number): Interval | null {
  const start = Math.max(day.start, now);
  return start < day.end ? { start, end: day.end } : null;
}

/** Total free minutes across `gaps`. */
export function freeMinutes(gaps: readonly Gap[]): number {
  return gaps.reduce((sum, gap) => sum + (gap.end - gap.start) / MINUTE, 0);
}

/** Whether every part of `interval` lies inside one of `covered`. */
export function covers(covered: readonly Interval[], interval: Interval): boolean {
  return subtract([interval], covered).length === 0;
}

/** Whether `interval` meets any of `unknown`. */
export function touches(unknown: readonly Interval[], interval: Interval): boolean {
  return unknown.some((range) => range.start < interval.end && interval.start < range.end);
}
