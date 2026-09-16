/**
 * A calendar feed refusal, from the status code to the sentence (UC-3.4, #188).
 *
 * The feed routes answer with their own reason at 400, 404, 409, 422, 429 and
 * 503. The generic classes for those statuses keep no reason — a 422 becomes a
 * plan-edit refusal, a 429 a model quota — so without the branch in
 * `errorForStatus`, "that link is not a calendar" and "that link cannot be
 * opened" would both read "something went wrong". This walks the whole chain
 * with the real recorded bodies: HTTP status → typed error → locale key → the
 * words in ar, en and he.
 */
import { afterEach, describe, expect, it } from '@jest/globals';
import { z } from 'zod';
import { apiRequest } from '../../../api/client';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { ForbiddenError, IcsFeedRefusedError, QuotaExceededError } from '../../../api/errors';
import { userFacingMessage, type UserFacingKey } from '../../../api/ui/userFacingMessage';
import { strings } from '../../../i18n/strings';
import invalidUrl from '../../../api/__fixtures__/icsFeeds.invalidUrl.json';
import refreshTooSoon from '../../../api/__fixtures__/icsFeeds.refreshTooSoon.json';

const okSchema = z.object({ ok: z.boolean() });

async function refusal(status: number, body: unknown): Promise<unknown> {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://localhost:3000';
  (globalThis as { fetch: unknown }).fetch = async () => ({ status, text: async () => JSON.stringify(body) });
  setAuthRepository(createFakeAuthRepository({
    initialUser: { uid: 'u1', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'] },
    idToken: 'token-1',
  }));
  try {
    await apiRequest('GET', '/api/mobile/calendar/ics', { schema: okSchema });
  } catch (error) {
    return error;
  }
  throw new Error('expected a refusal');
}

afterEach(() => resetAuthForTests());

describe('feed refusals keep their reason', () => {
  const CASES: [number, unknown, IcsFeedRefusedError['reason'], UserFacingKey][] = [
    [400, invalidUrl, 'invalid_url', 'icsFeedsErrInvalidUrl'],
    [429, refreshTooSoon, 'refresh_too_soon', 'icsFeedsErrTooSoon'],
    [422, { success: false, error: 'not_a_calendar', reason: 'not_a_calendar' }, 'not_a_calendar', 'icsFeedsErrNotCalendar'],
    [422, { success: false, error: 'fetch_failed', reason: 'fetch_failed', detail: 'timeout' }, 'fetch_failed', 'icsFeedsErrFetch'],
    [409, { success: false, error: 'too_many_feeds', reason: 'too_many_feeds' }, 'too_many_feeds', 'icsFeedsErrTooMany'],
    [503, { success: false, error: 'encryption_unavailable', reason: 'encryption_unavailable' }, 'encryption_unavailable', 'icsFeedsErrUnavailable'],
  ];
  it.each(CASES)('%i %s becomes its own sentence in every language', async (status, body, reason, key) => {
    const error = await refusal(status, body);
    expect(error).toBeInstanceOf(IcsFeedRefusedError);
    expect((error as IcsFeedRefusedError).reason).toBe(reason);
    for (const lang of ['ar', 'en', 'he'] as const) {
      expect(userFacingMessage(error, strings[lang])).toBe(strings[lang][key]);
    }
  });

  it('does not claim another route\'s refusal whose error is a sentence, not a feed code', async () => {
    const quota = await refusal(429, { success: false, error: 'Daily limit reached', reason: 'quota_exceeded', scope: 'user_daily' });
    expect(quota).toBeInstanceOf(QuotaExceededError);
    const disabled = await refusal(403, { success: false, error: 'This feature is off', reason: 'feature_disabled' });
    expect(disabled).toBeInstanceOf(ForbiddenError);
  });
});
