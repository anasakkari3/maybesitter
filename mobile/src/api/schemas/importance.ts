import type { Commitment } from './common';

/**
 * The design's three importance levels, from the server's priority levels.
 * `high → Must`, `normal → Should`, `low → Nice`.
 *
 * Its own file, with no schema library in it, because the reminder mapping
 * (`features/reminders/reminderInputs.ts`) needs it and the server's tests load
 * that mapping where only the root packages are installed (CL5a round 3).
 * `common.ts` re-exports it, so the cards and the reminders read one rule.
 */
export function importanceOf(commitment: Pick<Commitment, 'priority'>): 'must' | 'should' | 'nice' {
  return commitment.priority.level === 'high' ? 'must' : commitment.priority.level === 'low' ? 'nice' : 'should';
}
