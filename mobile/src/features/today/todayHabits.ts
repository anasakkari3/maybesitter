import type { Habit, HabitOccurrence, HabitToday } from '../../api/schemas/habits';

/** One habit occurrence Today asks for, with the habit it belongs to. */
export interface TodayHabitRow {
  readonly habit: Habit;
  readonly occurrence: HabitOccurrence;
}

/** `HH:MM` as minutes from midnight; null for anything else. */
function minuteOf(clock: string): number | null {
  const match = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(clock);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** The earliest hour a habit prefers, or Infinity when it names none. */
function preferredMinute(habit: Habit): number {
  const minutes = habit.preferredWindows.map(window => minuteOf(window.start)).filter((minute): minute is number => minute !== null);
  return minutes.length > 0 ? Math.min(...minutes) : Number.POSITIVE_INFINITY;
}

/**
 * The habit rows Today draws (QA v3 V3-F23-06, owner decision 2026-11-20).
 *
 * Only what today asks for: the server's own rows for its `localDate`, minus
 * the off days a weekly count merely allows (`anyDay` — not due, so not
 * here; the habits page still offers them), and minus a habit that is paused,
 * archived or not in the list. Ordered by the hour each habit prefers, earliest
 * first; a habit with no hour comes after, in the habits list's own order, so
 * the rows keep their places from one read to the next.
 */
export function todayHabitRows(habits: readonly Habit[] | undefined, today: HabitToday | null | undefined): TodayHabitRow[] {
  if (!habits || !today) return [];
  const anyDay = new Set(today.anyDay ?? []);
  const position = new Map(habits.map((habit, index) => [habit.habitId, index]));
  const byId = new Map(habits.map(habit => [habit.habitId, habit]));
  return today.occurrences
    .filter(occurrence => occurrence.localDate === today.localDate && !anyDay.has(occurrence.occurrenceId))
    .flatMap(occurrence => {
      const habit = byId.get(occurrence.habitId);
      return habit && habit.status === 'active' ? [{ habit, occurrence }] : [];
    })
    .sort((left, right) =>
      preferredMinute(left.habit) - preferredMinute(right.habit)
      || position.get(left.habit.habitId)! - position.get(right.habit.habitId)!
      || left.occurrence.ordinal - right.occurrence.ordinal);
}
