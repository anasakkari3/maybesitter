import type {
  MemoryCandidate,
  CommitmentMemoryStatus,
  NotificationDecision,
  NotificationReasonCode,
  CommitmentMemory,
} from './memoryTypes.ts';

export function classifyCommitmentStatus(candidate: MemoryCandidate): CommitmentMemoryStatus | null {
  if (candidate.candidateType !== 'commitment') return null;

  switch (candidate.modality) {
    case 'possible':
    case 'conditional':
      return 'mentioned';
    case 'intended':
      return 'proposed';
    case 'certain':
      return candidate.temporal?.resolvedAt ? 'scheduled' : 'confirmed';
    case 'negated':
      return null;
    case 'reported':
      return 'mentioned';
  }
}

export type ConfirmationLevel = 'auto_accept' | 'soft_confirmation' | 'hard_confirmation';

export function decideConfirmationLevel(candidate: MemoryCandidate): ConfirmationLevel {
  if (candidate.modality === 'certain' && candidate.confidence >= 0.90) {
    return 'auto_accept';
  }
  if (candidate.modality === 'intended' || (candidate.modality === 'certain' && candidate.confidence < 0.90)) {
    return 'soft_confirmation';
  }
  return 'hard_confirmation';
}

export function evaluateNotificationEligibility(commitment: CommitmentMemory): NotificationDecision {
  const reasons: NotificationReasonCode[] = [];

  if (!['confirmed', 'scheduled'].includes(commitment.status)) {
    reasons.push('STATUS_NOT_CONFIRMED');
  }
  if (!commitment.dueAt) {
    reasons.push('MISSING_TIME');
  }
  if (commitment.confidence < 0.85) {
    reasons.push('LOW_CONFIDENCE');
  }
  if (commitment.requiresConfirmation) {
    reasons.push('USER_CONFIRMATION_REQUIRED');
  }

  if (reasons.length > 0) {
    return { eligible: false, reasonCodes: reasons };
  }

  return {
    eligible: true,
    scheduledAt: commitment.dueAt,
    reasonCodes: ['ELIGIBLE'],
  };
}
