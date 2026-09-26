/**
 * The Arabic copy is plain spoken Levantine, and short (UAT 2026-09-26, #17).
 *
 * The UAT found formal MSA sentences mixed into the spoken UI — «هذا اقتراح.
 * لم يتغيّر أي شيء بعد.» on every proposal, «النص يُرسل لخادمنا لنفهمه، ولا
 * نحتفظ به.» under the composer — and explanatory bodies long enough that the
 * calendar and personalization screens read like terms of service.
 */
import { describe, expect, it } from '@jest/globals';
import ar from '../locales/ar.json';
import en from '../locales/en.json';
import he from '../locales/he.json';

type Bundle = Record<string, unknown>;

/** Constructions spoken Levantine does not use. */
const MSA: readonly RegExp[] = [
  /(^|[\s«(])(لم|لن|سوف|ليس|لدينا|لديك|لديه)\s/, // negation / possession
  /(^|[\s«(])(هذا|هذه|الذي|التي|الذين)([\s.،؟]|$)/, // demonstratives / relatives
  /(^|[\s«(])يُ/, // passive prefix
  /(^|\s)يتم\s/,
];

/**
 * Labels this lane does not own. `todayGroupShould` is the priority level's
 * name; the priority lane (CL1) decides it.
 */
const ALLOWED = new Set(['todayGroupShould']);

describe('Arabic register', () => {
  it('no Arabic string is written in formal MSA', () => {
    const offenders = Object.entries(ar as Bundle)
      .filter(([key, value]) => !ALLOWED.has(key) && typeof value === 'string' && MSA.some((re) => re.test(value)))
      .map(([key, value]) => `${key}: ${String(value).slice(0, 60)}`);
    expect(offenders).toEqual([]);
  });
});

describe('one spelling for "now"', () => {
  // The bundle said «هلّق», «هلق», «هلأ» and «هلا» for the same word, sometimes
  // on one screen («مش هلّق» beside «مش هلأ»). It is «هلّق».
  it('every Arabic "now" is «هلّق»', () => {
    const letters = '\u0621-\u064A\u064B-\u0652';
    const variant = new RegExp(`(?<![${letters}])ل?هل(ق|أ|ا)(?![${letters}])`);
    const offenders = Object.entries(ar as Bundle)
      .filter(([, value]) => typeof value === 'string' && variant.test(value))
      .map(([key]) => key);
    expect(offenders).toEqual([]);
  });
});

describe('explanatory bodies are one short line', () => {
  const sentences = (text: string) => text.split(/[.!?؟](\s|$)/).filter((part) => part && part.trim().length > 0).length;

  for (const [locale, bundle] of Object.entries({ ar, en, he }) as [string, Bundle][]) {
    for (const key of ['calendarReadBody', 'calendarWriteBody', 'calendarDisconnectBody', 'calendarDeclinedNote']) {
      it(`${locale}: ${key} is one sentence`, () => {
        expect({ key, sentences: sentences(String(bundle[key])) }).toEqual({ key, sentences: 1 });
      });
    }

    // A consent's words (personalizationConsentCopy.test.ts holds every claim);
    // the claims stay, the repetition goes. It was 228 characters in Arabic.
    it(`${locale}: trustPersonalizationBody says its claims and no more`, () => {
      const limit = locale === 'en' ? 200 : 150;
      expect(String(bundle.trustPersonalizationBody).length).toBeLessThanOrEqual(limit);
    });
  }
});
