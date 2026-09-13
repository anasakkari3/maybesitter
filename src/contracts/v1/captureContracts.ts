import { MODULE_CONTRACT_VERSION } from './moduleContracts';

export const CAPTURE_CONTRACT_VERSION = MODULE_CONTRACT_VERSION;

export type CaptureProposalStatus =
  | 'proposed'
  | 'needs_clarification'
  | 'no_commitment'
  | 'rejected';

export interface CaptureProposalItemContract {
  itemId: string;
  title: string;
  resolvedTime: string | null;
  needsClarification: boolean;
}

/**
 * Why a capture produced nothing (UC-2.6, #166).
 *
 * Present only on a `no_commitment` proposal, and used for one thing: choosing
 * which single neutral line the client shows. It carries no content — a reason
 * code, not a reading of what the person wrote — and the client maps it to fixed
 * copy rather than composing a sentence about it.
 *
 * `informational`, `greeting_or_chat`, `question` and `past_event` describe what
 * kind of message arrived. `negated_request` is someone asking not to be
 * reminded, which used to be answered with HTTP 400 — an error, for a request
 * the product understood perfectly and was right to refuse. `low_confidence` is
 * the extractor not having read enough to propose anything.
 */
export type NoCommitmentReason =
  | 'informational'
  | 'greeting_or_chat'
  | 'question'
  | 'past_event'
  | 'negated_request'
  | 'low_confidence';

/** A proposal cannot claim or imply persistence. */
export interface CaptureProposalContract {
  version: typeof CAPTURE_CONTRACT_VERSION;
  proposalId: string;
  status: CaptureProposalStatus;
  /** Set only when `status` is `no_commitment`. */
  noCommitmentReason?: NoCommitmentReason;
  items: CaptureProposalItemContract[];
  provenance: {
    requestedEngine: 'model' | 'rules';
    executedEngine: 'gemini' | 'ollama' | 'rule-based';
    fallbackUsed: boolean;
  };
}

export interface CaptureConfirmationRequestContract {
  proposalId: string;
  scopeId: string;
  selectedItemIds: string[];
  idempotencyKey: string;
}

export interface CaptureConfirmationResultContract {
  version: typeof CAPTURE_CONTRACT_VERSION;
  success: boolean;
  replayed: boolean;
  persistedItemIds: string[];
  failureCode?: 'proposal_not_found' | 'proposal_rejected' | 'invalid_selection' | 'persistence_failed';
}

export const CAPTURE_PERSISTENCE_POLICY = Object.freeze({
  proposalCanPersist: false,
  confirmationRequired: true,
  adapterOwnsCanonicalWrites: true,
  atomicBatchRequired: true,
  rawInputInAudit: false,
});

