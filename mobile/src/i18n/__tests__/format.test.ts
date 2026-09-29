import { describe, expect, it } from '@jest/globals';
import { formatClockRange, formatDate, formatDayRange, formatNumber, formatRelativeDay, formatTime, formatTimeRange } from '../format';
import { LOCALES, intlLocale, type Locale } from '../locale';
import ar from '../locales/ar.json';
import en from '../locales/en.json';
import he from '../locales/he.json';

const bundles: Record<Locale, { yesterday: string; days: string[] }> = { en, ar, he };

// 2026-09-10 18:30 UTC. Israel is on IDT (UTC+3) and New York on EDT (UTC-4),
// so the same instant is 21:30 in one place and 14:30 in the other. Nothing
// here may depend on the machine's own timezone.
const INSTANT = new Date('2026-09-10T18:30:00Z');
const DAY = 86_400_000;

const ARABIC_INDIC = /[٠-٩۰-۹]/;
/** Drops bidi marks Intl may add, so a comparison is about the text. */
const plain = (s: string) => s.replace(/[‎‏⁦-⁩]/g, '');

describe('formatTime', () => {
  it('renders the same instant as a different wall time per zone', () => {
    const jerusalem = plain(formatTime(INSTANT, { locale: 'en', timeZone: 'Asia/Jerusalem' }));
    const newYork = plain(formatTime(INSTANT, { locale: 'en', timeZone: 'America/New_York' }));
    expect(jerusalem).toBe('21:30');
    expect(newYork).toBe('14:30');
    expect(jerusalem).not.toBe(newYork);
  });

  it('renders Arabic with Latin digits', () => {
    const arabic = formatTime(INSTANT, { locale: 'ar', timeZone: 'Asia/Jerusalem' });
    expect(arabic).not.toMatch(ARABIC_INDIC);
    expect(plain(arabic)).toBe('21:30');
  });
});

describe('formatDate', () => {
  it('honours the timezone across a date boundary', () => {
    const lateNight = new Date('2026-09-10T21:30:00Z'); // 00:30 on the 11th in Israel
    expect(plain(formatDate(lateNight, 'short', { locale: 'en', timeZone: 'Asia/Jerusalem' }))).toBe('Sep 11');
    expect(plain(formatDate(lateNight, 'short', { locale: 'en', timeZone: 'America/New_York' }))).toBe('Sep 10');
  });

  it('renders Arabic with Latin digits at every style', () => {
    for (const style of ['short', 'weekday', 'full'] as const) {
      const out = formatDate(INSTANT, style, { locale: 'ar', timeZone: 'Asia/Jerusalem' });
      expect(out).not.toMatch(ARABIC_INDIC);
      expect(out).toContain('10');
    }
  });
});

describe('formatNumber', () => {
  it('uses Latin digits for Arabic', () => {
    const out = formatNumber(1234, { locale: 'ar' });
    expect(out).not.toMatch(ARABIC_INDIC);
    expect(plain(out).replace(/\D/g, '')).toBe('1234');
  });

  it('formats English normally', () => {
    expect(formatNumber(1234, { locale: 'en' })).toBe('1,234');
  });
});

describe('formatRelativeDay', () => {
  const opts = { timeZone: 'Asia/Jerusalem', now: INSTANT } as const;

  it('says today and tomorrow in the copy of each locale', () => {
    expect(formatRelativeDay(INSTANT, { ...opts, locale: 'en' })).toBe('Today');
    expect(formatRelativeDay(INSTANT, { ...opts, locale: 'ar' })).toBe('اليوم');
    expect(formatRelativeDay(INSTANT, { ...opts, locale: 'he' })).toBe('היום');
    expect(formatRelativeDay(new Date(INSTANT.getTime() + DAY), { ...opts, locale: 'en' })).toBe('Tomorrow');
    expect(formatRelativeDay(new Date(INSTANT.getTime() + DAY), { ...opts, locale: 'ar' })).toBe('بكرا');
  });

  it('compares calendar days in the given zone, not elapsed hours', () => {
    // Three hours later is still the 10th in New York and already the 11th in
    // Israel.
    const later = new Date('2026-09-10T21:30:00Z');
    expect(formatRelativeDay(later, { locale: 'en', timeZone: 'Asia/Jerusalem', now: INSTANT })).toBe('Tomorrow');
    expect(formatRelativeDay(later, { locale: 'en', timeZone: 'America/New_York', now: INSTANT })).toBe('Today');
  });

  /**
   * #397: `yesterday` was "Yesterday, Wednesday" / «أمس، الأربعاء» / "אתמול, יום
   * רביעי" — a weekday frozen into the copy, so every screen that printed it
   * named the wrong day six days in seven. It is a bare relative day now, the
   * same shape as `today` and `tomorrow`.
   */
  it.each(LOCALES)('says yesterday in the %s copy, one calendar day back', locale => {
    const bundle = bundles[locale];
    const oneDayBack = new Date(INSTANT.getTime() - DAY);
    expect(formatRelativeDay(oneDayBack, { ...opts, locale })).toBe(bundle.yesterday);
    // 22 hours back is 23:30 on the 9th in Israel: yesterday by the calendar,
    // though not a full day by the clock.
    const lateLastNight = new Date(INSTANT.getTime() - 22 * 3_600_000);
    expect(formatRelativeDay(lateLastNight, { ...opts, locale })).toBe(bundle.yesterday);
  });

  it('pins yesterday as a bare relative day, like today and tomorrow', () => {
    expect({ en: en.yesterday, ar: ar.yesterday, he: he.yesterday }).toEqual({
      en: 'Yesterday',
      ar: 'مبارح',
      he: 'אתמול',
    });
  });

  it.each(LOCALES)('never names a weekday in the %s yesterday copy', locale => {
    const bundle = bundles[locale];
    // 2026-09-06 is a Sunday; seven middays in UTC are the seven weekdays.
    const intlNames = Array.from({ length: 7 }, (_, i) =>
      new Intl.DateTimeFormat(intlLocale(locale), { weekday: 'long', timeZone: 'UTC' }).format(
        new Date(Date.UTC(2026, 8, 6 + i, 12)),
      ),
    );
    const names = [...new Set([...intlNames, ...bundle.days])];
    expect(names.length).toBeGreaterThanOrEqual(7);
    const named = names.filter(name => bundle.yesterday.includes(name));
    expect({ locale, named }).toEqual({ locale, named: [] });
  });

  it('falls back to a weekday date further out', () => {
    const out = formatRelativeDay(new Date(INSTANT.getTime() + 3 * DAY), { ...opts, locale: 'en' });
    expect(out).not.toBe('Today');
    expect(out).not.toBe('Tomorrow');
    expect(out).toContain('Sep');
  });
});

describe('formatTimeRange', () => {
  it('names both ends in the requested zone', () => {
    const end = new Date(INSTANT.getTime() + 90 * 60_000);
    const out = plain(formatTimeRange(INSTANT, end, { locale: 'en', timeZone: 'Asia/Jerusalem' }));
    expect(out).toContain('21:30');
    expect(out).toContain('23:00');
  });

  it('uses Latin digits in Arabic', () => {
    const end = new Date(INSTANT.getTime() + 60 * 60_000);
    expect(formatTimeRange(INSTANT, end, { locale: 'ar', timeZone: 'Asia/Jerusalem' })).not.toMatch(ARABIC_INDIC);
  });

  // UAT 2026-09-26: the plan card drew «16:00–15:30» in Arabic while the
  // calendar's busy rows drew «15:30–16:00». One rule, in every language: the
  // start first, and the whole range one left-to-right isolate.
  it('is one left-to-right unit, start first, in every language', () => {
    const end = new Date(INSTANT.getTime() + 60 * 60_000);
    for (const locale of LOCALES) {
      expect(formatTimeRange(INSTANT, end, { locale, timeZone: 'Asia/Jerusalem' })).toBe('\u206621:30–22:30\u2069');
    }
  });
});

describe('formatClockRange', () => {
  it('matches formatTimeRange for a stored wall-clock window', () => {
    expect(formatClockRange('22:30', '07:30')).toBe('\u206622:30–07:30\u2069');
  });
});

describe('formatDayRange', () => {
  const RLI = '\u2067';
  const LRI = '\u2066';
  const FSI = '\u2068';
  const PDI = '\u2069';

  // UAT 2026-09-26, #16, shot 83: «سبتمبر – 2 أكتوبر 26». The whole range sat in
  // one left-to-right isolate, so the Arabic run inside it reversed around the
  // dash. Each date is its own isolate; the range runs in the language's way.
  it('Arabic: right-to-left as a whole, first date first, each date whole', () => {
    expect(formatDayRange('2026-09-26', '2026-10-02', { locale: 'ar' }))
      .toBe(`${RLI}${FSI}26 سبتمبر${PDI} – ${FSI}2 أكتوبر${PDI}${PDI}`);
  });

  it('Hebrew: right-to-left too', () => {
    const out = formatDayRange('2026-09-26', '2026-10-02', { locale: 'he' });
    expect(out.startsWith(`${RLI}${FSI}26`)).toBe(true);
    expect(out.endsWith(`${PDI}${PDI}`)).toBe(true);
  });

  it('English: left-to-right', () => {
    expect(formatDayRange('2026-09-26', '2026-10-02', { locale: 'en' }))
      .toBe(`${LRI}${FSI}Sep 26${PDI} – ${FSI}Oct 2${PDI}${PDI}`);
  });
});
