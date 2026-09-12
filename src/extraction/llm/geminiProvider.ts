/**
 * Gemini on Vertex AI (UC-2.0, #160).
 *
 * ── Credentials ──────────────────────────────────────────────────
 *
 * Application Default Credentials, which on Cloud Run is the service account.
 * There is no API key anywhere in this path and no service-account JSON in the
 * repository: a key that exists is a key that can leak, and a hosted model is
 * exactly the kind of thing whose key ends up in a log line.
 *
 * ── Region ───────────────────────────────────────────────────────
 *
 * A pinned EU region, never `global`. Capture text is what a person typed
 * about their life; where it is processed is a promise the consent screen
 * (UC-2.1, #161) makes on our behalf, and `global` routes to wherever has
 * capacity.
 *
 * ── The model ────────────────────────────────────────────────────
 *
 * `gemini-2.5-flash`, verified by calling it: as of 2026-09-12 it and
 * `gemini-2.5-flash-lite` answer in `europe-west1`, while `gemini-2.0-flash`
 * and `gemini-3-flash` return NOT_FOUND there. Structured output and
 * `thinkingBudget: 0` were confirmed on the same endpoint rather than assumed
 * from documentation.
 *
 * ── Every failure is one failure ─────────────────────────────────
 *
 * Timeouts, 429s, 5xx, UNAVAILABLE, DEADLINE_EXCEEDED and aborts all become
 * `LLMUnavailableError`, because the caller does the same thing for all of
 * them: fall back to the rule-based extractor. What differs is the reason,
 * which is recorded so an outage and a throttle are distinguishable later.
 */
import { LLMUnavailableError, type LlmProvider, type LlmRequest, type LlmResponse } from './llmProvider';

export const DEFAULT_VERTEX_LOCATION = 'europe-west1';
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
export const DEFAULT_TIMEOUT_MS = 8000;

/** `global` sends the request wherever there is capacity. That is the point. */
function requireRegionalLocation(location: string): string {
  if (location === 'global' || location.trim() === '') {
    throw new Error('MAYBESITTER_VERTEX_LOCATION must be a region, never "global": capture text is processed where we said it would be');
  }
  return location;
}

export interface GeminiProviderOptions {
  project?: string;
  location?: string;
  model?: string;
  timeoutMs?: number;
  /** Injected by tests. Production resolves the real SDK client lazily. */
  generate?: GenerateContent;
}

/** The one SDK call this provider makes, narrowed to what it actually uses. */
export type GenerateContent = (input: {
  model: string;
  contents: unknown;
  config: Record<string, unknown>;
}) => Promise<{
  text?: string;
  modelVersion?: string;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  candidates?: Array<{ finishReason?: string }>;
}>;

/**
 * Retryable if the answer might differ next time.
 *
 * A 400 for a malformed schema will be a 400 forever, and retrying it spends
 * the deadline twice to reach the same fallback.
 */
function reasonFor(error: unknown): string | null {
  const status = (error as { status?: number; code?: number }).status ?? (error as { code?: number }).code;
  const message = error instanceof Error ? error.message : String(error);
  if ((error as { name?: string }).name === 'AbortError') return 'timeout';
  if (status === 429) return 'rate_limited';
  if (typeof status === 'number' && status >= 500) return 'server_error';
  if (/UNAVAILABLE|DEADLINE_EXCEEDED|ECONNRESET|ETIMEDOUT|socket hang up/i.test(message)) return 'unavailable';
  return null;
}

/** Non-retryable failures still have to be named, without quoting the body. */
function terminalReason(error: unknown): string {
  const status = (error as { status?: number; code?: number }).status ?? (error as { code?: number }).code;
  if (typeof status === 'number') return `provider_error:${status}`;
  return 'provider_error';
}

async function resolveGenerate(options: GeminiProviderOptions): Promise<GenerateContent> {
  if (options.generate) return options.generate;
  const { GoogleGenAI } = await import('@google/genai');
  const client = new GoogleGenAI({
    vertexai: true,
    project: options.project ?? process.env.MAYBESITTER_GCP_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT,
    location: requireRegionalLocation(options.location ?? process.env.MAYBESITTER_VERTEX_LOCATION ?? DEFAULT_VERTEX_LOCATION),
  });
  return (input) => client.models.generateContent(input as never) as never;
}

export function createGeminiProvider(options: GeminiProviderOptions = {}): LlmProvider {
  const model = options.model ?? process.env.MAYBESITTER_LLM_MODEL ?? DEFAULT_GEMINI_MODEL;
  const configuredTimeout = Number.parseInt(process.env.MAYBESITTER_LLM_TIMEOUT_MS ?? '', 10);
  const timeoutMs = options.timeoutMs
    ?? (Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : DEFAULT_TIMEOUT_MS);

  return {
    name: 'gemini',
    async generateJson(request: LlmRequest): Promise<LlmResponse> {
      const generate = await resolveGenerate(options);
      const startedAt = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await generate({
          model,
          // The untrusted text is the *content*; the instructions are the
          // system instruction. Keeping them apart is what makes the
          // BEGIN/END wrapper mean something to the model.
          contents: [{ role: 'user', parts: [{ text: request.user }] }],
          config: {
            systemInstruction: request.system,
            responseMimeType: 'application/json',
            responseSchema: request.responseSchema,
            temperature: 0,
            maxOutputTokens: 1024,
            // Extraction is a transcription task, not a reasoning one. Thinking
            // tokens here are latency and cost for no accuracy.
            thinkingConfig: { thinkingBudget: 0 },
            abortSignal: controller.signal,
          },
        });

        const text = response.text ?? '';
        if (text.trim() === '') {
          // A truncated or filtered answer is not an answer. Naming the finish
          // reason keeps "the model refused" separate from "the model broke",
          // and it is a fixed vocabulary, never user content.
          const finish = response.candidates?.[0]?.finishReason ?? 'empty';
          throw new LLMUnavailableError(`empty_response:${finish}`);
        }

        return {
          text,
          model: response.modelVersion ?? model,
          latencyMs: Date.now() - startedAt,
          promptTokens: response.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
        };
      } catch (error) {
        if (error instanceof LLMUnavailableError) throw error;
        // The message is never included: a provider error body can quote the
        // request, and the request is the user's sentence (#160 step 10).
        throw new LLMUnavailableError(reasonFor(error) ?? terminalReason(error));
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Whether this failure is worth one more attempt. */
export function isRetryable(error: unknown): boolean {
  if (!(error instanceof LLMUnavailableError)) return false;
  return ['timeout', 'rate_limited', 'server_error', 'unavailable'].includes(error.reason);
}
