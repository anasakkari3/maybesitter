import { describe, expect, it } from '@jest/globals';
import { dayWindow, occurrenceCovering, occurrencesAsBusy, occurrencesByDay } from '../occurrences';

const ZONE = 'Asia/Jerusalem';
const occ = (id: string, startAt: string, endAt: string) => ({ occurrenceId: id, weeklyBlockId: `b-${id}`, title: id, startAt, endAt });

describe('dayWindow', () => {
  it('runs from the first day\'s local midnight to the midnight after the last', () => {
    expect(dayWindow(['2026-10-03', '2026-10-09'], ZONE)).toEqual({ from: '2026-10-02T21:00:00.000Z', to: '2026-10-09T21:00:00.000Z' });
  });
  it('crosses the clock change without losing an hour of the last day', () => {
    // Jerusalem leaves summer time on 2026-10-25: that midnight is 22:00Z.
    expect(dayWindow(['2026-10-24', '2026-10-25'], ZONE).to).toBe('2026-10-25T22:00:00.000Z');
  });
});

describe('occurrencesByDay', () => {
  it('groups by the local day an occurrence starts on, in time order', () => {
    const late = occ('late', '2026-10-03T13:00:00.000Z', '2026-10-03T14:00:00.000Z');
    const early = occ('early', '2026-10-03T07:00:00.000Z', '2026-10-03T08:00:00.000Z');
    // 22:30Z on the 3rd is already the 4th in Jerusalem.
    const next = occ('next', '2026-10-03T22:30:00.000Z', '2026-10-03T23:30:00.000Z');
    const byDay = occurrencesByDay([late, next, early], ZONE);
    expect(byDay.get('2026-10-03')?.map((o) => o.occurrenceId)).toEqual(['early', 'late']);
    expect(byDay.get('2026-10-04')?.map((o) => o.occurrenceId)).toEqual(['next']);
  });
});

describe('occurrenceCovering', () => {
  const training = occ('t', '2026-10-03T07:00:00.000Z', '2026-10-03T13:00:00.000Z');
  it('finds the one under way, start included and end excluded', () => {
    expect(occurrenceCovering([training], new Date('2026-10-03T07:00:00.000Z'))).toBe(training);
    expect(occurrenceCovering([training], new Date('2026-10-03T12:59:59.000Z'))).toBe(training);
    expect(occurrenceCovering([training], new Date('2026-10-03T13:00:00.000Z'))).toBeNull();
    expect(occurrenceCovering([training], new Date('2026-10-03T06:59:59.000Z'))).toBeNull();
  });
});

describe('occurrencesAsBusy', () => {
  it('is an interval with no title', () => {
    const [busy] = occurrencesAsBusy([occ('t', '2026-10-03T07:00:00.000Z', '2026-10-03T13:00:00.000Z')]);
    expect(Object.keys(busy!).sort()).toEqual(['allDay', 'endAt', 'nativeId', 'startAt']);
    expect(busy!.allDay).toBe(false);
  });
});
