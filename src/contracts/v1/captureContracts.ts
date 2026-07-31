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

/** A proposal cannot claim or imply persistence. */
export interface CaptureProposalContract {
  version: typeof CAPTURE_CONTRACT_VERSION;
  proposalId: string;
  status: CaptureProposalStatus;
  items: CaptureProposalItemContract[];
  provenance: {
    requestedEngine: 'model' | 'rules';
    executedEngine: 'ollama' | 'rule-based';
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

