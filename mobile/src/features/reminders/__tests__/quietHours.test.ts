import { describe, expect, it } from '@jest/globals';
import { withHermesIntl } from '../../../testing/hermesIntl';
import { wallClockIn } from '../../../lib/time/zoneOffset';
import {
  deferOutOfQuietHours,
  endOfQuietWindow,
  isInQuietWindow,
  keepHigherIntensity,
  MIN_LEAD_AFTER_DEFER_MS,
  type QuietWindow,
} from '../quietHours';

/**
 * Quiet hours, on a device (UC-3.11, #196).
 *
 * Three rules this file holds itself to, each because of a defect this repo
 * has actually shipped:
 *
 *  - **Nothing is asserted as a date literal** (#382). Every expectation is
 *    recomputed from `wallClockIn`, so a test cannot agree with a broken
 *    conversion by coincidence.
 *  - **The zone is one no host runs in.** `Pacific/Chatham` is +12:45. An
 *    implementation that dropped the zone would answer UTC's answer, and these
 *    assertions would fail.
 *  - **The clock is read the way Hermes reports it.** `withHermesIntl` makes
 *    Node return the split `timeZoneName` parts a real device returns; the
 *    2026-09-14 audit found a zone conversion that was right under Jest and
 *    wrong on an iPhone.
 */

const NIGHT: QuietWindow = { start: '22:00', end: '07:00' };
const AFTERNOON: QuietWindow = { start: '13:00', end: '15:30' };
const ZONES = ['Asia/Jerusalem', 'Pacific/Chatham', 'America/Santiago'];

function minutesAt(instant: number, zone: string): number {
  const clock = wallClockIn(new Date(instant), zone);
  return clock.hour * 60 + clock.minute;
}

function expectedInside(window: QuietWindow, instant: number, zone: string): boolean {
  const toMinutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const minutes = minutesAt(instant, zone);
  const start = toMinutes(window.start);
  const end = toMinutes(window.end);
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/** Every quarter hour across three days, which is long enough to hold a DST change. */
function sweep(fromIso: string, days = 3): number[] {
  const start = Date.parse(fromIso);
  const stops: number[] = [];
  for (let at = start; at < start + days * 86_400_000; at += 15 * 60_000) stops.push(at);
  return stops;
}

describe('is it quiet right now', () => {
  it.each(ZONES)('follows the wall clock in %s, including across midnight', zone => {
    withHermesIntl(() => {
      for (const window of [NIGHT, AFTERNOON]) {
        let inside = 0;
        for (const at of sweep('2026-09-14T00:00:00.000Z')) {
          const actual = isInQuietWindow(window, at, zone);
          expect({ at: new Date(at).toISOString(), actual })
            .toEqual({ at: new Date(at).toISOString(), actual: expectedInside(window, at, zone) });
          if (actual) inside += 1;
        }
        expect(inside).toBeGreaterThan(0);
      }
    });
  });

  it('gives a different answer in a zone no host runs in', () => {
    withHermesIntl(() => {
      const stops = sweep('2026-09-14T00:00:00.000Z', 1);
      const chatham = stops.map(at => isInQuietWindow(NIGHT, at, 'Pacific/Chatham'));
      const utc = stops.map(at => isInQuietWindow(NIGHT, at, 'UTC'));
      // +12:45 against +00:00. If the zone were ignored these would be equal.
      expect(chatham).not.toEqual(utc);
    });
  });
});

describe('the end of the window', () => {
  it.each(ZONES)('lands on the clock reading the window ends at, in %s', zone => {
    withHermesIntl(() => {
      // Deliberately across the Israeli autumn change, where the naive
      // "add 9 hours" answer is an hour wrong.
      for (const at of sweep('2026-10-24T00:00:00.000Z')) {
        const end = endOfQuietWindow(NIGHT, at, zone);
        expect(end).not.toBeNull();
        expect(minutesAt(end as number, zone)).toBe(7 * 60);
        expect(end as number).toBeGreaterThan(at);
        /*
         * The *first* such moment, never the one after it.
         *
         * The bound is 25 hours rather than 24, and that is the point of
         * running this sweep across a clock change: on the autumn-back day the
         * hour from 02:00 happens twice, so the gap from one 07:00 to the next
         * really is 25 hours. A 24-hour assertion here failed against correct
         * code — which is the shape of the mistake #382 warns about, arriving
         * from the other direction.
         */
        expect((end as number) - at).toBeLessThanOrEqual(25 * 3_600_000);
      }
    });
  });
});

describe('deferring rather than dropping', () => {
  it('leaves a stage outside the window alone', () => {
    withHermesIntl(() => {
      const at = Date.parse('2026-09-14T09:00:00.000Z');
      expect(deferOutOfQuietHours(at, NIGHT, 'UTC', at + 3_600_000)).toEqual({ kind: 'keep', at });
    });
  });

  it('moves a stage inside the window to the end of it', () => {
    withHermesIntl(() => {
      // The acceptance criterion, stated in wall-clock terms and computed
      // rather than written down: a soft stage at 22:30 with quiet hours
      // 22:00-07:00 and a commitment at 09:00 the next morning.
      const zone = 'Pacific/Chatham';
      const start = Date.parse('2026-09-14T12:00:00.000Z');
      const stageAt = findMinuteOfDay(start, 22 * 60 + 30, zone);
      const commitmentAt = findMinuteOfDay(stageAt + 3_600_000, 9 * 60, zone);

      const outcome = deferOutOfQuietHours(stageAt, NIGHT, zone, commitmentAt);
      expect(outcome.kind).toBe('deferred');
      expect(minutesAt((outcome as { at: number }).at, zone)).toBe(7 * 60);
    });
  });

  it('drops a stage when the window ends too close to the commitment', () => {
    withHermesIntl(() => {
      // The same window, with the commitment at 07:02 instead: the reminder
      // would arrive two minutes before, which is not a heads-up.
      const zone = 'Pacific/Chatham';
      const start = Date.parse('2026-09-14T12:00:00.000Z');
      const stageAt = findMinuteOfDay(start, 22 * 60 + 30, zone);
      const commitmentAt = findMinuteOfDay(stageAt + 3_600_000, 7 * 60 + 2, zone);

      expect(deferOutOfQuietHours(stageAt, NIGHT, zone, commitmentAt)).toEqual({ kind: 'dropped' });
    });
  });

  it('keeps a deferred stage that clears the five-minute floor by a minute', () => {
    withHermesIntl(() => {
      const zone = 'Asia/Jerusalem';
      const start = Date.parse('2026-09-14T12:00:00.000Z');
      const stageAt = findMinuteOfDay(start, 23 * 60, zone);
      const windowEnd = endOfQuietWindow(NIGHT, stageAt, zone) as number;

      const justEnough = windowEnd + MIN_LEAD_AFTER_DEFER_MS + 60_000;
      expect(deferOutOfQuietHours(stageAt, NIGHT, zone, justEnough)).toEqual({
        kind: 'deferred',
        at: windowEnd,
      });

      const oneMinuteShort = windowEnd + MIN_LEAD_AFTER_DEFER_MS - 60_000;
      expect(deferOutOfQuietHours(stageAt, NIGHT, zone, oneMinuteShort)).toEqual({ kind: 'dropped' });
    });
  });

  it('does nothing at all when the account has no quiet hours', () => {
    const at = Date.parse('2026-09-14T23:30:00.000Z');
    expect(deferOutOfQuietHours(at, null, 'Asia/Jerusalem', at + 3_600_000)).toEqual({ kind: 'keep', at });
  });
});

describe('two stages deferred onto one instant', () => {
  it('keeps the firmer one', () => {
    const at = 1_000;
    expect(keepHigherIntensity([
      { stage: 'soft', at },
      { stage: 'followUp', at },
    ])).toEqual([{ stage: 'followUp', at }]);
    expect(keepHigherIntensity([
      { stage: 'strong', at },
      { stage: 'soft', at },
    ])).toEqual([{ stage: 'strong', at }]);
  });

  it('leaves stages at different instants alone, in fire order', () => {
    expect(keepHigherIntensity([
      { stage: 'followUp', at: 2_000 },
      { stage: 'soft', at: 1_000 },
    ])).toEqual([
      { stage: 'soft', at: 1_000 },
      { stage: 'followUp', at: 2_000 },
    ]);
  });
});

/** The first instant at or after `from` whose clock in `zone` reads `minute`. */
function findMinuteOfDay(from: number, minute: number, zone: string): number {
  for (let at = from; at < from + 2 * 86_400_000; at += 60_000) {
    if (minutesAt(at, zone) === minute) return at;
  }
  throw new Error(`no instant reads ${minute} in ${zone}`);
}
