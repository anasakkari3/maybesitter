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
import { createHash, randomUUID } from 'node:crypto';
import type { LlmPurpose, LlmProviderName } from '../../src/extraction/llm/llmProvider';
import type { CostFeatureKind, CostOperationStatus } from '../../src/contracts/v1/costAttributionContracts';
import { buildLlmObservabilityEnvelope, type LlmObservabilityEnvelope } from './observability';

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

export interface AttributedLlmCallLog extends LlmCallLog {
  /** The existing log line carries attribution; this is not another usage store. */
  attribution: LlmObservabilityEnvelope;
}

const FEATURE_FOR_PURPOSE: Readonly<Record<LlmPurpose, CostFeatureKind>> = Object.freeze({
  capture_extraction: 'capture',
  profile_extraction: 'other',
  importance_estimate: 'planning',
  plan_explanation: 'planning',
  share_extraction: 'share_intake',
  // Reading a profile about the person, same as `profile_extraction`: it is not
  // capture, not planning, and not an integration sync.
  ai_context_import: 'other',
});

function statusFor(outcome: LlmOutcome): CostOperationStatus {
  if (outcome === 'ok' || outcome === 'repaired') return 'success';
  if (outcome === 'cost_cap') return 'blocked_by_policy';
  return 'failure';
}

export function attributedLlmCall(
  entry: LlmCallLog,
  options: { readonly occurredAt?: string; readonly eventId?: string } = {},
): AttributedLlmCallLog {
  const occurredAt = options.occurredAt ?? new Date().toISOString();
  return {
    ...entry,
    attribution: buildLlmObservabilityEnvelope({
      eventId: options.eventId ?? randomUUID(),
      // The raw account id must not be reintroduced by the attribution layer.
      scopeId: entry.uidHash,
      occurredAt,
      feature: FEATURE_FOR_PURPOSE[entry.purpose],
      provider: 'llm',
      providerOperation: `${entry.provider}:${entry.purpose}`,
      status: statusFor(entry.outcome),
      inputTokens: entry.promptTokens,
      outputTokens: entry.outputTokens,
    }),
  };
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
  console.info(JSON.stringify(attributedLlmCall(entry)));
}
