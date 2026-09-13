/**
 * Picking a speech locale, and the two traps in it (UC-2.3, #163).
 */
import { describe, expect, it } from '@jest/globals';
import { normalizeLocaleId, resolveSpeechLocale, speechLanguageForTag } from '../speechLocale';

/** Roughly what iOS reports. */
const IOS = ['en-US', 'en-GB', 'en-AU', 'ar-SA', 'ar-AE', 'he-IL', 'fr-FR'];
/** Roughly what Android reports: underscores, and Hebrew as `iw`. */
const ANDROID = ['en_US', 'en_GB', 'ar_JO', 'ar_PS', 'ar_SA', 'iw_IL', 'fr_FR'];

describe('normalizeLocaleId', () => {
  it('folds the two spellings of Hebrew together', () => {
    // `iw` is the pre-1989 code the JDK froze, so Android says `iw-IL` for the
    // same language iOS calls `he-IL`.
    expect(normalizeLocaleId('iw-IL')).toBe(normalizeLocaleId('he-IL'));
    expect(normalizeLocaleId('iw_IL')).toBe('he-il');
  });

  it('folds underscores and case', () => {
    expect(normalizeLocaleId('ar_JO')).toBe('ar-jo');
    expect(normalizeLocaleId('AR-jo')).toBe('ar-jo');
    expect(normalizeLocaleId('  en_US  ')).toBe('en-us');
  });

  it('leaves other languages alone', () => {
    expect(normalizeLocaleId('fr-FR')).toBe('fr-fr');
  });
});

describe('resolveSpeechLocale', () => {
  it('returns the platform own string, not the normalized one', () => {
    // The whole point. Handing `he-IL` back to Android would be the same bug
    // from the other end: it does not know that name.
    expect(resolveSpeechLocale('he', ANDROID)).toEqual({ kind: 'supported', localeId: 'iw_IL', onDevice: false });
    expect(resolveSpeechLocale('he', IOS)).toEqual({ kind: 'supported', localeId: 'he-IL', onDevice: false });
  });

  it('prefers the Levantine regions for Arabic', () => {
    // `ar-SA` is Modern Standard and mishears dialect; the users write Levantine.
    expect((resolveSpeechLocale('ar', ANDROID) as { localeId: string }).localeId).toBe('ar_PS');
    // iOS has neither Levantine region, so Gulf is the best available.
    expect((resolveSpeechLocale('ar', IOS) as { localeId: string }).localeId).toBe('ar-SA');
  });

  it('falls back to any region of the language rather than refusing to listen', () => {
    expect(resolveSpeechLocale('ar', ['ar-MA', 'en-US'])).toEqual({
      kind: 'supported', localeId: 'ar-MA', onDevice: false,
    });
  });

  it('reports the language as unsupported when no region of it exists', () => {
    expect(resolveSpeechLocale('he', ['en-US', 'ar-SA'])).toEqual({ kind: 'unsupported', language: 'he' });
  });

  it('prefers an on-device locale within the order, never above it', () => {
    // `ar-PS` is the better match and is not installed; `ar-JO` is installed and
    // is also Levantine, so it wins. Installing the wrong dialect locally is not
    // a privacy win — it is a transcription nobody can use.
    expect(resolveSpeechLocale('ar', ['ar-PS', 'ar-JO', 'ar-SA'], ['ar-JO'])).toEqual({
      kind: 'supported', localeId: 'ar-JO', onDevice: true,
    });

    // With nothing installed, the order alone decides.
    expect(resolveSpeechLocale('ar', ['ar-PS', 'ar-JO', 'ar-SA'], [])).toEqual({
      kind: 'supported', localeId: 'ar-PS', onDevice: false,
    });
  });

  it('matches an installed locale across the two Hebrew spellings', () => {
    // Available as `iw_IL`, installed as reported `he-IL`: the same language,
    // and the resolution has to see that.
    expect(resolveSpeechLocale('he', ['iw_IL'], ['he-IL'])).toEqual({
      kind: 'supported', localeId: 'iw_IL', onDevice: true,
    });
  });

  it('keeps the first spelling a platform lists when it lists both', () => {
    expect((resolveSpeechLocale('he', ['iw-IL', 'he-IL']) as { localeId: string }).localeId).toBe('iw-IL');
    expect((resolveSpeechLocale('he', ['he-IL', 'iw-IL']) as { localeId: string }).localeId).toBe('he-IL');
  });

  it('handles an empty list without throwing', () => {
    expect(resolveSpeechLocale('en', [])).toEqual({ kind: 'unsupported', language: 'en' });
  });

  it('never returns a locale of a different language', () => {
    for (const language of ['ar', 'he', 'en'] as const) {
      for (const available of [IOS, ANDROID, ['fr-FR'], []]) {
        const resolution = resolveSpeechLocale(language, available);
        if (resolution.kind !== 'supported') continue;
        expect(normalizeLocaleId(resolution.localeId).split('-')[0]).toBe(language);
      }
    }
  });
});

describe('speechLanguageForTag', () => {
  it('reads the device tag, not what the UI is rendered in', () => {
    // The app displays only English and Arabic, but it reads and captures
    // Hebrew. Someone whose phone is Hebrew should be able to dictate Hebrew
    // into an English-looking app.
    expect(speechLanguageForTag('he-IL')).toBe('he');
    expect(speechLanguageForTag('iw-IL')).toBe('he');
    expect(speechLanguageForTag('ar-JO')).toBe('ar');
    expect(speechLanguageForTag('en-GB')).toBe('en');
  });

  it('falls back to English for anything else', () => {
    for (const tag of ['fr-FR', 'zz', '', null, undefined]) {
      expect(speechLanguageForTag(tag)).toBe('en');
    }
  });
});
