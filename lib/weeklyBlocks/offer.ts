/**
 * A capture item's offer to become a weekly block («ثابت أسبوعي»).
 *
 * FIX-R8 (PR #696) gives an item `recurrenceHint {weekdays, start?, end?}`
 * when the words state a weekly recurrence. The offer exists only when that
 * hint is complete and the item is settled: at least one weekday, a start the
 * person's words fixed (a bare «2» is asked صبح/مسا first, so the hint has no
 * start until it is answered), an end, and the end after the start on the
 * same day. Anything less stays the one-off it already was.
 *
 * The offer's title is the item's title without the recurrence phrase FIX-R8
 * kept in it, and without the possession lead-in («عندي تدريب كل سبت» →
 * «تدريب»): the card says «كل سبت · 10:00–16:00» beside it, and a calendar
 * event that repeats every Saturday does not need to say so in its name.
 */
import type { CaptureProposalItemContract } from '../../src/contracts/v1/captureContracts';
import {
  WEEKLY_BLOCK_TITLE_MAX,
  WeeklyBlockValidationError,
  validateWeeklyBlockShape,
  type WeeklyBlockOfferContract,
} from '../../src/contracts/v1/weeklyBlockContracts';
import { readRecurrence } from '../../src/extraction/weekdayLexicon';
import { stripTimeExpressions } from '../../src/extraction/ruleBasedExtractor';

/*
 * The possession lead-in a weekly block does not need (runtime UAT,
 * 2026-09-30): "I have an internship every Saturday from 10 to 4" was offered
 * as the block «I have an internship». A block is the thing itself — the
 * calendar event reads "internship", «تدريب», «התמחות» — so "I have (a|an|
 * the|my)", "I've got", "we have", «عندي», «عنّا», «عندنا», «إلي», «יש לי»,
 * «יש לנו» go when something is left after them.
 */
const POSSESSION_LEAD_IN = new RegExp(
  [
    "^(?:i|we)\\s+(?:have|'ve|'ve\\s+got|have\\s+got|got)\\s+(?:(?:a|an|the|my|our)\\s+)?",
    "^i've\\s+got\\s+(?:(?:a|an|the|my)\\s+)?",
    '^[وف]?(?:عندي|عندنا|عنّا|عنا|إلي|الي)\\s+',
    '^ו?יש\\s+(?:לי|לנו)\\s+',
  ].join('|'),
  'iu',
);

/** A title without its possession lead-in, when something is left after it ("I have a dentist appointment" → "dentist appointment"). */
export function withoutPossessionLeadIn(title: string): string {
  const stripped = title.trim().replace(POSSESSION_LEAD_IN, '').trim();
  return stripped || title.trim();
}

function titleWithoutRecurrence(title: string): string {
  const recurrence = readRecurrence(title);
  let stripped = title;
  for (const phrase of recurrence?.phrases ?? []) stripped = stripped.split(phrase).join(' ');
  // What is left once the recurrence and any time words go, and the lead-in.
  stripped = stripTimeExpressions(stripped).replace(/\s+/g, ' ').trim();
  const withoutLeadIn = stripped.replace(POSSESSION_LEAD_IN, '').trim();
  if (withoutLeadIn) stripped = withoutLeadIn;
  return (stripped || title.trim()).slice(0, WEEKLY_BLOCK_TITLE_MAX);
}

/** The offer for one item, or null when the item is not a complete weekly range. */
export function weeklyBlockOfferFor(
  item: Pick<CaptureProposalItemContract, 'title' | 'needsClarification' | 'recurrenceHint'>,
  timezone: string,
): WeeklyBlockOfferContract | null {
  const hint = item.recurrenceHint;
  if (item.needsClarification || !hint || !hint.start || !hint.end || hint.weekdays.length === 0) return null;
  const title = titleWithoutRecurrence(item.title ?? '');
  if (!title) return null;
  const weekdays = Array.from(new Set(hint.weekdays)).sort((a, b) => a - b);
  try {
    validateWeeklyBlockShape({ weekdays, start: hint.start, end: hint.end });
  } catch (error) {
    // Overnight («من 10 لـ 2» at night) or malformed: not a v1 block.
    if (error instanceof WeeklyBlockValidationError) return null;
    throw error;
  }
  return { title, weekdays, start: hint.start, end: hint.end, timezone };
}

/** Every item with its offer recomputed: set when complete, removed when not. */
export function withWeeklyBlockOffers<T extends CaptureProposalItemContract>(items: readonly T[], timezone: string): T[] {
  return items.map((item) => {
    const offer = weeklyBlockOfferFor(item, timezone);
    const { weeklyBlock: _previous, ...rest } = item;
    return (offer ? { ...rest, weeklyBlock: offer } : rest) as T;
  });
}
