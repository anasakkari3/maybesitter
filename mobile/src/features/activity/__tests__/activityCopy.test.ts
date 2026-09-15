/**
 * What the activity screen is allowed to say, in all three languages
 * (UC-3.15, #201).
 *
 * The forbidden words are not style. This screen is the one place the product
 * reports back on somebody's week, and the difference between "a quiet week"
 * and "you missed 4 things" is the difference between the product #201
 * describes and a scoreboard. A reviewer reading a diff in a language they do
 * not speak cannot catch "פספסת"; this can.
 *
 * The lists are per language rather than English-only, because the Arabic copy
 * here is written, not translated — plain spoken Levantine to match the rest
 * of the app — so an English-only check would police the one locale least
 * likely to drift.
 */
import { describe, expect, it } from '@jest/globals';
import ar from '../../../i18n/locales/ar.json';
import en from '../../../i18n/locales/en.json';
import he from '../../../i18n/locales/he.json';
import { tFor } from '../../../i18n/index';

const KEYS = [
  'activityTitle', 'activityWeekTitle', 'activityWeekDone', 'activityWeekPlanned', 'activityWeekKept',
  'activityWeekQuiet', 'activityMomentsTitle', 'activityMomentFirstCapture', 'activityMomentFirstDone',
  'activityMomentFirstPlan', 'activityMomentDone10', 'activityMomentDone25', 'activityMomentDone50',
  'activityMomentDone100', 'activityHistoryTitle', 'activityEmpty', 'activityRemovedItem',
  'activityKindCaptured', 'activityKindConfirmed', 'activityKindCompleted', 'activityKindPostponed',
  'activityKindDropped', 'activityKindPlanAccepted', 'activityKindReminderAcknowledged',
  'activityMovedTo', 'activityUnavailable',
] as const;

const BUNDLES: Record<string, Record<string, string>> = {
  en: en as unknown as Record<string, string>,
  ar: ar as unknown as Record<string, string>,
  he: he as unknown as Record<string, string>,
};

/**
 * Words that would make this a judgement. #201 names streak, missed, failed,
 * behind, lazy, "should have", "don't break" and rank; each language's list is
 * the forms somebody would actually write in it.
 */
const FORBIDDEN: Record<string, string[]> = {
  en: [
    'streak', 'missed', 'miss ', 'failed', 'failure', 'behind', 'lazy',
    'should have', 'should’ve', "shouldn't", 'don’t break', "don't break",
    'rank', 'score', 'overdue', 'late', 'only ', 'keep it up',
  ],
  ar: [
    'فشل', 'فشلت', 'فاتك', 'فاتتك', 'ضيّعت', 'ضيعت', 'متأخر', 'تأخرت', 'متأخرة',
    'كان لازم', 'المفروض', 'كسلان', 'كسول', 'قصّرت', 'قصرت', 'سلسلة', 'ترتيبك', 'علامتك',
  ],
  he: [
    'נכשל', 'כישלון', 'פספסת', 'החמצת', 'מאחר', 'באיחור', 'פיגור', 'עצלן',
    'היית צריך', 'רצף', 'דירוג', 'ציון', 'רק ',
  ],
};

describe('the activity copy', () => {
  it('exists in all three languages', () => {
    for (const [locale, bundle] of Object.entries(BUNDLES)) {
      for (const key of KEYS) {
        expect({ locale, key, ok: typeof bundle[key] === 'string' && bundle[key]!.trim().length > 0 })
          .toEqual({ locale, key, ok: true });
      }
    }
  });

  it.each(Object.keys(BUNDLES))('never judges the user in %s', locale => {
    const bundle = BUNDLES[locale]!;
    const offences: string[] = [];
    for (const key of KEYS) {
      const line = (bundle[key] ?? '').toLowerCase();
      for (const word of FORBIDDEN[locale]!) {
        if (line.includes(word.toLowerCase())) offences.push(`${key}: "${word}"`);
      }
    }
    expect(offences).toEqual([]);
  });

  it('says the all-zero week is fine rather than reporting three zeroes', () => {
    // The words differ per language; what is asserted is that the line exists,
    // is short, and does not print a number.
    for (const [locale, bundle] of Object.entries(BUNDLES)) {
      const quiet = bundle.activityWeekQuiet ?? '';
      expect({ locale, hasDigit: /[0-9٠-٩]/.test(quiet) }).toEqual({ locale, hasDigit: false });
      expect(quiet.trim().split(/\s+/).length).toBeLessThanOrEqual(8);
    }
  });

  it('never asks the user a question or tells them what to do next', () => {
    // This surface reports; it does not prompt. A question here would turn a
    // record of what happened into a nudge about what has not.
    for (const [locale, bundle] of Object.entries(BUNDLES)) {
      for (const key of KEYS) {
        expect({ locale, key, asks: /[?؟]/.test(bundle[key] ?? '') }).toEqual({ locale, key, asks: false });
        expect({ locale, key, shouts: /!/.test(bundle[key] ?? '') }).toEqual({ locale, key, shouts: false });
      }
    }
  });

  /*
   * The week's three lines are ICU plurals, and a plural is where copy breaks
   * in a language the reviewer does not read. Arabic has six categories and
   * Hebrew a dual; `fill()`-style substitution is right for 3–10 and wrong
   * everywhere else, and a build whose ICU parser lost the locale renders
   * `other` for every count while still looking like Arabic.
   */
  const COUNT_KEYS = ['activityWeekDone', 'activityWeekPlanned', 'activityWeekKept'] as const;
  const ARABIC_INDIC = /[٠-٩۰-۹]/;

  it.each(['en', 'ar', 'he'] as const)('never leaks ICU source for a count in %s', locale => {
    const t = tFor(locale);
    for (const key of COUNT_KEYS) {
      for (const n of [0, 1, 2, 3, 11, 100]) {
        const line = t(key, { n });
        expect({ key, n, line }).toEqual({ key, n, line: expect.not.stringMatching(/plural|[{}#]/) });
        // Digits stay Latin, as everywhere else in the app.
        expect({ key, n, arabicIndic: ARABIC_INDIC.test(line) }).toEqual({ key, n, arabicIndic: false });
      }
    }
  });

  it('reaches the Arabic dual and the Hebrew dual rather than falling back to "other"', () => {
    // Two is its own word in both — «شيئين», «יומיים» — so a count of two that
    // reads as the plural form is how a lost locale shows itself.
    expect(tFor('ar')('activityWeekDone', { n: 2 })).toBe('خلّصت شيئين');
    expect(tFor('ar')('activityWeekPlanned', { n: 2 })).toBe('يومين إلهم خطة');
    expect(tFor('he')('activityWeekPlanned', { n: 2 })).toBe('יומיים עם תוכנית');
    // Three is not the dual, in either.
    expect(tFor('ar')('activityWeekDone', { n: 3 })).toContain('3');
    expect(tFor('he')('activityWeekPlanned', { n: 3 })).toContain('3');
  });

  it('says nothing-yet for a zero count rather than printing a zero', () => {
    for (const locale of ['en', 'ar', 'he'] as const) {
      for (const key of COUNT_KEYS) {
        const line = tFor(locale)(key, { n: 0 });
        expect({ locale, key, hasZero: /0/.test(line) }).toEqual({ locale, key, hasZero: false });
      }
    }
  });

  it('has a word for every kind the contract names, including the two with no producer', () => {
    // #194 and #200 emit `plan_accepted` and `reminder_acknowledged`. A build
    // shipped without their copy would render an entry with no words the day
    // either lands, which is why the keys exist before the events do.
    for (const bundle of Object.values(BUNDLES)) {
      expect(typeof bundle.activityKindPlanAccepted).toBe('string');
      expect(typeof bundle.activityKindReminderAcknowledged).toBe('string');
      expect(typeof bundle.activityMomentFirstPlan).toBe('string');
    }
  });
});
