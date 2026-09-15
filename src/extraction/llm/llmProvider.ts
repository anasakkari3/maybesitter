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
  | 'plan_explanation';

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

export interface LlmProvider {
  name: LlmProviderName;
  generateJson(request: LlmRequest): Promise<LlmResponse>;
}

/**
 * The old seam: a prompt in, raw JSON text out.
 *
 * `ollamaExtractor` builds one prompt string and every test injects one of
 * these. Rewriting all of that to pass a request object would be a large
 * diff whose only effect is churn, so the new interface adapts to the old one
 * rather than replacing it.
 */
export type LLMProviderFunction = (prompt: string) => Promise<string>;

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
};
