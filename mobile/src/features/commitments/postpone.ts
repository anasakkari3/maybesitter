/**
 * "Not now" — the four presets, computed in the user's own zone
 * (UC-2.R3, #173).
 *
 * ── Why this is not `+ 24 * 60 * 60 * 1000` ──────────────────────
 *
 * "Tomorrow morning" means 09:00 where the person is, and on the two days a
 * year the clocks move, that is 23 or 25 hours away rather than 24. Adding
 * milliseconds gives 08:00 or 10:00 — an hour early is a reminder that
 * interrupts, an hour late is one that arrives after the thing it was for.
 *
 * So the two day-based presets are computed as *wall-clock* dates in the target
 * zone and converted back to an instant, and the two hour-based ones are plain
 * arithmetic, because "in an hour" really does mean 3,600 seconds regardless of
 * what the clocks do in between.
 *
 * ── No `Date` parsing of local strings ───────────────────────────
 *
 * `new Date('2026-03-27T09:00')` is parsed in the *host's* zone, which under
 * Jest is whatever `TZ` says and on a device is the user's — but not
 * necessarily the zone we are computing for. Everything here goes through
 * `Intl.DateTimeFormat` with an explicit `timeZone`, which is the only way to
 * ask "what is the offset in Jerusalem on that date" without a tz library.
 *
 * The offset itself comes from `lib/time/zoneOffset`, which reads it off the
 * clock rather than parsing a "GMT+03:00" label — Hermes does not report that
 * label the way Node does, and this file used to fall back to UTC on a device.
 */
import { instantForWallClock } from '../../lib/time/zoneOffset';

export type PostponePreset =
  | 'oneHour'
  | 'threeHours'
  | 'thisEvening'
  | 'tomorrowMorning'
  | 'nextWeek';

/** The four the details sheet offers for "not now" (UC-2.R3, #173). */
export const POSTPONE_PRESETS: readonly PostponePreset[] = [
  'oneHour', 'threeHours', 'tomorrowMorning', 'nextWeek',
];

/**
 * The three the next step offers for "later" (UC-2.9, #170).
 *
 * A shorter list than postponing, and deliberately: deferring a *suggestion* is
 * a small "not right now", and offering to push it a week would turn one tap
 * into a decision about the rest of the month.
 */
export const DEFER_PRESETS: readonly PostponePreset[] = [
  'oneHour', 'thisEvening', 'tomorrowMorning',
];

/** 09:00 is the design's "morning": late enough to be awake, early enough to act. */
const MORNING_HOUR = 9;
/** 18:00 is "this evening": after a working day, before it is too late to act. */
const EVENING_HOUR = 18;

const HOUR_MS = 60 * 60 * 1000;

/**
 * The parts of an instant, as they read on a wall clock in `timeZone`.
 */
function partsIn(instant: Date, timeZone: string): { year: number; month: number; day: number } {
  const formatted = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(instant);
  const [year, month, day] = formatted.split('-').map(Number);
  return { year: year!, month: month!, day: day! };
}

/** Adds days to a wall-clock date, letting `Date.UTC` carry month and year ends. */
function addDays(
  date: { year: number; month: number; day: number },
  days: number,
): { year: number; month: number; day: number } {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/**
 * When a preset postpones to, as an ISO instant.
 *
 * `now` is a parameter, so the same input gives the same answer in a test, in
 * a replay, and on a device whose clock is wrong.
 */
export function postponeTo(preset: PostponePreset, now: Date, timeZone: string): string {
  if (preset === 'oneHour') return new Date(now.getTime() + HOUR_MS).toISOString();
  if (preset === 'threeHours') return new Date(now.getTime() + 3 * HOUR_MS).toISOString();

  const today = partsIn(now, timeZone);

  if (preset === 'thisEvening') {
    const evening = instantForWallClock({ ...today, hour: EVENING_HOUR }, timeZone);
    // Past six already: "this evening" has gone, and answering with a time in
    // the past would defer nothing at all. Tomorrow evening is what the words
    // still honestly mean.
    return (evening.getTime() > now.getTime()
      ? evening
      : instantForWallClock({ ...addDays(today, 1), hour: EVENING_HOUR }, timeZone)).toISOString();
  }

  const target = addDays(today, preset === 'tomorrowMorning' ? 1 : 7);
  return instantForWallClock({ ...target, hour: MORNING_HOUR }, timeZone).toISOString();
}

/**
 * Whether an instant may be postponed to.
 *
 * The server refuses a past instant with a 400 before the state machine sees
 * it, so this is the client saying the same thing first — a picker that lets
 * somebody choose yesterday and then fails is a worse version of a picker that
 * does not.
 */
export function isPostponable(instant: string, now: Date): boolean {
  const ms = Date.parse(instant);
  return !Number.isNaN(ms) && ms > now.getTime();
}
