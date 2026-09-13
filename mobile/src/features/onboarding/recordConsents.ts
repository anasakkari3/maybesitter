/**
 * Recording the three onboarding answers (UC-2.R1 #171).
 *
 * Pulled out of the screen deliberately. What matters here is a *sequence* with
 * an all-or-nothing report — three writes, and the caller may only advance when
 * every one of them landed — and that rule deserves to be readable, and
 * testable, without a React tree in the way.
 *
 * ── Why a partial success is reported as a failure ───────────────
 *
 * Consider somebody who allows AI and declines analytics, and whose analytics
 * write fails. Two of their three answers are on the server and one is not.
 * Telling them "saved" would be a lie about their privacy settings; telling
 * them "nothing was changed" is not literally true either, but it is the one
 * that leads to the right action — press Retry — and it is safe, because every
 * write here is a whole-value `PUT` and re-sending all three is idempotent.
 *
 * ── The analytics event obeys the answer it is reporting ─────────
 *
 * `onboarding_completed` fires only when analytics consent was granted, and
 * from the answer the user just gave rather than from a refetch that may not
 * have landed. It is also fire-and-forget: a dropped ping must not be able to
 * hold somebody on the consent screen.
 */
import type { ConsentLocale, ConsentPlatformName } from './consentTypes';

export interface ConsentAnswers {
  ai: 'granted' | 'declined';
  recommendations: boolean;
  analytics: boolean;
}

export interface ConsentVersions {
  aiProcessing: string;
  recommendations: string;
}

export interface RecordConsentsDeps {
  setAiConsent: (input: { state: 'granted' | 'declined'; version: string; locale: ConsentLocale; platform: ConsentPlatformName }) => Promise<unknown>;
  setRecommendationConsent: (input: { state: 'granted' | 'declined'; version: string; locale: ConsentLocale; platform: ConsentPlatformName }) => Promise<unknown>;
  setAnalyticsConsent: (granted: boolean) => Promise<unknown>;
  /** Fire-and-forget. Never awaited into the failure path. */
  reportCompleted: () => void;
}

export type RecordConsentsResult =
  | { ok: true }
  /** `at` names which write did not land, for a log — never for the user. */
  | { ok: false; at: 'versions' | 'ai' | 'recommendations' | 'analytics' };

export async function recordConsents(
  answers: ConsentAnswers,
  versions: ConsentVersions | undefined,
  context: { locale: ConsentLocale; platform: ConsentPlatformName },
  deps: RecordConsentsDeps,
): Promise<RecordConsentsResult> {
  // Without the versions the server recognises there is nothing honest to
  // record: a guessed one is refused, and a hard-coded one would claim
  // agreement to words this build cannot prove were shown.
  if (!versions) return { ok: false, at: 'versions' };

  try {
    await deps.setAiConsent({
      state: answers.ai, version: versions.aiProcessing, ...context,
    });
  } catch {
    return { ok: false, at: 'ai' };
  }

  try {
    await deps.setRecommendationConsent({
      state: answers.recommendations ? 'granted' : 'declined',
      version: versions.recommendations,
      ...context,
    });
  } catch {
    return { ok: false, at: 'recommendations' };
  }

  try {
    await deps.setAnalyticsConsent(answers.analytics);
  } catch {
    return { ok: false, at: 'analytics' };
  }

  if (answers.analytics) {
    // Genuinely fire-and-forget, including if it throws on the way out. Every
    // answer is already on the server by this point; turning a recorded set of
    // consents into a "nothing was changed" retry because a metrics ping fell
    // over would be the tail wagging the dog.
    try {
      deps.reportCompleted();
    } catch {
      // Nothing to do, and nothing the user could do either.
    }
  }
  return { ok: true };
}
