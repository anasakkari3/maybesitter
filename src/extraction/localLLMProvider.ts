/**
 * Ollama HTTP client.
 *
 * Responsibilities:
 *  - POST to Ollama /api/generate
 *  - Enforce a configurable timeout
 *  - Classify errors so callers can decide whether to fallback
 *
 * Environment variables:
 *   MAYBESITTER_LLM_BASE_URL   (default: http://localhost:11434)
 *   MAYBESITTER_LLM_MODEL      (default: llama3.2)
 *   MAYBESITTER_LLM_TIMEOUT_MS (default: 10000)
 */

const LLM_BASE_URL = (process.env.MAYBESITTER_LLM_BASE_URL ?? 'http://localhost:11434').replace(/\/$/, '');
const LLM_MODEL = process.env.MAYBESITTER_LLM_MODEL ?? 'llama3.2';
const LLM_TIMEOUT_MS = Number(process.env.MAYBESITTER_LLM_TIMEOUT_MS) || 10_000;

/** Thrown when Ollama is unreachable or returns a 5xx error. Callers should fallback gracefully. */
export class LLMUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LLMUnavailableError';
  }
}

interface OllamaGenerateResponse {
  response: string;
  /** Thinking models put their answer here instead when thinking is enabled. */
  thinking?: string;
  done: boolean;
}

/**
 * Send a prompt to Ollama and return the raw response string.
 *
 * @throws {LLMUnavailableError} when Ollama is offline, times out, or returns 5xx
 * @throws {Error}               when Ollama returns 4xx (bad request / bad model name)
 */
export async function callOllama(prompt: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${LLM_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LLM_MODEL,
        prompt,
        stream: false,
        format: 'json',
        // Thinking-capable models default to thinking on, and then return
        // their answer in `thinking` with `response` empty. Reading only
        // `response` scored two of the three evaluated models 0/8 -- including
        // the one the plan designates for production -- which measured this
        // client, not the models. Verified against Ollama directly: the same
        // call with think:false returns real JSON from both.
        think: false,
      }),
      signal: controller.signal,
    });
  } catch (err: unknown) {
    // Network errors, ECONNREFUSED, AbortError (timeout) all land here
    const message = err instanceof Error ? err.message : String(err);
    throw new LLMUnavailableError(`Ollama unreachable: ${message}`);
  } finally {
    clearTimeout(timer);
  }

  if (response.status >= 500) {
    const body = await response.text().catch(() => '');
    throw new LLMUnavailableError(`Ollama server error ${response.status}${body ? ': ' + body.slice(0, 120) : ''}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Ollama request failed ${response.status}${body ? ': ' + body.slice(0, 120) : ''}`);
  }

  const data = (await response.json()) as OllamaGenerateResponse;
  // `think: false` should keep the answer in `response`, but older Ollama
  // builds ignore the flag rather than erroring, so fall back rather than
  // silently returning an empty string.
  return data.response || data.thinking || '';
}
