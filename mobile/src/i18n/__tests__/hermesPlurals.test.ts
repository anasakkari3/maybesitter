import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import type { tFor as TFor } from '../index';

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
    expect(tFor('ar')('lockedTitle', { n: 2 })).toBe('اليوم، شيئان');
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
});
