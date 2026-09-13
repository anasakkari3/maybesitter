/**
 * What the three languages actually print, as opposed to what tag they ask for.
 *
 * `locale.test.ts` asserts the spelling in `INTL_LOCALE`; this asserts the
 * digits that come out the other end, because the spelling is the mechanism and
 * the digits are the decision. A `he-u-nu-hebr` in that map would type-check,
 * pass every parity test, and print «י״ח:00» on a clock — Hebrew numerals are
 * gematria, not a way to read the time. Arabic is pushed onto Latin digits for
 * a different reason (README.md, "Digits"); the two languages agree, and this
 * is the test that says so out loud.
 */
import { describe, expect, it } from '@jest/globals';
import { formatNumber, formatTime } from '../format';
import { LOCALES } from '../locale';

describe('every language prints 0-9', () => {
  // Digits that are not 0-9: Arabic-Indic, Eastern Arabic-Indic, and the
  // Hebrew letters Intl uses as numerals under `-u-nu-hebr`.
  const NOT_LATIN_DIGITS = /[\u0660-\u0669\u06F0-\u06F9\u05D0-\u05EA]/;

  it.each([...LOCALES])('prints %s times and counts in 0-9', locale => {
    const at1800 = formatTime(new Date('2026-09-13T18:00:00.000Z'), { locale, timeZone: 'UTC' });
    expect(at1800).toContain('18');
    expect(at1800).not.toMatch(NOT_LATIN_DIGITS);

    // Under a thousand, so the grouping separator (which is a locale decision
    // of its own, and not this one) stays out of the comparison.
    const count = formatNumber(118, { locale });
    expect(count).toBe('118');
    expect(count).not.toMatch(NOT_LATIN_DIGITS);
  });
});
