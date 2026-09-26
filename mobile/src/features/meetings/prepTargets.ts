/**
 * Where «حضّرني» is offered (CL5a), decided without reading a calendar title.
 *
 * Two places. A **busy block** from the phone's calendar carries a start, an
 * end and nothing else (`busyBlocks.ts` strips every event down to that), so
 * any timed block that has not started is a meeting the person may want to
 * prepare for — they are the one who knows what it is, and the sheet asks.
 * A **commitment** is the person's own words, so its title may be read: it is
 * offered when it names a meeting or an appointment, or was stored as a
 * scheduled event.
 *
 * The notice and horizon mirror the server (`meetingPrepService.ts`), so a
 * button that is shown is a request the server will take.
 */
import type { DeviceBusyBlock } from '../calendar/busyBlocks';
import type { Commitment } from '../../api/schemas/common';
import type { MeetingPrepTarget } from '../../state/types';

const MINUTE = 60_000;
/** The server refuses a meeting starting sooner than ten minutes from now. */
export const PREP_MIN_NOTICE_MS = 10 * MINUTE;
/** …or one more than sixty days away. */
export const PREP_MAX_AHEAD_MS = 60 * 24 * 60 * MINUTE;

export function canPrepareFor(startAt: string, now: Date): boolean {
  const start = Date.parse(startAt);
  if (!Number.isFinite(start)) return false;
  // A minute of slack for the time between the tap and the request.
  return start >= now.getTime() + PREP_MIN_NOTICE_MS + MINUTE && start <= now.getTime() + PREP_MAX_AHEAD_MS;
}

export function busyBlockPrepTarget(block: DeviceBusyBlock, now: Date): MeetingPrepTarget | null {
  if (block.allDay || !canPrepareFor(block.startAt, now)) return null;
  return { startAt: block.startAt, endAt: block.endAt };
}

/**
 * Whether the person's own title names a meeting.
 *
 * Arabic and Hebrew are matched as stems with no `\b`: a JS word boundary
 * next to those letters only fires beside ASCII (#401). The Arabic stems carry
 * their own article and prefixes — «الاجتماع», «بالموعد» — for the same
 * reason.
 */
const MEETING_WORDS = [
  /اجتماع|ميت[ي]?ن[غج]|موعد|مقابل[ةه]|لقاء|زوم/,
  /פגיש|ראיון|תור ל|שיחת (?:זום|עבודה)/,
  /\b(?:meeting|meetings|appointment|interview|call with|sync|standup|stand-up|1:1|one-on-one|zoom)\b/i,
];

export function isMeetingLike(title: string): boolean {
  return MEETING_WORDS.some((pattern) => pattern.test(title));
}

export function commitmentPrepTarget(
  commitment: Pick<Commitment, 'title' | 'status' | 'timeSpec'>,
  now: Date,
): MeetingPrepTarget | null {
  if (commitment.status !== 'active') return null;
  const { kind, dueAt, endAt, allDay } = commitment.timeSpec;
  if (!dueAt || allDay || !canPrepareFor(dueAt, now)) return null;
  if (kind !== 'scheduled_event' && !isMeetingLike(commitment.title)) return null;
  return { startAt: dueAt, endAt: endAt && Date.parse(endAt) > Date.parse(dueAt) ? endAt : null };
}
