/**
 * A refused AI call, from the status code to the sentence (UC-4.5, #181).
 *
 * The four lines this is about — a spent daily quota, a minute's rate limit, a
 * busy service, text too long for one call — were written in all three locales
 * and mapped in `userFacingMessage`, and no user could ever be shown one. The
 * composer classified anything that was neither a 400 nor retryable as
 * "extraction", `isRetryable` excludes 429 and 413, and the screen rendered one
 * of three strings it chose itself. So hitting the daily cap said "something
 * went wrong" — in Arabic, in English, and in Hebrew.
 *
 * That is four separate joints, and a test of any one of them passes while the
 * chain is broken. This walks the whole chain instead: HTTP status → typed
 * error → locale key → the words in each locale → the recovery the composer
 * offers. `captureFlowReachable.test.tsx` then renders it on the real screen.
 *
 * ── All three languages ──────────────────────────────────────────
 *
 * Hebrew used to be uncheckable here: `Lang` was 'ar' | 'en' and
 * `resolveLanguage` fell back to English, so nothing could drive a render into
 * it. #355 made `he` selectable, so the loop below covers every locale the app
 * offers rather than the two it used to. `LOCALES` is the source of that list —
 * a hand-written pair would go stale again the next time one is added.
 */
import { describe, expect, it } from '@jest/globals';
import { z } from 'zod';
import { apiRequest } from '../client';
import { resetAuthForTests, setAuthRepository } from '../auth';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';
import {
  InputTooLargeError,
  NetworkError,
  QuotaExceededError,
  ValidationError,
  isRetryable,
  type QuotaScope,
} from '../errors';
import { userFacingMessage, userFacingMessageKey, type UserFacingKey } from '../ui/userFacingMessage';
import { classifyFailure } from '../../features/capture/CaptureProvider';
import { strings, type Strings } from '../../i18n/strings';
import { LOCALES } from '../../i18n/locale';
import ar from '../../i18n/locales/ar.json';
import en from '../../i18n/locales/en.json';
import he from '../../i18n/locales/he.json';

const okSchema = z.object({ ok: z.boolean() });

function respondWith(status: number, body: unknown): void {
  (globalThis as { fetch: unknown }).fetch = async () => ({
    status,
    text: async () => JSON.stringify(body),
  });
}

async function refusal(status: number, body: unknown): Promise<unknown> {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://localhost:3000';
  setAuthRepository(createFakeAuthRepository({
    initialUser: { uid: 'u1', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'] },
    idToken: 'token-1',
  }));
  respondWith(status, body);
  try {
    await apiRequest('POST', '/api/mobile/capture', { schema: okSchema, body: { text: 'x' } });
    throw new Error('the call should have been refused');
  } catch (error) {
    return error;
  } finally {
    resetAuthForTests();
  }
}

/** Every refusal the AI path can produce, and the line each one is. */
const REFUSALS: [string, number, Record<string, unknown>, UserFacingKey][] = [
  ['the account is out for today', 429, { reason: 'quota_exceeded', scope: 'user_daily', retryAfterSeconds: 3600 }, 'aiQuotaUserDaily'],
  ['too many in one minute', 429, { reason: 'quota_exceeded', scope: 'user_minute', retryAfterSeconds: 30 }, 'aiQuotaTryLater'],
  ['everyone is out for today', 429, { reason: 'quota_exceeded', scope: 'global_daily', retryAfterSeconds: 7200 }, 'aiServiceUnavailable'],
  ['the text is too long', 413, { reason: 'input_too_large', maxCharacters: 20000 }, 'aiInputTooLong'],
];

describe('a refused AI call becomes a typed error', () => {
  it.each(REFUSALS)('%s', async (_name, status, body, _key) => {
    const error = await refusal(status, body);
    expect(error).toBeInstanceOf(status === 413 ? InputTooLargeError : QuotaExceededError);
  });

  it('carries the scope the server named, and how long to wait', async () => {
    const error = await refusal(429, { scope: 'user_minute', retryAfterSeconds: 30 }) as QuotaExceededError;
    expect(error.scope).toBe('user_minute');
    expect(error.retryAfterSeconds).toBe(30);
  });

  it('is never retried automatically', () => {
    // The one 4xx that would succeed later, which is exactly why nothing may
    // retry it for the user: that is the loop the quota exists to stop.
    for (const scope of ['user_daily', 'user_minute', 'global_daily'] as QuotaScope[]) {
      expect(isRetryable(new QuotaExceededError(scope, 60))).toBe(false);
    }
    expect(isRetryable(new InputTooLargeError(20_000))).toBe(false);
  });
});

describe('each refusal has its own line', () => {
  const errorFor = (status: number, body: Record<string, unknown>): unknown => (status === 413
    ? new InputTooLargeError(body.maxCharacters as number)
    : new QuotaExceededError(body.scope as QuotaScope, body.retryAfterSeconds as number));

  it.each(REFUSALS)('%s maps to its own key', (_name, status, body, key) => {
    expect(userFacingMessageKey(errorFor(status, body))).toBe(key);
  });

  it.each(REFUSALS)('%s reads in the user’s own language', (_name, status, body, key) => {
    const error = errorFor(status, body);
    for (const lang of LOCALES) {
      const rendered = userFacingMessage(error, strings[lang]);
      expect(rendered).toBe(strings[lang][key]);
      // The bug this file exists for: all four came out as this one line.
      expect(rendered).not.toBe(strings[lang].errorsGeneric);
    }
  });

  it.each(REFUSALS)('%s has Hebrew copy, and maps to it', (_name, status, body, key) => {
    // Hebrew is not selectable yet (see the header), so this is the mapping
    // against the Hebrew bundle and not a render. The bundle is asserted to be
    // real text rather than an English fallback that happens to be present.
    const bundle = he as unknown as Record<string, string>;
    expect(typeof bundle[key]).toBe('string');
    expect(bundle[key]!.trim().length).toBeGreaterThan(0);
    expect(bundle[key]).toMatch(/[֐-׿]/);
    expect(userFacingMessage(errorFor(status, body), he as unknown as Strings)).toBe(bundle[key]);
  });

  it('says something different in each locale', () => {
    // Three distinct sentences, not one string copied across the files.
    for (const [, , , key] of REFUSALS) {
      const rendered = [en, ar, he].map(bundle => (bundle as unknown as Record<string, string>)[key]);
      expect(new Set(rendered).size).toBe(3);
    }
  });

  it('puts no developer word on the screen, in any locale', () => {
    const banned = /(Error:|Exception|backend|https?:|\bat \w+\.\w+|stack|undefined|null|429|413)/i;
    for (const [, , , key] of REFUSALS) {
      for (const [locale, bundle] of [['en', en], ['ar', ar], ['he', he]] as const) {
        const rendered = String((bundle as unknown as Record<string, string>)[key]);
        expect({ locale, key, offends: banned.test(rendered) }).toEqual({ locale, key, offends: false });
      }
    }
  });
});

describe('the composer knows what to do with one', () => {
  /**
   * The joint that was actually broken. `classifyFailure` is what the provider
   * dispatches, and before #181 it answered `extraction` with no key at all, so
   * the screen fell through to "something went wrong" and offered a Retry
   * against a spent quota.
   */
  it.each(REFUSALS)('%s is a refusal, with its own line', (_name, status, body, key) => {
    const error = status === 413
      ? new InputTooLargeError(body.maxCharacters as number)
      : new QuotaExceededError(body.scope as QuotaScope, body.retryAfterSeconds as number);
    expect(classifyFailure(error)).toEqual({ kind: 'refused', messageKey: key });
  });

  it('still tells the other failures apart', () => {
    // The new branch must not swallow the three that already worked.
    expect(classifyFailure(new NetworkError('offline')).kind).toBe('network');
    expect(classifyFailure(new ValidationError('bad')).kind).toBe('validation');
    expect(classifyFailure(new Error('boom')).kind).toBe('extraction');
  });
});
