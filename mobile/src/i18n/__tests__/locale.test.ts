import { describe, expect, it } from '@jest/globals';
import { isolate, isolateAuto, ltr, stripIsolates } from '../bidi';
import {
  DEFAULT_LOCALE, LOCALES, SELECTABLE_LOCALES, apiLocale, intlLocale, isLocale, isRtl, scriptFor,
} from '../locale';

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
  // The tags. What actually comes out of Intl is asserted in digits.test.ts,
  // which is a separate file because importing a formatter here would boot
  // i18next and give `apiLocale()` a current language the cases above assume
  // it does not have.
  it('asks Intl for Latin digits in Arabic only', () => {
    expect(intlLocale('ar')).toBe('ar-u-nu-latn');
    expect(intlLocale('en')).toBe('en');
    // No extension: CLDR already defaults Hebrew to `latn`. See README.md.
    expect(intlLocale('he')).toBe('he');
  });
});

describe('what the picker may offer', () => {
  it('offers Hebrew: it has a font face now, and imperfect Hebrew beats English', () => {
    expect([...SELECTABLE_LOCALES]).toEqual(['en', 'ar', 'he']);
    expect(isLocale('he')).toBe(true);
    // Nothing the app carries copy for is unreachable any more.
    expect([...SELECTABLE_LOCALES].sort()).toEqual([...LOCALES].sort());
  });
});

describe('direction and script are separate questions', () => {
  it('reads Hebrew right to left, exactly as Arabic', () => {
    expect(isRtl('he')).toBe(true);
    expect(isRtl('ar')).toBe(true);
    expect(isRtl('en')).toBe(false);
  });

  it('sets Hebrew in its own face, which is where it differs from Arabic', () => {
    expect(scriptFor('he')).toBe('hebrew');
    expect(scriptFor('ar')).toBe('arabic');
    expect(scriptFor('en')).toBe('latin');
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
