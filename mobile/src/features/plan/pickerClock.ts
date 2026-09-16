/**
 * Talking to a native wheel about wall-clock time (UC-3.10b, #195).
 *
 * ── Why local getters, here and nowhere else ─────────────────────
 *
 * `@react-native-community/datetimepicker` draws the *operating system's* clock
 * face. It is handed a `Date` and it shows that instant as the OS renders it;
 * the `Date` it hands back is the instant matching the face the user left it
 * on. Both ends are the same clock, so the only honest way to read the wheel is
 * with the same local getters that were used to set it — `getHours` in, out.
 *
 * This is the opposite of the rule everywhere else in this app, and deliberately
 * so. Elsewhere a local getter is a bug: it silently reads the *host's* zone,
 * which on 2026-09-14 stored "tomorrow morning" as noon and moved a 15:45
 * commitment to 21:45 while Jest stayed green (see `lib/time/zoneOffset`). What
 * makes it correct here is that nothing is being converted — the wall clock goes
 * in and the same wall clock comes out, and the conversion to an instant in the
 * *plan's* zone happens afterwards, through `instantForLocalDateTime`, which
 * reads offsets off the clock rather than off a label Hermes mis-reports.
 *
 * Going through a zone *name* instead would be worse, not better: the name
 * available to this app is `expo-localization`'s, and pairing it with a wheel
 * that draws the OS clock means two sources for one fact, disagreeing whenever
 * they are not the same string.
 */

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** The wall clock the wheel was showing, as `YYYY-MM-DDTHH:mm`. */
export function wallClockShown(picked: Date): string {
  return [
    `${picked.getFullYear()}-${pad(picked.getMonth() + 1)}-${pad(picked.getDate())}`,
    `${pad(picked.getHours())}:${pad(picked.getMinutes())}`,
  ].join('T');
}

/**
 * A `Date` the wheel will show as `wall`, which is `YYYY-MM-DDTHH:mm`.
 *
 * Built with local setters rather than parsed: `new Date('2026-03-27T09:00')`
 * is read in the host's zone by some engines and as UTC by others, and the two
 * answers differ by the offset — which is the whole class of defect this app
 * has already shipped once.
 */
export function dateShowing(wall: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(wall);
  if (!match) return new Date();
  const [, year, month, day, hour, minute] = match.map(Number) as unknown as number[];
  const value = new Date();
  value.setFullYear(year!, month! - 1, day!);
  value.setHours(hour!, minute!, 0, 0);
  return value;
}

/** A `Date` the wheel will show at `HH:mm` today. For a time with no date. */
export function timeShowing(hhmm: string): Date {
  const [hour = 0, minute = 0] = hhmm.split(':').map(Number);
  const value = new Date();
  value.setHours(hour, minute, 0, 0);
  return value;
}

/** The `HH:mm` half of what the wheel was showing. */
export function timeShown(picked: Date): string {
  return wallClockShown(picked).slice(11);
}
