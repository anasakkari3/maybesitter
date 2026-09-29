/**
 * A remembered time window reads left to right in every language (UAT round
 * 3, N14, shot 282).
 *
 * «بيركّز 09:00–17:00» rendered with 17:00 on the left: the two Latin runs
 * were laid out right to left around the dash, the reverse of every other
 * range in the app. The range is one left-to-right unit, the one
 * `formatClockRange` makes for quiet hours.
 */
import { describe, expect, it } from '@jest/globals';
import { memorySentence } from '../memoryDisplay';
import { formatClockRange } from '../../../i18n/format';
import ar from '../../../i18n/locales/ar.json';
import en from '../../../i18n/locales/en.json';
import he from '../../../i18n/locales/he.json';

const LRI = '⁦';
const PDI = '⁩';
const BUNDLES = { ar, en, he } as const;

describe('a remembered window (UAT round 3, N14)', () => {
  it('the literal row: «بيركّز 09:00–17:00», its range one left-to-right unit', () => {
    expect(memorySentence({ content: 'focus_window:09:00-17:00', strings: ar as unknown as Record<string, string> }))
      .toBe(`بيركّز ${formatClockRange('09:00', '17:00')}`);
  });

  it('isolates the range for every window kind, in every language', () => {
    for (const [lang, bundle] of Object.entries(BUNDLES)) {
      for (const key of ['sleep_window', 'focus_window', 'fixed_commitments', 'quiet_hours']) {
        const sentence = memorySentence({ content: `${key}:22:30-07:30`, strings: bundle as unknown as Record<string, string> });
        expect(`${lang} ${key} ${sentence}`).toContain(`${LRI}22:30–07:30${PDI}`);
      }
    }
  });
});
