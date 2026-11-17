import { fill, type Strings } from '../../i18n/strings';
import type { RescheduleProposal } from '../../api/schemas/reschedule';

type DayPart = RescheduleProposal['fromDayPart'];

export function dayPartWord(part: DayPart, t: Strings): string {
  return part === 'morning' ? t.rsPartMorning : part === 'afternoon' ? t.rsPartAfternoon : t.rsPartEvening;
}

/**
 * What changed and why, in one line, from the server's `reason` and `changes`
 * (lane E4). Templates only: no model words this line, and none chooses the
 * times it describes.
 */
export function rescheduleLine(proposal: Pick<RescheduleProposal, 'reason' | 'changes' | 'fromDayPart' | 'toDayPart'>, t: Strings): string {
  const split = proposal.changes.includes('smaller_pieces');
  const otherTime = proposal.changes.includes('other_time_of_day');
  if (proposal.reason === 'deadline_near') return t.rsLineEarlier;
  // Missed at different times and too short to split: only the time of day
  // changes, and the line does not claim the misses shared one part of it.
  if (otherTime && proposal.reason === 'missed_again') {
    return fill(t.rsLineOtherTimeMixed, { to: dayPartWord(proposal.toDayPart, t) });
  }
  if (otherTime) {
    const words = { from: dayPartWord(proposal.fromDayPart, t), to: dayPartWord(proposal.toDayPart, t) };
    return fill(split ? t.rsLineOtherTimeSplit : t.rsLineOtherTime, words);
  }
  if (split) return t.rsLineSplit;
  return t.rsLineFirst;
}
