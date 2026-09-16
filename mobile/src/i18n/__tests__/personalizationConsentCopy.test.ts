/**
 * The personalization toggle's words (UC-3.16, #202).
 *
 * A consent is consent to words, so the words are held to what
 * `personalization-consent-v1` claims, per language. Every locale is checked
 * against its own phrases — an English-only guard would pass an Arabic or
 * Hebrew string that dropped the promise about plans entirely.
 *
 * Each required fragment stands for one claim:
 *  - it names the inference: patterns, read from when you finish things;
 *  - it suggests, and saves nothing unless kept;
 *  - off stops the suggestions **and** stops the plan using kept patterns.
 */
import { describe, expect, it } from '@jest/globals';
import ar from '../locales/ar.json';
import en from '../locales/en.json';
import he from '../locales/he.json';

type Locale = 'en' | 'ar' | 'he';
const BUNDLES: Record<Locale, Record<string, string>> = { en, ar, he } as never;

const REQUIRED: Record<Locale, Record<string, readonly string[]>> = {
  en: {
    inference: ['patterns', 'times you finish things'],
    suggests: ['suggest'],
    nothingSaved: ['Nothing is saved unless you keep it'],
    offStopsSuggestions: ['stops the suggestions'],
    offStopsPlans: ['plan stops using patterns you kept'],
  },
  ar: {
    inference: ['أنماط', 'الأوقات اللي بتخلّص فيها'],
    suggests: ['يقترح'],
    nothingSaved: ['ما بينحفظ إشي إلا إذا إنت حفظته'],
    offStopsSuggestions: ['بتوقف الاقتراحات'],
    offStopsPlans: ['بتبطّل تستعمل الأنماط اللي حفظتها'],
  },
  he: {
    inference: ['דפוסים', 'השעות שבהן דברים מסתיימים'],
    suggests: ['להציע'],
    nothingSaved: ['שום דבר לא נשמר אלא אם תשמור'],
    offStopsSuggestions: ['עוצר את ההצעות'],
    offStopsPlans: ['מפסיקה להשתמש בדפוסים ששמרת'],
  },
};

/** §13, per language; the same lists the memory screen is held to. */
const BANNED: Record<Locale, readonly string[]> = {
  en: ['knows you', 'know you', 'understands you', 'understand you', 'better than you', 'everything about you'],
  ar: ['بيعرفك', 'بيفهمك', 'بفهمك', 'كل حياتك', 'أكتر منك', 'بيفهم كل'],
  he: ['מכיר אותך', 'מבין אותך', 'כל החיים שלך', 'יותר ממך'],
};

describe('personalization consent copy', () => {
  for (const locale of Object.keys(BUNDLES) as Locale[]) {
    const bundle = BUNDLES[locale];
    const text = `${bundle.trustPersonalizationTitle ?? ''} ${bundle.trustPersonalizationBody ?? ''}`;

    it(`${locale}: exists`, () => {
      expect(bundle.trustPersonalizationTitle).toBeTruthy();
      expect(bundle.trustPersonalizationBody).toBeTruthy();
    });

    for (const [claim, fragments] of Object.entries(REQUIRED[locale])) {
      it(`${locale}: says ${claim}`, () => {
        for (const fragment of fragments) expect(text).toContain(fragment);
      });
    }

    it(`${locale}: makes no §13 claim`, () => {
      const lower = text.toLowerCase();
      expect(BANNED[locale].filter(term => lower.includes(term.toLowerCase()))).toEqual([]);
    });
  }
});
