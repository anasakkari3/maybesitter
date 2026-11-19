/**
 * Recording the onboarding answers (UC-2.R1 #171).
 *
 * Two now: the recommendation question and analytics. AI processing is no
 * longer a question (owner decision 2026-09-30) — the screen discloses it and
 * nothing is recorded for it, because the server reads it as granted anyway
 * and recording agreement to the old words ("changeable in settings") would
 * be recording something nobody was shown.
 *
 * Pulled out of the screen deliberately. What matters here is a *sequence* with
 * an all-or-nothing report — every write, and the caller may only advance when
 * every one of them landed — and that rule deserves to be readable, and
 * testable, without a React tree in the way.
 *
 * ── Why a partial success is reported as a failure ───────────────
 *
 * Consider somebody who allows suggestions and declines analytics, and whose
 * analytics write fails. One of their answers is on the server and one is not.
 * Telling them "saved" would be a lie about their privacy settings; telling
 * them "nothing was changed" is not literally true either, but it is the one
 * that leads to the right action — press Retry — and it is safe, because every
 * write here is a whole-value `PUT` and re-sending them all is idempotent.
 *
 * ── The completion event is not sent from here ───────────────────
 *
 * `onboarding_completed` used to fire from this function, i.e. when the
 * consent step saved — three steps before onboarding ends (QA CA1.1). It is
 * now sent by `OnboardingFlow` when the last step finishes.
 */
import type { ConsentLocale, ConsentPlatformName } from './consentTypes';

export interface ConsentAnswers {
  /**
   * `null` means the switch was never touched on this run.
   *
   * It is recorded as a decline, which is what an untouched switch has always
   * meant — but it has to arrive here still distinguishable from a deliberate
   * `false`, because the screen's seeding rule treats the two differently and
   * collapsing them early is what let a refetch reinstate a withdrawn grant.
   */
  recommendations: boolean | null;
  analytics: boolean;
}

export interface ConsentVersions {
  recommendations: string;
}

export interface RecordConsentsDeps {
  setRecommendationConsent: (input: { state: 'granted' | 'declined'; version: string; locale: ConsentLocale; platform: ConsentPlatformName }) => Promise<unknown>;
  setAnalyticsConsent: (granted: boolean) => Promise<unknown>;
}

export type RecordConsentsResult =
  | { ok: true }
  /** `at` names which write did not land, for a log — never for the user. */
  | { ok: false; at: 'versions' | 'recommendations' | 'analytics' };

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
    await deps.setRecommendationConsent({
      // Untouched and off are both recorded as a decline. Nothing else could
      // be honest: a consent nobody gave is not a consent.
      state: answers.recommendations === true ? 'granted' : 'declined',
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

  return { ok: true };
}
