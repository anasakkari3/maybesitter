/**
 * TypeSafe Jev, as the Gmail triage stage uses it: one yes/no probability for
 * "is this mail worth a full read", for a fraction of a Gemini read's price
 * (`lib/features/pricing.ts`: $0.042 / 1M input tokens, output free).
 *
 * It is a scorer, not a reader. Nothing it answers is stored or shown; the only
 * thing that follows from it is whether the expensive read happens, and every
 * failure answers `null` so the caller reads the mail fully (fail open on
 * quality, never on cost of a missed commitment).
 *
 * Config is read on every call, like the kill switches:
 *   - `MAYBESITTER_JEV_API_KEY` (secret). Empty: no request is made at all.
 *   - `MAYBESITTER_JEV_URL`, default the jevai.org decisions endpoint.
 *   - `MAYBESITTER_JEV_MODEL`, default `typesafe-ai/jev`.
 *
 * Never logged: the key, the request body (it carries mail text) and the
 * response body. A failure leaves one content-free line naming its kind.
 */

export const DEFAULT_JEV_URL = 'https://www.jevai.org/api/v1/decisions';
export const DEFAULT_JEV_MODEL = 'typesafe-ai/jev';
export const DEFAULT_JEV_TIMEOUT_MS = 3_000;

export const RELEVANCE_INSTRUCTIONS = 'Does this email ask the recipient to do something, or contain a commitment, '
  + 'appointment, meeting, deadline, payment due date or event the recipient may need to act on or attend? '
  + 'Answer yes if unsure.';

export interface JevScore {
  /** Probability that the answer is yes, in [0, 1]. */
  readonly probability: number;
  readonly inputTokens: number;
  readonly model: string;
}

export interface JevDeps {
  readonly fetchImpl?: typeof fetch;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
}

type FailureKind = 'http' | 'malformed' | 'timeout' | 'network';

function unavailable(kind: FailureKind): null {
  console.warn(`[llm/jev] unavailable: ${kind}`);
  return null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * jevai.org wraps a result as `{ code, message, data }`; TypeSafe's direct API
 * answers `{ model, answers, usage }` unwrapped. Both are read.
 */
function parse(body: unknown, fallbackModel: string): JevScore | null {
  const outer = record(body);
  if (!outer) return null;
  const out = record(outer.data) ?? outer;
  const relevant = record(record(out.answers)?.relevant);
  const probability = relevant?.noul;
  if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) return null;
  const tokens = record(out.usage)?.input_tokens;
  const inputTokens = typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0 ? Math.trunc(tokens) : 0;
  const model = typeof out.model === 'string' && out.model ? out.model : fallbackModel;
  return { probability, inputTokens, model };
}

export async function scoreWithJev(input: { state: string }, deps: JevDeps = {}): Promise<JevScore | null> {
  const env = deps.env ?? process.env;
  const key = (env.MAYBESITTER_JEV_API_KEY ?? '').trim();
  if (!key) return null;
  const url = (env.MAYBESITTER_JEV_URL ?? '').trim() || DEFAULT_JEV_URL;
  const model = (env.MAYBESITTER_JEV_MODEL ?? '').trim() || DEFAULT_JEV_MODEL;
  const fetchImpl = deps.fetchImpl ?? ((resource, init) => fetch(resource, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_JEV_TIMEOUT_MS);
  try {
    const decision = {
      model,
      state: input.state,
      questions: { relevant: { type: 'noul', instructions: RELEVANCE_INSTRUCTIONS } },
    };
    // jevai.org also serves the same decision as an MCP tool (`jev_decide`)
    // at `/api/mcp`; its `structuredContent` is the REST `data` object.
    const mcp = /\/api\/mcp\/?$/.test(url);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          ...(mcp ? { Accept: 'application/json, text/event-stream' } : {}),
        },
        body: JSON.stringify(mcp
          ? { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'jev_decide', arguments: decision } }
          : decision),
        signal: controller.signal,
      });
    } catch {
      return unavailable(controller.signal.aborted ? 'timeout' : 'network');
    }
    if (!response.ok) return unavailable('http');
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return unavailable(controller.signal.aborted ? 'timeout' : 'malformed');
    }
    if (mcp) {
      const result = record(record(body)?.result);
      if (!result || result.isError === true) return unavailable('http');
      body = { data: result.structuredContent };
    }
    return parse(body, model) ?? unavailable('malformed');
  } finally {
    clearTimeout(timer);
  }
}
