import type {
  CaptureConfirmationResultContract,
  CaptureProposalContract,
} from '../../../src/contracts/v1/captureContracts';

/** A versioned proposal writer lost its compare-and-swap. */
export class ProposalChangedError extends Error {
  constructor(
    readonly proposal: CaptureProposalContract,
    readonly state: 'open' | 'confirmed',
    readonly confirmation?: CaptureConfirmationResultContract,
  ) {
    super('proposal changed');
    this.name = 'ProposalChangedError';
  }
}

export function proposalRevision(proposal: Pick<CaptureProposalContract, 'revision'>): number {
  return Number.isInteger(proposal.revision) && (proposal.revision as number) >= 0 ? proposal.revision as number : 0;
}

export function revisionMatches(current: number, requested: unknown): boolean {
  return requested === undefined ? current === 0 : Number.isInteger(requested) && requested === current;
}
