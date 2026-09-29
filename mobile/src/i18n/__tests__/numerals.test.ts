/**
 * One numeral style (UAT 2026-09-26, D6).
 *
 * `INTL_LOCALE` decides it for everything Intl formats: Arabic copy uses Latin
 * digits (`ar-u-nu-latn`). Copy typed by hand has to follow the same rule, or
 * a screen shows «٢٢:٣٠» beside «09:00» — which the quiet-hours chips did.
 */
import { describe, expect, it } from '@jest/globals';
import ar from '../locales/ar.json';
import he from '../locales/he.json';
import { formatDate, formatDayRange, formatTime, formatTimeRange } from '../format';

const NON_LATIN_DIGIT = /[٠-٩۰-۹]/;
const INSTANT = new Date('2026-09-26T19:30:00Z');

function offenders(bundle: Record<string, unknown>): string[] {
  return Object.entries(bundle)
    .filter(([key, value]) => key !== '_meta' && typeof value === 'string' && NON_LATIN_DIGIT.test(value))
    .map(([key]) => key);
}

describe('numerals', () => {
  it('no Arabic copy spells a number in Arabic-Indic digits', () => {
    expect(offenders(ar as Record<string, unknown>)).toEqual([]);
  });

  it('no Hebrew copy does either', () => {
    expect(offenders(he as Record<string, unknown>)).toEqual([]);
  });

  it('Arabic times, ranges and dates format with Latin digits', () => {
    const options = { locale: 'ar' as const, timeZone: 'Asia/Jerusalem' };
    const end = new Date(INSTANT.getTime() + 30 * 60_000);
    for (const out of [
      formatTime(INSTANT, options),
      formatTimeRange(INSTANT, end, options),
      formatDate(INSTANT, 'short', options),
      formatDate(INSTANT, 'full', options),
      formatDayRange('2026-09-26', '2026-10-02', { locale: 'ar' }),
    ]) {
      expect({ out, arabicIndic: NON_LATIN_DIGIT.test(out) }).toEqual({ out, arabicIndic: false });
    }
  });
});
