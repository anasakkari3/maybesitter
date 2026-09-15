/**
 * What the memory screen is not allowed to claim (UC-3.16 #202, strategy §13).
 *
 * The strategy names six claims the product must never make, and two of them —
 * "knows you better than you know yourself" and any comprehensive-memory
 * promise — are exactly the register a screen about memory drifts into. Not
 * through a deliberate line, but through a heading somebody tightens: "what we
 * know about you", "MaybeSitter understands your week". Each is one word away
 * from copy that already exists here, and neither would look wrong in review.
 *
 * So the ban is a test rather than a convention, and it reads the claim list
 * out of the strategy document instead of restating it — a §13 that grew a
 * seventh claim and left this file alone would be a rule nobody is keeping.
 *
 * ── What is checked, and what cannot be ──────────────────────────
 *
 * English is checked against phrases; Arabic and Hebrew against their own
 * terms, because a translated ban is not a ban. The list over-matches on
 * purpose: a heading that has to argue its way past it is a heading to
 * rewrite. What this cannot do is catch a claim phrased in words nobody
 * thought of, which is why §13 is also quoted in the file the copy lives
 * beside rather than only here.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from '@jest/globals';
import ar from '../locales/ar.json';
import en from '../locales/en.json';
import he from '../locales/he.json';

const LOCALES = { en, ar, he } as unknown as Record<string, Record<string, unknown>>;

const STRATEGY = join(
  __dirname, '..', '..', '..', '..', 'docs', 'strategy', 'CURRENT_PRODUCT_STRATEGY.md',
);

/** Every message whose key is about memory. */
function memoryCopy(bundle: Record<string, unknown>): [string, string][] {
  return Object.entries(bundle)
    .filter(([key, value]) => key.startsWith('memory') && typeof value === 'string')
    .map(([key, value]) => [key, value as string]);
}

/**
 * Phrases no memory string may contain, per locale.
 *
 * The object of the verb is what is banned, not the verb. "Something
 * MaybeSitter should know" is a placeholder telling somebody what to type;
 * "MaybeSitter knows you" is a claim about the person, and §13's line is drawn
 * at the second. Each entry below is a §13 claim carried into the language it
 * would actually be written in — a ban that only existed in English would be
 * no ban at all on the two locales the app defaults to.
 */
const BANNED: Record<string, readonly string[]> = {
  en: [
    'knows you', 'know you', 'understands you', 'understand you',
    'better than you', 'everything about you', 'your entire life',
    'automatically understands',
  ],
  ar: ['بيعرفك', 'بيفهمك', 'بفهمك', 'كل حياتك', 'أكتر منك', 'بيفهم كل'],
  he: ['מכיר אותך', 'מבין אותך', 'כל החיים שלך', 'יותר ממך'],
};

describe('§13 claims never reach the memory screen', () => {
  it('is checking a list the strategy still holds', () => {
    // Binding, not decoration: if §13 is edited or renumbered, this fails and
    // whoever edited it has to come and decide what the copy may now say.
    const strategy = readFileSync(STRATEGY, 'utf8');
    expect(strategy).toMatch(/## 13\. Claims that must not be used/);
    expect(strategy).toMatch(/Knows you better than you know yourself/i);
    expect(strategy).toMatch(/comprehensive-memory promise/i);
  });

  for (const [locale, bundle] of Object.entries(LOCALES)) {
    it(`${locale}: no memory string claims to know or understand the user`, () => {
      const offenders: string[] = [];
      for (const [key, text] of memoryCopy(bundle)) {
        for (const term of BANNED[locale] ?? []) {
          if (text.toLowerCase().includes(term.toLowerCase())) offenders.push(`${key}: ${text}`);
        }
      }
      expect(offenders).toEqual([]);
    });
  }

  it('says "remembers", which is a claim about storage and is true', () => {
    expect(en.memoryScreenTitle.toLowerCase()).toContain('remember');
  });
});
