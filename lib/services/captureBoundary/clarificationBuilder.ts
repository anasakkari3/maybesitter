/**
 * The one question worth asking, chosen deterministically (UC-2.5, #165).
 *
 * -- Why this is not the model's job -----------------------------
 *
 * A model asked to phrase a clarification will eventually phrase one that is
 * long, or leading, or wrong in Arabic. The answer is applied to somebody's
 * commitment, so a question they cannot trust is worse than no question at all.
 *
 * So the *decision* is a function of the extraction result, and the *words* are
 * an i18n key the phone renders. Nothing here returns prose.
 *
 * -- One question, chosen by what is most missing ----------------
 *
 * Priority is action > time_period > which_day > time, and it is an ordering of
 * how useless the commitment is without the answer:
 *
 *   no action        there is nothing to be reminded *to do*. Everything else
 *                    is decoration on an empty commitment.
 *   a bare hour      the product knows the number and is guessing which half of
 *                    the day. That guess is a twelve-hour error, and it is the
 *                    one a user can settle with a single tap.
 *   no day           a time with no date cannot be scheduled at all.
 *   no time          a day with no hour is the mildest case: the item is real
 *                    and the question is only when.
 *
 * -- Nothing in the past is ever offered ------------------------
 *
 * Every option is filtered against `now` before it is returned. Offering
 * somebody "this morning" at four in the afternoon invites them to tap it, and
 * then the commitment is refused on save for being in the past -- which reads
 * as the product breaking rather than the product having asked a bad question.
 */
import { randomUUID } from 'crypto';
import type {
  ClarificationContract,
  ClarificationOptionContract,
} from '../../../src/contracts/v1/captureContracts';
import type { ExtractionResult } from '../../../src/extraction/extractionTypes';
import { localTimeSpecFor, instantFromLocal } from '../../../src/extraction/timeLexicon';

export interface ClarificationContext {
  now: Date;
  timezone: string;
}

/** The hours the product offers for a named part of the day. */
const DAYPART_OPTIONS: readonly { optionId: string; labelKey: string; localTime: string }[] = [
  { optionId: 'morning', labelKey: 'morning', localTime: '09:00' },
  { optionId: 'afternoon', labelKey: 'afternoon', localTime: '14:00' },
  { optionId: 'evening', labelKey: 'evening', localTime: '19:00' },
];

/**
 * The hour a typed part of the day means as an answer: the one its button
 * uses (FY1 re-review). The lexicon reads «المسا» as 18:00 while the «المسا»
 * button is 19:00, so at 18:08 a typed «بالمسا» rolled to tomorrow while the
 * button still offered tonight. Parts with no button keep the lexicon's hour.
 */
const LEXICON_HOUR_TO_OPTION: Readonly<Record<number, string>> = { 9: 'morning', 14: 'afternoon', 18: 'evening' };
export function answeredDayPartTime(lexiconHour: number): string {
  const option = DAYPART_OPTIONS.find((candidate) => candidate.optionId === LEXICON_HOUR_TO_OPTION[lexiconHour]);
  return option ? option.localTime : `${String(lexiconHour).padStart(2, '0')}:00`;
}

/** `YYYY-MM-DD` for a day offset from now, on the user's own clock. */
function localDay(context: ClarificationContext, offsetDays: number): string | null {
  const shifted = new Date(context.now.getTime() + offsetDays * 86_400_000);
  return localTimeSpecFor(shifted, context.timezone)?.date ?? null;
}

/** True when a local date and time is still ahead of `now`. */
function isFuture(date: string, time: string, context: ClarificationContext): boolean {
  const instant = instantFromLocal(date, time, context.timezone);
  return instant !== null && instant.getTime() > context.now.getTime();
}

/**
 * The day an option should land on.
 *
 * Today when the time is still ahead of now, otherwise tomorrow. This is what
 * keeps "evening" meaning *this* evening at two in the afternoon and *tomorrow*
 * evening at eleven at night, without asking a second question about which day.
 */
function dayFor(time: string, context: ClarificationContext): string | null {
  const today = localDay(context, 0);
  if (today && isFuture(today, time, context)) return today;
  return localDay(context, 1);
}

/**
 * The day a local time should land on, preferring the day the item already
 * named when that time on it is still ahead (#165).
 *
 * Exported for the free-text answer: "in the evening" typed into the box has to
 * land on the same day the Evening button would have, or the two ways of giving
 * one answer disagree about when it is.
 */
export function dayForAnswer(
  time: string,
  preferredDate: string | null,
  context: ClarificationContext,
): string | null {
  // A day the item names is the day the answer is about (UAT round 6, batch
  // 3): «المسا» typed at 23:29 to «أي ساعة يوم الاثنين؟» was put on Tuesday.
  // When that hour on it has gone there is no answer here, never another day.
  if (preferredDate) return isFuture(preferredDate, time, context) ? preferredDate : null;
  const day = dayFor(time, context);
  return day && isFuture(day, time, context) ? day : null;
}

/** The local hour a resolved instant fell on, or null. */
function resolvedLocalTime(result: ExtractionResult, context: ClarificationContext): string | null {
  if (result.localTimeSpec?.time) return result.localTimeSpec.time;
  // An all-day reading's `dueAt` is its midnight, not an hour anybody said (FX3).
  if (result.allDay) return null;
  const instant = result.remindAt ?? result.dueAt;
  if (!instant) return null;
  return localTimeSpecFor(new Date(Date.parse(instant)), context.timezone)?.time ?? null;
}

/** The local date the item already has, from either source. */
function resolvedLocalDate(result: ExtractionResult, context: ClarificationContext): string | null {
  if (result.localTimeSpec?.date) return result.localTimeSpec.date;
  const instant = result.remindAt ?? result.dueAt;
  if (!instant) return null;
  return localTimeSpecFor(new Date(Date.parse(instant)), context.timezone)?.date ?? null;
}

function option(
  optionId: string,
  labelKey: string,
  labelParams: Record<string, string>,
  value: { localTime?: string; localDate?: string },
): ClarificationOptionContract {
  return { optionId, labelKey, labelParams, value };
}

/**
 * Builds the question, or returns null when there is nothing worth asking.
 *
 * Null is a real answer: an item with an action and a resolved time has no
 * question, and an item whose only sensible options have all fallen into the
 * past has none either -- in which case the caller falls back to #164's edit
 * sheet rather than asking something unanswerable.
 */
export function buildClarification(
  result: ExtractionResult,
  context: ClarificationContext,
): ClarificationContract | null {
  const title = (result.title ?? result.action ?? '').trim();
  const flags = result.ambiguityFlags;
  const hasAction = Boolean(result.action && result.action.trim().length >= 3);
  const localTime = resolvedLocalTime(result, context);
  const localDate = resolvedLocalDate(result, context);

  // 1. No action. Nothing else matters: there is nothing to be reminded to do.
  if (!hasAction || flags.includes('vague_action') || flags.includes('no_action_verb')) {
    return {
      questionId: randomUUID(),
      field: 'action',
      questionKey: 'ask_action',
      params: {},
      // No options: the product cannot guess what somebody meant to do, and a
      // list of guesses would be worse than an empty field.
      options: [],
      allowFreeText: true,
    };
  }

  // 2. A bare hour. The number is the user's; which half of the day is ours.
  if (result.timeEvidence === 'clock_marker' && localTime) {
    const hour = Number(localTime.slice(0, 2));
    if (Number.isFinite(hour) && hour >= 1 && hour <= 11) {
      const morning = `${String(hour).padStart(2, '0')}:${localTime.slice(3, 5)}`;
      const evening = `${String(hour + 12).padStart(2, '0')}:${localTime.slice(3, 5)}`;
      const day = localDate ?? dayFor(evening, context);
      const options = day
        ? [
          option('am', 'amPmOption', { hour: String(hour), period: 'am' }, { localTime: morning, localDate: day }),
          option('pm', 'amPmOption', { hour: String(hour), period: 'pm' }, { localTime: evening, localDate: day }),
        ].filter((candidate) => isFuture(day, candidate.value.localTime!, context))
        : [];
      // Both in the past means the day itself is wrong, and am/pm is the wrong
      // question to ask about it.
      if (options.length > 0) {
        return {
          questionId: randomUUID(),
          field: 'time_period',
          questionKey: 'ask_am_pm',
          params: { hour: String(hour), title },
          options,
          allowFreeText: false,
        };
      }
    }
  }

  // 3. A time, but no day to put it on.
  if (localTime && !localDate) {
    const options = [
      { optionId: 'today', labelKey: 'today', offset: 0 },
      { optionId: 'tomorrow', labelKey: 'tomorrow', offset: 1 },
    ]
      .map(({ optionId, labelKey, offset }) => {
        const date = localDay(context, offset);
        return date ? option(optionId, labelKey, {}, { localDate: date, localTime }) : null;
      })
      .filter((candidate): candidate is ClarificationOptionContract => candidate !== null)
      .filter((candidate) => isFuture(candidate.value.localDate!, localTime, context));

    if (options.length > 0) {
      return {
        questionId: randomUUID(),
        field: 'which_day',
        questionKey: 'ask_day',
        params: { title, time: localTime },
        options,
        allowFreeText: true,
      };
    }
  }

  // 4. A day, but no hour. The mildest case: the item is real, the question is
  //    only when.
  //
  //    The question names the item's day («أي ساعة يوم الاثنين، 28 سبتمبر؟»),
  //    so every part it offers is on that day, and a part of it that has gone
  //    is not offered at all (UAT round 6, batch 3). It used to be offered on
  //    tomorrow under the same heading: «المسا» tapped at 23:29 saved «بكرا ·
  //    19:00» with nothing said. When every part of the day has gone, «بدون
  //    وقت محدد» and the typed box are what is left — a day the person types
  //    («بكرا المسا») is theirs to choose. Only an item with no day at all has
  //    its parts on the next day they are ahead.
  if (!localTime) {
    const options = DAYPART_OPTIONS
      .map(({ optionId, labelKey, localTime: time }) => {
        const day = localDate ?? dayFor(time, context);
        return day && isFuture(day, time, context)
          ? option(optionId, labelKey, {}, { localTime: time, localDate: day })
          : null;
      })
      .filter((candidate): candidate is ClarificationOptionContract => candidate !== null);

    // "No specific time" is always offered, and carries no value: a commitment
    // without an hour is a legitimate thing to want, and forcing a time would
    // be the product insisting on an answer the user does not have.
    options.push(option('none', 'noTime', {}, {}));

    return {
      questionId: randomUUID(),
      field: 'time',
      questionKey: 'ask_time',
      // The day the hour is for, when there is one, so the question can say
      // which Sunday it means (L4). A key, not prose: the phone formats it.
      params: localDate ? { title, date: localDate } : { title },
      options,
      allowFreeText: true,
    };
  }

  // An action and a time it can trust. Nothing to ask.
  return null;
}
