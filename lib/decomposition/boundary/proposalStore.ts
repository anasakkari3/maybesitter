/**
 * Where a proposal waits between being offered and being ruled on.
 *
 * Deliberately not persistence. `DECOMPOSITION_PERSISTENCE_POLICY.proposalCanPersist`
 * is false, and this store is in-memory and keyed only by proposal id so that
 * "the proposal is stored" can never be mistaken for "the steps exist".
 */

import type { DecompositionProposal, DecompositionConfirmationResult } from '../../../src/contracts/v1/decompositionContracts';

export interface StoredDecompositionProposal {
  readonly proposal: DecompositionProposal;
  readonly scopeId: string;
  /** Set once the proposal has been confirmed; a spent proposal is not re-confirmable. */
  confirmedResult?: DecompositionConfirmationResult;
  idempotencyKey?: string;
}

export interface DecompositionProposalStore {
  put(stored: StoredDecompositionProposal): void;
  get(proposalId: string): StoredDecompositionProposal | undefined;
}

export class MemoryDecompositionProposalStore implements DecompositionProposalStore {
  private readonly proposals = new Map<string, StoredDecompositionProposal>();

  put(stored: StoredDecompositionProposal): void {
    this.proposals.set(stored.proposal.proposalId, stored);
  }

  get(proposalId: string): StoredDecompositionProposal | undefined {
    return this.proposals.get(proposalId);
  }
}
