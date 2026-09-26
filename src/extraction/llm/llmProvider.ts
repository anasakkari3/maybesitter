/**
 * What a hosted model looks like to the rest of the backend (UC-2.0, #160).
 *
 * Until now the only model was Ollama on localhost, and the seam was a single
 * function `(prompt: string) => Promise<string>`. That is enough for one
 * provider on one machine and not enough for a hosted one: a request has to
 * carry who it is for (the cost guard is per user), what it is for (capture
 * extraction today, profile and importance later), and the schema the answer
 * must match — and the response has to carry what it cost.
 *
 * So this is the shape, and `providerFunction` adapts it back to the old
 * signature so every existing injection point and test keeps working.
 *
 * ── The provider is not the authority ────────────────────────────
 *
 * Nothing here validates anything. `schemaValidator.ts` remains the gate: a
 * model answering in the right shape is not the same as an answer being
 * right, and the moment this layer starts believing the model is the moment a
 * malformed extraction becomes a commitment in someone's day.
 */

export type LlmPurpose =
  | 'capture_extraction'
  | 'profile_extraction'
  | 'importance_estimate'
  /** Narrating a plan the deterministic scheduler already produced (#194). */
  | 'plan_explanation'
  /** One shared thing, read once (UC-3.0, #183). */
  | 'share_extraction'
  /** A profile another AI assistant wrote about the user, read once. */
  | 'ai_context_import';

export type LlmProviderName = 'gemini' | 'ollama' | 'none';

export interface LlmRequest {
  /** Instructions the model is to follow. Never user text. */
  system: string;
  /** The untrusted message, already wrapped by the caller's prompt builder. */
  user: string;
  /** The shape the answer must take, in the dialect the provider accepts. */
  responseSchema: object;
  purpose: LlmPurpose;
  /** Whose request this is. Used for the cost guard and the log's uid hash. */
  uid: string;
}

export interface LlmResponse {
  text: string;
  model: string;
  latencyMs: number;
  promptTokens: number;
  outputTokens: number;
}

/**
 * What an inline part may be (UC-3.0, #183).
 *
 * A closed list, and deliberately not `string`. Vertex accepts a `mimeType` on
 * an inline part and does nothing to check it against the bytes; the type that
 * gets here has already been sniffed from the bytes by
 * `lib/services/share/mediaType.ts`, and narrowing it to what the model can
 * actually read is what keeps a renamed file from being handed to Gemini as
 * whatever its name claimed.
 */
export type LlmInlineMediaType =
  | 'image/jpeg'
  | 'image/png'
  | 'image/webp'
  | 'image/heic'
  | 'image/heif'
  | 'application/pdf';

/**
 * One piece of a multipart request.
 *
 * `text` is content, never instructions: the instructions are the request's
 * `system`, exactly as they are for `generateJson`. A caller that puts its
 * rules in a text part has put them in the turn the prompt itself declares
 * untrusted, which is the defect `splitPrompt` exists to prevent.
 */
export type LlmPart =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'inlineData';
      readonly mediaType: LlmInlineMediaType;
      /** Request memory only. The caller zeroes it once the call has answered. */
      readonly data: Uint8Array;
    };

/**
 * A request that can carry bytes (UC-3.0, #183).
 *
 * Separate from `LlmRequest` rather than a widening of it, because the two are
 * genuinely different asks: `generateJson` takes one untrusted string that the
 * prompt builder has already framed, and this takes an ordered list of parts
 * the caller assembled. Folding them together would make `user` optional on
 * every existing call site for the benefit of one new one.
 */
export interface LlmStructuredRequest {
  /** Instructions the model is to follow. Never user content. */
  system: string;
  /** Content, in order. At least one part. */
  parts: readonly LlmPart[];
  /** The shape the answer must take, in the dialect the provider accepts. */
  responseSchema: object;
  purpose: LlmPurpose;
  /** Whose request this is. Used for the cost guard and the log's uid hash. */
  uid: string;
  /**
   * The ceiling on the answer. Optional because most callers want the default;
   * present because a page of shared chat yields more items than one sentence
   * does, and a truncated answer is an `empty_response` rather than a short one.
   */
  maxOutputTokens?: number;
  /**
   * How long to wait, in milliseconds (UC-3.0, #183).
   *
   * Present for the same reason `maxOutputTokens` is. `generateJson` sends one
   * sentence and 8 s of silence means the provider is not going to answer; this
   * can carry megabytes of inline image or PDF, which has to be uploaded before
   * the model begins. Sharing the text deadline would make every large share
   * time out and be reported as an outage. Defaults to
   * `DEFAULT_STRUCTURED_TIMEOUT_MS`.
   */
  timeoutMs?: number;
  /** Aborted when the caller's request is. */
  signal?: AbortSignal;
}

export interface LlmProvider {
  name: LlmProviderName;
  generateJson(request: LlmRequest): Promise<LlmResponse>;
  /**
   * The multipart call (UC-3.0, #183).
   *
   * **Required, not optional.** An optional method would mean every wrapper
   * that forgot it — the consent gate above all — silently became a provider
   * with no structured path, and the failure would look like "the model does
   * not support images" rather than "the gate does not gate this call".
   * `structuredFromJson` below makes a text-only implementation one line, so
   * requiring it costs a wrapper nothing.
   */
  generateStructured(request: LlmStructuredRequest): Promise<LlmResponse>;
}

/**
 * A `generateStructured` for a provider that only speaks text.
 *
 * Text parts are joined and sent through `generateJson`; a binary part is
 * refused rather than dropped. Dropping it would send the model a request
 * missing the only thing it was asked about and return a confident answer
 * about nothing.
 */
export function structuredFromJson(
  generateJson: (request: LlmRequest) => Promise<LlmResponse>,
): (request: LlmStructuredRequest) => Promise<LlmResponse> {
  return async (request: LlmStructuredRequest) => {
    if (request.parts.some((part) => part.kind !== 'text')) {
      throw new LLMUnavailableError('inline_data_unsupported');
    }
    return generateJson({
      system: request.system,
      user: request.parts.map((part) => (part.kind === 'text' ? part.text : '')).join('\n\n'),
      responseSchema: request.responseSchema,
      purpose: request.purpose,
      uid: request.uid,
    });
  };
}

/**
 * The old seam: a prompt in, raw JSON text out.
 *
 * `ollamaExtractor` builds one prompt string and every test injects one of
 * these. Rewriting all of that to pass a request object would be a large
 * diff whose only effect is churn, so the new interface adapts to the old one
 * rather than replacing it.
 */
/**
 * How one call is shaped (CL1 review, I4). `batch` asks for `{"items":[…]}` —
 * one extraction object per clause of a capture, in one model call — and the
 * provider answers it with the batch schema and a larger output ceiling.
 * Absent means one object, which is every caller that predates it.
 */
export interface LLMCallOptions {
  shape?: 'single' | 'batch';
  /**
   * How long this one call may take, in milliseconds (CL1 round 4, N3). The
   * capture boundary sets it on every call of a multi-clause capture so that
   * the call, its one retry and the back-off between them end inside the
   * server's budget; absent, the provider's own default applies.
   */
  timeoutMs?: number;
}

/**
 * How long one batched capture call may take (CL1 review, I4). The provider
 * retries a timeout once, so two of these plus the back-off stay under the
 * capture's 12 s server budget — the phone gives up at 15 s
 * (`mobile/src/api/client.ts`). A three-clause call measured 3.3–4.6 s.
 */
export const CAPTURE_BATCH_TIMEOUT_MS = 5_500;

/**
 * The longest pause before the provider's one retry (`withSingleRetry`): a
 * 250 ms base plus up to 500 ms of jitter. One number, so the capture's time
 * budget and the retry cannot drift apart.
 */
export const RETRY_BACKOFF_MAX_MS = 750;
export type LLMProviderFunction = (prompt: string, options?: LLMCallOptions) => Promise<string>;

export function providerFunction(
  provider: LlmProvider,
  context: { purpose: LlmPurpose; uid: string; responseSchema: object; system?: string },
): LLMProviderFunction {
  return async (prompt: string) => {
    const response = await provider.generateJson({
      system: context.system ?? '',
      user: prompt,
      responseSchema: context.responseSchema,
      purpose: context.purpose,
      uid: context.uid,
    });
    return response.text;
  };
}

/**
 * The model could not answer: unreachable, over deadline, throttled, refused,
 * or switched off. Every one of them means the same thing to the caller —
 * fall back to the rule-based extractor — which is why they are one error
 * with a reason rather than a taxonomy the call site has to handle.
 */
export class LLMUnavailableError extends Error {
  constructor(readonly reason: string, message?: string) {
    super(message ?? reason);
    this.name = 'LLMUnavailableError';
  }
}

/** A provider that is switched off. Its failure is immediate and free. */
export const NONE_PROVIDER: LlmProvider = {
  name: 'none',
  async generateJson() {
    throw new LLMUnavailableError('provider_none', 'no hosted model is configured');
  },
  async generateStructured() {
    throw new LLMUnavailableError('provider_none', 'no hosted model is configured');
  },
};
