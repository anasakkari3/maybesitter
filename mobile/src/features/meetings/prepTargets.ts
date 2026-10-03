/**
 * Where «حضّرني» is offered (CL5a), decided without reading a calendar title.
 *
 * Three places. A **busy block** from the phone's calendar carries a start, an
 * end and nothing else (`busyBlocks.ts` strips every event down to that), so
 * any timed block that has not started is a meeting the person may want to
 * prepare for — they are the one who knows what it is, and the sheet asks.
 * A **commitment** is the person's own words, so its title may be read: it is
 * offered when it names a meeting or an appointment, or was stored as a
 * scheduled event. A **fixed row on the Plan** is such a commitment too.
 *
 * The notice and horizon mirror the server (`meetingPrepService.ts`), so a
 * button that is shown is a request the server will take.
 */
import type { DeviceBusyBlock } from '../calendar/busyBlocks';
import type { Commitment } from '../../api/schemas/common';
import type { PlanItem } from '../../api/schemas/plan';
import type { MeetingPrepTarget } from '../../state/types';
import { APPOINTMENT_NOUNS } from '../../../../src/extraction/lexicon/appointmentNouns';

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

/*
 * Whether the person's own title names a meeting or an appointment (M-4).
 *
 * The nouns are the extractor's (`src/extraction/lexicon/appointmentNouns.ts`,
 * the list `captureCommand.ts` builds from), so "a meeting" means one thing on
 * the server and on the phone. What this file adds is the word edges, and a few
 * meeting words the extractor has no use for (`MEETING_ONLY_NOUNS`).
 *
 * The edges are spelled as letter ranges, with no `\b` and no `\p{L}`: a JS
 * word boundary next to Arabic or Hebrew letters only fires beside ASCII (#401),
 * and a Unicode property class is exactly the kind of thing Hermes may read
 * differently from the Node that runs the tests. A noun must stand as a word of
 * its own, with the prefixes a sentence gives it — «الاجتماع», «بالموعد»,
 * «واجتماعنا», «הפגישה», «בראיון» — so «مش لزوم» is not a Zoom call and
 * «نشاط اجتماعي» is not a meeting. Hebrew «תור» takes only ה/ו: «בתור» is
 * "as" (the priority lexicon's rule).
 */
const AR_LETTER = '\u0621-\u065F\u0670-\u06D3\u06FA-\u06FF';
const HE_LETTER = '\u05B0-\u05EA';

type Nouns = { readonly ar: readonly string[]; readonly he: readonly string[]; readonly en: readonly string[] };

function escape(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** One test for a set of nouns, each standing as a word of its own. */
function nounMatcher(nouns: Nouns): (title: string) => boolean {
  const ar = nouns.ar.length > 0 ? new RegExp(
    `(?:^|[^${AR_LETTER}])(?:و|ف)?(?:بال|عال|ال|ب)?(?:${nouns.ar.map(escape).join('|')})(?:نا)?(?=$|[^${AR_LETTER}])`,
  ) : null;
  const heOthers = nouns.he.filter((noun) => noun !== 'תור');
  const heAlternatives = [
    ...(heOthers.length > 0 ? [`ו?(?:ה|ל|ב|ש)?(?:${heOthers.map(escape).join('|')})`] : []),
    ...(nouns.he.includes('תור') ? ['ו?ה?תור'] : []),
  ];
  const he = heAlternatives.length > 0
    ? new RegExp(`(?:^|[^${HE_LETTER}])(?:${heAlternatives.join('|')})(?=$|[^${HE_LETTER}])`)
    : null;
  const en = nouns.en.length > 0 ? new RegExp(`\\b(?:${nouns.en.map(escape).join('|')})s?\\b`, 'i') : null;
  return (title) => Boolean(ar?.test(title) || he?.test(title) || en?.test(title));
}

/**
 * The ways people name a meeting that are not appointment nouns (M-4, round 2).
 *
 * The phone's own, because the extractor has no use for them: «سجّل لقاء» is
 * not how anyone starts a reminder, but «لقاء مع سامي» is how many people title
 * a meeting, and so are «زوم», "standup", "sync", "1:1" and "call with". A bare
 * "call" is not here — "Call mum" is an errand; «שיחה» is only a meeting with
 * someone («שיחה עם»). The same word edges as the shared nouns, so «مش لزوم»
 * still is not «زوم».
 */
const MEETING_ONLY_NOUNS = {
  ar: ['لقاء', 'ميتنج', 'ميتينج', 'زوم'],
  he: ['זום', 'ישיבה', 'ישיבת', 'שיחה עם'],
  en: ['standup', 'stand-up', 'sync', '1:1', 'one-on-one', 'call with', 'zoom call', 'zoom'],
} as const;

/** Any of the extractor's appointment nouns, or a meeting word of the phone's own. */
export const isMeetingLike = nounMatcher({
  ar: [...APPOINTMENT_NOUNS.ar, ...MEETING_ONLY_NOUNS.ar],
  he: [...APPOINTMENT_NOUNS.he, ...MEETING_ONLY_NOUNS.he],
  en: [...APPOINTMENT_NOUNS.en, ...MEETING_ONLY_NOUNS.en],
});

/**
 * Which of those are a *meeting*: the shared list's meeting nouns and every
 * meeting word above, so the sheet can say «الموعد» for the dentist and
 * «الاجتماع» for the meeting.
 */
const MEETING_NOUNS = new Set<string>(['اجتماع', 'ميتنغ', 'ميتينغ', 'פגישה', 'meeting']);
const namesMeeting = nounMatcher({
  ar: [...APPOINTMENT_NOUNS.ar.filter((noun) => MEETING_NOUNS.has(noun)), ...MEETING_ONLY_NOUNS.ar],
  he: [...APPOINTMENT_NOUNS.he.filter((noun) => MEETING_NOUNS.has(noun)), ...MEETING_ONLY_NOUNS.he],
  en: [...APPOINTMENT_NOUNS.en.filter((noun) => MEETING_NOUNS.has(noun)), ...MEETING_ONLY_NOUNS.en],
});

/**
 * An appointment that is not a meeting: a doctor, an exam, a flight. A title
 * that names both reads as the meeting, and one with neither (a scheduled
 * event, a busy block) is a meeting too, which is what the sheet has always
 * called it.
 */
export function isAppointmentNotMeeting(title: string): boolean {
  return isMeetingLike(title) && !namesMeeting(title);
}

function targetFor(title: string, startAt: string, endAt: string | null, commitmentId?: string): MeetingPrepTarget {
  return {
    startAt,
    endAt: endAt && Date.parse(endAt) > Date.parse(startAt) ? endAt : null,
    ...(isAppointmentNotMeeting(title) ? { appointment: true } : {}),
    // The person's own commitment, so the server can read what it is (audit
    // 2026-10-03 #3: an exam gets a day of lead). Never a calendar block's.
    ...(commitmentId ? { commitmentId } : {}),
  };
}

export function commitmentPrepTarget(
  commitment: Pick<Commitment, 'title' | 'status' | 'timeSpec'> & { id?: string },
  now: Date,
): MeetingPrepTarget | null {
  if (commitment.status !== 'active') return null;
  const { kind, dueAt, endAt, allDay } = commitment.timeSpec;
  if (!dueAt || allDay || !canPrepareFor(dueAt, now)) return null;
  if (kind !== 'scheduled_event' && !isMeetingLike(commitment.title)) return null;
  return targetFor(commitment.title, dueAt, endAt, commitment.id);
}

/**
 * A fixed row on the Plan (a commitment pinned to a time), when it is a
 * meeting or an appointment that has not started. The row carries the
 * commitment's own title, the same words Details reads.
 */
export function planItemPrepTarget(item: Pick<PlanItem, 'itemId' | 'title' | 'startsAt' | 'endsAt' | 'endEstimated'>, now: Date): MeetingPrepTarget | null {
  if (!item.title || !isMeetingLike(item.title) || !canPrepareFor(item.startsAt, now)) return null;
  // A fixed row's id is its commitment's (`fixedRowsOf`): sent, so an exam
  // planned from here gets the same day-before preparation as from Details
  // (review of audit #3).
  // An end the planner guessed is no end of the event's (audit #11).
  return targetFor(item.title, item.startsAt, item.endEstimated === true ? null : item.endsAt, item.itemId);
}
