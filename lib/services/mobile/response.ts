import type { Commitment } from '../../../src/domain/stateMachine';
import type { RankedItem } from '../../priority/mobileRanking';

/**
 * One commitment, as the phone reads it.
 *
 * `rank` and `reasonCodes` are present only when the priority module is on
 * (UC-2.8, #169) — absent means "this build does not rank", which the client
 * renders as the time order it has always used, rather than as rank 0.
 */
export function commitmentToMobileDto(commitment: Commitment, ranked?: RankedItem) {
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
    ...(ranked ? { rank: ranked.rank, reasonCodes: ranked.reasonCodes } : {}),
  };
}

export function commitmentListResponse(
  commitments: Commitment[],
  ranking?: Map<string, RankedItem>,
) {
  return {
    items: commitments.map((commitment) => commitmentToMobileDto(commitment, ranking?.get(commitment.id))),
  };
}

export function mobileError(message: string, status = 400): Response {
  return Response.json({ success: false, error: message }, { status });
}
