/**
 * The model, as a share channel is allowed to use it (UC-3.0, #183).
 *
 * `lib/llm/captureProvider.ts` is the same idea for one typed sentence: the
 * kill switch, the consent gate, the cost reservation, the call, the token
 * commit and one log line with nothing a person wrote in it. This is that
 * sequence for a *multipart* call, because a shared screenshot or PDF cannot go
 * through `generateJson` at all.
 *
 * It is deliberately not a widening of `captureLlmProvider`. That function
 * returns an `LLMProviderFunction` — a prompt string in, JSON text out — which
 * the extraction service injects, and every one of its callers builds its
 * prompt with `splitPrompt`'s marker. A channel assembling image parts has no
 * prompt string to split, so sharing the signature would mean one of the two
 * callers lying about its shape.
 *
 * ── What a channel gets, and what it does not ────────────────────
 *
 * It gets one function. It does not get a provider, a uid it could meter
 * against, or a way to choose a model — because the four channel issues
 * (#189–#192) each want to add a model call, and every one of those calls has
 * to be counted against the same caps, gated by the same consent and logged on
 * the same line. A seam that handed out a provider would make that a
 * convention; this makes it the only reachable thing.
 */
import {
  LLMUnavailableError,
  type LlmPart,
  type LlmProvider,
  type LlmPurpose,
} from '../../src/extraction/llm';
import { getAiConsent } from '../consents/aiConsentService';
import { AiConsentRequiredError, consentGatedProvider } from './consentGatedProvider';
import { logLlmCall, uidHash } from './llmLog';
import {
  aiDisabled,
  commitUsage,
  quotaScopeFor,
  reserveCall,
  retryAfterSecondsFor,
  type ReserveOptions,
} from './usageGuard';

/**
 * The most bytes one share may put in front of the model, across every part.
 *
 * Vertex bills inline data by tokens, and an image is worth far more of them
 * than its size suggests. This is a second brake on top of the route's own
 * 25 MB body limit, at the point where the bytes would actually cost money:
 * the route refuses what is too big to accept, and this refuses what is too
 * expensive to read. #190's token guard sits on top of both.
 */
export const MAX_INLINE_BYTES = 12 * 1024 * 1024;
/** The most text one share may put in front of the model, in characters. */
export const MAX_SHARE_CHARACTERS = 60_000;

/** What a structured call answered, and what it cost. */
export interface ShareStructuredResponse {
  /** The model's raw answer. Validation is the caller's, never this layer's. */
  text: string;
  model: string;
  latencyMs: number;
  /**
   * Kept and surfaced deliberately. #190 needs it to refuse a second pass over
   * an image that already cost more than a page of text, and a wrapper that
   * swallowed it would make that guard unwritable.
   */
  promptTokens: number;
  outputTokens: number;
}

/**
 * The one call a share preprocessor may make (UC-3.0, #183).
 *
 * **Frozen.** #189, #190, #191 and #192 each consume this exact shape through
 * `SharePreprocessContext.generateStructured`.
 */
export type ShareStructuredGenerator = (request: {
  /** Instructions. Never the shared content. */
  readonly system: string;
  /** Content, in order. Frame untrusted text with `wrapUntrustedShared`. */
  readonly parts: readonly LlmPart[];
  /** Vertex dialect — run a JSON Schema through `toVertexSchema` first. */
  readonly responseSchema: object;
  readonly maxOutputTokens?: number;
  /**
   * How long to wait, in milliseconds.
   *
   * Defaults to `DEFAULT_STRUCTURED_TIMEOUT_MS`, which is several times the
   * text-only deadline: the provider's 8 s is sized for one sentence, and this
   * seam permits 12 MB of inline data — a call that has to *upload* megabytes
   * before the model starts reading cannot share a deadline with one that sends
   * forty characters. A channel that knows its call is small may pass less.
   */
  readonly timeoutMs?: number;
  /**
   * Aborted when the request is. Pass `SharePreprocessContext.signal` straight
   * through: a share the user backed out of should stop costing money.
   */
  readonly signal?: AbortSignal;
  /** `false`: no provider-level retry; the caller budgets its own attempts. */
  readonly retry?: boolean;
}) => Promise<ShareStructuredResponse>;

export interface ShareProviderOptions {
  provider?: LlmProvider;
  consent?: typeof getAiConsent;
  purpose?: LlmPurpose;
  reserve?: typeof reserveCall;
  reserveOptions?: ReserveOptions;
  log?: typeof logLlmCall;
  commit?: typeof commitUsage;
  now?: () => Date;
}

function sizeOf(parts: readonly LlmPart[]): { characters: number; bytes: number } {
  let characters = 0;
  let bytes = 0;
  for (const part of parts) {
    if (part.kind === 'text') characters += part.text.length;
    else bytes += part.data.byteLength;
  }
  return { characters, bytes };
}

/**
 * A metered, gated, logged multipart call for one account.
 *
 * Every failure is an `LLMUnavailableError`, so a channel can treat "the model
 * would not answer" as one case rather than a taxonomy — which is what lets a
 * channel fall back to whatever it can do without a model instead of failing
 * the whole share.
 */
export function shareLlmProvider(uid: string, options: ShareProviderOptions = {}): ShareStructuredGenerator {
  const purpose = options.purpose ?? 'share_extraction';
  const reserve = options.reserve ?? reserveCall;
  const log = options.log ?? logLlmCall;
  const commit = options.commit ?? commitUsage;
  const clock = options.now ?? (() => new Date());

  return async (request) => {
    // The kill switch, before anything else (#181). One variable takes every
    // model call out of the product without a code change.
    if (aiDisabled()) throw new LLMUnavailableError('ai_disabled');

    const { characters, bytes } = sizeOf(request.parts);
    // Refused before the reservation, because a call this size costs what a
    // whole day of ordinary use costs and refusing it should be free.
    if (characters > MAX_SHARE_CHARACTERS) throw new LLMUnavailableError('input_too_large');
    if (bytes > MAX_INLINE_BYTES) throw new LLMUnavailableError('input_too_large');

    // Gated, always. This is the only provider this module can reach, and
    // `tests/llm/providerBoundary.test.ts` is what keeps it that way.
    const provider = options.provider ?? consentGatedProvider(uid, {});
    if (provider.name === 'none') throw new LLMUnavailableError('provider_none');

    // Consent before cost, exactly as the capture path does it: the gated
    // provider refuses this call anyway, but it refuses *after* the
    // reservation, and charging somebody's budget for a call their consent
    // forbids is the wrong way round.
    const readConsent = options.consent ?? getAiConsent;
    if ((await readConsent(uid)) !== 'granted') throw new AiConsentRequiredError();

    const reservation = await reserve(uid, purpose, options.reserveOptions ?? {});
    if (reservation !== 'ok') {
      const scope = quotaScopeFor(reservation);
      const reason = scope ? `cost_cap:${scope}` : 'usage_guard_unavailable';
      if (scope) {
        console.warn(JSON.stringify({
          event: 'ai_quota_exceeded',
          scope,
          purpose,
          uidHash: uidHash(uid),
          retryAfterSeconds: retryAfterSecondsFor(scope, clock()),
        }));
      }
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

    const startedAt = Date.now();
    try {
      const response = await provider.generateStructured({
        system: request.system,
        parts: request.parts,
        responseSchema: request.responseSchema,
        purpose,
        uid,
        ...(request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens }),
        ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
        ...(request.signal ? { signal: request.signal } : {}),
        ...(request.retry === false ? { retry: false } : {}),
      });
      await commit(uid, { promptTokens: response.promptTokens, outputTokens: response.outputTokens });
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
      return response;
    } catch (error) {
      // `reason` only. The provider already refuses to carry its own message,
      // because a provider error body can quote the request — and here the
      // request is somebody's screenshot.
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
