import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import type { tFor as TFor } from '../index';
import en from '../locales/en.json';
import ar from '../locales/ar.json';
import he from '../locales/he.json';

// Hermes, the engine the app runs on, has no Intl.PluralRules and no
// Intl.Locale (docs: facebook/hermes doc/IntlAPIs.md). Without them
// intl-messageformat throws on every `{n, plural, …}` and i18next-icu's default
// error handler returns the raw message, so the Today card showed
// "Today, {n, plural, one{# thing} …}" on device while Node, which has full
// Intl, kept plurals.test.ts green. This suite removes both constructors before
// the i18n module loads, the way the app actually starts.

type MutableIntl = { PluralRules?: unknown; Locale?: unknown };
const intl = Intl as unknown as MutableIntl;
const saved = { PluralRules: intl.PluralRules, Locale: intl.Locale };

let tFor: typeof TFor;

beforeAll(() => {
  delete intl.PluralRules;
  delete intl.Locale;
  jest.isolateModules(() => {
    // isolateModules needs a synchronous require for a fresh module registry;
    // `await import()` is a native dynamic import here and Jest rejects it
    // without --experimental-vm-modules.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ({ tFor } = require('../index') as { tFor: typeof TFor });
  });
});

afterAll(() => {
  intl.PluralRules = saved.PluralRules;
  intl.Locale = saved.Locale;
});

describe('count messages on an engine without Intl.PluralRules (Hermes)', () => {
  it('formats the English Today card instead of showing the ICU source', () => {
    const en = tFor('en');
    expect(en('lockedTitle', { n: 3 })).toBe('Today, 3 things');
    expect(en('lockedTitle', { n: 1 })).toBe('Today, 1 thing');
    expect(en('progressWords', { d: 1, n: 3 })).toBe('1 of 3 done');
  });

  it('keeps the Arabic dual and the Hebrew two-form', () => {
    expect(tFor('ar')('lockedTitle', { n: 2 })).toBe('اليوم، إشيين');
    expect(tFor('ar')('confirmN', { n: 11 })).toBe('أكّد 11 التزامًا');
    expect(tFor('he')('confirmN', { n: 2 })).toBe('אישור שתי התחייבויות');
  });

  it('never leaks the ICU syntax', () => {
    for (const locale of ['en', 'ar', 'he'] as const) {
      const t = tFor(locale);
      for (const n of [0, 1, 2, 3, 11]) {
        expect(t('lockedTitle', { n })).not.toMatch(/plural|[{}]/);
        expect(t('confirmN', { n })).not.toMatch(/plural|[{}]/);
        expect(t('progressWords', { d: Math.min(n, 3), n: 3 })).not.toMatch(/plural|[{}]/);
      }
    }
  });

  /**
   * The same assertion over every plural message there is, found rather than
   * listed.
   *
   * The three keys above are the ones somebody thought to name when this
   * defect was fixed. `planRegenerateLeft` (#195) arrived afterwards, is an
   * ICU plural in all three locales, and was covered by nothing — which is
   * exactly how the original escaped to a device while Node kept the suite
   * green. A sweep cannot be added to and forgotten.
   */
  it('formats every plural message this app ships, in every locale', () => {
    const bundles = { en, ar, he };
    const checked: string[] = [];
    for (const locale of ['en', 'ar', 'he'] as const) {
      // The key is discovered at runtime, so it cannot be one of the literal
      // types `t` is overloaded on; the cast is about the key, not the result.
      const t = tFor(locale) as unknown as (key: string, values: Record<string, number>) => string;
      for (const [key, value] of Object.entries(bundles[locale] as Record<string, unknown>)) {
        if (typeof value !== 'string' || !/\{\s*\w+\s*,\s*plural\s*,/.test(value)) continue;
        // Every `{name}` and `{name, plural, …}` the message reads, each given
        // a number: a missing variable is its own kind of leak.
        const args = Object.fromEntries(
          [...value.matchAll(/\{\s*(\w+)/g)].map(match => [match[1] as string, 1]),
        );
        checked.push(`${locale}.${key}`);
        for (const n of [0, 1, 2, 3, 11]) {
          const rendered = t(key, { ...args, n, d: Math.min(n, 3) });
          expect({ key: `${locale}.${key}`, n, leaks: /plural|[{}]/.test(rendered) })
            .toEqual({ key: `${locale}.${key}`, n, leaks: false });
        }
      }
    }
    // A bundle that stopped being readable would otherwise pass vacuously.
    expect(checked).toContain('ar.planRegenerateLeft');
    // The Today card's count (#195 step 4), which is a plural in all three and
    // would render as its own ICU source on a device if the sweep missed it.
    expect(checked).toContain('ar.planCardPlaced');
    expect(checked).toContain('he.planCardPlaced');
    expect(checked.length).toBeGreaterThanOrEqual(15);
  });
});
