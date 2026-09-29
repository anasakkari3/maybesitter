/**
 * How a weekly block is said: «تدريب · كل سبت · 10:00–16:00».
 *
 * Day names are the app's own (`days` / `wbDays` in the locale files), joined
 * the way each language joins a list, and a run of three or more days in a row
 * is said as a range — «من الأحد للخميس» — because a working week read out as
 * five names is a sentence nobody says.
 */
import { describe, expect, it } from '@jest/globals';
import { stripIsolates } from '../../../i18n/bidi';
import { weekdaysPhrase, weeklyA11yLabel, weeklyLine } from '../weeklyText';

describe('weekdaysPhrase', () => {
  it('says one day as «every Saturday»', () => {
    expect(weekdaysPhrase([6], 'ar')).toBe('كل سبت');
    expect(weekdaysPhrase([6], 'en')).toBe('every Saturday');
    expect(weekdaysPhrase([0], 'he')).toBe('כל ראשון');
  });

  it('joins two days with the language\'s own «and»', () => {
    expect(weekdaysPhrase([6, 0], 'ar')).toBe('كل أحد وسبت');
    expect(weekdaysPhrase([1, 3], 'en')).toBe('every Monday and Wednesday');
    expect(weekdaysPhrase([1, 3], 'he')).toBe('כל שני ורביעי');
  });

  it('lists scattered days, the last one joined with «and»', () => {
    expect(weekdaysPhrase([0, 2, 4], 'ar')).toBe('كل أحد، ثلاثاء وخميس');
    expect(weekdaysPhrase([4, 0, 2], 'en')).toBe('every Sunday, Tuesday and Thursday');
  });

  it('says three or more days in a row as a range', () => {
    expect(weekdaysPhrase([0, 1, 2, 3, 4], 'ar')).toBe('من الأحد للخميس');
    expect(weekdaysPhrase([0, 1, 2, 3, 4], 'en')).toBe('Sunday to Thursday');
    expect(weekdaysPhrase([0, 1, 2, 3, 4], 'he')).toBe('מראשון עד חמישי');
    expect(weekdaysPhrase([2, 3, 4], 'ar')).toBe('من الثلاثاء للخميس');
  });

  it('keeps two days in a row a list, not a range', () => {
    expect(weekdaysPhrase([5, 6], 'ar')).toBe('كل جمعة وسبت');
  });

  it('says all seven as «every day»', () => {
    expect(weekdaysPhrase([0, 1, 2, 3, 4, 5, 6], 'ar')).toBe('كل يوم');
    expect(weekdaysPhrase([6, 5, 4, 3, 2, 1, 0], 'en')).toBe('every day');
  });

  it('ignores a repeated day and anything that is not one', () => {
    expect(weekdaysPhrase([6, 6, 9, -1], 'en')).toBe('every Saturday');
  });
});

describe('weeklyLine', () => {
  it('is title · days · one left-to-right time range', () => {
    const line = weeklyLine({ title: 'تدريب', weekdays: [6], start: '10:00', end: '16:00' }, 'ar');
    expect(stripIsolates(line)).toBe('تدريب · كل سبت · 10:00–16:00');
    // The range is one LTR unit, so «16:00–10:00» can never be read.
    expect(line).toContain('⁦10:00–16:00⁩');
  });

  it('leaves the title out when asked', () => {
    const line = weeklyLine({ title: 'Work', weekdays: [0, 1, 2, 3, 4], start: '09:00', end: '17:00' }, 'en', { withTitle: false });
    expect(stripIsolates(line)).toBe('Sunday to Thursday · 09:00–17:00');
  });
});

describe('weeklyA11yLabel', () => {
  it('reads days as words and the hours as from–to, with no dash to pronounce', () => {
    const label = weeklyA11yLabel({ title: 'تدريب', weekdays: [6], start: '10:00', end: '16:00' }, 'ar');
    expect(label).toBe('تدريب، كل سبت، من 10:00 لـ 16:00');
    expect(label).not.toMatch(/[⁦-⁩]/);
    expect(weeklyA11yLabel({ title: 'Gym', weekdays: [1, 3], start: '07:00', end: '08:00' }, 'en'))
      .toBe('Gym, every Monday and Wednesday, from 07:00 to 08:00');
  });
});
