/**
 * Alpha interaction trace contracts.
 *
 * For each relevant session the trace allows reconstruction of:
 *   pseudonymous ID, user input, extractor interpretation, commitment/proposal
 *   state, context supplied to recommendation logic, model/path used,
 *   proposal shown, latency/error/fallback, accept/edit/defer/dismiss/done
 *   outcome, before/after edit content, and explicit feedback flags.
 *
 * Raw content is NOT sent to analytics. Records have bounded retention.
 * Private messages are never ingested.
 */

export const ALPHA_TRACE_VERSION = 'alpha-trace-v1';

/** A single stage record within a session trace. */
export type AlphaTraceStage =
  | 'input_received'
  | 'extraction_completed'
  | 'commitment_created'
  | 'commitment_confirmed'
  | 'commitment_edited'
  | 'recommendation_generated'
  | 'recommendation_shown'
  | 'proposal_decided'
  | 'proposal_edited'
  | 'feedback_flagged';

export interface AlphaTraceStageRecord {
  readonly stage: AlphaTraceStage;
  readonly timestamp: string;
  /** Stage-specific payload. Shape varies by stage. */
  readonly payload: Record<string, unknown>;
}

export interface AlphaTraceSession {
  readonly version: typeof ALPHA_TRACE_VERSION;
  readonly sessionId: string;
  readonly participantId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly stages: readonly AlphaTraceStageRecord[];
}

/** Summary for quick review without loading full trace. */
export interface AlphaTraceSummary {
  readonly sessionId: string;
  readonly participantId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly stageCount: number;
  readonly stages: readonly AlphaTraceStage[];
  readonly hasDecisions: boolean;
  readonly hasFeedback: boolean;
  readonly hasErrors: boolean;
}

/* ── Payload shape helpers ──────────────────────────────────────── */

export interface InputReceivedPayload {
  readonly inputText: string;
}

export interface ExtractionCompletedPayload {
  readonly engine: 'rule-based' | 'ollama' | 'unknown';
  readonly type: string;
  readonly title: string | null;
  readonly disposition: string;
  readonly remindAt: string | null;
  readonly dueAt: string | null;
  readonly confidence: number;
  readonly fallbackReason: string | null;
}

export interface CommitmentCreatedPayload {
  readonly commitmentId: string;
  readonly title: string;
  readonly status: string;
}

export interface RecommendationGeneratedPayload {
  readonly proposalId: string;
  readonly state: string;
  readonly primaryStep: string | null;
  readonly arm: string;
  readonly fallbackReason: string | null;
}

export interface RecommendationShownPayload {
  readonly proposalId: string;
  readonly latencyMs: number;
  readonly costMicros: number | null;
}

export interface ProposalDecidedPayload {
  readonly proposalId: string;
  readonly decision: string;
  readonly decidedAt: string;
}

export interface ProposalEditedPayload {
  readonly proposalId: string;
  readonly originalTitle: string;
  readonly editedTitle: string;
}

export interface FeedbackFlaggedPayload {
  readonly flagId: string;
  readonly category: string;
  readonly proposalId: string;
  readonly note: string | null;
}
