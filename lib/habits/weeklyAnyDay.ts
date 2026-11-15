/**
 * A weekly-count habit counts whatever day it is done on (owner decision
 * 2026-11-15).
 *
 * "Gym 3 times a week" asks for three dates (`canonicalWeekOffsets`: Monday,
 * Wednesday, Saturday). Done on a Tuesday, that Tuesday counts for the week,
 * and the nearest still-open asked-for date *after* it stops being asked for:
 * that row becomes `recovered`, linked from the Tuesday row by
 * `recoveredFromOccurrenceId`. The week therefore still totals three, the
 * planner frees Wednesday's hour (a `recovered` row is not open, and
 * materialization keeps it rather than re-creating Wednesday), and goal
 * progress counts the Tuesday like any completion.
 *
 * `recovered` is reused rather than a new state so an installed app that
 * parses the state enum strictly keeps working. The two uses are told apart
 * by direction: a recovery replacement is dated *on or after* the row it
 * recovers; a row covered in advance has its stand-in dated *before* it.
 *
 * Pure: no storage, no clock. The week is the civil week (Monday first) of
 * the local date the caller passes, which is the person's own date in their
 * own zone — `periodStartOf` is the one week rule materialization and
 * recovery already share.
 */
import type { HabitDefinition, HabitOccurrence } from '../../src/contracts/v1/habitContracts';
import { addDays, fromCivilDays, periodStartOf, toCivilDays } from './civilDate';
import { byDateThenOrdinal, canonicalWeekOffsets, materializeHabitOccurrences, occurrenceIdFor } from './materialize';

const OPEN: readonly HabitOccurrence['state'][] = ['pending', 'scheduled'];

export interface WeekTally {
  readonly habitId: string;
  readonly completed: number;
  readonly target: number;
}

export type AnyDayPlan =
  /** Not a weekly-count habit, or not active. */
  | { readonly kind: 'not_applicable' }
  /** The week's count is met: nothing more is asked this week. */
  | { readonly kind: 'week_complete'; readonly tally: WeekTally }
  /** Today already has a row of its own (asked for, or already decided). */
  | { readonly kind: 'has_row'; readonly tally: WeekTally }
  /**
   * Today may be marked done as an off day: `row` is the row to write (at a
   * deterministic id), `consume` the asked-for row it takes, or null when no
   * open one is left this week.
   */
  | {
    readonly kind: 'any_day';
    readonly tally: WeekTally;
    readonly row: HabitOccurrence;
    readonly consume: HabitOccurrence | null;
    /**
     * Every id in the week a completion could be stored at, for the write to
     * re-count inside its transaction: the rows this read saw, plus the next
     * free ordinal on each day — where another device's off-day row would land,
     * since it is minted by this same rule from the same or an older read.
     */
    readonly weekIds: readonly string[];
  };

/** `[Monday, Sunday]` of the week holding `localDate`. */
export function weekOf(localDate: string): { fromLocalDate: string; toLocalDate: string } {
  const fromLocalDate = fromCivilDays(periodStartOf(toCivilDays(localDate)));
  return { fromLocalDate, toLocalDate: addDays(fromLocalDate, 6) };
}

export function countsOnAnyDay(habit: HabitDefinition): boolean {
  return habit.status === 'active' && habit.cadence.kind === 'weekly_count';
}

/** A `recovered` row whose stand-in is dated before it: taken in advance, not skipped. */
export function coveredInAdvance(row: HabitOccurrence, occurrences: readonly HabitOccurrence[]): boolean {
  return row.state === 'recovered' && occurrences.some((other) =>
    other.recoveredFromOccurrenceId === row.occurrenceId && other.localDate < row.localDate);
}

/**
 * The week around `today`, merged with what the cadence asks for, so a date
 * the stored horizon no longer covers is still seen (the same merge the daily
 * plan runs).
 */
function weekRows(habit: HabitDefinition, stored: readonly HabitOccurrence[], today: string): readonly HabitOccurrence[] {
  const week = weekOf(today);
  const mine = stored.filter((row) => row.habitId === habit.habitId);
  return materializeHabitOccurrences(habit, week, mine).occurrences
    .filter((row) => row.localDate >= week.fromLocalDate && row.localDate <= week.toLocalDate);
}

export function weekTally(habit: HabitDefinition, stored: readonly HabitOccurrence[], today: string): WeekTally {
  return {
    habitId: habit.habitId,
    completed: weekRows(habit, stored, today).filter((row) => row.state === 'completed').length,
    target: canonicalWeekOffsets(habit).length,
  };
}

export function planAnyDay(habit: HabitDefinition, stored: readonly HabitOccurrence[], today: string): AnyDayPlan {
  if (!countsOnAnyDay(habit)) return { kind: 'not_applicable' };
  const rows = weekRows(habit, stored, today);
  const tally: WeekTally = {
    habitId: habit.habitId,
    completed: rows.filter((row) => row.state === 'completed').length,
    target: canonicalWeekOffsets(habit).length,
  };
  if (tally.completed >= tally.target) return { kind: 'week_complete', tally };
  const onToday = rows.filter((row) => row.localDate === today);
  if (onToday.some((row) => !coveredInAdvance(row, rows))) return { kind: 'has_row', tally };

  const taken = new Set(onToday.map((row) => row.ordinal));
  let ordinal = 0;
  while (taken.has(ordinal)) ordinal += 1;
  const consume = [...rows]
    .sort(byDateThenOrdinal)
    .find((row) => row.localDate > today && OPEN.includes(row.state)) ?? null;
  const row: HabitOccurrence = Object.freeze({
    occurrenceId: occurrenceIdFor(habit.habitId, today, ordinal),
    habitId: habit.habitId,
    localDate: today,
    ordinal,
    state: 'pending' as const,
    durationMinutes: habit.durationMinutes,
    recoveredFromOccurrenceId: consume?.occurrenceId ?? null,
  });
  const week = weekOf(today);
  const weekIds = new Set(rows.map((entry) => entry.occurrenceId));
  for (let offset = 0; offset < 7; offset += 1) {
    const date = addDays(week.fromLocalDate, offset);
    const used = rows.filter((entry) => entry.localDate === date).map((entry) => entry.ordinal);
    weekIds.add(occurrenceIdFor(habit.habitId, date, used.length === 0 ? 0 : Math.max(...used) + 1));
  }
  return { kind: 'any_day', tally, row, consume, weekIds: Array.from(weekIds).sort() };
}
