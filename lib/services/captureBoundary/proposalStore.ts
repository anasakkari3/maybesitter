import type { Command } from '../../../src/domain/stateMachine';
import type { CaptureProposalContract } from '../../../src/contracts/v1/captureContracts';

export interface StoredCaptureProposal {
  contract: CaptureProposalContract;
  scopeId: string;
  commandsByItemId: ReadonlyMap<string, readonly Command[]>;
  confirmedResult?: unknown;
  idempotencyKey?: string;
}

export interface CaptureProposalStore {
  put(proposal: StoredCaptureProposal): void;
  get(proposalId: string): StoredCaptureProposal | undefined;
}

export class MemoryCaptureProposalStore implements CaptureProposalStore {
  private readonly proposals = new Map<string, StoredCaptureProposal>();

  put(proposal: StoredCaptureProposal): void {
    this.proposals.set(proposal.contract.proposalId, proposal);
  }

  get(proposalId: string): StoredCaptureProposal | undefined {
    return this.proposals.get(proposalId);
  }
}

