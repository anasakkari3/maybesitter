import { describe, expect, it } from '@jest/globals';
import { instantAt } from '../wallClock';

// Expected instants are written out, not recomputed: this helper is what other
// suites trust to build their fixtures, so it is checked against the calendar.
describe('instantAt', () => {
  const J = 'Asia/Jerusalem';

  it('uses summer time (+03:00) before the October change', () => {
    expect(instantAt('2026-09-28T18:00:00', J)).toBe('2026-09-28T15:00:00.000Z');
  });

  it('uses standard time (+02:00) after it — the literal +03:00 was an hour off here', () => {
    expect(instantAt('2026-10-26T18:00:00', J)).toBe('2026-10-26T16:00:00.000Z');
    expect(instantAt('2027-01-15T00:00:00', J)).toBe('2027-01-14T22:00:00.000Z');
  });

  it('reads each side of the change on the day of it (Sunday 25 October 2026, 02:00 → 01:00)', () => {
    expect(instantAt('2026-10-25T00:00:00', J)).toBe('2026-10-24T21:00:00.000Z');
    expect(instantAt('2026-10-25T15:00:00', J)).toBe('2026-10-25T13:00:00.000Z');
  });

  it('reads each side of the spring change (Friday 26 March 2027, 02:00 → 03:00)', () => {
    expect(instantAt('2027-03-26T00:00:00', J)).toBe('2027-03-25T22:00:00.000Z');
    expect(instantAt('2027-03-26T09:00:00', J)).toBe('2027-03-26T06:00:00.000Z');
  });

  it('refuses a wall clock the zone skips, instead of returning a neighbour', () => {
    expect(() => instantAt('2027-03-26T02:30:00', J)).toThrow('does not occur');
  });

  it('handles a zone with a half-hour offset and keeps milliseconds', () => {
    expect(instantAt('2026-09-28T09:00:00.250', 'Pacific/Marquesas')).toBe('2026-09-28T18:30:00.250Z');
  });
});
