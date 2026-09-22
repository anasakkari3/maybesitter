/**
 * Turning a Habit into the dates it asks for (#520).
 *
 * ── The occurrence id is the whole design ───────────────────────
 *
 * `{habitId}.{localDate}.{ordinal}`, derived from nothing but the habit and
 * the date. No uuid, no timestamp, no counter. That is what the acceptance
 * criterion "re-running materialization produces identical IDs" reduces to:
 * two runs address the same rows because there was never a second id either
 * of them could have produced, so a nightly re-materialization updates
 * Wednesday's gym session instead of writing a second one beside it.
 *
 * A random id would pass every functional test in this file and fail in
 * production on day two, as four gym sessions in one week. The determinism
 * test exists for that and is checked by mutation, not by reading.
 *
 * ── Which dates a `weekly_count` means ──────────────────────────
 *
 * "Three times a week" names a count, not days, and something has to choose
 * days — a planner cannot allocate "some time, thrice". The choice is
 * `canonicalWeekOffsets`: spread the n sessions as evenly as seven days allow,
 * starting Monday. Three becomes Monday/Wednesday/Saturday.
 *
 * Two things about that rule matter more than which days it picks. It is a
 * function of the *week alone* — not of the horizon, not of what is already
 * stored, not of when it ran — so materializing 1 March to 28 March and
 * materializing 15 March to 11 April agree exactly about the fortnight they
 * share. And it is a *demand* date, not a promise: the adapter hands the
 * occurrence to the scheduler, which places it inside the day using the
 * habit's `preferredWindows` and may reach a different hour each week.
 *
 * ── Pausing keeps history ───────────────────────────────────────
 *
 * A paused habit yields no demand dates at all, so the merge below drops its
 * unstarted `pending` rows and keeps everything the person actually touched.
 * That is the acceptance criterion "pausing removes future demand without
 * deleting history", and it is one rule rather than a pause-shaped special
 * case: a cadence edited from five days a week to three drops Thursday's
 * untouched row the same way, and keeps the Thursday three weeks ago that
 * somebody completed.
 */

import {
  HABIT_HORIZON_MAX_DAYS,
  HABIT_LIVE_OCCURRENCE_STATES,
  HabitValidationError,
  cadenceOccurrencesPerPeriod,
  type HabitDefinition,
  type HabitHorizon,
  type HabitOccurrence,
} from '../../src/contracts/v1/habitContracts';
import {
  fromCivilDays,
  periodStartOf,
  toCivilDays,
  type CivilDays,
} from './civilDate';

/**
 * The offsets from Monday, in days, that a week's demand falls on.
 *
 * Exported because the adapter and the tests both need to be able to say what
 * the rule is without re-deriving it, and a second derivation of a *choice*
 * this arbitrary would drift the first time somebody rounded differently.
 */
export function canonicalWeekOffsets(habit: HabitDefinition): readonly number[] {
  const { cadence } = habit;
  if (cadence.kind === 'weekdays') {
    // 0 = Sunday in the contract, 0 = Monday here: Sunday is the *last* day of
    // an ISO week, not the first, so it is six days after that week's Monday.
    return Object.freeze(
      cadence.weekdays
        .map((weekday) => (weekday + 6) % 7)
        .sort((left, right) => left - right)
        .slice(0, habit.maximumOccurrences),
    );
  }
  const count = Math.min(cadence.count, habit.maximumOccurrences);
  // Evenly spread across the seven days. `count` is at most 7 (the contract
  // caps it), and for every value in 1..7 these round to distinct offsets.
  return Object.freeze(
    Array.from({ length: count }, (_unused, index) => Math.round((index * 7) / count)),
  );
}

export function occurrenceIdFor(habitId: string, localDate: string, ordinal: number): string {
  if (!Number.isInteger(ordinal) || ordinal < 0) {
    throw new HabitValidationError(`ordinal must be a non-negative integer: ${String(ordinal)}`);
  }
  return `${habitId}.${localDate}.${ordinal}`;
}

/**
 * The dates one habit asks for inside one horizon, ascending.
 *
 * Bounded twice over: by the horizon, which `checkHorizon` refuses to let grow
 * past `HABIT_HORIZON_MAX_DAYS`, and by `maximumOccurrences` within each week.
 * There is no argument that makes this return an unbounded list and no
 * overload that omits the horizon.
 */
export function demandDates(habit: HabitDefinition, horizon: HabitHorizon): readonly string[] {
  const { fromDays, toDays } = checkHorizon(horizon);
  if (habit.status !== 'active') return Object.freeze([]);

  const offsets = canonicalWeekOffsets(habit);
  const dates: string[] = [];
  // Walk whole weeks and filter, rather than walking days and testing each:
  // the week is the unit the offsets are defined against, so a horizon that
  // starts on a Thursday yields that week's Saturday and no Monday — the same
  // Saturday, under the same id, as a horizon that started on the Monday.
  for (let weekStart: CivilDays = periodStartOf(fromDays); weekStart <= toDays; weekStart += 7) {
    for (const offset of offsets) {
      const day = weekStart + offset;
      if (day >= fromDays && day <= toDays) dates.push(fromCivilDays(day));
    }
  }
  dates.sort();
  return Object.freeze(dates);
}

export interface MaterializationResult {
  /** Every occurrence the habit has in this horizon, ascending by date. */
  readonly occurrences: readonly HabitOccurrence[];
  /** Rows this run added. */
  readonly created: readonly HabitOccurrence[];
  /**
   * Untouched `pending` rows this run withdrew because the habit no longer
   * asks for their date — a pause, an archive, or an edited cadence. Named
   * `withdrawn` rather than `deleted` because the caller decides what to do
   * with them, and because nothing the person did is ever in this list.
   */
  readonly withdrawn: readonly HabitOccurrence[];
}

/**
 * Materialize a habit over a bounded horizon, merging with what already exists.
 *
 * `existing` is whatever the caller already holds for this habit — it may be
 * empty on a first run and it may reach outside the horizon, which is normal
 * for a nightly job whose window slides forward. Occurrences outside the
 * horizon are passed through untouched: this function's claim is about the
 * horizon it was given, and quietly editing rows outside it would make a
 * narrow re-run a destructive operation.
 */
export function materializeHabitOccurrences(
  habit: HabitDefinition,
  horizon: HabitHorizon,
  existing: readonly HabitOccurrence[] = [],
): MaterializationResult {
  const { fromDays, toDays } = checkHorizon(horizon);
  const dates = demandDates(habit, horizon);
  const wanted = new Set(dates);

  const kept: HabitOccurrence[] = [];
  const withdrawn: HabitOccurrence[] = [];
  const seen = new Set<string>();

  for (const occurrence of existing) {
    if (occurrence.habitId !== habit.habitId) {
      throw new HabitValidationError(
        `occurrence ${occurrence.occurrenceId} belongs to habit ${occurrence.habitId}, not ${habit.habitId}`,
      );
    }
    if (seen.has(occurrence.occurrenceId)) continue;
    seen.add(occurrence.occurrenceId);
    const day = toCivilDays(occurrence.localDate);
    const insideHorizon = day >= fromDays && day <= toDays;
    // Anything the person touched, anything the planner placed, anything a
    // recovery produced, and anything outside the window: kept as it stands.
    // Only an untouched `pending` row the cadence no longer asks for is
    // withdrawn, and `ordinal > 0` means a recovery put it there rather than
    // the cadence, so the cadence may not take it away.
    const isUntouchedCadenceRow = occurrence.state === 'pending'
      && occurrence.ordinal === 0
      && occurrence.recoveredFromOccurrenceId === null;
    if (insideHorizon && isUntouchedCadenceRow && !wanted.has(occurrence.localDate)) {
      withdrawn.push(occurrence);
      continue;
    }
    kept.push(occurrence);
  }

  const created: HabitOccurrence[] = [];
  for (const localDate of dates) {
    const occurrenceId = occurrenceIdFor(habit.habitId, localDate, 0);
    if (seen.has(occurrenceId)) continue;
    created.push(Object.freeze({
      occurrenceId,
      habitId: habit.habitId,
      localDate,
      ordinal: 0,
      state: 'pending' as const,
      durationMinutes: habit.durationMinutes,
      recoveredFromOccurrenceId: null,
    }));
  }

  return Object.freeze({
    occurrences: Object.freeze([...kept, ...created].sort(byDateThenOrdinal)),
    created: Object.freeze(created),
    withdrawn: Object.freeze(withdrawn),
  });
}

/** Ascending by date, then by ordinal — never by anything a clock decides. */
export function byDateThenOrdinal(left: HabitOccurrence, right: HabitOccurrence): number {
  if (left.localDate !== right.localDate) return left.localDate < right.localDate ? -1 : 1;
  if (left.ordinal !== right.ordinal) return left.ordinal - right.ordinal;
  return left.occurrenceId < right.occurrenceId ? -1 : left.occurrenceId > right.occurrenceId ? 1 : 0;
}

/** How many of a week's `maximumOccurrences` slots are still spent. */
export function liveOccurrencesInPeriod(
  occurrences: readonly HabitOccurrence[],
  periodStart: CivilDays,
): readonly HabitOccurrence[] {
  return occurrences.filter((occurrence) => {
    if (!HABIT_LIVE_OCCURRENCE_STATES.includes(occurrence.state)) return false;
    return periodStartOf(toCivilDays(occurrence.localDate)) === periodStart;
  });
}

/**
 * Refuses an unbounded, backwards or over-long horizon.
 *
 * Refuses rather than clamps. A caller who asked for a year and got eight
 * weeks back would have no way to tell, and would go on believing the rest of
 * the year was already materialized.
 */
export function checkHorizon(horizon: HabitHorizon): { fromDays: CivilDays; toDays: CivilDays } {
  const fromDays = toCivilDays(horizon.fromLocalDate);
  const toDays = toCivilDays(horizon.toLocalDate);
  if (toDays < fromDays) {
    throw new HabitValidationError(
      `horizon ends before it starts: ${horizon.fromLocalDate}..${horizon.toLocalDate}`,
    );
  }
  const span = toDays - fromDays + 1;
  if (span > HABIT_HORIZON_MAX_DAYS) {
    throw new HabitValidationError(
      `horizon spans ${span} days, above the maximum of ${HABIT_HORIZON_MAX_DAYS}`,
    );
  }
  return { fromDays, toDays };
}

/** The demand a full week of this habit carries, for a caller sizing a horizon. */
export function occurrencesPerWeek(habit: HabitDefinition): number {
  return habit.status === 'active'
    ? Math.min(cadenceOccurrencesPerPeriod(habit.cadence), habit.maximumOccurrences)
    : 0;
}
