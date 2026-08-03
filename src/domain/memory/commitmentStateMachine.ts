import type { CommitmentMemoryStatus } from './memoryTypes.ts';

export const allowedTransitions: Record<CommitmentMemoryStatus, CommitmentMemoryStatus[]> = {
  mentioned: ['proposed', 'confirmed', 'scheduled', 'cancelled'],
  proposed: ['confirmed', 'scheduled', 'cancelled', 'postponed'],
  confirmed: ['scheduled', 'completed', 'cancelled', 'postponed'],
  scheduled: ['completed', 'cancelled', 'postponed', 'expired'],
  postponed: ['proposed', 'confirmed', 'scheduled', 'cancelled'],
  completed: [],
  cancelled: [],
  expired: [],
};

export class InvalidCommitmentTransitionError extends Error {
  from: CommitmentMemoryStatus;
  to: CommitmentMemoryStatus;

  constructor(from: CommitmentMemoryStatus, to: CommitmentMemoryStatus) {
    super(`Invalid transition from "${from}" to "${to}"`);
    this.name = 'InvalidCommitmentTransitionError';
    this.from = from;
    this.to = to;
  }
}

export function assertValidTransition(from: CommitmentMemoryStatus, to: CommitmentMemoryStatus): void {
  if (!allowedTransitions[from].includes(to)) {
    throw new InvalidCommitmentTransitionError(from, to);
  }
}

export function isTerminalStatus(status: CommitmentMemoryStatus): boolean {
  return allowedTransitions[status].length === 0;
}
