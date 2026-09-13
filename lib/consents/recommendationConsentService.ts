/**
 * Whether this account wants a suggested next step (UC-2.9, #170).
 *
 * The rules live in `lib/consents/consentService`, shared with UC-2.1 (#161)'s
 * AI consent and parametrised by `RECOMMENDATION_CONSENT`. This file is the
 * named seam, for the same reason `aiConsentService` is one: the access check
 * in `lib/recommendation/launchAccess` should import a function whose name says
 * which question it is asking, not pass a contract object around.
 *
 * ── Not the same thing as the pilot trust flag ───────────────────
 *
 * `PilotTrustState.recommendationConsent` already exists and already means
 * something adjacent. It stays where it is and keeps meaning what it meant:
 * it is the *closed pilot's* admission control, reached only behind
 * `pilotModeEnabled()`. This is the launch consent, asked of everybody, stored
 * beside the AI answer, and versioned against the words the user was actually
 * shown. Reading one where the other was meant is the mistake worth naming, so
 * they are deliberately not merged and deliberately not made to shadow each
 * other.
 *
 * ── Not the same thing as AI consent either ──────────────────────
 *
 * Nothing on this path reaches a model. Granting this permits MaybeSitter to
 * choose what to put in front of you using your own data and first-party
 * rules; it permits nothing to be sent anywhere. A user may reasonably want
 * either consent without the other, and neither may be inferred from the other.
 */
import {
  RECOMMENDATION_CONSENT,
  RECOMMENDATION_CONSENT_VERSION,
  type ConsentRecord,
  type ConsentState,
} from '../../src/contracts/v1/consentContracts';
import {
  consentViewFor,
  getConsent,
  readConsent,
  setConsent,
  type ConsentOptions,
  type ConsentView,
  type SetConsentInput,
} from './consentService';

export async function readRecommendationConsent(
  uid: string,
  options: ConsentOptions = {},
): Promise<ConsentRecord | null> {
  return readConsent(RECOMMENDATION_CONSENT, uid, options);
}

/**
 * Granted, or declined. A fresh account has never been asked, so it is
 * declined, and the card does not appear.
 */
export async function getRecommendationConsent(
  uid: string,
  options: ConsentOptions = {},
): Promise<ConsentState> {
  return getConsent(RECOMMENDATION_CONSENT, uid, options);
}

export async function setRecommendationConsent(
  uid: string,
  input: SetConsentInput,
  options: ConsentOptions = {},
): Promise<ConsentRecord> {
  return setConsent(RECOMMENDATION_CONSENT, uid, input, options);
}

export async function recommendationConsentView(
  uid: string,
  options: ConsentOptions = {},
): Promise<ConsentView> {
  return consentViewFor(RECOMMENDATION_CONSENT, uid, options);
}

export { RECOMMENDATION_CONSENT_VERSION };
