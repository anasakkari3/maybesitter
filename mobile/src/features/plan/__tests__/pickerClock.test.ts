import { describe, expect, it } from '@jest/globals';
import { dateShowing, timeShowing, timeShown, wallClockShown } from '../pickerClock';
import { instantForLocalDateTime, localDateTimeFor } from '../../capture/localInstant';
import { withHermesIntl } from '../../../testing/hermesIntl';

/**
 * What goes into a native wheel and what comes back out (UC-3.10b, #195).
 *
 * Every assertion here is a *round trip*, never a literal instant. A literal
 * would be a statement about the machine running the suite — the host here is
 * in Asia/Hebron, so a "correct" answer written down today would be wrong on a
 * CI box in UTC, and, worse, a broken conversion would look right on the
 * developer's own laptop. What must hold is that the reading the user left the
 * wheel on is the reading that comes back, wherever this runs.
 */

describe('the wheel’s own clock face', () => {
  const FACES = [
    '2026-08-09T09:00',
    '2026-03-27T02:30',
    '2026-12-31T23:45',
    '2026-01-01T00:00',
    '2026-06-15T13:15',
  ];

  it.each(FACES)('gives back exactly the face it was set to: %s', face => {
    expect(wallClockShown(dateShowing(face))).toBe(face);
  });

  it.each(['00:00', '06:45', '07:30', '23:45'])('round-trips a bare time: %s', hhmm => {
    expect(timeShown(timeShowing(hhmm))).toBe(hhmm);
  });

  it('falls back to now rather than to an invented date', () => {
    // A malformed wall clock must not become 1970 on somebody's picker.
    const now = Date.now();
    expect(Math.abs(dateShowing('not a time').getTime() - now)).toBeLessThan(5_000);
  });
});

describe('from the wheel to an instant in the plan’s zone', () => {
  /**
   * Two zones no host is ever set to, and neither shares an offset with the
   * other or with a plausible CI box: +14:00 and −09:30.
   */
  const ZONES = ['Pacific/Kiritimati', 'Pacific/Marquesas'];

  it.each(ZONES)('lands on the instant that reads back as that face in %s', zone => {
    withHermesIntl(() => {
      const face = '2026-08-09T09:00';
      const instant = instantForLocalDateTime(wallClockShown(dateShowing(face)), zone);
      expect(instant).not.toBeNull();
      // The property: in the plan's zone, the instant reads as the face the
      // user left the wheel on. Not "equals this many milliseconds".
      expect(localDateTimeFor(instant!, zone)).toBe(face);
    });
  });

  it('does not land on the same instant for two different zones', () => {
    withHermesIntl(() => {
      const face = '2026-08-09T09:00';
      const wall = wallClockShown(dateShowing(face));
      const kiritimati = instantForLocalDateTime(wall, ZONES[0]!)!;
      const marquesas = instantForLocalDateTime(wall, ZONES[1]!)!;
      // 09:00 in one place is not 09:00 in the other. A conversion that ignored
      // the zone would make these equal — and would also make the first
      // assertion above pass for the wrong reason.
      expect(kiritimati.getTime()).not.toBe(marquesas.getTime());
      expect(marquesas.getTime() - kiritimati.getTime()).toBe((14 + 9.5) * 3_600_000);
    });
  });
});
