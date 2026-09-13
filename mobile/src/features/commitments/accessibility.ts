import type { CommitmentView } from './model';

/**
 * What a screen reader says about one row (UC-2.R3 #173 step 8).
 *
 * ── The row was announcing a third of itself ─────────────────────
 *
 * `Btn` takes one `label`, and the lists passed `item.title`. So VoiceOver read
 * "Send the report" where a sighted user saw a Must, due at 18:00, with an
 * estimated-importance mark beside it. Every signal the design added to help
 * someone triage their day was visual only.
 *
 * The order is title, importance, time, status: the title first because it is
 * how the person identifies the row and the rest is qualification, and status
 * last because it is absent for the common case.
 *
 * ── Composed from the same strings the row draws ─────────────────
 *
 * Not a second set of accessibility copy. Two vocabularies for one row is how
 * they drift, and a screen reader saying "high priority" while the screen says
 * «لازم» is worse than a short label.
 */
export interface RowStrings {
  todayGroupMust: string;
  todayGroupShould: string;
  todayGroupNice: string;
  todayEstimatedMark: string;
  noTimeYet: string;
  doneS: string;
  dropped: string;
}

export function rowAccessibilityLabel(
  view: CommitmentView,
  strings: RowStrings,
  /** The time exactly as the row prints it, so the two cannot disagree. */
  shownTime: string | null,
): string {
  const importance = view.importance === 'must'
    ? strings.todayGroupMust
    : view.importance === 'should'
      ? strings.todayGroupShould
      : strings.todayGroupNice;

  const parts = [view.title, importance];
  // Only when it was read off their words. Saying "estimated" about something
  // the user set would be the announcement contradicting the screen.
  if (!view.importanceIsStated) parts.push(strings.todayEstimatedMark);
  parts.push(shownTime ?? strings.noTimeYet);
  if (view.status === 'done') parts.push(strings.doneS);
  if (view.status === 'dropped') parts.push(strings.dropped);

  // A comma is what makes a screen reader pause between them rather than
  // running the row into one word.
  return parts.filter((part) => part.length > 0).join(', ');
}
