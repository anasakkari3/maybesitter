import { describe, expect, it } from '@jest/globals';
import { tFor } from '../index';

// The point of the typed-resources declaration in i18next.d.ts: a key that does
// not exist must fail `tsc --noEmit`, not quietly render its own name at run
// time. If the declaration is lost, the @ts-expect-error below stops matching
// an error and TypeScript fails the build with "Unused '@ts-expect-error'".
describe('typed keys', () => {
  const t = tFor('en');

  it('resolves a key that exists', () => {
    expect(t('confirmNone')).toBe('Nothing to confirm');
    expect(t('reviewTitle')).toBe('Review');
  });

  it('rejects a key that does not exist', () => {
    // @ts-expect-error notAKeyInTheLocaleFiles is not in locales/en.json
    expect(typeof t('notAKeyInTheLocaleFiles')).toBe('string');
  });
});
