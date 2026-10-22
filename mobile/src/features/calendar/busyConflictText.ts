import { formatTimeRange } from '../../i18n/format';
import { fill, type Lang, type Strings } from '../../i18n/strings';
import type { DeviceBusyBlock } from './busyBlocks';

/**
 * The words for "this runs into something", shared by Today's conflict line and
 * every row's `BusyConflictChip`, so the two never name the same block
 * differently on one screen (Codex M6B-R3-002).
 */

/**
 * A weekly fixed block reaches the day's busy time with a `weekly:` id
 * (`occurrencesAsBusy`). It is the person's own fixed time, not an event in a
 * calendar, and is named so (M6b BB-01: «موعد بتقويمك» with no calendar
 * connected).
 */
export function isWeeklyFixedBlock(block: Pick<DeviceBusyBlock, 'nativeId'>): boolean {
  return block.nativeId?.startsWith('weekly:') === true;
}

/**
 * A range inside a sentence, its dash held to both times by word joiners: the
 * line may otherwise break after the en dash and leave «10:00–» on one line and
 * the end time on the next (M6b BB-02).
 */
export function unbreakableRange(range: string): string {
  return range.replace(/–/g, '⁠–⁠');
}

/** The busy range, or the all-day wording when that is all there is. */
export function busyConflictSentence(
  block: Pick<DeviceBusyBlock, 'nativeId' | 'startAt' | 'endAt' | 'allDay'>,
  t: Strings,
  lang: Lang,
  timeZone: string,
): string {
  if (block.allDay) return t.calendarBusyConflictAllDay;
  const range = unbreakableRange(formatTimeRange(new Date(block.startAt), new Date(block.endAt), { locale: lang, timeZone }));
  return fill(isWeeklyFixedBlock(block) ? t.fixedBlockConflict : t.calendarBusyConflict, { range });
}
