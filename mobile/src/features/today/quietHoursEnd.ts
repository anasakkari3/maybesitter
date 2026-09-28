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
  const later = instantForLocalDateTime(`${today}T${until}`, profileZone);
  if (!later) return null;
  if (later.getTime() > now.getTime()) return later;
  const [year, month, day] = today.split('-').map(Number) as [number, number, number];
  const tomorrow = new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
  return instantForLocalDateTime(`${tomorrow}T${until}`, profileZone);
}
