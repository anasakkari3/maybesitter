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
 * kept in it («عندي تدريب كل سبت» → «عندي تدريب»): the card says «كل سبت ·
 * 10:00–16:00» beside it, and a calendar event that repeats every Saturday
 * does not need to say so in its name.
 */
import type { CaptureProposalItemContract } from '../../src/contracts/v1/captureContracts';
import {
  WEEKLY_BLOCK_TITLE_MAX,
  WeeklyBlockValidationError,
  validateWeeklyBlockShape,
  type WeeklyBlockOfferContract,
} from '../../src/contracts/v1/weeklyBlockContracts';
import { readRecurrence } from '../../src/extraction/weekdayLexicon';

function titleWithoutRecurrence(title: string): string {
  const recurrence = readRecurrence(title);
  let stripped = title;
  for (const phrase of recurrence?.phrases ?? []) stripped = stripped.split(phrase).join(' ');
  stripped = stripped.replace(/\s+/g, ' ').trim();
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
