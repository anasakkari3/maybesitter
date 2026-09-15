/**
 * The three onboarding writes, and what happens when one does not land
 * (UC-2.R1 #171, UC-2.1 #161, UC-2.9 #170).
 *
 * The partial success is the case worth the file: two answers on the server
 * and one not is the state a user must never be told is "saved", because what
 * they would believe about their own privacy settings would be wrong.
 */
import { describe, expect, it, jest } from '@jest/globals';
import { recordConsents, type ConsentAnswers, type RecordConsentsDeps } from '../recordConsents';

const VERSIONS = { aiProcessing: 'ai-consent-v1', recommendations: 'rec-consent-v1' };
const CONTEXT = { locale: 'ar' as const, platform: 'ios' as const };

function deps(overrides: Partial<RecordConsentsDeps> = {}) {
  return {
    setAiConsent: jest.fn(async () => ({}) as unknown),
    setRecommendationConsent: jest.fn(async () => ({})),
    setAnalyticsConsent: jest.fn(async () => ({})),
    reportCompleted: jest.fn(),
    ...overrides,
  } as unknown as RecordConsentsDeps & {
    setAiConsent: jest.Mock; setRecommendationConsent: jest.Mock;
    setAnalyticsConsent: jest.Mock; reportCompleted: jest.Mock;
  };
}

const ALLOW_ALL: ConsentAnswers = { ai: 'granted', recommendations: true, analytics: true };

describe('when every write lands', () => {
  it('sends each answer with the version the server said it recognises', async () => {
    const d = deps();
    expect(await recordConsents(ALLOW_ALL, VERSIONS, CONTEXT, d)).toEqual({ ok: true });
    expect(d.setAiConsent).toHaveBeenCalledWith({
      state: 'granted', version: 'ai-consent-v1', locale: 'ar', platform: 'ios',
    });
    expect(d.setRecommendationConsent).toHaveBeenCalledWith({
      state: 'granted', version: 'rec-consent-v1', locale: 'ar', platform: 'ios',
    });
    expect(d.setAnalyticsConsent).toHaveBeenCalledWith(true);
  });

  it('records a decline as a decline, not as an absent answer', async () => {
    const d = deps();
    await recordConsents({ ai: 'declined', recommendations: false, analytics: false }, VERSIONS, CONTEXT, d);
    expect(d.setAiConsent.mock.calls[0]![0]).toMatchObject({ state: 'declined' });
    expect(d.setRecommendationConsent.mock.calls[0]![0]).toMatchObject({ state: 'declined' });
    expect(d.setAnalyticsConsent).toHaveBeenCalledWith(false);
  });

  it('records an untouched switch as a decline, not as a grant', async () => {
    // `null` is the third state the screen needs and the server does not have:
    // nobody has answered this run. It has always meant "no", and this is the
    // one place that is decided — the screen keeps the distinction only so a
    // refetch cannot mistake a deliberate decline for an untouched default.
    const d = deps();
    expect(await recordConsents(
      { ai: 'granted', recommendations: null, analytics: false }, VERSIONS, CONTEXT, d,
    )).toEqual({ ok: true });
    expect(d.setRecommendationConsent.mock.calls[0]![0]).toMatchObject({
      state: 'declined', version: 'rec-consent-v1',
    });
  });

  it('never sends one question’s version to the other', async () => {
    // A mix-up the server refuses outright, so it would surface as an
    // unexplained failure on the consent screen rather than as bad data.
    const d = deps();
    await recordConsents(ALLOW_ALL, VERSIONS, CONTEXT, d);
    expect((d.setAiConsent.mock.calls[0]![0] as { version: string }).version).toBe('ai-consent-v1');
    expect((d.setRecommendationConsent.mock.calls[0]![0] as { version: string }).version).toBe('rec-consent-v1');
  });
});

describe('when one write does not land', () => {
  it('reports a failure rather than a partial success', async () => {
    const d = deps({ setAnalyticsConsent: jest.fn(async () => { throw new Error('offline'); }) as never });
    expect(await recordConsents(ALLOW_ALL, VERSIONS, CONTEXT, d)).toEqual({ ok: false, at: 'analytics' });
  });

  it('stops at the first failure instead of sending the rest', async () => {
    const d = deps({ setAiConsent: jest.fn(async () => { throw new Error('offline'); }) as never });
    expect(await recordConsents(ALLOW_ALL, VERSIONS, CONTEXT, d)).toEqual({ ok: false, at: 'ai' });
    expect(d.setRecommendationConsent).not.toHaveBeenCalled();
    expect(d.setAnalyticsConsent).not.toHaveBeenCalled();
  });

  it('does not report the completion when the run failed', async () => {
    const d = deps({ setRecommendationConsent: jest.fn(async () => { throw new Error('offline'); }) as never });
    await recordConsents(ALLOW_ALL, VERSIONS, CONTEXT, d);
    expect(d.reportCompleted).not.toHaveBeenCalled();
  });
});

describe('when the server has not said which versions it knows', () => {
  it('refuses to guess one', async () => {
    // A guessed version is refused by the server, and a hard-coded one would
    // claim agreement to words this build cannot prove were shown.
    const d = deps();
    expect(await recordConsents(ALLOW_ALL, undefined, CONTEXT, d)).toEqual({ ok: false, at: 'versions' });
    expect(d.setAiConsent).not.toHaveBeenCalled();
  });
});

describe('the completion event', () => {
  it('fires only when analytics consent was granted', async () => {
    const granted = deps();
    await recordConsents(ALLOW_ALL, VERSIONS, CONTEXT, granted);
    expect(granted.reportCompleted).toHaveBeenCalledTimes(1);

    const declined = deps();
    await recordConsents({ ...ALLOW_ALL, analytics: false }, VERSIONS, CONTEXT, declined);
    expect(declined.reportCompleted).not.toHaveBeenCalled();
  });

  it('is fire-and-forget: a dropped ping does not fail the run', async () => {
    const d = deps({ reportCompleted: jest.fn(() => { throw new Error('dropped'); }) as never });
    // Every answer is already on the server by this point. A metrics ping that
    // falls over must not turn that into a "nothing was changed" retry.
    expect(await recordConsents(ALLOW_ALL, VERSIONS, CONTEXT, d)).toEqual({ ok: true });
  });
});
