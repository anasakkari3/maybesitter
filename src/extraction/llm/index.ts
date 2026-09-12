/**
 * Which model answers, and how hard it tries (UC-2.0, #160).
 *
 * ── The default is off, everywhere ───────────────────────────────
 *
 * #160 proposed defaulting to Gemini when `NODE_ENV=production`. That is not
 * done here, deliberately. #160's own scope says user text must not reach
 * Vertex before UC-2.1 (#161)'s consent enforcement exists, and a default that
 * switches on with the environment would send it the moment this merged and
 * deployed — before anybody had been asked.
 *
 * So the provider is `none` unless `MAYBESITTER_LLM_PROVIDER` says otherwise.
 * Turning it on is a deployment decision someone makes, not something that
 * happens because a branch landed. `none` throws immediately, the extraction
 * service falls back to rules, and capture is unaffected.
 *
 * ── One retry, and only when retrying could help ─────────────────
 *
 * A timeout, a throttle or a 5xx might answer differently a moment later; a
 * 400 will not. Retrying the second kind spends the deadline twice to reach
 * the same fallback, so only the first kind is retried, once, with jitter so
 * that a partial outage does not turn every instance into a synchronised
 * hammer.
 */
import { createGeminiProvider, isRetryable } from './geminiProvider';
import {
  LLMUnavailableError,
  NONE_PROVIDER,
  type LlmProvider,
  type LlmProviderName,
  type LlmRequest,
  type LlmResponse,
} from './llmProvider';

export * from './llmProvider';
export { createGeminiProvider, isRetryable, DEFAULT_GEMINI_MODEL, DEFAULT_VERTEX_LOCATION, type GenerateContent } from './geminiProvider';
export { toVertexSchema } from './vertexSchema';

export const DEFAULT_MAX_RETRIES = 1;
const RETRY_BASE_MS = 250;
const RETRY_JITTER_MS = 500;

export function configuredProviderName(env: NodeJS.ProcessEnv = process.env): LlmProviderName {
  const raw = (env.MAYBESITTER_LLM_PROVIDER ?? '').trim();
  if (raw === '') return 'none';
  if (raw === 'gemini' || raw === 'ollama' || raw === 'none') return raw;
  // A typo must not silently become "off" — that is a production incident that
  // looks like normal fallback for however long nobody reads the logs.
  throw new Error(`MAYBESITTER_LLM_PROVIDER must be gemini, ollama or none, not ${JSON.stringify(raw)}`);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wraps a provider so a retryable failure gets exactly one more attempt. */
export function withSingleRetry(
  provider: LlmProvider,
  options: { maxRetries?: number; delayMs?: () => number } = {},
): LlmProvider {
  const maxRetries = options.maxRetries
    ?? Number.parseInt(process.env.MAYBESITTER_LLM_MAX_RETRIES ?? '', 10);
  const retries = Number.isFinite(maxRetries) ? Math.max(0, maxRetries) : DEFAULT_MAX_RETRIES;
  const delayMs = options.delayMs ?? (() => RETRY_BASE_MS + Math.floor(Math.random() * RETRY_JITTER_MS));

  return {
    name: provider.name,
    async generateJson(request: LlmRequest): Promise<LlmResponse> {
      let lastError: unknown;
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
          return await provider.generateJson(request);
        } catch (error) {
          lastError = error;
          if (attempt === retries || !isRetryable(error)) break;
          await sleep(delayMs());
        }
      }
      throw lastError instanceof Error ? lastError : new LLMUnavailableError('provider_error');
    },
  };
}

let cached: { name: LlmProviderName; provider: LlmProvider } | null = null;

/**
 * The configured provider, built once.
 *
 * Cached by name so that a test changing the environment gets a different
 * provider, while a process serving requests does not rebuild an SDK client
 * per capture.
 */
export function getDefaultProvider(env: NodeJS.ProcessEnv = process.env): LlmProvider {
  const name = configuredProviderName(env);
  if (cached?.name === name) return cached.provider;

  const provider = name === 'gemini'
    ? withSingleRetry(createGeminiProvider())
    : name === 'ollama'
      ? withSingleRetry(createOllamaProvider())
      : NONE_PROVIDER;
  cached = { name, provider };
  return provider;
}

export function resetProviderForTests(): void {
  cached = null;
}

/**
 * Ollama, kept for local development only.
 *
 * It has no place in production — it is a model on localhost — but it is how
 * the capture pipeline is exercised offline, and deleting it would make
 * "develop against a real model" mean "point at Vertex", which is the thing
 * this whole issue is trying to keep deliberate.
 */
function createOllamaProvider(): LlmProvider {
  return {
    name: 'ollama',
    async generateJson(request: LlmRequest): Promise<LlmResponse> {
      const { callOllama } = await import('../localLLMProvider');
      const startedAt = Date.now();
      const text = await callOllama(`${request.system}\n\n${request.user}`.trim());
      return {
        text,
        model: process.env.MAYBESITTER_LLM_MODEL ?? 'llama3.2',
        latencyMs: Date.now() - startedAt,
        // Ollama's response carries counts this adapter does not read; the cost
        // guard exists for the hosted provider, and local calls cost nothing.
        promptTokens: 0,
        outputTokens: 0,
      };
    },
  };
}
