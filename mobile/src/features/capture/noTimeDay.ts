import type { CaptureProposalItem } from '../../api/schemas/capture';
import type { CaptureItemEdit } from './captureMachine';

/**
 * The day an item keeps when «بدون وقت» was chosen in the review edit sheet
 * (UAT round 3, N11).
 *
 * The confirm keeps an event on its day as an all-day event and drops a task's
 * day (the server's `keepEventOnItsDay`). The server marks the first kind
 * `eventOnDay`, so the card and the Saved screen name the day only when the
 * saved commitment will actually have it — «الجمعة · بدون وقت» for the
 * dentist, a bare «بدون وقت» for a call.
 */
export function dayKeptWithoutTime(
  item: Pick<CaptureProposalItem, 'resolvedDate' | 'eventOnDay'> | undefined,
  edit: CaptureItemEdit | undefined,
): string | undefined {
  return edit?.localDateTime === '' && item?.eventOnDay === true ? item.resolvedDate : undefined;
}
