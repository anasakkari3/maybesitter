import { describe, expect, it } from '@jest/globals';
import { currentGoalProgressPeriod } from '../progressPeriod';

describe('goal progress period', () => {
  it('uses the real Sunday-to-Saturday local week for Arabic and Hebrew', () => {
    const now = new Date('2026-09-23T21:30:00.000Z');

    expect(currentGoalProgressPeriod(now, 'Asia/Jerusalem', 'ar')).toEqual({
      fromLocalDate: '2026-09-20',
      toLocalDate: '2026-09-26',
    });
    expect(currentGoalProgressPeriod(now, 'Asia/Jerusalem', 'he')).toEqual({
      fromLocalDate: '2026-09-20',
      toLocalDate: '2026-09-26',
    });
  });

  it('uses the real Monday-to-Sunday local week for English', () => {
    expect(currentGoalProgressPeriod(
      new Date('2026-09-23T21:30:00.000Z'),
      'Asia/Jerusalem',
      'en',
    )).toEqual({
      fromLocalDate: '2026-09-21',
      toLocalDate: '2026-09-27',
    });
  });
});
