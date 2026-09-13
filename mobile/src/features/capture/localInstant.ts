/**
 * A wall-clock string as an instant in a named zone (UC-2.4, #164).
 *
 * ── Not `new Date('2026-03-27T09:00')` ───────────────────────────
 *
 * That is parsed in the *host's* zone, which under Jest is whatever `TZ` says
 * and on a device is the user's — but not necessarily the zone being computed
 * for. The same reasoning as `postpone.ts`: everything goes through `Intl` with
 * an explicit `timeZone`, which is the only way to ask "what is the offset in
 * Jerusalem on that date" without a tz library.
 *
 * Resolved twice, because the offset at the guess and the offset at the answer
 * differ across a clock change. Two passes is enough for every real zone: none
 * changes offset twice within a day.
 */
function offsetMinutes(instant: Date, timeZone: string): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(instant)
    .find((part) => part.type === 'timeZoneName')?.value ?? 'GMT+00:00';
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (!match) return 0;
  return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
}

/** `YYYY-MM-DDTHH:mm` in `timeZone`, or null when it is not that shape. */
export function instantForLocalDateTime(value: string, timeZone: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number) as unknown as number[];
  if (month! < 1 || month! > 12 || day! < 1 || day! > 31 || hour! > 23 || minute! > 59) return null;

  const asUtc = Date.UTC(year!, month! - 1, day!, hour!, minute!, 0, 0);
  const firstGuess = new Date(asUtc - offsetMinutes(new Date(asUtc), timeZone) * 60_000);
  return new Date(asUtc - offsetMinutes(firstGuess, timeZone) * 60_000);
}

/** The inverse: an instant as `YYYY-MM-DDTHH:mm` on the clock in `timeZone`. */
export function localDateTimeFor(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(instant);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '00';
  // `en-CA` renders midnight as 24 in some engines.
  const hour = String(Number(get('hour')) % 24).padStart(2, '0');
  return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}`;
}
