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
  return data.response ?? '';
}
