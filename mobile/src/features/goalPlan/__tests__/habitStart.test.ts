import { describe, expect, it } from '@jest/globals';
import { habitStart } from '../habitStart';

/**
 * When a habit's week begins (#751, SIM-A4): «خميس، جمعة · 08:00» for a
 * habit in the plan's second week read as this week's Friday.
 */
describe('when a habit\'s week begins', () => {
  const TODAY = '2026-10-09';

  it('is now for the plan\'s first week', () => {
    expect(habitStart({ unit: 'week', index: 1 }, TODAY, TODAY)).toEqual({ kind: 'now' });
    expect(habitStart({ unit: 'day', index: 3 }, TODAY, TODAY)).toEqual({ kind: 'now' });
  });

  it('is next week for the second week of a plan made today', () => {
    expect(habitStart({ unit: 'week', index: 2 }, TODAY, TODAY)).toEqual({ kind: 'next_week' });
    // A day phase belongs to the week its day falls in, as the server places it.
    expect(habitStart({ unit: 'day', index: 8 }, TODAY, TODAY)).toEqual({ kind: 'next_week' });
    expect(habitStart({ unit: 'day', index: 14 }, TODAY, TODAY)).toEqual({ kind: 'next_week' });
  });

  it('is a date when the week is more than seven days away, where «next week» would be wrong', () => {
    expect(habitStart({ unit: 'week', index: 3 }, TODAY, TODAY)).toEqual({ kind: 'date', key: '2026-10-23' });
  });

  it('is now once the week has begun, however long ago the plan was made', () => {
    // Made nine days ago: its second week began two days ago.
    expect(habitStart({ unit: 'week', index: 2 }, '2026-09-30', TODAY)).toEqual({ kind: 'now' });
    // Made three days ago: its second week begins in four.
    expect(habitStart({ unit: 'week', index: 2 }, '2026-10-06', TODAY)).toEqual({ kind: 'next_week' });
  });

  it('crosses a month and a year without drifting', () => {
    expect(habitStart({ unit: 'week', index: 3 }, '2026-12-25', '2026-12-25')).toEqual({ kind: 'date', key: '2027-01-08' });
  });

  it('says nothing it cannot work out', () => {
    expect(habitStart(null, TODAY, TODAY)).toEqual({ kind: 'now' });
    expect(habitStart({ unit: 'week', index: 2 }, 'not-a-date', TODAY)).toEqual({ kind: 'now' });
  });
});
