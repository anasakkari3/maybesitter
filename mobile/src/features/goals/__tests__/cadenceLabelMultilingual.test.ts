import { describe, expect, it } from '@jest/globals';
import { fill } from '../../../i18n/strings';
import en from '../../../i18n/locales/en.json';
import he from '../../../i18n/locales/he.json';
import ar from '../../../i18n/locales/ar.json';

describe('Habit cadence frequency pill copy parity across locales', () => {
  it('English control uses multiplier format (1× a week) avoiding singular/plural clash', () => {
    expect(fill(en.xTimesPerWeek, { count: 1 })).toBe('1× a week');
    expect(fill(en.xTimesPerWeek, { count: 3 })).toBe('3× a week');
    expect(fill(en.xTimesPerWeek, { count: 5 })).toBe('5× a week');
  });

  it('Arabic probe uses multiplier format (1× بالأسبوع) avoiding ungrammatical plural clash with 1', () => {
    const rendered1 = fill(ar.xTimesPerWeek, { count: 1 });
    // Must NOT say "1 مرّات" (grammatically broken: 1 is singular, مرّات is plural)
    expect(rendered1).not.toContain('1 مرّات');
    expect(rendered1).toBe('1× بالأسبوع');
    expect(fill(ar.xTimesPerWeek, { count: 3 })).toBe('3× بالأسبوع');
  });

  it('Hebrew probe uses multiplier format (1× בשבוע) avoiding ungrammatical plural clash with 1', () => {
    const rendered1 = fill(he.xTimesPerWeek, { count: 1 });
    // Must NOT say "1 פעמים" (grammatically broken: 1 is singular, פעמים is plural)
    expect(rendered1).not.toContain('1 פעמים');
    expect(rendered1).toBe('1× בשבוע');
    expect(fill(he.xTimesPerWeek, { count: 3 })).toBe('3× בשבוע');
  });
});
