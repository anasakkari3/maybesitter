/**
 * What the user was actually asked, pinned (UC-2.1, #161).
 *
 * A consent is only meaningful as consent *to something*, so the version is
 * not a free-form string the client may invent — it names a specific set of
 * words. Changing those words without changing the version would mean holding
 * someone to an answer they never gave.
 *
 * The copy itself lives in the client. What lives here is the version, the
 * list of claims that version makes, and a digest of them, so that editing the
 * claims without bumping the version fails a test rather than shipping.
 */
import { createHash } from 'node:crypto';

export const AI_CONSENT_VERSION = 'ai-consent-v1';

/**
 * "Suggest one next step" (UC-2.9, #170).
 *
 * A separate question with a separate answer, and deliberately not a mode of
 * the AI one. They are different promises: the AI consent is about *sending
 * your sentences to Google*, this is about *MaybeSitter choosing what to put in
 * front of you*. Somebody can reasonably want either without the other, and
 * folding them together would mean inferring an answer to a question nobody
 * asked. Nothing here reaches a model — the next step is first-party and
 * deterministic, which is what the claims below say.
 */
export const RECOMMENDATION_CONSENT_VERSION = 'rec-consent-v1';

/**
 * "Notice patterns in when you finish things" (UC-3.16, #202).
 *
 * The phone's answer to the personalization question: whether MaybeSitter may
 * read the times the user finishes things, suggest a pattern it sees there as
 * something to remember, and let a pattern the user kept shape their daily
 * plan. A third question, not a mode of either of the others — deciding when
 * somebody works is a conclusion *about the person*, which neither "send my
 * words to Google" nor "suggest one next step" asked about.
 *
 * Mirrored into `users/{uid}/consents/personalization` by
 * `lib/consents/personalizationConsentService`, because that store is what the
 * personalization contracts already read. Growth requires both to agree.
 */
export const PERSONALIZATION_CONSENT_VERSION = 'personalization-consent-v1';

export type AiConsentState = 'granted' | 'declined';
export type ConsentLocale = 'ar' | 'he' | 'en';
export type ConsentPlatform = 'ios' | 'android';

/**
 * The five things `ai-consent-v1` told the user, in the order the card showed
 * them. These are the *claims*, not the translated copy: a translation may be
 * reworded without a new version, but what is promised may not.
 *
 * A historical record since 2026-09-30, kept unedited because it is what the
 * people who answered v1 were shown. Its last claim — optional, changeable in
 * settings — is no longer true (AI processing is always on,
 * `lib/consents/aiProcessingPolicy`), and no screen shows this card any more:
 * what the app tells people now is `AI_PROCESSING_DISCLOSURE_CLAIMS_V1`.
 */
export const AI_CONSENT_CLAIMS_V1 = [
  'what_is_sent:typed_or_dictated_text,date_time,timezone,optional_self_description',
  'to_whom:google_cloud_vertex_ai_gemini,eu_region',
  'why:turn_words_into_reminders_and_plans',
  'what_is_not_sent:name,email,contacts,calendar,location',
  'optional:changeable_in_settings',
] as const;

/**
 * AI processing is disclosed, not asked (owner decision 2026-09-30).
 *
 * The capture page is a chat on the model and AI processing can no longer be
 * declined, so the consent card became a disclosure: shown on the onboarding
 * consent step, on the capture page before the first message, and at the top
 * of the trust centre, with nothing to answer. Nothing is recorded for it.
 * These are its claims, in the order the copy states them (`aiDisclosure`,
 * `aiDisclosureKept` in the app's locales); the same rule as the consents':
 * a translation may be reworded, what is claimed may not — a change here is a
 * new version, and `aiConsent.test` pins the digest.
 *
 * `what_is_kept` is what the server does: a chat conversation is kept a day
 * after its last message (`captureChat/conversationStore`, the Firestore TTL
 * in `infra/firestore-ttl.sh`) and read for thirty minutes of idleness, and
 * nothing becomes a commitment until the person confirms it.
 */
export const AI_PROCESSING_DISCLOSURE_VERSION = 'ai-disclosure-v1';

export const AI_PROCESSING_DISCLOSURE_CLAIMS_V1 = [
  'what_is_sent:what_you_write_or_say',
  'to_whom:google_cloud_vertex_ai_gemini,via_our_server,eu_region',
  'why:to_be_understood',
  'what_is_kept:the_conversation_only_briefly,only_what_you_confirm_is_saved',
  'optional:no,always_on',
] as const;

/**
 * What `rec-consent-v1` tells the user, in the order the toggle's copy shows
 * them. Same rule as above: a translation may be reworded without a new
 * version, what is promised may not.
 */
export const RECOMMENDATION_CONSENT_CLAIMS_V1 = [
  'what_it_does:one_suggested_next_step_at_a_time,with_a_short_reason',
  'from_what:your_own_commitments,deadlines,routine,past_decisions',
  'how:first_party_deterministic_rules,no_model_generated_text',
  'what_it_never_does:act_on_your_behalf,send_anything_to_a_model',
  'optional:changeable_in_settings',
] as const;

/**
 * What `personalization-consent-v1` tells the user. It names the inference
 * outright, and it names both things turning it off stops.
 */
export const PERSONALIZATION_CONSENT_CLAIMS_V1 = [
  'what_it_does:notice_patterns_in_when_you_finish_things,suggest_saving_them',
  'from_what:the_times_you_finish_your_own_commitments,no_titles,no_model',
  'what_is_saved:nothing_unless_you_keep_it',
  'off_means:no_suggestions,plans_stop_using_patterns_you_kept',
  'optional:off_by_default,changeable_in_settings',
] as const;

/** A digest of the claims, so a change to them without a version bump is caught. */
export function aiConsentClaimsDigest(claims: readonly string[] = AI_CONSENT_CLAIMS_V1): string {
  return createHash('sha256').update(claims.join('\n')).digest('hex').slice(0, 16);
}

/** Every version this server will accept. An unknown one is refused, never upgraded. */
export const SUPPORTED_AI_CONSENT_VERSIONS: readonly string[] = [AI_CONSENT_VERSION];

export function isSupportedAiConsentVersion(version: unknown): version is string {
  return typeof version === 'string' && SUPPORTED_AI_CONSENT_VERSIONS.includes(version);
}

export const SUPPORTED_RECOMMENDATION_CONSENT_VERSIONS: readonly string[] = [RECOMMENDATION_CONSENT_VERSION];

export function isSupportedRecommendationConsentVersion(version: unknown): version is string {
  return typeof version === 'string' && SUPPORTED_RECOMMENDATION_CONSENT_VERSIONS.includes(version);
}

export const SUPPORTED_PERSONALIZATION_CONSENT_VERSIONS: readonly string[] = [PERSONALIZATION_CONSENT_VERSION];

export function isSupportedPersonalizationConsentVersion(version: unknown): version is string {
  return typeof version === 'string' && SUPPORTED_PERSONALIZATION_CONSENT_VERSIONS.includes(version);
}

/**
 * The consents this server knows how to record, as data.
 *
 * `lib/consents/consentService` is written against this rather than against
 * either one, so "missing means declined", "an unknown version is refused" and
 * "every change is audited" are one implementation both kinds share. A second
 * hand-written copy of those rules is exactly how one of them would eventually
 * come to differ from the other, in the direction nobody notices — the
 * permissive one.
 */
export type ConsentKey = 'aiProcessing' | 'recommendations' | 'personalization';

export interface ConsentKindContract {
  /** The field under `users/{uid}.consents`. */
  readonly key: ConsentKey;
  readonly currentVersion: string;
  readonly isSupportedVersion: (version: unknown) => version is string;
  /** Prefixed onto the audit `reasonCode`; must be a safe lowercase code. */
  readonly auditCode: string;
}

export const AI_PROCESSING_CONSENT: ConsentKindContract = Object.freeze({
  key: 'aiProcessing',
  currentVersion: AI_CONSENT_VERSION,
  isSupportedVersion: isSupportedAiConsentVersion,
  auditCode: 'ai_processing',
});

export const RECOMMENDATION_CONSENT: ConsentKindContract = Object.freeze({
  key: 'recommendations',
  currentVersion: RECOMMENDATION_CONSENT_VERSION,
  isSupportedVersion: isSupportedRecommendationConsentVersion,
  auditCode: 'recommendations',
});

export const PERSONALIZATION_CONSENT: ConsentKindContract = Object.freeze({
  key: 'personalization',
  currentVersion: PERSONALIZATION_CONSENT_VERSION,
  isSupportedVersion: isSupportedPersonalizationConsentVersion,
  auditCode: 'personalization',
});

export const CONSENT_KINDS: readonly ConsentKindContract[] = Object.freeze([
  AI_PROCESSING_CONSENT,
  RECOMMENDATION_CONSENT,
  PERSONALIZATION_CONSENT,
]);

/**
 * The record as it is stored and returned. Named for the AI consent because it
 * was the first, and shared by both: the shape of "an answer, to a version, at
 * a time" does not differ per question.
 */
export interface AiConsentRecord {
  state: AiConsentState;
  version: string;
  changedAt: string;
  locale?: ConsentLocale;
  platform?: ConsentPlatform;
}

/** The same record, under a name that does not claim to be about AI. */
export type ConsentRecord = AiConsentRecord;
export type ConsentState = AiConsentState;
