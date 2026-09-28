/**
 * The instant a wall clock reads in a zone, for building test fixtures.
 *
 * Tests used to write Jerusalem as a literal `+03:00`. That is true until the
 * last Sunday of October and false for the five months after it, so a fixture
 * built from "today" (or "today + 10 days") started failing on its own as the
 * calendar walked into winter — with nothing in the app having changed.
 *
 * The offset is read off the zone's own clock at the instant in question, so a
 * fixture is right on either side of a clock change and on the day of one.
 *
 * Deliberately not `lib/time/zoneOffset`: that is code under test, and a
 * fixture built with it could agree with a broken conversion instead of
 * catching it.
 */

/** What `timeZone`'s clock face read at `ms`, written as if it were UTC. */
function clockAsUtc(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(read('year'), read('month') - 1, read('day'), read('hour') % 24, read('minute'), read('second'));
}

/**
 * The ISO instant at which `local` (`YYYY-MM-DDTHH:MM[:SS[.mmm]]`, no offset)
 * happens in `timeZone`. Throws for a wall clock the zone skips (the hour lost
 * when the clocks go forward), rather than quietly returning a neighbour.
 */
export function instantAt(local: string, timeZone: string): string {
  const wall = Date.parse(`${local}Z`);
  if (Number.isNaN(wall)) throw new Error(`instantAt: not a local date-time: ${local}`);
  const whole = Math.floor(wall / 1000) * 1000;
  let guess = whole;
  // Twice: the offset at the first guess and at the answer can differ across a
  // clock change; no real zone changes twice within a day.
  for (let pass = 0; pass < 2; pass += 1) guess = whole - (clockAsUtc(guess, timeZone) - guess);
  if (clockAsUtc(guess, timeZone) !== whole) throw new Error(`instantAt: ${local} does not occur in ${timeZone}`);
  return new Date(guess + (wall - whole)).toISOString();
}
