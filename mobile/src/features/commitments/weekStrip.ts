/**
 * The seven days the calendar strip shows (UC-2.R3, #173).
 *
 * Pure, and taking `now` and the zone explicitly, because the one thing that
 * can be wrong here is invisible from a test that reads the real clock: build
 * the strip in UTC instead of the user's zone and it is correct for twenty-odd
 * hours a day and off by one for the rest. A fixed `now` inside that window is
 * the only honest way to assert it.
 */
import { dayKey, shiftDayKey } from '../../i18n/format';

/** Today, and the six days after it. */
export const STRIP_DAYS = 7;

export function weekStripKeys(now: Date, timeZone: string): string[] {
  const first = dayKey(now, timeZone);
  return Array.from({ length: STRIP_DAYS }, (_, offset) => shiftDayKey(first, offset));
}
