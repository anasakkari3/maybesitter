/**
 * «كل يوم» reads as every day (owner decision 2026-11-20): stored as the
 * seven weekdays now, and as 7 a week by an older server.
 */
import { describe, expect, it } from '@jest/globals';
import { describeCadence } from '../HabitCadencePicker';
import ar from '../../../i18n/locales/ar.json';
import en from '../../../i18n/locales/en.json';

const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

describe('describeCadence', () => {
  it('says every day for the seven weekdays and for 7 a week', () => {
    expect(describeCadence({ kind: 'weekdays', weekdays: [0, 1, 2, 3, 4, 5, 6] }, { ...en, days }, 'en')).toBe(en.xHabitEveryDay);
    expect(describeCadence({ kind: 'weekly_count', count: 7 }, { ...en, days }, 'en')).toBe(en.xHabitEveryDay);
    expect(describeCadence({ kind: 'weekdays', weekdays: [0, 1, 2, 3, 4, 5, 6] }, { ...ar, days }, 'ar')).toBe(ar.xHabitEveryDay);
  });

  it('still names the days, or the count, for anything less', () => {
    expect(describeCadence({ kind: 'weekdays', weekdays: [2, 4] }, { ...en, days }, 'en')).toBe('Tue · Thu');
    expect(describeCadence({ kind: 'weekly_count', count: 3 }, { ...en, days }, 'en')).toBe(en.xTimesPerWeek.replace('{count}', '3'));
  });
});
