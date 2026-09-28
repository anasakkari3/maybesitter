/**
 * When quiet hours end, as an instant (FZ2 review M4).
 *
 * The route says `until: "07:30"` on the profile's clock. A phone in another
 * zone printed that as-is: a person whose profile is Tokyo, in Delhi, read
 * "back at 07:30" when suggestions came back at 04:00 on the phone. Zones with
 * no clock change, so the expected hours hold on any date the suite runs.
 */
import { describe, expect, it } from '@jest/globals';
import { quietHoursEndAt } from '../quietHoursEnd';

describe('quietHoursEndAt', () => {
  it('is the next time the profile clock reads `until`, later tonight', () => {
    // 22:40 in Tokyo; quiet until 23:30 there.
    const now = new Date('2026-09-28T13:40:00.000Z');
    expect(quietHoursEndAt('23:30', 'Asia/Tokyo', now)?.toISOString()).toBe('2026-09-28T14:30:00.000Z');
  });

  it('rolls to the next day when `until` has already passed on the profile clock today', () => {
    // 23:30 in Tokyo inside 22:30–07:30: the end is tomorrow morning there.
    const now = new Date('2026-09-28T14:30:00.000Z');
    expect(quietHoursEndAt('07:30', 'Asia/Tokyo', now)?.toISOString()).toBe('2026-09-28T22:30:00.000Z');
  });

  it('is the same instant whatever zone the phone is in', () => {
    // 01:00 in Tokyo, quiet until 07:30 Tokyo = 22:30Z = 04:00 in Delhi.
    const now = new Date('2026-09-28T16:00:00.000Z');
    const end = quietHoursEndAt('07:30', 'Asia/Tokyo', now)!;
    expect(end.toISOString()).toBe('2026-09-28T22:30:00.000Z');
    const delhi = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(end);
    expect(delhi).toBe('04:00');
  });

  /*
   * POLISH-MOBILE review m6: an end inside a spring-forward gap. New York
   * skips 02:00–03:00 on 14 March 2027; quiet hours "until 02:30" end when
   * the clock jumps to 03:00, which the server's minutes-of-day check agrees
   * with. The card still has an hour to say, and a moment to ask again.
   */
  it('ends at the jump when `until` falls in a spring-forward gap', () => {
    const now = new Date('2027-03-14T05:00:00.000Z'); // 00:00 EST
    expect(quietHoursEndAt('02:30', 'America/New_York', now)?.toISOString()).toBe('2027-03-14T07:00:00.000Z');
  });

  it('keeps an ordinary end on a day with a clock change', () => {
    const now = new Date('2027-03-14T05:00:00.000Z');
    expect(quietHoursEndAt('07:30', 'America/New_York', now)?.toISOString()).toBe('2027-03-14T11:30:00.000Z');
  });

  it('refuses what is not a clock time', () => {
    expect(quietHoursEndAt('7:30', 'Asia/Tokyo', new Date())).toBeNull();
    expect(quietHoursEndAt('25:00', 'Asia/Tokyo', new Date())).toBeNull();
  });
});
