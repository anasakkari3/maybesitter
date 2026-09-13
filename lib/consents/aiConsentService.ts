/**
 * Whether this account has agreed to AI processing (UC-2.1, #161).
 *
 * ── Where the rules actually live ────────────────────────────────
 *
 * They moved to `lib/consents/consentService` when UC-2.9 (#170) added the
 * second question. "Missing means declined", "an unknown version is refused
 * rather than upgraded", "never cached", and "every change is audited" are now
 * one implementation both consents share, parametrised by
 * `AI_PROCESSING_CONSENT`. Read that file for the reasoning.
 *
 * The behaviour here is unchanged, and that is checkable rather than claimed:
 * `tests/consents/aiConsent.test.ts` was not touched by the move, including
 * the two enforcement-layer tests and the revocation-with-no-cache one.
 *
 * ── Why this file still exists ───────────────────────────────────
 *
 * `getAiConsent` is the enforcement seam. `lib/llm/consentGatedProvider`,
 * `lib/llm/captureProvider` and `lib/services/mobile/mobileCaptureService`
 * each take it as an injectable default, and one named function that means
 * "may this account's words be sent to a model" is worth keeping as one
 * importable thing — the alternative is three call sites each remembering to
 * pass the right `ConsentKindContract`, and one of them eventually passing
 * the recommendation one.
 */
import {
  AI_CONSENT_VERSION,
  AI_PROCESSING_CONSENT,
  type AiConsentRecord,
  type AiConsentState,
} from '../../src/contracts/v1/consentContracts';
import {
  UnsupportedConsentVersionError,
  consentViewFor,
  getConsent,
  readConsent,
  setConsent,
  type ConsentOptions,
  type SetConsentInput,
} from './consentService';

export { UnsupportedConsentVersionError };
export type AiConsentOptions = ConsentOptions;
export type SetAiConsentInput = SetConsentInput;

/** The stored record, or null when there has never been one. */
export async function readAiConsent(
  uid: string,
  options: AiConsentOptions = {},
): Promise<AiConsentRecord | null> {
  return readConsent(AI_PROCESSING_CONSENT, uid, options);
}

/** Granted, or declined. There is no third answer and no default-on. */
export async function getAiConsent(uid: string, options: AiConsentOptions = {}): Promise<AiConsentState> {
  return getConsent(AI_PROCESSING_CONSENT, uid, options);
}

/** Records an answer, and the fact that it was given. */
export async function setAiConsent(
  uid: string,
  input: SetAiConsentInput,
  options: AiConsentOptions = {},
): Promise<AiConsentRecord> {
  return setConsent(AI_PROCESSING_CONSENT, uid, input, options);
}

/**
 * The AI half of `GET /api/mobile/consents`.
 *
 * Kept for the callers that only care about this one question. The route
 * itself answers with `allConsentsView`, which includes both.
 */
export async function aiConsentView(uid: string, options: AiConsentOptions = {}): Promise<{
  aiProcessing: AiConsentRecord & { asked: boolean };
  currentVersion: string;
}> {
  return {
    aiProcessing: await consentViewFor(AI_PROCESSING_CONSENT, uid, options),
    currentVersion: AI_CONSENT_VERSION,
  };
}
