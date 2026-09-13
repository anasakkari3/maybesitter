import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from '@jest/globals';

/**
 * The polyfill has to be the *first* thing the i18n barrel imports (UC-1.R3).
 *
 * `hermesPlurals.test.ts` proves the polyfill fixes the formatting. This proves
 * it still runs in time. The two are different failures: an import sorter, a
 * lint autofix, or someone tidying the header could move `./polyfills` below
 * `i18next-icu` and every test would stay green, because Node has a full `Intl`
 * and never needed the polyfill in the first place. On Hermes the ICU source
 * would come back on screen.
 *
 * Reading the file rather than the module graph is deliberate: the ordering is
 * a property of the source text, and by the time a module has loaded there is
 * nothing left to observe about the order it loaded things in.
 */
describe('the i18n barrel loads the Intl polyfill before anything else', () => {
  const source = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8');

  const firstImport = source
    .split('\n')
    .map(line => line.trim())
    .find(line => line.startsWith('import '));

  it('imports ./polyfills first', () => {
    expect(firstImport).toBe("import './polyfills';");
  });

  it('imports it before i18next-icu, which is what would throw without it', () => {
    const polyfillAt = source.indexOf("import './polyfills'");
    const icuAt = source.indexOf("from 'i18next-icu'");
    expect(polyfillAt).toBeGreaterThanOrEqual(0);
    expect(icuAt).toBeGreaterThanOrEqual(0);
    expect(polyfillAt).toBeLessThan(icuAt);
  });

  it('loads Locale before PluralRules, which depends on it', () => {
    // formatjs's own ordering requirement: PluralRules needs Intl.Locale, and
    // Intl.Locale needs getCanonicalLocales. Installed out of order, the later
    // polyfill sees a half-built Intl and the plural lookup silently degrades.
    const polyfills = readFileSync(join(__dirname, '..', 'polyfills.ts'), 'utf8');
    const canonical = polyfills.indexOf('intl-getcanonicallocales');
    const locale = polyfills.indexOf('intl-locale');
    const plural = polyfills.indexOf('intl-pluralrules');
    expect(canonical).toBeGreaterThanOrEqual(0);
    expect(canonical).toBeLessThan(locale);
    expect(locale).toBeLessThan(plural);
  });

  it('carries locale data for every language the app can render', () => {
    const polyfills = readFileSync(join(__dirname, '..', 'polyfills.ts'), 'utf8');
    // A missing locale file is the quiet version of this bug: plurals work in
    // English and fall back to `other` everywhere else.
    for (const locale of ['en', 'ar', 'he']) {
      expect(polyfills).toContain(`intl-pluralrules/locale-data/${locale}`);
    }
  });
});
