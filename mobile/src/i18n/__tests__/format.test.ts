import { describe, expect, it } from '@jest/globals';
import { formatDate, formatNumber, formatRelativeDay, formatTime, formatTimeRange } from '../format';

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
});
