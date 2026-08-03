import type { CommitmentMemory, NotificationDecision } from '../domain/memory/memoryTypes.ts';
import { evaluateNotificationEligibility } from '../domain/memory/memoryPolicy.ts';

export interface NotificationAction {
  type: 'schedule' | 'cancel' | 'reschedule' | 'none';
  commitmentId: string;
  scheduledAt?: string;
  reason: string;
  decision: NotificationDecision;
}

export function decideNotificationAction(
  commitment: CommitmentMemory,
  previousCommitment: CommitmentMemory | null,
): NotificationAction {
  const decision = evaluateNotificationEligibility(commitment);

  if (!previousCommitment) {
    if (decision.eligible) {
      return {
        type: 'schedule',
        commitmentId: commitment.id,
        scheduledAt: decision.scheduledAt,
        reason: 'New eligible commitment',
        decision,
      };
    }
    return {
      type: 'none',
      commitmentId: commitment.id,
      reason: `Not eligible: ${decision.reasonCodes.join(', ')}`,
      decision,
    };
  }

  const wasPreviouslyEligible = evaluateNotificationEligibility(previousCommitment).eligible;

  if (wasPreviouslyEligible && !decision.eligible) {
    return {
      type: 'cancel',
      commitmentId: commitment.id,
      reason: `No longer eligible: ${decision.reasonCodes.join(', ')}`,
      decision,
    };
  }

  if (!wasPreviouslyEligible && decision.eligible) {
    return {
      type: 'schedule',
      commitmentId: commitment.id,
      scheduledAt: decision.scheduledAt,
      reason: 'Became eligible after update',
      decision,
    };
  }

  if (wasPreviouslyEligible && decision.eligible && previousCommitment.dueAt !== commitment.dueAt) {
    return {
      type: 'reschedule',
      commitmentId: commitment.id,
      scheduledAt: decision.scheduledAt,
      reason: 'Due date changed while eligible',
      decision,
    };
  }

  return {
    type: 'none',
    commitmentId: commitment.id,
    reason: 'No change in notification state',
    decision,
  };
}
