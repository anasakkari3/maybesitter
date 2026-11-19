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
import disabled from '../../../api/__fixtures__/icsFeeds.disabled.json';

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
    // A server without ICS_FEEDS_ENABLED, as recorded from the real handler.
    [404, disabled, 'feature_disabled', 'icsFeedsUnavailable'],
    [422, { success: false, error: 'not_a_calendar', reason: 'not_a_calendar' }, 'not_a_calendar', 'icsFeedsErrNotCalendar'],
    // QA v3 V3-F19-01: a site that refused, one that did not answer and one
    // that could not be reached are three different sentences. Only a site
    // that did not answer leaves the link out of it: `network` is also a host
    // typed wrong (DNS), and `http_status` is also a wrong or expired link.
    [422, { success: false, error: 'fetch_failed', reason: 'fetch_failed', detail: 'http_status' }, 'fetch_failed', 'icsFeedsErrSiteRefused'],
    [422, { success: false, error: 'fetch_failed', reason: 'fetch_failed', detail: 'timeout' }, 'fetch_failed', 'icsFeedsErrNoAnswer'],
    [422, { success: false, error: 'fetch_failed', reason: 'fetch_failed', detail: 'network' }, 'fetch_failed', 'icsFeedsErrUnreachable'],
    [422, { success: false, error: 'fetch_failed', reason: 'fetch_failed', detail: 'too_large' }, 'fetch_failed', 'icsFeedsErrFetch'],
    [422, { success: false, error: 'fetch_failed', reason: 'fetch_failed' }, 'fetch_failed', 'icsFeedsErrFetch'],
    [409, { success: false, error: 'too_many_feeds', reason: 'too_many_feeds' }, 'too_many_feeds', 'icsFeedsErrTooMany'],
    [503, { success: false, error: 'encryption_unavailable', reason: 'encryption_unavailable' }, 'encryption_unavailable', 'icsFeedsErrUnavailable'],
  ];
  it.each(CASES)('%i %s becomes its own sentence in every language', async (status, body, reason, key) => {
    const error = await refusal(status, body);
    expect(error).toBeInstanceOf(IcsFeedRefusedError);
    expect((error as IcsFeedRefusedError).reason).toBe(reason);
    for (const lang of ['ar', 'en', 'he'] as const) {
      expect(typeof strings[lang][key]).toBe('string');
      expect(userFacingMessage(error, strings[lang])).toBe(strings[lang][key]);
    }
  });

  // The words themselves, not only the key: a key pointing at the old
  // «check the link» sentence passes every mapping test above.
  const WORDS: Record<'icsFeedsErrSiteRefused' | 'icsFeedsErrNoAnswer' | 'icsFeedsErrUnreachable', Record<'ar' | 'en' | 'he', string>> = {
    icsFeedsErrSiteRefused: {
      ar: 'موقع التقويم ما رضي يعطينا التقويم. تأكّد إنك نسخت رابط التصدير (بجوجل: العنوان العام أو السرّي بصيغة iCal)، وإنه التقويم مشارك. إذا الرابط صح، جرّب كمان شوي.',
      en: "The calendar's site wouldn't give us the calendar. Check you copied the export link (for Google, the public or secret iCal address) and that the calendar is shared. If it's right, try again in a bit.",
      he: 'האתר של היומן לא הסכים לתת לנו את היומן. כדאי לוודא שהעתקת את קישור הייצוא (בגוגל: הכתובת הציבורית או הסודית בפורמט iCal) ושהיומן משותף. אם הקישור נכון, אפשר לנסות שוב עוד מעט.',
    },
    icsFeedsErrNoAnswer: {
      ar: 'موقع التقويم ما ردّ علينا. جرّب كمان شوي.',
      en: "The calendar's website didn't answer. Try again in a bit.",
      he: 'האתר של היומן לא ענה. אפשר לנסות שוב עוד מעט.',
    },
    icsFeedsErrUnreachable: {
      ar: 'ما قدرنا نوصل لموقع التقويم. تأكّد من الرابط، وإذا هو صح جرّب كمان شوي.',
      en: "We couldn't reach the calendar's site. Check the link, and if it's right, try again in a bit.",
      he: 'לא הצלחנו להגיע לאתר של היומן. כדאי לבדוק את הקישור, ואם הוא נכון, לנסות שוב עוד מעט.',
    },
  };
  it.each(Object.keys(WORDS) as (keyof typeof WORDS)[])('%s says what it should in every language', (key) => {
    for (const lang of ['ar', 'en', 'he'] as const) expect(strings[lang][key]).toBe(WORDS[key][lang]);
  });

  it('a site that did not answer never blames the link, and the other two still ask to check it', () => {
    expect(strings.ar.icsFeedsErrNoAnswer).not.toMatch(/الرابط/);
    expect(strings.en.icsFeedsErrNoAnswer).not.toMatch(/link/i);
    expect(strings.he.icsFeedsErrNoAnswer).not.toMatch(/קישור/);
    for (const key of ['icsFeedsErrSiteRefused', 'icsFeedsErrUnreachable'] as const) {
      expect(strings.ar[key]).toMatch(/الرابط/);
      expect(strings.en[key]).toMatch(/link/i);
      expect(strings.he[key]).toMatch(/קישור/);
    }
  });

  it('does not claim another route\'s refusal whose error is a sentence, not a feed code', async () => {
    const quota = await refusal(429, { success: false, error: 'Daily limit reached', reason: 'quota_exceeded', scope: 'user_daily' });
    expect(quota).toBeInstanceOf(QuotaExceededError);
    const disabled = await refusal(403, { success: false, error: 'This feature is off', reason: 'feature_disabled' });
    expect(disabled).toBeInstanceOf(ForbiddenError);
  });
});
