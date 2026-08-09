import type { Commitment } from '../../../src/domain/stateMachine';

export function commitmentToMobileDto(commitment: Commitment) {
  return {
    id: commitment.id,
    kind: commitment.kind,
    title: commitment.title,
    description: commitment.description,
    person: commitment.person,
    status: commitment.status,
    priority: commitment.priority,
    timeSpec: commitment.timeSpec,
    currentAckState: commitment.currentAckState,
    postponedUntil: commitment.postponedUntil,
    createdAt: commitment.createdAt,
    updatedAt: commitment.updatedAt,
    confirmedAt: commitment.confirmedAt,
    completedAt: commitment.completedAt,
    droppedAt: commitment.droppedAt,
  };
}

export function commitmentListResponse(commitments: Commitment[]) {
  return {
    items: commitments.map(commitmentToMobileDto),
  };
}

export function mobileError(message: string, status = 400): Response {
  return Response.json({ success: false, error: message }, { status });
}
