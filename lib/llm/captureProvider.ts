/**
 * The model, as the capture path is allowed to use it (UC-2.0, #160).
 *
 * `src/extraction` never imports from `lib/` — extraction is domain logic and
 * storage is not — so the pieces that need Firestore and a uid are composed
 * here and handed in through the `llmProvider` seam the capture boundary
 * already has.
 *
 * Three things wrap the raw provider, in this order:
 *
 *   1. **The cost guard.** A call is reserved before Vertex is asked. Over the
 *      cap, this throws and capture falls back to rules with the cap named.
 *   2. **The call.** Instructions and untrusted text are separated at the
 *      marker the prompt already carries.
 *   3. **The log.** One line, with counts and latency and a hashed uid, and
 *      nothing a person wrote.
 *
 * The repair attempt inside the extractor comes back through this same
 * function, so it reserves and logs like any other call — which is what makes
 * "at most N calls a day" mean calls rather than captures.
 */
import {
  LLMUnavailableError,
  getDefaultProvider,
  type LLMProviderFunction,
  type LlmProvider,
  type LlmPurpose,
} from '../../src/extraction/llm';
import { GEMINI_EXTRACTION_SCHEMA } from '../../src/extraction/ollamaExtractionSchema';
import { logLlmCall, uidHash } from './llmLog';
import { reserveCall, type ReserveOptions } from './usageGuard';

const UNTRUSTED_MARKER = 'BEGIN_UNTRUSTED_USER_MESSAGE';

/**
 * Splits the extractor's prompt into instructions and untrusted content.
 *
 * The prompt is built as rules, then a `BEGIN_UNTRUSTED_USER_MESSAGE` block.
 * Sending the whole string as one turn would make that boundary a formatting
 * detail; sending the rules as the system instruction makes it the thing the
 * model is actually told to respect.
 */
export function splitPrompt(prompt: string): { system: string; user: string } {
  const index = prompt.indexOf(UNTRUSTED_MARKER);
  // No marker means a caller built the prompt some other way. Everything is
  // then treated as untrusted, which is the safe direction to be wrong in.
  if (index < 0) return { system: '', user: prompt };
  return { system: prompt.slice(0, index).trimEnd(), user: prompt.slice(index) };
}

export interface CaptureProviderOptions {
  provider?: LlmProvider;
  purpose?: LlmPurpose;
  reserve?: typeof reserveCall;
  reserveOptions?: ReserveOptions;
  log?: typeof logLlmCall;
}

/**
 * A metered, logged model call for one account.
 *
 * Returns the provider function the capture boundary injects. Every failure it
 * throws is an `LLMUnavailableError`, so the extraction service falls back to
 * rules and records the reason.
 */
export function captureLlmProvider(uid: string, options: CaptureProviderOptions = {}): LLMProviderFunction {
  const purpose = options.purpose ?? 'capture_extraction';
  const reserve = options.reserve ?? reserveCall;
  const log = options.log ?? logLlmCall;

  return async (prompt: string): Promise<string> => {
    const provider = options.provider ?? getDefaultProvider();
    // Nothing to meter and nothing to log: the fast path when no model is
    // configured, which is the default everywhere.
    if (provider.name === 'none') throw new LLMUnavailableError('provider_none');

    const reservation = await reserve(uid, purpose, options.reserveOptions ?? {});
    if (reservation !== 'ok') {
      const reason = reservation === 'user_cap' ? 'cost_cap:user' : 'cost_cap:global';
      log({
        event: 'llm_call',
        purpose,
        provider: provider.name,
        model: process.env.MAYBESITTER_LLM_MODEL ?? '',
        location: process.env.MAYBESITTER_VERTEX_LOCATION ?? '',
        uidHash: uidHash(uid),
        latencyMs: 0,
        promptTokens: 0,
        outputTokens: 0,
        outcome: 'cost_cap',
        fallbackReason: reason,
      });
      throw new LLMUnavailableError(reason);
    }

    const { system, user } = splitPrompt(prompt);
    const startedAt = Date.now();
    try {
      const response = await provider.generateJson({
        system,
        user,
        responseSchema: GEMINI_EXTRACTION_SCHEMA,
        purpose,
        uid,
      });
      log({
        event: 'llm_call',
        purpose,
        provider: provider.name,
        model: response.model,
        location: process.env.MAYBESITTER_VERTEX_LOCATION ?? '',
        uidHash: uidHash(uid),
        latencyMs: response.latencyMs,
        promptTokens: response.promptTokens,
        outputTokens: response.outputTokens,
        outcome: 'ok',
      });
      return response.text;
    } catch (error) {
      // `reason` only. The provider already refused to carry its own message
      // for exactly this reason.
      const reason = error instanceof LLMUnavailableError ? error.reason : 'provider_error';
      log({
        event: 'llm_call',
        purpose,
        provider: provider.name,
        model: process.env.MAYBESITTER_LLM_MODEL ?? '',
        location: process.env.MAYBESITTER_VERTEX_LOCATION ?? '',
        uidHash: uidHash(uid),
        latencyMs: Date.now() - startedAt,
        promptTokens: 0,
        outputTokens: 0,
        outcome: 'unavailable',
        fallbackReason: reason,
      });
      throw error instanceof LLMUnavailableError ? error : new LLMUnavailableError(reason);
    }
  };
}
