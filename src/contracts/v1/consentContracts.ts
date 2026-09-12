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

export type AiConsentState = 'granted' | 'declined';
export type ConsentLocale = 'ar' | 'he' | 'en';
export type ConsentPlatform = 'ios' | 'android';

/**
 * The five things `ai-consent-v1` tells the user, in the order the card shows
 * them. These are the *claims*, not the translated copy: a translation may be
 * reworded without a new version, but what is promised may not.
 */
export const AI_CONSENT_CLAIMS_V1 = [
  'what_is_sent:typed_or_dictated_text,date_time,timezone,optional_self_description',
  'to_whom:google_cloud_vertex_ai_gemini,eu_region',
  'why:turn_words_into_reminders_and_plans',
  'what_is_not_sent:name,email,contacts,calendar,location',
  'optional:changeable_in_settings',
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

/** The record as it is stored and returned. */
export interface AiConsentRecord {
  state: AiConsentState;
  version: string;
  changedAt: string;
  locale?: ConsentLocale;
  platform?: ConsentPlatform;
}
