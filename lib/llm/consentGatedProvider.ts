/**
 * The only way to reach Gemini (UC-2.1, #161).
 *
 * ── Why a second check exists ────────────────────────────────────
 *
 * The capture route already refuses to request the model when consent is
 * missing. That is one decision in one place, and the paths that will want a
 * model later — profile extraction (#168), importance estimation (#169) —
 * have not been written yet. Whoever writes them will reach for a provider,
 * and the provider they can reach has to be one that asks.
 *
 * So the gate is on the provider rather than on the caller, and
 * `tests/llm/providerBoundary.test.ts` fails if anything outside this module
 * builds a Gemini provider or takes the configured one. A future feature
 * cannot send a sentence to Google by forgetting a check, because there is no
 * ungated provider to forget it with.
 *
 * ── Read every time ──────────────────────────────────────────────
 *
 * No caching, per request or otherwise. Revocation has to hold on the next
 * request, and a cached "granted" is precisely the case where it would not.
 */
import { LLMUnavailableError, getDefaultProvider, type LlmProvider } from '../../src/extraction/llm';
import { getAiConsent, type AiConsentOptions } from '../consents/aiConsentService';

/**
 * The account has not agreed to AI processing.
 *
 * An `LLMUnavailableError` on purpose: every caller already falls back to the
 * rule-based extractor when the model cannot answer, and "not allowed" needs
 * exactly that behaviour. The reason distinguishes it in the logs.
 */
export class AiConsentRequiredError extends LLMUnavailableError {
  constructor() {
    super('consent_required', 'AI processing has not been agreed to for this account');
    this.name = 'AiConsentRequiredError';
  }
}

export interface ConsentGatedProviderOptions extends AiConsentOptions {
  /** Injected by tests. Production takes the configured provider. */
  provider?: LlmProvider;
  consent?: typeof getAiConsent;
}

export function consentGatedProvider(uid: string, options: ConsentGatedProviderOptions = {}): LlmProvider {
  const inner = options.provider ?? getDefaultProvider();
  const readConsent = options.consent ?? getAiConsent;

  return {
    name: inner.name,
    async generateJson(request) {
      // Before the call, every call. The uid is the gate's, not the request's:
      // a request object naming somebody else changes nothing about whose
      // consent is checked.
      const consent = await readConsent(uid, options.storage ? { storage: options.storage } : {});
      if (consent !== 'granted') throw new AiConsentRequiredError();
      return inner.generateJson(request);
    },
  };
}
