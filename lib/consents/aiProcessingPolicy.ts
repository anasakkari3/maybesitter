/**
 * AI processing is always on (owner decision, 2026-09-30).
 *
 * The capture page became a real chat powered by the model, and the owner
 * ruled that a person can no longer turn AI processing off. This file is the
 * whole of that policy, in one place, so no gate has to be edited to follow
 * it: `lib/consents/consentService` applies it at the two chokepoints every
 * AI-consent read and write already passes through.
 *
 *   read   `readConsent` answers `granted` at the current version for the AI
 *          question, whatever is stored — so `getAiConsent`, the gated
 *          provider, the capture path, share intake, meeting prep, profile
 *          describe/import, Google connect, the plan explanation and
 *          `GET /api/mobile/consents` all see the same yes.
 *   write  `setConsent` refuses `declined` for the AI question with
 *          `AiProcessingAlwaysOnError`, which the route answers as
 *          409 `{ code: 'ai_always_on' }`. A `granted` write is still recorded
 *          and audited as before.
 *
 * What did NOT change: the per-user and global daily caps, the minute cap,
 * the token cap, the kill switch and the cost guardrails (`lib/llm/usageGuard`)
 * — every model call is still reserved and metered, and a refused one still
 * falls back to the rule-based path. The recommendation, personalization and
 * calendar consents are separate questions and are untouched.
 */
import { AI_CONSENT_VERSION, AI_PROCESSING_CONSENT, type ConsentKindContract, type ConsentRecord } from '../../src/contracts/v1/consentContracts';

/** The policy switch. There is no environment override: it is a product rule. */
export const AI_PROCESSING_ALWAYS_ON = true as const;

/** The machine-readable code a refused "turn AI off" carries. */
export const AI_ALWAYS_ON_CODE = 'ai_always_on' as const;

/** Somebody asked to decline AI processing, which is no longer a choice. */
export class AiProcessingAlwaysOnError extends Error {
  readonly code = AI_ALWAYS_ON_CODE;
  constructor() {
    super('AI processing is always on and cannot be declined');
    this.name = 'AiProcessingAlwaysOnError';
  }
}

/** Whether a consent question is the one this policy answers. */
export function isAlwaysOnConsent(kind: ConsentKindContract): boolean {
  return AI_PROCESSING_ALWAYS_ON && kind.key === AI_PROCESSING_CONSENT.key;
}

/**
 * The record the AI question reads as: granted, at the current version.
 *
 * A stored granted record at a supported version keeps its own `changedAt`,
 * locale and platform, so a person who did agree still shows when and where.
 * Anything else — never asked, declined, an unknown version — reads as
 * granted with no `changedAt`: nobody recorded that moment, and inventing one
 * would be a claim about the person.
 */
export function alwaysOnAiRecord(stored: ConsentRecord | null | undefined, supported: boolean): ConsentRecord {
  if (stored && stored.state === 'granted' && supported) {
    return { ...stored, state: 'granted', version: stored.version };
  }
  return {
    state: 'granted',
    version: AI_CONSENT_VERSION,
    changedAt: '',
    ...(stored?.locale ? { locale: stored.locale } : {}),
    ...(stored?.platform ? { platform: stored.platform } : {}),
  };
}
