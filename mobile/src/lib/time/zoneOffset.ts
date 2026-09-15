/**
 * A zone's offset from UTC, read off the clock rather than off a label.
 *
 * ── Why not `timeZoneName: 'longOffset'` ─────────────────────────
 *
 * Asking for the offset *by name* and parsing "GMT+03:00" out of it is the
 * obvious way, and it is what `postpone`, `localInstant` and `diffEdits` each
 * used to do. It works on V8 and it does not work on Hermes, which splits that
 * one part up and files the digits under `literal`:
 *
 *   timeZoneName 'GMT' | literal '+' | literal '03' | literal ':' | timeZoneName '00'
 *
 * `find(p => p.type === 'timeZoneName')` then yields `"GMT"`, the regex misses,
 * and every caller quietly fell back to treating the user's wall clock as UTC.
 * On the 2026-09-14 audit that stored "tomorrow morning" as noon and moved a
 * 15:45 commitment to 21:45 — on a device, while Jest stayed green, because
 * Node's `Intl` gets it right.
 *
 * So this asks for the numbers instead. `year/month/day/hour/minute/second`
 * with an explicit `timeZone` is the one part of `Intl` both engines agree on
 * — the app already trusts it to *display* times — and the offset is simply the
 * gap between what that clock reads and the instant it reads it at.
 */

/** The offset, in minutes, of `timeZone` from UTC at `instant`. */
export function offsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const year = read('year');
  const month = read('month');
  const day = read('day');
  // Midnight renders as 24 in some engines, the same way `localDateTimeFor`
  // guards against.
  const hour = read('hour') % 24;
  const minute = read('minute');
  const second = read('second');

  if ([year, month, day, hour, minute, second].some(Number.isNaN)) return 0;

  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  // The instant's own seconds, so a zone with a sub-minute historical offset
  // does not leave a fractional remainder behind.
  const actual = Math.floor(instant.getTime() / 1000) * 1000;
  return Math.round((wall - actual) / 60_000);
}

/**
 * The instant at which a wall-clock time occurs in a zone.
 *
 * Resolved twice, because the offset at the guess and the offset at the answer
 * differ across a clock change. Two passes is enough for every real zone: none
 * changes offset twice within a day.
 */
export function instantForWallClock(
  wall: { year: number; month: number; day: number; hour: number; minute?: number },
  timeZone: string,
): Date {
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute ?? 0, 0, 0);
  const firstGuess = new Date(asUtc - offsetMinutes(new Date(asUtc), timeZone) * 60_000);
  return new Date(asUtc - offsetMinutes(firstGuess, timeZone) * 60_000);
}

/** The wall-clock fields a zone showed at an instant. Hour is 0-23. */
export interface WallClock {
  readonly year: number;
  /** 1-12, one-based, because these come from a clock face rather than `Date`. */
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

/**
 * What the clock face read in `timeZone` at `instant`.
 *
 * Here rather than in the caller for the reason the header gives: reading
 * `formatToParts` correctly on Hermes is a thing this app got wrong once, and
 * one implementation of it is one place to be right. Quiet hours ask this
 * question ("is it 23:30 where they are?") and `deferOutOfQuietHours` asks the
 * reverse one through `instantForWallClock`.
 */
export function wallClockIn(instant: Date, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(instant);

  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const year = read('year');
  const month = read('month');
  const day = read('day');
  // Midnight renders as 24 in some engines; the same guard `offsetMinutes` has.
  const hour = read('hour') % 24;
  const minute = read('minute');

  if ([year, month, day, hour, minute].some(Number.isNaN)) {
    // The instant read through UTC rather than a lie about the zone: a NaN
    // here would propagate into every comparison as `false`.
    return {
      year: instant.getUTCFullYear(),
      month: instant.getUTCMonth() + 1,
      day: instant.getUTCDate(),
      hour: instant.getUTCHours(),
      minute: instant.getUTCMinutes(),
    };
  }
  return { year, month, day, hour, minute };
}
