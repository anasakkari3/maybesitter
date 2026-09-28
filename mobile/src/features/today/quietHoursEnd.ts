import { instantForLocalDateTime, localDateTimeFor } from '../capture/localInstant';

/**
 * When quiet hours end, as an instant (FZ2 review M4).
 *
 * The next-step route says `until: "07:30"`, which is the end of the quiet
 * window on the *profile's* clock — the zone `nextStepAccess` judged "inside
 * quiet hours" in. A phone in another zone that printed it as-is told a
 * traveller the wrong hour. So it becomes the next instant the profile's clock
 * reads that time — later today there, or tomorrow when the window crosses
 * midnight — and every screen formats that instant on the phone's own clock.
 */
export function quietHoursEndAt(until: string, profileZone: string, now: Date): Date | null {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(until)) return null;
  const today = localDateTimeFor(now, profileZone).slice(0, 10);
  const later = firstInstantReading(`${today}T${until}`, profileZone);
  if (!later) return null;
  if (later.getTime() > now.getTime()) return later;
  const [year, month, day] = today.split('-').map(Number) as [number, number, number];
  const tomorrow = new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
  return firstInstantReading(`${tomorrow}T${until}`, profileZone);
}

const MINUTE = 60_000;

/**
 * The first instant the clock in `zone` reads `local` or later.
 *
 * Normally the instant it reads exactly that. In a spring-forward gap the
 * clock never does — New York goes from 01:59 to 03:00 — and quiet hours
 * "until 02:30" end at the jump, which is also when the server's
 * minutes-of-day check stops calling it quiet (POLISH-MOBILE review m6).
 * Found by halving between three hours either side, at minute steps.
 */
function firstInstantReading(local: string, zone: string): Date | null {
  const guess = instantForLocalDateTime(local, zone);
  if (!guess) return null;
  if (localDateTimeFor(guess, zone) === local) return guess;
  let before = guess.getTime() - 3 * 60 * MINUTE;
  let after = guess.getTime() + 3 * 60 * MINUTE;
  while (after - before > MINUTE) {
    const mid = before + Math.floor((after - before) / 2 / MINUTE) * MINUTE;
    if (localDateTimeFor(new Date(mid), zone) >= local) after = mid;
    else before = mid;
  }
  return new Date(after);
}
