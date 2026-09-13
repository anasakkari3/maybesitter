/**
 * "Not now" (UC-2.R3, #173).
 *
 * The DST cases are the reason this file exists. Adding 24 hours to get
 * "tomorrow morning" gives 08:00 or 10:00 on the two days a year the clocks
 * move — an hour early is a reminder that interrupts, an hour late is one that
 * arrives after the thing it was for.
 */
import { describe, expect, it } from '@jest/globals';
import { POSTPONE_PRESETS, isPostponable, postponeTo } from '../postpone';

/** What an instant reads as on a wall clock in a zone. */
function wallClock(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso));
}

const JERUSALEM = 'Asia/Jerusalem';
const NEW_YORK = 'America/New_York';

describe('the hour presets', () => {
  it('really are that many hours, whatever the clocks do', () => {
    // "In an hour" means 3,600 seconds even across a clock change: the user
    // asked for an hour of their life, not an hour of wall clock.
    const now = new Date('2026-09-13T09:00:00.000Z');
    expect(postponeTo('oneHour', now, JERUSALEM)).toBe('2026-09-13T10:00:00.000Z');
    expect(postponeTo('threeHours', now, JERUSALEM)).toBe('2026-09-13T12:00:00.000Z');
  });

  it('do not depend on the zone', () => {
    const now = new Date('2026-09-13T09:00:00.000Z');
    expect(postponeTo('oneHour', now, JERUSALEM)).toBe(postponeTo('oneHour', now, NEW_YORK));
  });
});

describe('tomorrow morning', () => {
  it('is 09:00 where the user is, not 09:00 UTC', () => {
    const now = new Date('2026-09-13T09:00:00.000Z');
    expect(wallClock(postponeTo('tomorrowMorning', now, JERUSALEM), JERUSALEM))
      .toBe('14/09/2026, 09:00');
    expect(wallClock(postponeTo('tomorrowMorning', now, NEW_YORK), NEW_YORK))
      .toBe('14/09/2026, 09:00');
  });

  it('is still 09:00 across the spring-forward boundary', () => {
    // Israel moves to IDT on the last Friday of March. 2026-03-27 02:00 → 03:00.
    const before = new Date('2026-03-26T20:00:00.000Z');
    expect(wallClock(postponeTo('tomorrowMorning', before, JERUSALEM), JERUSALEM))
      .toBe('27/03/2026, 09:00');
  });

  it('is still 09:00 across the autumn fall-back boundary', () => {
    // The US moves back on the first Sunday of November: 2026-11-01 02:00 → 01:00.
    const before = new Date('2026-10-31T20:00:00.000Z');
    expect(wallClock(postponeTo('tomorrowMorning', before, NEW_YORK), NEW_YORK))
      .toBe('01/11/2026, 09:00');
  });

  it('crosses a month end without inventing a 32nd', () => {
    const lastDay = new Date('2026-09-30T09:00:00.000Z');
    expect(wallClock(postponeTo('tomorrowMorning', lastDay, JERUSALEM), JERUSALEM))
      .toBe('01/10/2026, 09:00');
  });

  it('crosses a year end', () => {
    const newYearsEve = new Date('2026-12-31T09:00:00.000Z');
    expect(wallClock(postponeTo('tomorrowMorning', newYearsEve, JERUSALEM), JERUSALEM))
      .toBe('01/01/2027, 09:00');
  });

  it('is tomorrow even when "now" is late enough to already be tomorrow in UTC', () => {
    // 23:30 in Jerusalem on the 13th is 20:30 UTC on the 13th; but at 22:30 UTC
    // it is already the 14th in Jerusalem, and "tomorrow" must mean the 15th.
    const lateLocal = new Date('2026-09-13T22:30:00.000Z');
    expect(wallClock(postponeTo('tomorrowMorning', lateLocal, JERUSALEM), JERUSALEM))
      .toBe('15/09/2026, 09:00');
  });
});

describe('next week', () => {
  it('is seven days on, at 09:00 local', () => {
    const now = new Date('2026-09-13T09:00:00.000Z');
    expect(wallClock(postponeTo('nextWeek', now, JERUSALEM), JERUSALEM))
      .toBe('20/09/2026, 09:00');
  });

  it('stays 09:00 when the clocks change inside the week', () => {
    const beforeChange = new Date('2026-03-24T09:00:00.000Z');
    expect(wallClock(postponeTo('nextWeek', beforeChange, JERUSALEM), JERUSALEM))
      .toBe('31/03/2026, 09:00');
  });
});

describe('every preset', () => {
  it('is in the future, from any starting point', () => {
    const now = new Date('2026-09-13T09:00:00.000Z');
    for (const preset of POSTPONE_PRESETS) {
      expect(isPostponable(postponeTo(preset, now, JERUSALEM), now)).toBe(true);
    }
  });

  it('is in the future even at 08:59 local, when 09:00 today is still ahead', () => {
    // The one that would fail a naive "today at 09:00" implementation: the
    // preset must be *tomorrow*, not thirty seconds from now.
    const early = new Date('2026-09-13T05:59:00.000Z'); // 08:59 in Jerusalem
    const at = postponeTo('tomorrowMorning', early, JERUSALEM);
    expect(wallClock(at, JERUSALEM)).toBe('14/09/2026, 09:00');
  });
});

describe('a chosen time', () => {
  it('is refused when it has already passed', () => {
    // The server refuses a past instant with a 400 before the state machine
    // sees it; the client says the same thing first.
    const now = new Date('2026-09-13T09:00:00.000Z');
    expect(isPostponable('2026-09-13T08:59:59.000Z', now)).toBe(false);
    expect(isPostponable('2026-09-13T09:00:00.000Z', now)).toBe(false);
    expect(isPostponable('2026-09-13T09:00:01.000Z', now)).toBe(true);
  });

  it('is refused when it is not a time at all', () => {
    expect(isPostponable('soon', new Date('2026-09-13T09:00:00.000Z'))).toBe(false);
  });
});
