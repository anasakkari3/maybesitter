/**
 * The two switches share intake is behind (UC-3.0, #183 step 10).
 *
 * `releaseGuard.test.ts` covers the half that refuses to *build* a binary which
 * sets them wrongly. This covers the half that runs on the phone, and the thing
 * worth asserting about both is the same: they are off unless they are exactly
 * on. A flag that reads `1`, `yes` or `TRUE` as true is a flag that turns a
 * feature on by typo — and one of these two writes the user's shared text into
 * the device log.
 */
import { afterEach, describe, expect, it } from '@jest/globals';
import { shareIntakeEnabled, shareIntentDebugEnabled } from '../env';

const KEYS = ['EXPO_PUBLIC_FEATURE_SHARE_INTAKE', 'EXPO_PUBLIC_SHARE_INTENT_DEBUG', 'EXPO_PUBLIC_APP_ENV'] as const;
const original: Record<string, string | undefined> = {};
for (const key of KEYS) original[key] = process.env[key];

afterEach(() => {
  for (const key of KEYS) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

describe('shareIntakeEnabled', () => {
  it('is off when nothing is set', () => {
    delete process.env.EXPO_PUBLIC_FEATURE_SHARE_INTAKE;
    expect(shareIntakeEnabled()).toBe(false);
  });

  it('is on only for the literal string true', () => {
    for (const [value, expected] of [
      ['true', true],
      [' true ', true],
      ['false', false],
      ['1', false],
      ['yes', false],
      ['TRUE', false],
      ['', false],
    ] as const) {
      process.env.EXPO_PUBLIC_FEATURE_SHARE_INTAKE = value;
      expect({ value, on: shareIntakeEnabled() }).toEqual({ value, on: expected });
    }
  });
});

describe('shareIntentDebugEnabled', () => {
  it('needs a development bundle, a development environment and the variable', () => {
    process.env.EXPO_PUBLIC_APP_ENV = 'development';
    process.env.EXPO_PUBLIC_SHARE_INTENT_DEBUG = 'true';
    expect(shareIntentDebugEnabled(true)).toBe(true);
    // A release bundle is enough on its own to refuse it.
    expect(shareIntentDebugEnabled(false)).toBe(false);
  });

  it('is off in staging and production even in a development bundle', () => {
    process.env.EXPO_PUBLIC_SHARE_INTENT_DEBUG = 'true';
    for (const appEnv of ['staging', 'production']) {
      process.env.EXPO_PUBLIC_APP_ENV = appEnv;
      expect({ appEnv, on: shareIntentDebugEnabled(true) }).toEqual({ appEnv, on: false });
    }
  });

  it('is off without the variable, whatever else is true', () => {
    process.env.EXPO_PUBLIC_APP_ENV = 'development';
    delete process.env.EXPO_PUBLIC_SHARE_INTENT_DEBUG;
    expect(shareIntentDebugEnabled(true)).toBe(false);
    process.env.EXPO_PUBLIC_SHARE_INTENT_DEBUG = '1';
    expect(shareIntentDebugEnabled(true)).toBe(false);
  });
});
