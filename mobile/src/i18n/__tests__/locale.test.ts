import { describe, expect, it } from '@jest/globals';
import { isolate, isolateAuto, ltr, stripIsolates } from '../bidi';
import { DEFAULT_LOCALE, SELECTABLE_LOCALES, apiLocale, intlLocale, isLocale } from '../locale';

describe('apiLocale', () => {
  const cases: [string | null | undefined, string][] = [
    ['en', 'en'],
    ['ar', 'ar'],
    ['he', 'he'],
    ['ar-IL', 'ar'],
    ['he-IL', 'he'],
    ['en_US', 'en'],
    ['AR', 'ar'],
    // Some Android builds still report Hebrew with the deprecated ISO code.
    ['iw', 'he'],
    ['iw-IL', 'he'],
    // Anything unsupported goes to English rather than to the backend.
    ['fr', DEFAULT_LOCALE],
    ['', DEFAULT_LOCALE],
    [null, DEFAULT_LOCALE],
    [undefined, DEFAULT_LOCALE],
  ];
  for (const [tag, expected] of cases) {
    it(`maps ${JSON.stringify(tag)} to ${expected}`, () => expect(apiLocale(tag)).toBe(expected));
  }
});

describe('the digit decision', () => {
  it('asks Intl for Latin digits in Arabic only', () => {
    expect(intlLocale('ar')).toBe('ar-u-nu-latn');
    expect(intlLocale('en')).toBe('en');
    expect(intlLocale('he')).toBe('he');
  });
});

describe('what the picker may offer', () => {
  it('leaves Hebrew out — no native review and no Hebrew font face', () => {
    expect([...SELECTABLE_LOCALES]).toEqual(['en', 'ar']);
    expect(isLocale('he')).toBe(true);
  });
});

describe('bidi isolates', () => {
  it('wraps in the requested direction', () => {
    expect(isolate('9:00')).toBe('⁦9:00⁩');
    expect(isolate('9:00', 'rtl')).toBe('⁧9:00⁩');
    expect(isolateAuto('مراجعة')).toBe('⁨مراجعة⁩');
  });

  it('ltr is the isolate the screens have always used', () => {
    expect(ltr('9:00')).toBe(isolate('9:00', 'ltr'));
  });

  it('strips every isolate control back out', () => {
    const wrapped = `اليوم ${ltr('9:00')} و${isolateAuto('Sarah')}`;
    expect(stripIsolates(wrapped)).toBe('اليوم 9:00 وSarah');
    expect(stripIsolates(wrapped)).not.toMatch(/[⁦-⁩]/);
  });
});
