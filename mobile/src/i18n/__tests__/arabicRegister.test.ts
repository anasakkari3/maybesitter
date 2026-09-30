/**
 * The Arabic copy is plain spoken Levantine, and short (UAT 2026-09-26, #17).
 *
 * The UAT found formal MSA sentences mixed into the spoken UI — «هذا اقتراح.
 * لم يتغيّر أي شيء بعد.» on every proposal, «النص يُرسل لخادمنا لنفهمه، ولا
 * نحتفظ به.» under the composer — and explanatory bodies long enough that the
 * calendar and personalization screens read like terms of service.
 *
 * The proposal note has since gone back to its fusha wording by the owner's
 * copy direction (#687); it is the one exact exception below.
 */
import { describe, expect, it } from '@jest/globals';
import ar from '../locales/ar.json';
import en from '../locales/en.json';
import he from '../locales/he.json';

type Bundle = Record<string, unknown>;

/** Constructions spoken Levantine does not use. */
const MSA: readonly RegExp[] = [
  // Each also with a و-/ف- prefix: «ولم», «وهذا».
  /(^|[\s«({])[وف]?(لم|لن|سوف|ليس|لدينا|لديك|لديه)\s/, // negation / possession
  /(^|[\s«({])[وف]?(هذا|هذه|الذي|التي|الذين)([\s.،؟]|$)/, // demonstratives / relatives
  /(^|[\s«({])[وف]?[يت]ُ/, // passive: «يُحفظ», «تُصمَّم»
  /(^|\s)[وف]?(يتم|سيتم|تم)\s/, // «تم» without the shadda is the formal passive
  /(^|[\s«({])جاري\s/, // «جاري التحديث»
  /(اثنان|اثنتان|شيئان|شيئًا)/, // formal numerals and duals
];

/**
 * Labels this lane does not own. `todayGroupShould` is the priority level's
 * name; the priority lane (CL1) decides it.
 */
const ALLOWED = new Set(['todayGroupShould']);

/**
 * One sentence allowed in MSA, and only word for word. The proposal note is a
 * product-contract sentence (mobile/AGENTS.md): the owner's copy direction
 * behind #687 is simple fusha with light Levantine, and it keeps this line in
 * fusha (ARABIC_STYLE_GUIDE.md). Any other wording of the key, and MSA in any
 * other key, is still refused.
 */
const ALLOWED_EXACT: Readonly<Record<string, string>> = {
  suggestionNote: 'هذا اقتراح. لم يتغيّر أي شيء بعد.',
};

describe('Arabic register', () => {
  it('no Arabic string is written in formal MSA', () => {
    const offenders = Object.entries(ar as Bundle)
      .filter(([key, value]) => !ALLOWED.has(key) && ALLOWED_EXACT[key] !== value && typeof value === 'string' && MSA.some((re) => re.test(value)))
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

    // UAT 2026-09-27 (#17): the second sentence of each of these restated the
    // title, the button under it, or a line elsewhere on the same screen.
    for (const key of ['obConsentLede', 'aiDisclosure', 'aiDisclosureKept', 'xModesBody', 'xNoContext', 'xNoLearning', 'planEmptyBodyReady']) {
      it(`${locale}: ${key} is one sentence`, () => {
        expect({ key, sentences: sentences(String(bundle[key])) }).toEqual({ key, sentences: 1 });
      });
    }

    // The title already asks what MaybeSitter may use; the lede said it back.
    it(`${locale}: the consent lede does not repeat the consent title`, () => {
      expect(String(bundle.obConsentTitle)).toContain('MaybeSitter');
      expect(String(bundle.obConsentLede)).not.toContain('MaybeSitter');
    });

    // A consent's words (personalizationConsentCopy.test.ts holds every claim);
    // the claims stay, the repetition goes. It was 228 characters in Arabic.
    it(`${locale}: trustPersonalizationBody says its claims and no more`, () => {
      const limit = locale === 'en' ? 200 : 150;
      expect(String(bundle.trustPersonalizationBody).length).toBeLessThanOrEqual(limit);
    });
  }
});
