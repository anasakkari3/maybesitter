import { describe, expect, it } from '@jest/globals';
import { instantForLocalDateTime, localDateTimeFor } from '../../capture/localInstant';
import {
  covers,
  dayBounds,
  dayWindow,
  freeGaps,
  freeMinutes,
  mergeIntervals,
  occupancyOf,
  touches,
  type Interval,
  type OccupancyInput,
} from '../freeTime';

const ZONE = 'Asia/Jerusalem';
const ms = (key: string, clock: string) => instantForLocalDateTime(`${key}T${clock}`, ZONE)!.getTime();
const iso = (key: string, clock: string) => new Date(ms(key, clock)).toISOString();
const span = (key: string, from: string, to: string, toKey = key): Interval => ({ start: ms(key, from), end: ms(toKey, to) });
const base: OccupancyInput = { kind: 'scheduled_event', dueAt: null, endAt: null, allDay: false, postponedUntil: null, saved: null };
const DAY = '2026-10-08';

describe('occupancyOf — the server rule, on the effective placement', () => {
  it('a scheduled event blocks to its end, or 30 minutes without one', () => {
    expect(occupancyOf({ ...base, dueAt: iso(DAY, '09:00'), endAt: iso(DAY, '10:15') })).toEqual(span(DAY, '09:00', '10:15'));
    expect(occupancyOf({ ...base, dueAt: iso(DAY, '09:00') })).toEqual(span(DAY, '09:00', '09:30'));
    // An end not after the start is no end.
    expect(occupancyOf({ ...base, dueAt: iso(DAY, '09:00'), endAt: iso(DAY, '08:00') })).toEqual(span(DAY, '09:00', '09:30'));
  });

  it('a timed due-by window blocks; a plain deadline and an all-day item do not', () => {
    expect(occupancyOf({ ...base, kind: 'due_by', dueAt: iso(DAY, '13:00'), endAt: iso(DAY, '15:00') })).toEqual(span(DAY, '13:00', '15:00'));
    expect(occupancyOf({ ...base, kind: 'due_by', dueAt: iso(DAY, '15:00') })).toBeNull();
    expect(occupancyOf({ ...base, dueAt: iso(DAY, '00:00'), allDay: true })).toBeNull();
    expect(occupancyOf({ ...base, kind: 'unscheduled' })).toBeNull();
  });

  it('a saved slot wins over everything, with its own end or 30 minutes', () => {
    const saved = { startsAt: iso('2026-10-09', '10:00'), endsAt: iso('2026-10-09', '11:00') };
    expect(occupancyOf({ ...base, kind: 'due_by', dueAt: iso(DAY, '15:00'), postponedUntil: iso(DAY, '18:00'), saved }))
      .toEqual(span('2026-10-09', '10:00', '11:00'));
    expect(occupancyOf({ ...base, saved: { startsAt: saved.startsAt, endsAt: null } })).toEqual(span('2026-10-09', '10:00', '10:30'));
  });

  it('a postponement occupies from postponedUntil, even for a plain deadline, as fixedStartOf does', () => {
    expect(occupancyOf({ ...base, kind: 'due_by', dueAt: iso(DAY, '15:00'), postponedUntil: iso('2026-10-09', '11:00') }))
      .toEqual(span('2026-10-09', '11:00', '11:30'));
    // Its old end is before the new start, so it is not an end.
    expect(occupancyOf({ ...base, dueAt: iso(DAY, '09:00'), endAt: iso(DAY, '10:00'), postponedUntil: iso('2026-10-09', '11:00') }))
      .toEqual(span('2026-10-09', '11:00', '11:30'));
  });
});

describe('dayBounds and dayWindow', () => {
  it('a spring-forward day is 23 hours, a fall-back day 25', () => {
    const spring = dayBounds('2030-03-29', ZONE);
    expect((spring.end - spring.start) / 3_600_000).toBe(23);
    const fall = dayBounds('2026-10-25', ZONE);
    expect((fall.end - fall.start) / 3_600_000).toBe(25);
  });

  it('M4A-REV-002 a day whose midnight does not exist starts at the first instant it has', () => {
    // America/Santiago springs forward at 00:00 on 2026-09-06: the day starts at 01:00.
    const spring = dayBounds('2026-09-06', 'America/Santiago');
    expect(localDateTimeFor(new Date(spring.start), 'America/Santiago')).toBe('2026-09-06T01:00');
    expect((spring.end - spring.start) / 3_600_000).toBe(23);
    // The day before ends where that one starts, and is a whole 24 hours.
    const before = dayBounds('2026-09-05', 'America/Santiago');
    expect(before.end).toBe(spring.start);
    expect((before.end - before.start) / 3_600_000).toBe(24);
  });

  it('no sleep window is 08:00–22:00', () => {
    expect(dayWindow(DAY, ZONE, null)).toEqual([span(DAY, '08:00', '22:00')]);
  });

  it('a sleep across midnight leaves the day between waking and sleeping', () => {
    expect(dayWindow(DAY, ZONE, { start: '23:00', end: '07:00' })).toEqual([span(DAY, '07:00', '23:00')]);
  });

  it('a sleep inside the day leaves both ends awake', () => {
    expect(dayWindow(DAY, ZONE, { start: '02:00', end: '10:00' }))
      .toEqual([span(DAY, '00:00', '02:00'), span(DAY, '10:00', '00:00', '2026-10-09')]);
  });

  it('a malformed sleep window falls back to 08:00–22:00', () => {
    expect(dayWindow(DAY, ZONE, { start: '7am', end: '23:00' })).toEqual([span(DAY, '08:00', '22:00')]);
  });
});

describe('freeGaps', () => {
  const day = dayBounds(DAY, ZONE);
  const window = dayWindow(DAY, ZONE, null);
  const before = day.start - 1;

  it('an empty day is one gap, the whole window', () => {
    expect(freeGaps([], day, window, before)).toEqual([span(DAY, '08:00', '22:00')]);
  });

  it('overlapping and touching blocks merge; a gap under 30 minutes is dropped', () => {
    const gaps = freeGaps([
      span(DAY, '09:00', '10:00'), span(DAY, '09:30', '11:00'), span(DAY, '11:00', '12:00'),
      span(DAY, '12:20', '13:00'),
    ], day, window, before);
    expect(gaps).toEqual([span(DAY, '08:00', '09:00'), span(DAY, '13:00', '22:00')]);
  });

  it('a block across midnight takes the start of the next day', () => {
    const awakeEarly = dayWindow(DAY, ZONE, { start: '02:00', end: '10:00' });
    const gaps = freeGaps([span('2026-10-07', '23:00', '01:00', DAY)], day, awakeEarly, before);
    expect(gaps[0]).toEqual(span(DAY, '01:00', '02:00'));
  });

  it('today counts only from now', () => {
    expect(freeGaps([span(DAY, '13:00', '14:00')], day, window, ms(DAY, '12:10')))
      .toEqual([span(DAY, '12:10', '13:00'), span(DAY, '14:00', '22:00')]);
    expect(freeGaps([], day, window, ms(DAY, '21:45'))).toEqual([]);
    expect(freeGaps([], day, window, day.end)).toEqual([]);
  });

  it('the free total sums the gaps', () => {
    expect(freeMinutes(freeGaps([span(DAY, '09:00', '20:00')], day, window, before))).toBe(60 + 120);
  });
});

describe('coverage helpers', () => {
  it('covers needs the whole interval, across merged pieces', () => {
    const covered = mergeIntervals([span(DAY, '00:00', '12:00'), span(DAY, '12:00', '20:00')]);
    expect(covers(covered, span(DAY, '08:00', '19:00'))).toBe(true);
    expect(covers(covered, span(DAY, '08:00', '21:00'))).toBe(false);
  });

  it('touches finds any overlap with an unknown range', () => {
    expect(touches([span(DAY, '13:00', '15:00')], span(DAY, '14:30', '16:00'))).toBe(true);
    expect(touches([span(DAY, '13:00', '15:00')], span(DAY, '15:00', '16:00'))).toBe(false);
  });
});
