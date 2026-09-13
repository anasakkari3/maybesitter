import { describe, expect, it } from '@jest/globals';
import { STRIP_DAYS, weekStripKeys } from '../weekStrip';

describe('the week strip', () => {
  it('runs from today forward, one key per day', () => {
    const keys = weekStripKeys(new Date('2026-09-13T09:00:00.000Z'), 'UTC');
    expect(keys).toEqual([
      '2026-09-13', '2026-09-14', '2026-09-15', '2026-09-16',
      '2026-09-17', '2026-09-18', '2026-09-19',
    ]);
    expect(keys).toHaveLength(STRIP_DAYS);
  });

  it('starts on the user’s today, not on UTC’s', () => {
    // 22:00 UTC is already 01:00 tomorrow in Jerusalem. Building the strip in
    // UTC would open the app on yesterday for three hours every night.
    const late = new Date('2026-09-13T22:00:00.000Z');
    expect(weekStripKeys(late, 'UTC')[0]).toBe('2026-09-13');
    expect(weekStripKeys(late, 'Asia/Jerusalem')[0]).toBe('2026-09-14');
  });

  it('is still today’s day west of Greenwich', () => {
    // 02:00 UTC is 22:00 the previous evening in New York.
    const early = new Date('2026-09-13T02:00:00.000Z');
    expect(weekStripKeys(early, 'America/New_York')[0]).toBe('2026-09-12');
  });

  it('counts calendar days across a DST change, not 24-hour blocks', () => {
    // Europe/Berlin falls back on 2026-10-25; that day is 25 hours long.
    const keys = weekStripKeys(new Date('2026-10-23T10:00:00.000Z'), 'Europe/Berlin');
    expect(keys.slice(0, 4)).toEqual(['2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26']);
  });

  it('crosses a month boundary', () => {
    expect(weekStripKeys(new Date('2026-09-28T09:00:00.000Z'), 'UTC')).toEqual([
      '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01',
      '2026-10-02', '2026-10-03', '2026-10-04',
    ]);
  });
});
