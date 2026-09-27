import type { SavedWeek } from '../../api/schemas/plan';
import type { CommitmentView } from '../commitments/model';
import { dayKey, formatRelativeDay, formatTime } from '../../i18n/format';
import { fill, ltr, type Lang } from '../../i18n/strings';

/**
 * Where the saved week days put each step (CL5b I4; post-UAT FX1).
 *
 * ── One answer to "when", on every screen ────────────────────────
 *
 * Saving a day in «خطّط أسبوعي» stores a plan for that date; it changes
 * nothing about the commitment, which keeps its own due
 * (`PLANNING_PERSISTENCE_POLICY.originalCommitmentRemainsCanonical`). That is
 * how the daily plan already works, and Today already draws a planned item
 * at its planned slot (the plan preview) rather than its due. The Calendar
 * learned the same for saved week days; Today's rows and Details did not, so
 * after moving «أروح عالسوق» to Thursday the Calendar said Thursday 09:00
 * while Today and Details said tomorrow 15:00 — two truths, neither aware of
 * the other.
 *
 * So every screen reads this one map: a step a saved day holds is shown at
 * its planned time, and its own due is said beside it, once, when the two
 * differ. When the read fails there is no map, and every screen shows the due
 * as it did before — the same fallback the Calendar already had.
 */
export interface SavedPlacement {
  /** The saved day, `YYYY-MM-DD`. */
  readonly date: string;
  /** The planned start on that day. */
  readonly startsAt: string;
}

export function savedPlacements(saved: SavedWeek | undefined): ReadonlyMap<string, SavedPlacement> {
  const map = new Map<string, SavedPlacement>();
  for (const day of saved?.saved ?? []) {
    for (const step of day.items) map.set(step.itemId, { date: day.date, startsAt: step.startsAt });
  }
  return map;
}

/** The view with `plannedAt` set when a saved day holds it. */
export function placeView(view: CommitmentView, placements: ReadonlyMap<string, SavedPlacement>): CommitmentView {
  const placement = placements.get(view.id);
  return placement ? { ...view, plannedAt: placement.startsAt } : view;
}

/** The instant a screen draws the item at: where a saved plan put it, or its own time. */
export function drawnAt(view: CommitmentView): string | null {
  return view.plannedAt ?? view.shownAt;
}

/** Its own due, when a saved plan puts it at another instant — the one fact to say beside it. */
export function dueApart(view: CommitmentView): string | null {
  if (!view.plannedAt || !view.shownAt) return null;
  return Date.parse(view.plannedAt) === Date.parse(view.shownAt) ? null : view.shownAt;
}

/** A day and an hour, «بكرا · 15:00», as the rows and the due aside say them. */
export function dayAndTime(iso: string, lang: Lang, timeZone: string): string {
  const at = new Date(iso);
  return `${formatRelativeDay(at, { locale: lang, timeZone })} · ${ltr(formatTime(at, { locale: lang, timeZone }))}`;
}

/**
 * The time a today row or card draws: the hour alone, as before — unless a
 * saved week day holds it on another day, which the hour alone would hide.
 */
export function drawnWhen(view: CommitmentView, lang: Lang, timeZone: string): string | null {
  const drawn = drawnAt(view);
  if (!drawn) return null;
  return view.plannedAt && dayKey(new Date(drawn), timeZone) !== dayKey(new Date(), timeZone)
    ? dayAndTime(drawn, lang, timeZone)
    : ltr(formatTime(new Date(drawn), { locale: lang, timeZone }));
}

/** «موعدها بكرا · 15:00», when a saved plan puts it at another time; else null. */
export function dueAsideText(view: CommitmentView, template: string, lang: Lang, timeZone: string): string | null {
  const due = dueApart(view);
  return due ? fill(template, { when: dayAndTime(due, lang, timeZone) }) : null;
}
