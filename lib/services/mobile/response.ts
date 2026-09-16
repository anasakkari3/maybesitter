import type { Commitment } from '../../../src/domain/stateMachine';
import type { RankedItem } from '../../priority/mobileRanking';
import type { DeviceCalendarLink } from '../calendar/deviceCalendarLinks';

/**
 * One commitment, as the phone reads it.
 *
 * `rank` and `reasonCodes` are present only when the priority module is on
 * (UC-2.8, #169) — absent means "this build does not rank", which the client
 * renders as the time order it has always used, rather than as rank 0.
 *
 * `deviceCalendarLink` (UC-3.1, #185) draws the same distinction, and it is the
 * reason it is optional rather than always null. **Absent** means this response
 * did not look the link up; **null** means it looked and there is none. A
 * client that treated the two as one would read a 409 conflict body — which
 * carries a commitment but no link, because a refusal is not a source of sync
 * state — as proof that the user's calendar event had been unlinked, and would
 * write a second one.
 *
 * The lists and the single-commitment reads always answer, so the reconcile
 * pass has a complete picture from exactly the responses it already holds.
 */
export function commitmentToMobileDto(
  commitment: Commitment,
  ranked?: RankedItem,
  link?: DeviceCalendarLink | null,
) {
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
    ...(link === undefined ? {} : { deviceCalendarLink: link }),
  };
}

/**
 * `calendarOrphans` is the other half of the calendar sync (UC-3.1, #185).
 *
 * The rows say which event each commitment owns; this says which events are
 * owned by a commitment that is gone. A phone cannot work the second out for
 * itself — a commitment that vanished from a list and a commitment that was
 * cancelled look identical from there — and without it "deleting the commitment
 * removes the event" is a promise no code keeps.
 *
 * Absent means this response did not compute it, and `[]` means it did and
 * there are none, for the same reason `deviceCalendarLink` distinguishes the
 * two: the sync deletes what appears here, so "I did not look" must never be
 * readable as "I looked and found nothing".
 */
export function commitmentListResponse(
  commitments: Commitment[],
  ranking?: Map<string, RankedItem>,
  links?: Map<string, DeviceCalendarLink>,
  calendarOrphans?: { commitmentId: string; link: DeviceCalendarLink }[],
) {
  return {
    items: commitments.map((commitment) => commitmentToMobileDto(
      commitment,
      ranking?.get(commitment.id),
      // `?? null` rather than the lookup's own undefined: a list that was given
      // the link map answers for every row, including the rows with no link.
      links === undefined ? undefined : links.get(commitment.id) ?? null,
    )),
    ...(calendarOrphans === undefined ? {} : { calendarOrphans }),
  };
}

export function mobileError(message: string, status = 400): Response {
  return Response.json({ success: false, error: message }, { status });
}
