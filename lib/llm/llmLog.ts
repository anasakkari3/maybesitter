/**
 * What a model call is allowed to say about itself (UC-2.0, #160).
 *
 * One structured line per call, carrying what an operator needs to answer "is
 * it working, what is it costing, and why did that fall back" — and nothing
 * that could reconstruct what a person typed.
 *
 * ── The rule, stated as a list because it is a list ──────────────
 *
 * Never logged: the prompt, the response, a commitment title, the raw capture
 * text, an email, a token, a credential, or a provider error body. A provider's
 * error message routinely quotes the request that failed, and the request is
 * the user's sentence — which is why the provider maps every failure to a
 * reason of ours before it gets here.
 *
 * ── The uid is hashed, not omitted ───────────────────────────────
 *
 * Omitting it entirely would make "one account is looping" unanswerable. A
 * Firebase uid is a random 28-character token, not an email, so a truncated
 * SHA-256 of it is a stable pseudonym rather than a lookup table over anything
 * guessable. `MAYBESITTER_LLM_UID_SALT` makes it stronger where it is set; it
 * is not required, and its absence is not a silent downgrade because the thing
 * being hashed is already high-entropy.
 */
import { createHash } from 'node:crypto';
import type { LlmPurpose, LlmProviderName } from '../../src/extraction/llm/llmProvider';

export type LlmOutcome = 'ok' | 'schema_invalid' | 'repaired' | 'unavailable' | 'cost_cap';

export interface LlmCallLog {
  event: 'llm_call';
  purpose: LlmPurpose;
  provider: LlmProviderName;
  model: string;
  location: string;
  uidHash: string;
  latencyMs: number;
  promptTokens: number;
  outputTokens: number;
  outcome: LlmOutcome;
  fallbackReason?: string;
}

/** A stable pseudonym for one account: 16 hex characters, 64 bits. */
export function uidHash(uid: string): string {
  const salt = process.env.MAYBESITTER_LLM_UID_SALT ?? '';
  return createHash('sha256').update(`${salt}${uid}`).digest('hex').slice(0, 16);
}

/**
 * Writes the line.
 *
 * Deliberately `console.info` with a JSON string: Cloud Run parses that into a
 * structured entry, and nothing here needs a logging framework whose
 * formatters could be configured to include more than this object.
 */
export function logLlmCall(entry: LlmCallLog): void {
  console.info(JSON.stringify(entry));
}
