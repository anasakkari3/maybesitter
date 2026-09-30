/**
 * What the person said, as the capture chat's items are checked against it
 * (capture chat, owner decision 2026-09-30).
 *
 * In the chat the model answers with the whole current list of items, built
 * from every turn: a time the person gives in a later turn ("make it 6",
 * «خلّيها الساعة 6») belongs to an item they named earlier. So an item is not
 * checked against one clause, as a capture's is, but against the person's
 * turns together — and never against anything the assistant said.
 *
 * Two things live here:
 *
 *   `chatEvidenceFrom`  the text every chat item is validated against: the
 *                       user's turns, joined, with any clause that refuses a
 *                       reminder («لا تذكرني», "don't add…") left out. A
 *                       refusal is an instruction about what not to keep; left
 *                       in, the validator would read the whole conversation as
 *                       negated and every later item would be lost with it.
 *   `withoutUnsaidTime` the chat's own guard, after the ordinary validator: an
 *                       hour, minute or day the person never said is taken
 *                       off, so the item is asked about rather than proposed
 *                       at a time somebody picked for them. The validator's
 *                       "no invented time" rule only fires when the words
 *                       state no time at all; a conversation that states *a*
 *                       time would otherwise let the model put down another.
 *
 * Pure: no clock of its own, no storage.
 */
import type { ExtractionResult } from '../../../src/extraction/extractionTypes';
import { splitCaptureClauseDetails } from '../../../src/extraction/clauseSplitter';
import { statesNegatedReminder } from '../../../src/extraction/schemaValidator';
import {
  dayPartHour,
  hourWithDayPart,
  localTimeSpecFor,
  namesDayOfMonth,
  normalizeClockText,
  relativeDayOffset,
  statedClockHours,
  statesClock,
  thisMonthEndWords,
} from '../../../src/extraction/timeLexicon';
import { namesCalendarDate, readRecurrence, resolveWeekdayDate } from '../../../src/extraction/weekdayLexicon';
import { isNegatedRequest } from '../mobile/safety';

/** A clause that refuses a reminder, by either of the two checks the capture path makes. */
function refuses(text: string): boolean {
  return isNegatedRequest(text) || statesNegatedReminder(text);
}

/**
 * The person's turns, as evidence: each one whole, except that a turn which
 * refuses something keeps only its clauses that do not.
 */
export function chatEvidenceTurns(userTurns: readonly string[]): string[] {
  const out: string[] = [];
  for (const turn of userTurns) {
    const text = turn.trim();
    if (!text) continue;
    if (!refuses(text)) {
      out.push(text);
      continue;
    }
    for (const clause of splitCaptureClauseDetails(text)) {
      if (clause.text.trim() && !refuses(clause.text)) out.push(clause.text.trim());
    }
  }
  return out;
}

/** The evidence text itself: the kept turns, one per line. */
export function chatEvidenceFrom(userTurns: readonly string[]): string {
  return chatEvidenceTurns(userTurns).join('\n');
}

/** `YYYY-MM-DD` plus `days`. */
function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** Minutes the words state on a clock ("6:30", «6 ونص» → 6:30), always including the hour itself. */
function statedMinutes(turn: string): Set<number> {
  const minutes = new Set<number>([0]);
  const text = normalizeClockText(turn);
  for (const match of Array.from(text.matchAll(/(\d{1,2})[:.](\d{2})/g))) minutes.add(Number(match[2]));
  return minutes;
}

export interface ChatTimeAllowance {
  /** Clock hours, modulo twelve, some turn states or names by its part of the day. */
  hours: Set<number>;
  minutes: Set<number>;
  /** The days the turns name, on the person's clock. */
  dates: Set<string>;
  /** A turn states a date this guard cannot compute (a calendar date, a month's end, a recurrence): the validator's day stands. */
  anyDate: boolean;
}

/** What the person's turns allow an item to carry. */
export function chatTimeAllowance(turns: readonly string[], now: Date, timezone: string): ChatTimeAllowance {
  const today = localTimeSpecFor(now, timezone)?.date ?? null;
  const allowance: ChatTimeAllowance = { hours: new Set(), minutes: new Set([0]), dates: new Set(), anyDate: false };
  for (const turn of turns) {
    for (const hour of Array.from(statedClockHours(turn))) allowance.hours.add(hour);
    const part = dayPartHour(turn);
    if (part !== null) allowance.hours.add(part % 12);
    const paired = hourWithDayPart(turn);
    if (paired && paired !== 'ambiguous') allowance.hours.add(Number(paired.slice(0, 2)) % 12);
    for (const minute of Array.from(statedMinutes(turn))) allowance.minutes.add(minute);

    if (namesCalendarDate(turn) || thisMonthEndWords(turn) !== null || readRecurrence(turn) !== null || namesDayOfMonth(turn)) {
      allowance.anyDate = true;
    }
    const offset = relativeDayOffset(turn);
    if (today && offset !== null) allowance.dates.add(shiftDate(today, offset));
    const weekday = resolveWeekdayDate(turn, now, timezone);
    if (weekday) allowance.dates.add(weekday.date);
    // A clock or a part of the day with no day of its own is today's, as the
    // capture path reads it — never a later day picked for the person.
    if (today && (statesClock(turn) || part !== null)) allowance.dates.add(today);
  }
  return allowance;
}

/** The item's local `HH:MM`, from its wall clock or its instant, or null when it has no hour. */
function localTimeOf(result: ExtractionResult, timezone: string): string | null {
  if (result.allDay) return null;
  if (result.localTimeSpec?.time) return result.localTimeSpec.time;
  const instant = result.remindAt ?? result.dueAt;
  if (!instant) return null;
  const parsed = Date.parse(instant);
  return Number.isFinite(parsed) ? localTimeSpecFor(new Date(parsed), timezone)?.time ?? null : null;
}

/** The item's local day, or null when it has none. */
function localDateOf(result: ExtractionResult, timezone: string): string | null {
  if (result.localTimeSpec?.date) return result.localTimeSpec.date;
  const instant = result.remindAt ?? result.dueAt;
  if (!instant) return null;
  const parsed = Date.parse(instant);
  return Number.isFinite(parsed) ? localTimeSpecFor(new Date(parsed), timezone)?.date ?? null : null;
}

export interface UnsaidTimeOutcome {
  result: ExtractionResult;
  /** True when a time or a day was taken off: the item must then be asked about. */
  fired: boolean;
}

/**
 * The same reading with any hour, minute or day the person never said taken
 * off (capture chat). What remains is asked, never filled:
 *
 *   an hour they did not say     the time goes; the day, if theirs, stays;
 *   a day they did not name      the day goes; an hour they did say is kept
 *                                as `undatedTime`, so the question is "which
 *                                day?" and not "when?".
 *
 * Hours compare modulo twelve («الساعة 6» is 06:00 or 18:00), so the half of
 * the day stays the validator's and the bare-early-hour question's to settle.
 */
export function withoutUnsaidTime(
  result: ExtractionResult,
  turns: readonly string[],
  now: Date,
  timezone: string,
): UnsaidTimeOutcome {
  const time = localTimeOf(result, timezone);
  const date = localDateOf(result, timezone);
  if (!time && !date) return { result, fired: false };
  const allowance = chatTimeAllowance(turns, now, timezone);

  let keepTime = true;
  if (time) {
    const hour = Number(time.slice(0, 2));
    const minute = Number(time.slice(3, 5));
    keepTime = allowance.hours.has(hour % 12) && allowance.minutes.has(minute);
  }
  const keepDate = !date || allowance.anyDate || allowance.dates.has(date);
  if (keepTime && keepDate) return { result, fired: false };

  const missingFields = result.missingFields.includes('time') ? result.missingFields : [...result.missingFields, 'time' as const];
  const ambiguityFlags = result.ambiguityFlags.includes('vague_time') ? result.ambiguityFlags : [...result.ambiguityFlags, 'vague_time' as const];
  const { undatedTime: _undated, ...rest } = result;
  return {
    fired: true,
    result: {
      ...rest,
      dueAt: null,
      remindAt: null,
      allDay: false,
      localTimeSpec: keepDate && date ? { date, time: null, timezone } : null,
      dateInferred: keepDate ? result.dateInferred ?? false : false,
      // A said hour on an unsaid day: kept, so only the day is asked.
      ...(!keepDate && keepTime && time ? { undatedTime: time } : {}),
      missingFields,
      ambiguityFlags,
      confidence: { ...result.confidence, time: Math.min(result.confidence.time, 0.1) },
    },
  };
}
