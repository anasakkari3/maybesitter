/**
 * What a saved week day holds, and how every other solve of a day honours it
 * (CL5b, review round 1: I2, I3).
 *
 * A day saved from the week view (`StoredDailyPlan.weekPlan`) holds its
 * step(s) *for that date*. The week's promise is that no step lands on two
 * days, so every other way a day comes to be solved has to know about it:
 *
 *  - **A day built on its own** — the morning job, "Build today's plan", a
 *    person's rebuild — leaves out the work a saved week day of this week
 *    holds (`readWeekHolds`), and records which work that was on the plan
 *    (`StoredDailyPlan.heldByWeek`).
 *  - **A stored day solved again** — the read-time refresh and the
 *    continuous replan tick — is solved under the assignment it was stored
 *    with (`storedWeekAssignment`), rebuilt from the document alone: a saved
 *    week day keeps exactly its own work (and whatever landed on the day
 *    since); a day built around the week keeps leaving the held work out.
 *
 * #383 still holds: work held for a date that has passed is yesterday's
 * unfinished work, and it rolls into today like any other.
 *
 * Pure except `readWeekHolds`, and importing nothing from the services that
 * import it, so there is one definition of "held" and no cycle to reason about.
 */
import { getStorage, type StorageAdapter } from '../../storage';
import type { DayAssignment } from './buildDailyPlan';
import { readStoredPlan, type StoredDailyPlan, type WeekHold } from './planStore';

/**
 * Proposals for the week view: today and the six days after it, one date at a
 * time through the same daily planner. A day's own build keeps its own two
 * days (`PLAN_BUILD_DAYS`).
 */
export const PLAN_PROPOSAL_DAYS = 7;

/** The calendar date `days` after a `YYYY-MM-DD`. Civil arithmetic, no zone. */
export function addCivilDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** `today` and the `days - 1` dates after it, in order. */
export function planDatesFrom(today: string, days: number): string[] {
  return Array.from({ length: days }, (_, offset) => addCivilDays(today, offset));
}

/**
 * The work a saved week day holds: what its plan places, less what the person
 * took off it. Nothing for a plan that was not saved from the week, or that
 * the person dismissed.
 */
export function heldBySavedWeekDay(stored: StoredDailyPlan): string[] {
  if (!stored.weekPlan || stored.status === 'dismissed') return [];
  const removed = new Set(stored.edits.removals);
  return stored.plan.scheduled.map((item) => item.itemId).filter((itemId) => !removed.has(itemId));
}

/**
 * The work the saved week days of `today … today+6` hold, other than
 * `exceptDate`'s own. Read before a day is built on its own.
 */
export async function readWeekHolds(
  uid: string,
  today: string,
  exceptDate: string,
  storage: StorageAdapter = getStorage(),
): Promise<WeekHold[]> {
  const holds: WeekHold[] = [];
  for (const date of planDatesFrom(today, PLAN_PROPOSAL_DAYS)) {
    if (date === exceptDate) continue;
    const stored = await readStoredPlan(uid, date, storage);
    if (!stored) continue;
    for (const itemId of heldBySavedWeekDay(stored)) holds.push({ itemId, date });
  }
  return holds;
}

/** The exclusion a day built on its own gets from `readWeekHolds`; null when nothing is held. */
export function assignmentAroundHolds(holds: readonly WeekHold[]): DayAssignment | null {
  return holds.length === 0 ? null : { include: [], exclude: Array.from(new Set(holds.map((hold) => hold.itemId))) };
}

/**
 * The assignment a stored day was solved under, rebuilt from the document, as
 * of `today` (the account's local date now; null reads nothing as passed).
 *
 * - A saved week day: its own floating work stays on it (`include`, so a step
 *   the person moved there stays even though the daily rule would not put it
 *   there), and the work the week considered for it and placed elsewhere or
 *   left waiting stays off (`exclude`) — unless the day it was held for has
 *   passed, when it rolls in (#383).
 * - A day built around saved week days: the held work stays off while the day
 *   holding it is today or later.
 * - Any other plan: null, the plain daily rule.
 */
export function storedWeekAssignment(stored: StoredDailyPlan, today: string | null): DayAssignment | null {
  const week = stored.weekPlan;
  if (week) {
    const include = stored.constraints.items.map((item) => item.itemId);
    const onThisDay = new Set(include);
    const rolledIn = new Set(week.heldElsewhere
      .filter((held) => today !== null && held.date < today)
      .map((held) => held.itemId));
    return { include, exclude: week.considered.filter((itemId) => !onThisDay.has(itemId) && !rolledIn.has(itemId)) };
  }
  return assignmentAroundHolds((stored.heldByWeek ?? []).filter((held) => today === null || held.date >= today));
}
