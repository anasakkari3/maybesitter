/**
 * Quiet hours defer a reminder; they do not delete it (UC-3.11, #196).
 *
 * ── The defect this port exists to fix ───────────────────────────
 *
 * The Flutter engine *dropped* any stage that fell inside quiet hours
 * (`soft_awareness_reminder_engine.dart:190-193`) while its own mode was named
 * `alwaysDefer` (`pilot_presence.dart:395`). So a 09:00 commitment with quiet
 * hours ending at 07:00 got no reminder at all: the one setting whose purpose
 * is "not right now" was implemented as "not at all".
 *
 * Here a stage inside the window moves to the **end** of the window, and is
 * dropped only when that would put it too close to the commitment to be of any
 * use. "Too close" is five minutes: a reminder that lands four minutes before
 * something is not a heads-up, it is a start.
 *
 * ── Wall clock, not arithmetic on the instant ────────────────────
 *
 * The end of the quiet window is `07:00 on the user's clock`, which is not a
 * fixed number of milliseconds away on the morning the clocks change. So the
 * end is resolved through `instantForWallClock`, which resolves the offset
 * twice — and both halves read the clock the way Hermes reports it, because
 * `timeZoneName: 'longOffset'` does not work there (`src/lib/time/zoneOffset.ts`).
 */
import { instantForWallClock, wallClockIn } from '../../lib/time/zoneOffset';

export interface QuietWindow {
  /** `HH:MM` on the user's own clock face. */
  readonly start: string;
  readonly end: string;
}

/** A stage that lands this close to the start is not a heads-up. */
export const MIN_LEAD_AFTER_DEFER_MS = 5 * 60_000;

export type DeferOutcome =
  /** Outside the window, or there is no window: fire as planned. */
  | { readonly kind: 'keep'; readonly at: number }
  /** Inside the window: moved to the end of it. */
  | { readonly kind: 'deferred'; readonly at: number }
  /** Inside the window, and the end of it is too late to be worth anything. */
  | { readonly kind: 'dropped' };

function minutesOf(value: string): number | null {
  const match = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/**
 * Whether `at` falls inside `window` on the clock in `timeZone`.
 *
 * A window whose end is not after its start wraps midnight — which is the
 * normal case for quiet hours, not the exception. Getting that backwards would
 * silence the app all day and let it speak all night.
 *
 * This is the same rule the server applies in `isWithinWindow`
 * (`lib/services/mobile/nextStepAccess.ts`), deliberately: the phone and the
 * server must agree about whether 23:30 is quiet, because one schedules the
 * local reminder and the other decides whether to push.
 */
export function isInQuietWindow(window: QuietWindow, at: number, timeZone: string): boolean {
  const start = minutesOf(window.start);
  const end = minutesOf(window.end);
  if (start === null || end === null) return false;
  const clock = wallClockIn(new Date(at), timeZone);
  const minutes = clock.hour * 60 + clock.minute;
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/**
 * The first instant at or after `at` at which the clock in `timeZone` reads
 * `window.end`.
 *
 * Today's occurrence when it is still ahead, otherwise tomorrow's. The day is
 * advanced through `Date.UTC`, which handles month and year ends, and the
 * result is resolved back to an instant through the zone — so on a spring
 * morning where 02:30 does not exist the resolver lands on the transition
 * rather than on an hour the clock skipped.
 */
export function endOfQuietWindow(window: QuietWindow, at: number, timeZone: string): number | null {
  const end = minutesOf(window.end);
  if (end === null) return null;
  const clock = wallClockIn(new Date(at), timeZone);
  const hour = Math.floor(end / 60);
  const minute = end % 60;

  const sameDay = instantForWallClock(
    { year: clock.year, month: clock.month, day: clock.day, hour, minute },
    timeZone,
  ).getTime();
  if (sameDay > at) return sameDay;

  const tomorrow = new Date(Date.UTC(clock.year, clock.month - 1, clock.day + 1));
  return instantForWallClock(
    {
      year: tomorrow.getUTCFullYear(),
      month: tomorrow.getUTCMonth() + 1,
      day: tomorrow.getUTCDate(),
      hour,
      minute,
    },
    timeZone,
  ).getTime();
}

/**
 * Moves a stage out of the quiet window, or reports that it cannot be saved.
 *
 * `startsAt` is the commitment's own instant: a deferred reminder that would
 * land within five minutes of it is dropped, because arriving at 06:58 for
 * something at 07:02 tells the user nothing they are not about to find out.
 */
export function deferOutOfQuietHours(
  at: number,
  window: QuietWindow | null,
  timeZone: string,
  startsAt: number,
): DeferOutcome {
  if (!window) return { kind: 'keep', at };
  // An unreadable window is not a quiet one, so a malformed `start` or `end`
  // has already returned `keep` here — which is why `endOfQuietWindow` below
  // cannot answer null past this line, and why there is no branch for it. A
  // `?? at` there would look like care and be unreachable, which is how a
  // clamp on a constant shipped in #199 with a green suite around it.
  if (!isInQuietWindow(window, at, timeZone)) return { kind: 'keep', at };

  const end = endOfQuietWindow(window, at, timeZone) as number;
  if (end > startsAt - MIN_LEAD_AFTER_DEFER_MS) return { kind: 'dropped' };
  return { kind: 'deferred', at: end };
}

/**
 * Keeps the firmer of two stages that were deferred onto the same instant.
 *
 * Two stages inside one quiet window both come out at its end, and two
 * notifications at the same second for one commitment is a bug the user reads
 * as the app being broken. `strong` beats `followUp` beats `soft`: the point of
 * escalating is that the last thing said is the firmest.
 */
export const STAGE_INTENSITY: Readonly<Record<string, number>> = Object.freeze({
  soft: 0,
  followUp: 1,
  strong: 2,
});

export function keepHigherIntensity<T extends { stage: string; at: number }>(planned: readonly T[]): T[] {
  const byInstant = new Map<number, T>();
  for (const entry of planned) {
    const existing = byInstant.get(entry.at);
    if (!existing || (STAGE_INTENSITY[entry.stage] ?? 0) > (STAGE_INTENSITY[existing.stage] ?? 0)) {
      byInstant.set(entry.at, entry);
    }
  }
  return [...byInstant.values()].sort((left, right) => left.at - right.at);
}
