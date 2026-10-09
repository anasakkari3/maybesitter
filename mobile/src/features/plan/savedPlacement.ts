import type { SavedWeek } from '../../api/schemas/plan';
import { clockOf, type CommitmentView } from '../commitments/model';
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
  /** Its planned end (M4a: the slot occupies `startsAt`–`endsAt`). */
  readonly endsAt: string | null;
}

export function savedPlacements(saved: SavedWeek | undefined): ReadonlyMap<string, SavedPlacement> {
  const map = new Map<string, SavedPlacement>();
  for (const day of saved?.saved ?? []) {
    for (const step of day.items) map.set(step.itemId, { date: day.date, startsAt: step.startsAt, endsAt: step.endsAt });
  }
  return map;
}

/** The view with `plannedAt` set when a saved day holds it. */
export function placeView(view: CommitmentView, placements: ReadonlyMap<string, SavedPlacement>): CommitmentView {
  const placement = placements.get(view.id);
  return placement ? { ...view, plannedAt: placement.startsAt, plannedEnd: placement.endsAt } : view;
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

/*
 * An all-day commitment (FX3, `TimeSpec.allDay`) has a day and no hour: its
 * `shownAt` is that day's local midnight, which nobody chose, so no helper
 * here prints it as «00:00». A saved plan slot is always an hour, all-day or
 * not. (Closure integration: FX1's helpers predate FX3's rule.)
 */

/** The instant with a real hour to draw and to check busy time at: a saved slot, or its own time unless it is all-day. */
export function drawnClockAt(view: CommitmentView): string | null {
  return view.plannedAt ?? (view.allDay ? null : view.shownAt);
}

/**
 * The time a today row or card draws, and whether it names a day.
 *
 * Today's hour alone, as before. Any other day says which: a saved week day
 * that holds it elsewhere (FX1), and — the owner's Redmi, 2026-09-29 — its own
 * due on a day that is not today. A task two weeks late drew «09:00» beside
 * «الوقت راح», which reads as this morning; it now draws «الثلاثاء، 15 سبتمبر ·
 * 09:00», as «بعدين», Details and the review card do. An all-day item whose
 * day is over says that day (it has no hour); on its own day there is still
 * nothing to say. Null when there is nothing to say.
 *
 * `dated` is for the text's face: a bare clock is set in the Latin face, a
 * weekday in the language's own script.
 */
export function drawnWhenLine(view: CommitmentView, lang: Lang, timeZone: string): { text: string; dated: boolean } | null {
  const options = { locale: lang, timeZone };
  const today = dayKey(new Date(), timeZone);
  if (view.plannedAt) {
    return dayKey(new Date(view.plannedAt), timeZone) !== today
      ? { text: dayAndTime(view.plannedAt, lang, timeZone), dated: true }
      : { text: ltr(formatTime(new Date(view.plannedAt), options)), dated: false };
  }
  if (!view.shownAt) return null;
  // All-day: "is its day over" is the model's own rule (`isPast`, judged in
  // the zone the day was named in), not this zone's midnight arithmetic.
  if (view.allDay) return view.isPast ? { text: formatRelativeDay(new Date(view.shownAt), options), dated: true } : null;
  if (dayKey(new Date(view.shownAt), timeZone) !== today) return { text: dayAndTime(view.shownAt, lang, timeZone), dated: true };
  const clock = clockOf(view, options);
  return clock ? { text: clock, dated: false } : null;
}

/** `drawnWhenLine`'s text alone. */
export function drawnWhen(view: CommitmentView, lang: Lang, timeZone: string): string | null {
  return drawnWhenLine(view, lang, timeZone)?.text ?? null;
}

/** A «بعدين» row's day and time: the saved slot, else its own day with its hour or `noTime`. */
export function laterWhen(view: CommitmentView, lang: Lang, timeZone: string, noTime: string): string {
  if (view.plannedAt) return dayAndTime(view.plannedAt, lang, timeZone);
  if (!view.shownAt) return noTime;
  return `${formatRelativeDay(new Date(view.shownAt), { locale: lang, timeZone })} · ${clockOf(view, { locale: lang, timeZone }) ?? noTime}`;
}

/** «موعدها بكرا · 15:00» (or «موعدها الجمعة» for an all-day due), when a saved plan puts it at another time; else null. */
export function dueAsideText(view: CommitmentView, template: string, lang: Lang, timeZone: string): string | null {
  const due = dueApart(view);
  if (!due) return null;
  return fill(template, {
    when: view.allDay ? formatRelativeDay(new Date(due), { locale: lang, timeZone }) : dayAndTime(due, lang, timeZone),
  });
}
