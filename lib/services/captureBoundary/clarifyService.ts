import { randomUUID } from 'crypto';
import { dayPartHour, forbidsResolvedTime, hourWithDayPart, instantFromLocal, isBareEarlyHourAnswer, localTimeSpecFor, namesDay, namesTwelveInTheEvening, nightClockHour, relativeDayOffset, relativeDaySource, statesClock, timeAnchorOf, typedHalfOfDay, withoutTimeOfDay } from '../../../src/extraction/timeLexicon';
import { PastCommitmentTimeError } from '../mobile/safety';
import { endOfRange, mapExtractionToCommand } from '../../../src/extraction/mapExtractionToCommand';
import { recurrenceHintOf } from '../../../src/extraction/extractionService';
import { withWeeklyBlockOffers } from '../../weeklyBlocks/offer';
import { extractWithFallback, type ExtractAndMapOptions } from '../../../src/extraction/extractionService';
import type { ExtractionResult } from '../../../src/extraction/extractionTypes';
import { resolveModuleRuntime, type RuntimeControlSnapshot } from '../../../src/contracts/v1/runtimeControls';
import {
  CAPTURE_EDIT_TITLE_MAX,
  CLARIFICATION_FREE_TEXT_MAX,
  type CaptureProposalContract,
  type ClarificationContract,
} from '../../../src/contracts/v1/captureContracts';
import type { Command } from '../../../src/domain/stateMachine';
import { applyEditToCommands } from './applyEdits';
import { answeredDayPartTime, buildClarification, dayForAnswer, resolvedLocalTime } from './clarificationBuilder';
import { dateIsGuess, hourIsPartOfDayGuess } from './timeGuess';
import { namesCalendarDate, namesExplicitDate, readWeekdayReference, resolveWeekdayDate, WEEKDAY_MENTION_SOURCES } from '../../../src/extraction/weekdayLexicon';
import { isEventOnDay } from '../../../src/extraction/priorityLexicon';
import type { CaptureProposalStore, StoredCaptureProposal } from './proposalStore';
import { finalizeUnderstood } from './understood';

/**
 * Answering the one question (UC-2.5, #165).
 *
 * ── The answer is applied to the extraction, not to the contract ─
 *
 * A `resolvedTime` patched onto the proposal would leave the *command* behind —
 * and the command is what a confirm persists. Somebody answering "nine in the
 * evening" would see 21:00 on the review screen and get a commitment at 09:00.
 * So the answer edits the stored `ExtractionResult` and the command is rebuilt
 * by `mapExtractionToCommand`, the same function that built it the first time.
 *
 * ── One round, and then the edit sheet ───────────────────────────
 *
 * A product that asks twice has stopped being a capture box and become an
 * interview. A second attempt on the same item is refused; the item comes back
 * with `needsClarification: true` and `clarification: null`, which the app reads
 * as "open UC-2.4 (#164)'s edit sheet instead".
 *
 * ── Free text is re-read, never pasted in ────────────────────────
 *
 * "make it 9" is not a title. It is re-extracted together with the original
 * segment so the extractor resolves it the same way it resolves everything
 * else — including the injection screen, which a raw splice past the extractor
 * would have skipped. It is read by the same engine the capture was: the
 * model when this account's AI consent allows it, the rules when it does not.
 *
 * ── An answer settles the question it answers ───────────────────
 *
 * Only the field that was asked about is taken from the answer: a time answer
 * moves the time and leaves the title the user saw alone. And the user's
 * explicit answer is what settles it — not the extractor's confidence, which
 * it did not change. An item flagged for low confidence and then told "in the
 * evening" used to come back still flagged, with no question left to ask and
 * no command, so nothing could be saved (the dead end found on the first
 * device run). After an accepted answer an item is confirmable, with commands.
 *
 * An answer nothing can be read out of is refused as `answer_not_understood`
 * *before* the round is spent, so the question stays up and the person can
 * pick an option instead.
 */
export type ClarifyFailure =
  | 'proposal_not_found'
  | 'item_not_found'
  | 'question_mismatch'
  | 'already_clarified'
  | 'answer_required'
  | 'free_text_too_long'
  | 'option_not_found'
  /**
   * Free text to a question that takes none (`allowFreeText: false`, the am/pm
   * question). The round is not spent; an option still answers it.
   */
  | 'free_text_not_allowed'
  /** Free text that answered nothing the question asked. The round is not spent. */
  | 'answer_not_understood';

export interface ClarifyInput {
  proposalId: string;
  itemId: string;
  questionId: string;
  optionId?: string | undefined;
  freeText?: string | undefined;
}

export interface ClarifyOptions {
  now: Date;
  timezone: string;
  scopeId: string;
}

export interface ClarifyDependencies {
  store: CaptureProposalStore;
  extractor?: typeof extractWithFallback;
  /**
   * The model, when this account's AI consent allows one — the same provider
   * the capture was read with. Absent means the rules read the answer, and
   * nothing is sent anywhere: the default is never a model call.
   */
  llmProvider?: ExtractAndMapOptions['llmProvider'];
  llmEngine?: ExtractAndMapOptions['llmEngine'];
  controls?: RuntimeControlSnapshot;
  /**
   * Where the answer is written down.
   *
   * Required, and called without a `?.`, because it was neither: the port was
   * optional and the call was optional-chained, the single production
   * construction site never passed one, and so for the whole life of UC-2.5
   * the event was assembled and dropped with nothing that could go red about
   * it. A missing implementation is now a type error at the construction site
   * rather than silence at runtime — which is the only version of this the
   * suite can defend.
   *
   * `{ type:'clarification_answered', … }`. The free text itself is never in it.
   */
  recordEvent: (event: ClarificationAnsweredEvent) => void | Promise<void>;
}

export interface ClarificationAnsweredEvent {
  type: 'clarification_answered';
  proposalId: string;
  itemId: string;
  field: string;
  answerKind: 'option' | 'free_text';
  at: string;
}

export class ClarifyError extends Error {
  constructor(readonly failure: ClarifyFailure, message?: string) {
    super(message ?? failure);
  }
}

/** The local date and time an answered item should resolve to. */
function appliedLocal(
  result: ExtractionResult,
  value: { localTime?: string; localDate?: string },
): { date: string | null; time: string | null } {
  return {
    date: value.localDate ?? result.localTimeSpec?.date ?? null,
    // An option with neither a time nor a date is the "no specific time"
    // choice: a deliberate answer, and the reason `time` is set to null rather
    // than left as whatever the extractor had guessed.
    time: value.localTime ?? (value.localDate ? result.localTimeSpec?.time ?? null : null),
  };
}

/**
 * "No specific time" (#474): the person chose no hour, so nothing the extractor
 * guessed about one survives.
 *
 * When the question named a day — «أي ساعة يوم الاثنين، 28 سبتمبر؟» — the
 * answer is "that day, no hour", not "no day": the review card goes on saying
 * «لحد بكرا», and the saved commitment used to have no date at all, so the
 * week called it «بلا موعد» and put «أتصل بسامي», due tomorrow, on Friday (UAT
 * round 2, N3). It is kept as FX3's all-day shape — the day's local midnight,
 * no reminder, a limit («لحد») — the one the review already shows. Without a
 * day it is what it always was: no time at all, the shape a "No time" edit
 * produces (`applyEdits`).
 */
function noHourAnswer(result: ExtractionResult, fallbackZone: string): ExtractionResult {
  const date = result.localTimeSpec?.date ?? null;
  const zone = result.localTimeSpec?.timezone || fallbackZone;
  const midnight = date ? instantFromLocal(date, '00:00', zone) : null;
  if (!date || !midnight) return { ...result, remindAt: null, dueAt: null } as ExtractionResult;
  return {
    ...result,
    dueAt: midnight.toISOString(),
    remindAt: null,
    localTimeSpec: { date, time: null, timezone: zone },
    timeAnchor: 'deadline',
    allDay: true,
  } as ExtractionResult;
}

function withResolvedTime(
  result: ExtractionResult,
  local: { date: string | null; time: string | null },
  timezone: string,
): ExtractionResult {
  if (!local.date) return result;
  const instant = local.time ? instantFromLocal(local.date, local.time, timezone) : null;
  // A day answered: the hour that waited for one (FIX-R8-CAPTURE) is placed.
  const { undatedTime: _undated, ...placed } = result;
  return {
    ...placed,
    // The person's zone travels with the answer (FZ1 round 3 add-on): left
    // out, the command was drafted in UTC, and an appointment cleared to «بدون
    // وقت» at confirm landed on UTC midnight instead of its local one.
    localTimeSpec: { date: local.date, time: local.time, timezone },
    // Only the reminder moves. `dueAt` is the deadline the user named, and an
    // answer about *when to be reminded* is not permission to move it.
    remindAt: instant ? instant.toISOString() : null,
    dueAt: instant ? instant.toISOString() : result.dueAt,
    // The user said it, so the evidence is theirs now rather than the
    // extractor's reading.
    timeEvidence: local.time ? 'explicit' : result.timeEvidence,
    // An hour answered is no longer a whole day (FX3).
    allDay: local.time ? false : result.allDay,
  } as ExtractionResult;
}

/**
 * Drafts an answer left flagged, made confirmable.
 *
 * The extractor's confidence measured how well *it* read the sentence; once
 * the person has answered the question it was unsure about, a score below the
 * policy's floor is no longer a reason to hold the item back. And what is
 * still missing after the one round (a follow-up's person, a time the
 * question was not about) is the review screen's to show and the edit sheet's
 * to fix. It is not a reason to strand the item: the user sees it and presses
 * Confirm themselves, so `pending_confirmation` is exactly what it is.
 */
function settleDrafts(commands: readonly Command[]): Command[] {
  return commands.map((command) => (
    command.type === 'CreateDraft' && command.draftStatus !== 'pending_confirmation'
      ? { ...command, draftStatus: 'pending_confirmation' as const }
      : command
  ));
}

const TIME_FIELDS: ReadonlySet<ClarificationContract['field']> = new Set<ClarificationContract['field']>(['time', 'time_period', 'which_day']);
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;

/** A limit word in the sentence or in the answer keeps a deadline; otherwise a time to be at. */
function answeredTimeAnchor(rawText: string, freeText: string): 'event' | 'deadline' {
  return timeAnchorOf(rawText) === 'deadline' || (freeText !== '' && timeAnchorOf(freeText) === 'deadline')
    ? 'deadline'
    : 'event';
}

/**
 * An appointment answered "no specific time", kept on its day (closure UAT
 * round 2, FY1 N4).
 *
 * «سجّل موعد دكتور يوم الأحد» answered «بدون وقت محدد» used to lose its day:
 * the answer cleared the time and the day with it, the commitment was stored
 * `unscheduled`, the card read «لحد الأحد» as if it were a deadline, and the
 * day plan put the doctor on today. An appointment happens *on* its day, so
 * it is an all-day `scheduled_event` there — `dueAt` that day's local
 * midnight, `allDay` saying nobody chose the hour (`TimeSpec.allDay`).
 *
 * Only for what happens on a day (`isEventOnDay`: an appointment, a meeting,
 * a wedding — FY1 review, event branch), and only with a day. A task
 * answered the same way is unchanged.
 */
function allDayAppointment(result: ExtractionResult, timezone: string): ExtractionResult | null {
  const date = result.localTimeSpec?.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (result.type !== 'task' && result.type !== 'follow_up') return null;
  if (!isEventOnDay(result.rawText ?? '')) return null;
  const midnight = instantFromLocal(date, '00:00', timezone);
  if (!midnight) return null;
  return {
    ...result,
    dueAt: midnight.toISOString(),
    remindAt: null,
    localTimeSpec: { date, time: null, timezone },
    timeEvidence: 'day_only',
    allDay: true,
    timeAnchor: 'event',
    missingFields: result.missingFields.filter((field) => field !== 'time'),
  } as ExtractionResult;
}

/*
 * A typed number with a half of the day and no clock word — «5 المسا», «5 م»,
 * "5 in the evening", «5 בערב» (FZ1 review, M5a): that hour in that half,
 * 17:00. The time question's button hours (09/14/19) are for a part of the
 * day typed with no number; with one, FY1's button mapping gave 19:00.
 *
 * Only the number right before the part of the day (FZ1 round 4); a count or
 * a date is not an hour. The words and the halves are the capture's own
 * (`hourWithDayPart`, closure UAT round 6), so «خمسة المسا» typed here and
 * said in the capture are the same 17:00, and «12 الصبح» is asked in both.
 */
function typedHourWithHalf(freeText: string): string | 'ambiguous' | null {
  if (statesClock(freeText)) return null;
  return hourWithDayPart(freeText);
}

/**
 * The day a typed answer names on its own — «بكرا», "tonight", «מחר», «الخميس»
 * — on the person's clock, or null (FY1 re-review 2, R2-M1). Read from the
 * answer alone: re-read together with «سجّل موعد دكتور يوم الأحد», the
 * sentence's Sunday came first and «بكرا المسا» stayed on Sunday.
 */
function dayTypedIn(freeText: string, options: ClarifyOptions): string | 'ambiguous' | null {
  const today = localTimeSpecFor(options.now, options.timezone)?.date ?? null;
  if (!today) return null;
  return typedDay(freeText, (text) => dayOf(text, today, options));
}

/** The day one day expression (or a whole answer) names, on the person's clock. */
function dayOf(text: string, today: string, options: ClarifyOptions): string | null {
  const offset = relativeDayOffset(text);
  if (offset !== null) {
    const [year, month, day] = today.split('-').map(Number) as [number, number, number];
    return new Date(Date.UTC(year, month - 1, day + offset)).toISOString().slice(0, 10);
  }
  return resolveWeekdayDate(text, options.now, options.timezone)?.date ?? null;
}

/*
 * Which day a typed answer means (POLISH-CAPTURE review I3; rounds 3 and 4).
 *
 * Negations in free text do not converge: «ما بقدر بكرا المسا», "I can't
 * tomorrow evening", «مش الأحد، الأحد اللي بعد الجاي» each settled on a day
 * the person had ruled out, one reading at a time. So an answer with any
 * negation or "can't" in it is refused — not understood, the buttons stay —
 * unless it is one of two plain shapes (round 4):
 *
 *   (a) a leading «لا/لأ/لاء»/"no/nope/nah"/«לא», then straight away the one day, and no
 *       other negation («לא יכול מחר» is "I can't", not "no — tomorrow"):
 *       «لا بكرا المسا», «لا، بكرا المسا», "no, tomorrow evening" → that day;
 *   (b) «مش/مو/لا»/"not"/«לא» X, then a comma or «بس»/"but"/«אבל», then Y —
 *       X nothing but a day, Y opening with one: «مش اليوم، بكرا المسا», "not today but
 *       tomorrow evening" → Y. Each is read with the words after it up to
 *       the next comma, so a week suffix is kept («مش الأحد، الأحد اللي بعد
 *       الجاي» → the Sunday after); when X and Y are the same date the answer
 *       is refused («مش الخميس، الخميس اللي بعده» → both read 1 Oct).
 *
 * Words that only look like a negation — «مش مشكلة», "no problem», «بعد ما»,
 * «شو ما», «ما بعد الضهر», «אין בעיה» — are set aside first.
 *
 * With no negation: one day is that day (read from the whole answer, so «الأحد
 * اللي بعد الجاي» keeps its week); two days, an alternative («بدل», «أو»,
 * «ولا», "or") or "the next day" is refused. Null when no day is named.
 */
const NOT_LETTER_BEFORE_WORD = "(?<![\\p{L}\\p{M}'’])";
const NOT_LETTER_AFTER_WORD = '(?![\\p{L}\\p{M}])';
const NOT_A_NEGATION = new RegExp(`${NOT_LETTER_BEFORE_WORD}(?:${[
  'مش\\s+مشكلة', 'مو\\s+مشكلة', 'لا\\s+مشكلة', 'ما\\s+في(?:ه|ش)?\\s+مشكلة', 'مافي\\s+مشكلة',
  '(?:بعد|قبل|شو|وين|متى|كل|زي|مثل|متل|أول|اول|قد|حسب|مهما)\\s+ما', 'ما\\s+بعد\\s+(?:الضهر|الظهر)',
  'no\\s+(?:problem|worries)', 'not\\s+a\\s+problem', 'אין\\s+בעיה',
].join('|')})${NOT_LETTER_AFTER_WORD}`, 'giu');
const NEGATION = new RegExp(`${NOT_LETTER_BEFORE_WORD}(?:${[
  'مش', 'مو', 'ما', 'لا', 'لأ', 'لاء', 'مب', 'ليس', 'لست', 'لن', 'مافي', 'مستحيل', 'بلاش', 'أبد\\p{M}*ا\\p{M}*', 'ابد\\p{M}*ا\\p{M}*',
  // Busy is "I can't" too (round 4 addendum). «عندي شغل» is left out: "I have work" is not plainly a refusal.
  'مشغول', 'مشغولة', 'مشغوله',
  'not', 'no', 'nope', 'nah', 'never', 'cannot', 'cant', 'wont', 'dont', 'unable', 'impossible', 'busy', "[a-z]+n['’]t",
  'לא', 'אין', 'אי', 'עסוק', 'עסוקה',
].join('|')})${NOT_LETTER_AFTER_WORD}`, 'iu');
const LEADING_NO_SHAPE = /^\s*(?:لا|لأ|لاء|no|nope|nah|לא)(?:\s*[,،]\s*|\s+)([\s\S]+)$/i;
const RULED_OUT_SHAPE = /^\s*(?:مش|مو|لا|not|לא)\s+([^,،]+?)(?:\s*[,،]\s*(?:(?:بس|but|אבל)\s+)?|\s+(?:بس|but|אבל)\s+)([\s\S]+)$/i;
const DAY_ALTERNATIVE = /(?:^|[\s,،])(?:بدل|بدال|عوض|أو|او|ولا|or|instead|או|במקום)(?=$|[\s,،?؟])/i;
const DAY_AFTER_TODAY = /(?:^|[\s,،])(?:[وف]?(?:اليوم|النهار)\s+(?:التاني|الثاني|التالي)|(?:تاني|ثاني)\s+يوم|למחרת)(?=$|[\s,،])|\b(?:the\s+)?(?:next|following)\s+day\b/i;
const DAY_MENTIONS: readonly RegExp[] = [
  ...([0, 1, 2] as const).map((offset) => new RegExp(relativeDaySource(offset), 'giu')),
  ...WEEKDAY_MENTION_SOURCES.map((source) => new RegExp(source, 'giu')),
  /\b(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi,
];

function dayMentions(text: string): Array<{ start: number; end: number }> {
  const found = DAY_MENTIONS.flatMap((pattern) => Array.from(text.matchAll(pattern), (match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  })));
  // «بعد بكرا» holds «بكرا», "day after tomorrow" holds "tomorrow": one mention.
  return found.filter((mention) => !found.some((other) => other !== mention
    && other.start <= mention.start && other.end >= mention.end && (other.end - other.start) > (mention.end - mention.start)));
}

const dayMentionCount = (text: string): number => dayMentions(text).length;

/** "this"/"the"/«هاد» before a day are part of saying it. */
const DAY_LEAD = /^(?:(?:this|the|هاد|هادا|هاي)\s+)*/i;

/** The text opens with its one day: «بكرا المسا», "the Thursday after that", «ביום חמישי». */
function opensWithTheDay(text: string): boolean {
  const rest = text.trim().replace(DAY_LEAD, '');
  const mentions = dayMentions(rest);
  return mentions.length === 1 && mentions[0]!.start === 0;
}

/** The text is its one day and nothing else: «بكرا», "this Sunday", «الأحد». */
function isOnlyTheDay(text: string): boolean {
  const rest = text.trim().replace(DAY_LEAD, '');
  const mentions = dayMentions(rest);
  return mentions.length === 1 && mentions[0]!.start === 0 && rest.slice(mentions[0]!.end).trim() === '';
}

function hasNegation(text: string): boolean {
  return NEGATION.test(text.replace(NOT_A_NEGATION, ' '));
}

/** The first comma-separated part: a day read "with the words after it up to the next comma". */
const firstPart = (text: string): string => text.split(/[,،]/)[0] ?? text;

function typedDay(freeText: string, dateOf: (text: string) => string | null): string | 'ambiguous' | null {
  if (DAY_AFTER_TODAY.test(freeText)) return 'ambiguous';
  if (!hasNegation(freeText)) {
    const count = dayMentionCount(freeText);
    if (count === 0) return null;
    if (count > 1 || DAY_ALTERNATIVE.test(freeText)) return 'ambiguous';
    return dateOf(freeText) ?? 'ambiguous';
  }
  if (DAY_ALTERNATIVE.test(freeText)) return 'ambiguous';
  // (a) «لا بكرا المسا»: one day after a leading «لا», nothing else negated.
  const leading = LEADING_NO_SHAPE.exec(freeText);
  if (leading && !hasNegation(leading[1]!) && opensWithTheDay(leading[1]!)) {
    return dateOf(leading[1]!) ?? 'ambiguous';
  }
  // (b) «مش X، Y» / "not X but Y": Y, unless it is X's own date.
  const ruledOut = RULED_OUT_SHAPE.exec(freeText);
  if (
    ruledOut && !hasNegation(ruledOut[2]!) && isOnlyTheDay(ruledOut[1]!)
    && dayMentionCount(ruledOut[2]!) === 1 && opensWithTheDay(firstPart(ruledOut[2]!))
  ) {
    const notThis = dateOf(ruledOut[1]!);
    const thisOne = dateOf(firstPart(ruledOut[2]!));
    if (notThis && thisOne && notThis !== thisOne) return thisOne;
  }
  return 'ambiguous';
}

/** An answered time already behind `now` is not an answer anyone can keep (FY1 review, I3). */
function notPast(answered: ExtractionResult, now: Date): ExtractionResult {
  const at = answered.remindAt ?? answered.dueAt;
  if (at && Date.parse(at) <= now.getTime()) throw new ClarifyError('answer_not_understood');
  return answered;
}

/** The time the answer named, applied to the item it answers and nothing else. */
function withTimeFrom(result: ExtractionResult, source: ExtractionResult): ExtractionResult {
  return {
    ...result,
    dueAt: source.dueAt ?? source.remindAt,
    remindAt: source.remindAt ?? source.dueAt,
    localTimeSpec: source.localTimeSpec,
    timeEvidence: source.timeEvidence,
  };
}

/**
 * The bare early hour an item waits to place on a day (FIX-R8-CAPTURE):
 * «والثاني الحنعة عال٦» is 6 with no day and no half. `HH:MM`, or null.
 */
function undatedBareEarlyHour(result: ExtractionResult): string | null {
  const time = result.undatedTime;
  if (!time || result.localTimeSpec || result.timeEvidence !== 'clock_marker') return null;
  const hour = Number(time.slice(0, 2));
  return hour >= 1 && hour <= 6 ? time : null;
}

/** That hour in the half a typed answer names — «الجمعة المسا» for a 6 is 18:00. */
function bareHourInHalf(time: string, half: 'am' | 'pm' | 'night'): string {
  const hour = Number(time.slice(0, 2));
  const inHalf = half === 'am' ? hour : half === 'pm' ? hour + 12 : nightClockHour(hour);
  return `${String(inHalf).padStart(2, '0')}:${time.slice(3, 5)}`;
}

/**
 * Reads a typed answer, and applies what it says to the field that was asked.
 *
 * The original text and the answer are re-read together, by the engine the
 * capture was allowed: the model under this account's consent, otherwise the
 * rules. Then only the asked field is taken:
 *
 *   a time question   the time the re-read found; failing that, a bare part of
 *                     the day ("بالمسا", "in the evening") on the day the
 *                     matching option would have used. The title stays.
 *   the action        the re-read's action when it found one; failing that,
 *                     the answer itself — it is the user's reply to "what do
 *                     you want to do?", screened by the same re-read and held
 *                     to the edit sheet's title bounds.
 *
 * Anything else is `answer_not_understood`, with the round intact.
 */
async function readFreeTextAnswer(
  result: ExtractionResult,
  question: ClarificationContract,
  freeText: string,
  options: ClarifyOptions,
  dependencies: ClarifyDependencies,
): Promise<ExtractionResult> {
  const extractor = dependencies.extractor ?? extractWithFallback;
  const rulesOnly = resolveModuleRuntime('capture', dependencies.controls).mode === 'rules_only';
  // The original text plus what they added, read together. Splicing the words
  // straight into a field would skip the injection screen and the time
  // lexicon both.
  //
  // A time of day typed in answer to a time question replaces the one the
  // sentence had (FY1 review, I3). «اليوم الساعة 3 العصر لازم أبعت الإيميل»,
  // asked again at 18:08 because 15:00 had gone, was re-read with its 15:00
  // still in it: «الساعة 7 المسا» was refused as a past time (a generic 400)
  // and «بكرا الساعة 10» settled at 15:00 tomorrow. So the sentence is read
  // without its own times of day, its days kept.
  const replacesTime = TIME_FIELDS.has(question.field) && !forbidsResolvedTime(freeText);
  // «الساعة 4» typed alone: the unlikely morning or a guess (FY1 re-review);
  // not understood, and the صبح/مسا buttons are still there.
  if (TIME_FIELDS.has(question.field) && isBareEarlyHourAnswer(freeText)) throw new ClarifyError('answer_not_understood');
  if (TIME_FIELDS.has(question.field) && namesTwelveInTheEvening(freeText)) throw new ClarifyError('answer_not_understood');
  // The day the answer typed (R2-M1), read before anything else: an answer
  // that rules a day out outside the two plain shapes, names two days, or
  // hesitates is not understood — nothing is re-read (POLISH-CAPTURE round 4).
  const typed = TIME_FIELDS.has(question.field) ? dayTypedIn(freeText, options) : null;
  if (typed === 'ambiguous') throw new ClarifyError('answer_not_understood');
  // An hour waiting for its day (FIX-R8-CAPTURE) is placed only on a day the
  // person typed: "which day?" answered «المسا» is not today by default.
  if (question.field === 'which_day' && result.undatedTime && !typed && !readWeekdayReference(freeText) && !namesExplicitDate(freeText)) {
    throw new ClarifyError('answer_not_understood');
  }
  // …and a bare early one takes the half typed with the day: «الجمعة المسا»
  // is that 6 on Friday evening, 18:00 — not the evening button's 19:00.
  const waitingHour = question.field === 'which_day' ? undatedBareEarlyHour(result) : null;
  const waitingHalf = waitingHour && !statesClock(freeText) ? typedHalfOfDay(freeText) : null;
  if (waitingHour && waitingHalf && typeof typed === 'string') {
    const time = bareHourInHalf(waitingHour, waitingHalf);
    return notPast(withResolvedTime(result, { date: typed, time }, options.timezone), options.now);
  }
  // "What time?" answered with no time of day and no day — «بعد ساعة»,
  // "later", «אחר כך». Whatever hour a re-read finds is not one the person
  // typed: the sentence's own passed hour, or the engine's guess (closure UAT
  // round 3, FZ1 N10: Gemini re-read «اليوم الساعة 2 بالليل…» + «بعد ساعة» at
  // 03:22 as Tuesday 02:00, applied as «بكرا · 02:00»). Not understood; the
  // buttons stay. A named day alone («بكرا») keeps the person's own hour on
  // it (FY1 I4). (The am/pm question takes no typed answer at all.)
  if (question.field === 'time' && forbidsResolvedTime(freeText) && !namesDay(freeText) && !namesCalendarDate(freeText)) {
    throw new ClarifyError('answer_not_understood');
  }
  const original = replacesTime ? withoutTimeOfDay(result.rawText ?? '') : result.rawText ?? '';
  const combined = `${original}\n${freeText}`.trim();
  let extracted: Awaited<ReturnType<typeof extractor>>;
  try {
    extracted = await extractor(combined, { now: options.now, timezone: options.timezone }, {
      // Never the extractor's default: with no provider it would try a local
      // model, which is neither the consented engine nor the rules.
      llmProvider: !rulesOnly && dependencies.llmProvider
        ? dependencies.llmProvider
        : async () => { throw new Error('rules-only runtime'); },
      ...(dependencies.llmEngine ? { llmEngine: dependencies.llmEngine } : {}),
    });
  } catch (error) {
    // The guarded extractor refuses a reading whose time has gone, with the
    // reading. A typed time of day is placed on its next occurrence below, as
    // any typed hour is. Anything else — «بعد ساعة», "later", "now" — re-read
    // the clause's own passed hour, and taking that would roll it to tomorrow
    // unasked (FY1 re-review, I4): not understood. (A day named alone is
    // never refused here: «بكرا» re-reads the person's own 15:00 on it.)
    if (error instanceof PastCommitmentTimeError && error.extracted && replacesTime) extracted = error.extracted;
    else if (error instanceof PastCommitmentTimeError) throw new ClarifyError('answer_not_understood');
    else throw error;
  }
  if (extracted.fallbackReason?.startsWith('prompt_injection')) throw new ClarifyError('answer_not_understood');
  const reread = extracted.result;
  const readable = reread.type === 'task' || reread.type === 'follow_up';

  if (TIME_FIELDS.has(question.field)) {
    // Asked for the hour of a day the item already has, and answered with an
    // hour alone: the day stays the item's (CL1 round 2). Re-reading «سجّل
    // موعد دكتور يوم الأحد» + «الساعة 10 الصبح», Gemini put the doctor on the
    // Sunday after — the question was never about the day, and the review
    // card had just shown the 27th. Only the time of day is taken from the
    // re-read; a typed answer that names a day, or a "which day" question,
    // still moves it.
    const itemDate = result.localTimeSpec?.date ?? null;
    // The hour the re-read found, on the person's clock — from its wall clock,
    // or else from its instant (never an all-day reading's midnight). Read
    // from `localTimeSpec` alone, an instant-only reading of «at 10» to the
    // Sunday doctor had no hour here, fell through to the re-read's own
    // instant, and was saved on Thursday (UAT round 6, FIX-R6-TYPEDDAY).
    const rereadTime = resolvedLocalTime(reread, { now: options.now, timezone: options.timezone });
    // The day the answer typed wins over the item's (R2-M1): «بكرا المسا» to
    // the Sunday doctor is tomorrow evening. When the typed day cannot take
    // the typed hour — «اليوم الصبح» at 10:00 — the answer is not understood,
    // never quietly put on Sunday or tomorrow instead.
    const typedDay = typed;
    const onTypedDay = (answered: ExtractionResult): ExtractionResult => {
      if (typedDay && answered.localTimeSpec?.date !== typedDay) throw new ClarifyError('answer_not_understood');
      return answered;
    };
    // An hour typed alone answers the question about the item's day (UAT
    // round 6, batch 3). A re-read hour still ahead on that day was put on it
    // below; one that reaches here on another day either has gone on the
    // asked day — Gemini reading «المسا» at 23:29 as tomorrow — or was no
    // hour at all. Neither is the person's answer: not understood, never
    // another day unasked (FIX-R6-TYPEDDAY: the Sunday doctor answered «at
    // 10» was kept on the re-read's Thursday while 10:00 Sunday was ahead). A
    // day they type, name or date still moves it.
    const namesNoDay = !typedDay && !readWeekdayReference(freeText) && !namesExplicitDate(freeText);
    const onAskedDay = (answered: ExtractionResult): ExtractionResult => {
      if (!itemDate || !namesNoDay || question.field === 'which_day') return answered;
      const at = answered.remindAt ?? answered.dueAt;
      const local = at ? localTimeSpecFor(new Date(Date.parse(at)), options.timezone) : null;
      if ((answered.localTimeSpec?.date ?? local?.date ?? null) === itemDate) return answered;
      throw new ClarifyError('answer_not_understood');
    };
    // A part of the day typed with no clock is its button's hour (FY1
    // re-review): «بالمسا» is 19:00 like «المسا», tonight while it is ahead.
    // A day named with it is the re-read's; otherwise the item's.
    const typedPart = statesClock(freeText) ? null : dayPartHour(freeText, { answer: true });
    // A number typed with the half: that hour, not the button's (FZ1 review, M5a).
    const typedHour = typedHourWithHalf(freeText);
    if (typedHour === 'ambiguous') throw new ClarifyError('answer_not_understood');
    const numberedTime = typedHour;
    if (typedPart !== null || numberedTime) {
      const time = numberedTime ?? answeredDayPartTime(typedPart!);
      const namedDay = typedDay ?? (readWeekdayReference(freeText) || namesExplicitDate(freeText) ? reread.localTimeSpec?.date ?? null : null);
      const day = dayForAnswer(time, namedDay ?? itemDate, { now: options.now, timezone: options.timezone });
      if (day) return onTypedDay(withResolvedTime(result, { date: day, time }, options.timezone));
      if (typedDay) throw new ClarifyError('answer_not_understood');
    }
    if (
      readable && (reread.remindAt || reread.dueAt)
      && question.field !== 'which_day' && itemDate && rereadTime
      && !readWeekdayReference(freeText) && !namesExplicitDate(freeText)
    ) {
      const day = dayForAnswer(rereadTime, itemDate, { now: options.now, timezone: options.timezone });
      if (day) return withResolvedTime(result, { date: day, time: rereadTime }, options.timezone);
    }
    if (readable && (reread.remindAt || reread.dueAt)) {
      // The re-read's hour on the day the answer typed, whichever day the
      // engine put it on (R2-M1).
      if (typedDay && rereadTime) return notPast(withResolvedTime(result, { date: typedDay, time: rereadTime }, options.timezone), options.now);
      return notPast(onAskedDay(onTypedDay(withTimeFrom(result, reread))), options.now);
    }
    // The answer to "when?": its part of the day is the answer, even before
    // another word ("morning is fine").
    const hour = numberedTime ? null : dayPartHour(freeText, { answer: true });
    if (hour !== null) {
      const time = answeredDayPartTime(hour);
      const preferred = typedDay ?? result.localTimeSpec?.date
        ?? (result.remindAt || result.dueAt
          ? localTimeSpecFor(new Date(Date.parse((result.remindAt || result.dueAt)!)), options.timezone)?.date ?? null
          : null);
      const day = dayForAnswer(time, preferred, { now: options.now, timezone: options.timezone });
      if (day) return onTypedDay(withResolvedTime(result, { date: day, time }, options.timezone));
    }
    throw new ClarifyError('answer_not_understood');
  }

  // The action question. Its answer is a new title in the person's own words,
  // so an app-language title and the words it stood for go with the old one.
  const { sourceTitle: _sourceTitle, appTitle: _appTitle, ...unnamed } = result;
  const action = reread.action?.trim() ?? '';
  if (readable && action.length >= 3) {
    return {
      ...unnamed,
      action,
      title: (reread.title || action).trim(),
      type: reread.type,
      person: reread.person ?? result.person,
      // A time the re-read found is kept only when the item had none; the
      // question was not about it.
      ...(result.remindAt || result.dueAt ? {} : {
        dueAt: reread.dueAt, remindAt: reread.remindAt, localTimeSpec: reread.localTimeSpec, timeEvidence: reread.timeEvidence,
      }),
      ambiguityFlags: result.ambiguityFlags.filter((flag) => flag !== 'vague_action' && flag !== 'no_action_verb'),
    };
  }
  if (freeText.length >= 3 && freeText.length <= CAPTURE_EDIT_TITLE_MAX && !CONTROL_CHARACTERS.test(freeText)) {
    return {
      ...unnamed,
      type: result.type === 'follow_up' ? 'follow_up' : 'task',
      action: freeText,
      title: freeText,
      ambiguityFlags: result.ambiguityFlags.filter((flag) => flag !== 'vague_action' && flag !== 'no_action_verb'),
    };
  }
  throw new ClarifyError('answer_not_understood');
}

export async function answerClarification(
  input: ClarifyInput,
  options: ClarifyOptions,
  dependencies: ClarifyDependencies,
): Promise<CaptureProposalContract> {
  const stored = await dependencies.store.get(input.proposalId);
  if (!stored || stored.scopeId !== options.scopeId) throw new ClarifyError('proposal_not_found');

  const index = stored.contract.items.findIndex((item) => item.itemId === input.itemId);
  const item = stored.contract.items[index];
  if (!item) throw new ClarifyError('item_not_found');

  if ((stored.clarifiedItemIds ?? []).includes(input.itemId)) {
    throw new ClarifyError('already_clarified');
  }
  const question = item.clarification;
  if (!question || question.questionId !== input.questionId) {
    // A stale question id means the app is answering something this proposal is
    // no longer asking. Applying it would apply an answer to a different
    // question.
    throw new ClarifyError('question_mismatch');
  }

  const result = stored.resultsByItemId?.get(input.itemId);
  if (!result) throw new ClarifyError('item_not_found');
  // The item's stored clock is authoritative. The request zone is only a
  // fallback for proposals created before localTimeSpec carried one.
  const resolutionOptions: ClarifyOptions = {
    ...options,
    timezone: result.localTimeSpec?.timezone || options.timezone,
  };

  const freeText = typeof input.freeText === 'string' ? input.freeText.trim() : '';
  if (!input.optionId && !freeText) throw new ClarifyError('answer_required');
  if (freeText.length > CLARIFICATION_FREE_TEXT_MAX) throw new ClarifyError('free_text_too_long');

  // A question that offers only its options takes no typed answer (FY1
  // re-review, R2-M2). The phone shows no text box for it, but the server read
  // one anyway: «بعد بكرا pm» and "I am not sure" typed to «5 الصبح ولا
  // المسا؟» came back 05:00 (FZ1, M3) — the unlikely half, picked silently.
  // Refused before anything is read, with the round intact.
  if (!input.optionId && question.allowFreeText === false) throw new ClarifyError('free_text_not_allowed');

  let answered: ExtractionResult;
  let answerKind: 'option' | 'free_text';
  // "No specific time" — the option with no value (#474).
  let noTime = false;
  // …for an appointment with a day: an all-day event on it (FY1 N4).
  let appointmentDay: ExtractionResult | null = null;

  if (input.optionId) {
    const option = question.options.find((candidate) => candidate.optionId === input.optionId);
    if (!option) throw new ClarifyError('option_not_found');
    noTime = !option.value.localTime && !option.value.localDate;
    // An appointment with a day becomes an all-day event on it (FY1 N4);
    // anything else answered "no hour" keeps a named day as an all-day
    // deadline, or is undated without one (FY2 N3, `noHourAnswer`).
    appointmentDay = noTime ? allDayAppointment(result, resolutionOptions.timezone) : null;
    answered = appointmentDay
      ?? (noTime
        ? noHourAnswer(result, resolutionOptions.timezone)
        : withResolvedTime(result, appliedLocal(result, option.value), resolutionOptions.timezone));
    // A button whose hour went by while it was on the screen — «المسا»
    // offered at 18:59 and tapped at 19:01 (UAT round 6, batch 3) — is held to
    // the typed answer's rule (FY1 I3): refused, the round kept, never saved
    // in the past and never moved to another day.
    if (!noTime) notPast(answered, resolutionOptions.now);
    answerKind = 'option';
  } else {
    /*
     * The one follow-up the server asks (FIX-R8-CAPTURE). «والثاني الحنعة
     * عال٦» is 6 with no day and no half: the owner's rule is that both are
     * asked, and neither is picked. "Which day?" answered with a day alone —
     * «الجمعة» — places the 6 on Friday and asks صبح or مسا about it, as the
     * same 6 said with its day would have been asked (CL1 round 6). A day
     * with its half, or a clock, settles in this one round as always; a
     * contract "never a chain" still holds for every other question.
     */
    const waitingHour = question.field === 'which_day' ? undatedBareEarlyHour(result) : null;
    if (waitingHour && !statesClock(freeText) && typedHalfOfDay(freeText) === null) {
      const day = dayTypedIn(freeText, resolutionOptions);
      if (typeof day !== 'string') throw new ClarifyError('answer_not_understood');
      return askHalfAfterDay({ stored, index, item, result, day, hour: waitingHour, input, question, options: resolutionOptions, dependencies });
    }
    answered = await readFreeTextAnswer(result, question, freeText, resolutionOptions, dependencies);
    answerKind = 'free_text';
  }

  // What the answered time is to the person (CL1 review, I1). The answer is a
  // time of day; with no limit word in the sentence or in a typed answer —
  // «قبل», "by", «עד» — it is a time to be *at*, so the doctor answered
  // "morning" or «الساعة 10 الصبح» is a fixed event the planner keeps where
  // it is. Without this every answered time became a `due_by` and the planner
  // floated the appointment ahead as a deadline — D2's defect, through the one
  // path the UAT doctor actually takes.
  if (!noTime && (answered.dueAt || answered.remindAt)) {
    answered = { ...answered, timeAnchor: answeredTimeAnchor(result.rawText, answerKind === 'free_text' ? freeText : '') };
  }

  // A "no specific time" answer settles the item (#474). The builder offers it
  // because a commitment without an hour is a legitimate thing to want, but the
  // disposition policy still reads a missing time as unclear — so without this
  // the item came back flagged, with no command, and could never be confirmed.
  //
  // The command is the extractor's draft with the time cleared through
  // `applyEditToCommands`, the path a "No time" edit at confirm takes, so the
  // two cannot disagree about what a time-less commitment is. It waits as
  // `pending_confirmation`, like any other answered item, so the confirm
  // activates it. A confirm-time edit with a title and no time is still refused:
  // only this explicit answer settles.
  //
  // A "no specific time" answer to a question about a named day keeps the day
  // (UAT round 2, N3): `noHourAnswer` makes it that day, all day, and it is
  // drafted like any other answered item — as is an appointment answered the
  // same way, an all-day event on its day (FY1 N4). Both are `allDay`.
  const answeredCommands = noTime && !answered.allDay
    ? settleDrafts(applyEditToCommands(mapExtractionToCommand(answered, options.now.toISOString()), { resolvedTime: null }))
    : settleDrafts(mapExtractionToCommand(answered, options.now.toISOString()));

  // Never resolved with nothing to persist. An item marked answered with zero
  // commands is a Confirm the server then refuses with `invalid_selection`;
  // refusing the answer instead keeps the question, and the round, for another
  // try.
  if (answeredCommands.length === 0) throw new ClarifyError('answer_not_understood');

  const items = [...stored.contract.items];
  // A whole day has no time to show (the capture service's own rule): an
  // all-day event's or deadline's `dueAt` is its midnight, not an hour
  // anybody chose.
  const resolvedTime = answered.allDay ? null : answered.remindAt || answered.dueAt || null;
  items[index] = {
    ...item,
    title: (answered.title || answered.action || item.title).trim(),
    resolvedTime,
    ...(resolvedTime && endOfRange(answered) ? { endTime: endOfRange(answered)! } : { endTime: undefined }),
    // Whether the hour is still our guess (UAT round 6, D2). An answer about
    // the hour — the صبح/مسا or part-of-day buttons, or anything typed to a
    // time question — is the person's choice, so the mark goes. An answer
    // about something else leaves a part-of-day hour as it was: a guess.
    timeEstimated: resolvedTime !== null && !answeredTheHour(question.field, answerKind)
      && hourIsPartOfDayGuess(`${result.rawText ?? ''}\n${freeText}`),
    // On its day, not by it: the card says «الأحد · بدون وقت», not «لحد الأحد».
    ...(appointmentDay ? { allDayEvent: true } : {}),
    // Settled: the question it had was the one it needed, and it is answered.
    needsClarification: false,
    priority: answered.priority.level,
    priorityEstimated: answered.priority.source !== 'user_explicit',
    clarification: null,
  };
  items[index] = withDateGuess(items[index]!, answered, result);
  // A weekly hint's hour is settled now (FIX-R8-CAPTURE).
  if (answered.recurrenceHint) {
    items[index] = { ...items[index]!, recurrenceHint: recurrenceHintOf(answered, resolutionOptions.timezone, resolvedTime !== null) };
  }
  // With the hour settled, a complete weekly range is offered as a weekly block.
  items[index] = withWeeklyBlockOffers([items[index]!], resolutionOptions.timezone)[0]!;

  const mutated: CaptureProposalContract = {
    ...stored.contract,
    items,
    // Answering the last open question makes the proposal confirmable.
    status: items.length > 0 && items.every((candidate) => candidate.needsClarification)
      ? 'needs_clarification'
      : 'proposed',
  };
  const contract = finalizeUnderstood(mutated, stored.responseLocale ?? 'ar', stored.sourceOrdinals);

  const commands = new Map(stored.commandsByItemId);
  commands.set(input.itemId, answeredCommands);
  const results = new Map(stored.resultsByItemId);
  results.set(input.itemId, answered);

  const next: StoredCaptureProposal = {
    ...stored,
    contract,
    commandsByItemId: commands,
    resultsByItemId: results,
    clarifiedItemIds: [...(stored.clarifiedItemIds ?? []), input.itemId],
  };
  await dependencies.store.put(next);

  // The answer, never the words. A free-text answer is the user's own sentence
  // about their own commitment and has no business in an event log.
  await dependencies.recordEvent({
    type: 'clarification_answered',
    proposalId: input.proposalId,
    itemId: input.itemId,
    field: question.field,
    answerKind,
    at: options.now.toISOString(),
  });

  return contract;
}

/**
 * The answer chose the hour (UAT round 6, D2): a time or am/pm question, or a
 * typed answer to "which day?". Only a button for the day, or an answer about
 * the action, leaves the hour the item had.
 */
function answeredTheHour(field: ClarificationContract['field'], answerKind: 'option' | 'free_text'): boolean {
  if (field === 'time' || field === 'time_period') return true;
  if (field === 'which_day') return answerKind === 'free_text';
  return false;
}

/** A question id, for a builder that needs one. Kept here so tests can stub it. */
export const newQuestionId = (): string => randomUUID();

/**
 * The answered item's day, and whether it is still our guess (L4, fix round 1).
 *
 * Recomputed from the answer, like `priorityEstimated`: a free-text answer can
 * name another day, and an option can land on a different date from the one
 * guessed. Kept a guess only while the day is still the one the weekday name
 * produced; dropped when the answer left no day at all.
 */
function withDateGuess(
  item: CaptureProposalContract['items'][number],
  answered: ExtractionResult,
  before: ExtractionResult,
): CaptureProposalContract['items'][number] {
  const { resolvedDate: _date, dateEstimated: _estimated, ...rest } = item;
  const date = answered.localTimeSpec?.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return rest;
  // A free-text answer is re-extracted, so its own flag is the truth. An option
  // answer carries the original flag, which holds only for the original day.
  const reextracted = answered.rawText !== before.rawText;
  // A weekday the person named is their day, not our guess (`dateIsGuess`).
  const stillGuessed = dateIsGuess(answered, answered.rawText) && (reextracted || date === before.localTimeSpec?.date);
  return { ...rest, resolvedDate: date, dateEstimated: stillGuessed };
}


/**
 * «الجمعة» answered to "which day?" for a bare early hour with no day
 * (FIX-R8-CAPTURE): the hour is put on that day, still the person's number
 * with no half, and the صبح/مسا question is asked about it — the halves that
 * are still ahead on that day. The round is not spent: that question is the
 * item's one remaining one, and it takes only its two buttons.
 */
async function askHalfAfterDay(args: {
  stored: StoredCaptureProposal;
  index: number;
  item: CaptureProposalContract['items'][number];
  result: ExtractionResult;
  day: string;
  hour: string;
  input: ClarifyInput;
  question: ClarificationContract;
  options: ClarifyOptions;
  dependencies: ClarifyDependencies;
}): Promise<CaptureProposalContract> {
  const { stored, index, item, result, day, hour, input, question, options, dependencies } = args;
  const placed: ExtractionResult = {
    ...withResolvedTime(result, { date: day, time: hour }, options.timezone),
    // Still the number said with no half: the review marks it and asks.
    timeEvidence: 'clock_marker',
    dateInferred: false,
  };
  const clarification = buildClarification(placed, { now: options.now, timezone: options.timezone });
  const items = [...stored.contract.items];
  items[index] = {
    ...item,
    resolvedTime: null,
    needsClarification: true,
    resolvedDate: day,
    dateEstimated: false,
    timeEstimated: false,
    clarification,
    ...(placed.recurrenceHint ? { recurrenceHint: recurrenceHintOf(placed, options.timezone, false) } : {}),
  };
  // Still asking صبح/مسا: whatever was offered before is not offered now.
  items[index] = withWeeklyBlockOffers([items[index]!], options.timezone)[0]!;
  const mutated: CaptureProposalContract = {
    ...stored.contract,
    items,
    status: items.every((candidate) => candidate.needsClarification) ? 'needs_clarification' : 'proposed',
  };
  const contract = finalizeUnderstood(mutated, stored.responseLocale ?? 'ar', stored.sourceOrdinals);
  const commands = new Map(stored.commandsByItemId);
  commands.set(input.itemId, []);
  const results = new Map(stored.resultsByItemId);
  results.set(input.itemId, placed);
  // Not added to `clarifiedItemIds`: the صبح/مسا question is still to answer.
  await dependencies.store.put({ ...stored, contract, commandsByItemId: commands, resultsByItemId: results });
  await dependencies.recordEvent({
    type: 'clarification_answered',
    proposalId: input.proposalId,
    itemId: input.itemId,
    field: question.field,
    answerKind: 'free_text',
    at: options.now.toISOString(),
  });
  return contract;
}
