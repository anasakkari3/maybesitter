/**
 * What a habit does with a date that did not happen (#520).
 *
 * ── A skip is a date, not a verdict ─────────────────────────────
 *
 * The only thing this module knows how to do is offer another date, and only
 * when the person configured it to. There is no count of consecutive skips, no
 * adjustment to anything, and nothing here reads or writes a field that
 * accumulates across weeks — a skipped Monday leaves the week exactly as able
 * to hold three gym sessions as it was before.
 *
 * ── Bounded by the week, and by the ceiling ─────────────────────
 *
 * `recover_within_period` may only offer a date inside the same ISO week, and
 * only while fewer than `maximumOccurrences` of that week's slots are still
 * spent. Both bounds are needed and they catch different things: without the
 * week, a fortnight away would recover into the fortnight's end; without the
 * ceiling, a week where all three sessions were skipped would offer three
 * replacements on the remaining days, which is the pile-up the issue's
 * `maximumOccurrences` exists to prevent.
 *
 * ── No clock ────────────────────────────────────────────────────
 *
 * `notBeforeLocalDate` is required. A recovery that could read the current
 * date would offer a different answer every time it ran, and the caller — who
 * knows the user's zone, which this module deliberately does not — is the only
 * one who can say what "today" is for this person anyway.
 */

import {
  HABIT_LIVE_OCCURRENCE_STATES,
  HabitValidationError,
  type HabitDefinition,
  type HabitOccurrence,
} from '../../src/contracts/v1/habitContracts';
import { fromCivilDays, periodStartOf, toCivilDays } from './civilDate';
import { byDateThenOrdinal, liveOccurrencesInPeriod, occurrenceIdFor } from './materialize';

/**
 * Why no replacement was offered. Every one of these is a fact about the
 * configuration or the week, and none of them is a fact about the person.
 */
export type HabitRecoveryDeclineReason =
  | 'occurrence_not_found'
  | 'occurrence_not_skipped'
  | 'habit_not_active'
  | 'policy_is_skip'
  | 'period_capacity_reached'
  | 'no_date_left_in_period';

export type HabitRecoveryOutcome =
  | {
    readonly kind: 'recovered';
    readonly replacement: HabitOccurrence;
    /** The full list, with the skipped row now `recovered`. Ascending. */
    readonly occurrences: readonly HabitOccurrence[];
  }
  | {
    readonly kind: 'none';
    readonly reason: HabitRecoveryDeclineReason;
    /** Unchanged, so a caller can write the result back either way. */
    readonly occurrences: readonly HabitOccurrence[];
  };

export interface HabitRecoveryRequest {
  readonly habit: HabitDefinition;
  readonly occurrences: readonly HabitOccurrence[];
  /** The skipped occurrence to offer a replacement for. */
  readonly occurrenceId: string;
  /** The earliest date a replacement may land on — the caller's "today". */
  readonly notBeforeLocalDate: string;
}

export function recoverSkippedOccurrence(request: HabitRecoveryRequest): HabitRecoveryOutcome {
  const { habit, occurrences, occurrenceId, notBeforeLocalDate } = request;
  const notBeforeDays = toCivilDays(notBeforeLocalDate);
  const sorted = Object.freeze([...occurrences].sort(byDateThenOrdinal));
  const decline = (reason: HabitRecoveryDeclineReason): HabitRecoveryOutcome =>
    Object.freeze({ kind: 'none' as const, reason, occurrences: sorted });

  const skipped = sorted.find((entry) => entry.occurrenceId === occurrenceId);
  if (!skipped) return decline('occurrence_not_found');
  if (skipped.habitId !== habit.habitId) {
    throw new HabitValidationError(
      `occurrence ${occurrenceId} belongs to habit ${skipped.habitId}, not ${habit.habitId}`,
    );
  }
  // Only a skip recovers. A `completed` occurrence has nothing to replace and a
  // `pending` one has not happened yet, so recovering either would add demand
  // the cadence never asked for.
  if (skipped.state !== 'skipped') return decline('occurrence_not_skipped');
  // A paused habit stops asking for future time; offering it a replacement
  // would be the pause creating demand, which is the opposite of a pause.
  if (habit.status !== 'active') return decline('habit_not_active');
  if (habit.recoveryPolicy === 'skip') return decline('policy_is_skip');

  const skippedDays = toCivilDays(skipped.localDate);
  const periodStart = periodStartOf(skippedDays);
  if (liveOccurrencesInPeriod(sorted, periodStart).length >= habit.maximumOccurrences) {
    return decline('period_capacity_reached');
  }

  const candidates = habit.recoveryPolicy === 'retry_same_day'
    ? [skippedDays]
    // Strictly later in the same week: the same day is what `retry_same_day`
    // is for, and a policy that quietly did both would make the two settings
    // indistinguishable for the user who chose between them.
    : rangeOfDays(Math.max(skippedDays + 1, periodStart), periodStart + 6);

  const day = candidates.find((candidate) => {
    if (candidate < notBeforeDays) return false;
    const localDate = fromCivilDays(candidate);
    return !sorted.some((entry) =>
      entry.localDate === localDate && HABIT_LIVE_OCCURRENCE_STATES.includes(entry.state));
  });
  if (day === undefined) return decline('no_date_left_in_period');

  const localDate = fromCivilDays(day);
  const ordinal = nextFreeOrdinal(sorted, localDate);
  const replacement: HabitOccurrence = Object.freeze({
    occurrenceId: occurrenceIdFor(habit.habitId, localDate, ordinal),
    habitId: habit.habitId,
    localDate,
    ordinal,
    state: 'pending' as const,
    durationMinutes: habit.durationMinutes,
    recoveredFromOccurrenceId: skipped.occurrenceId,
  });

  // The skipped row becomes `recovered`: it stays, it still says the date did
  // not happen, and it stops being a skip anything could offer a second
  // replacement for. Calling this twice therefore declines the second time
  // with `occurrence_not_skipped` rather than writing two replacements.
  const updated = sorted.map((entry) =>
    entry.occurrenceId === skipped.occurrenceId
      ? Object.freeze({ ...entry, state: 'recovered' as const })
      : entry);

  return Object.freeze({
    kind: 'recovered' as const,
    replacement,
    occurrences: Object.freeze([...updated, replacement].sort(byDateThenOrdinal)),
  });
}

function rangeOfDays(from: number, to: number): number[] {
  const days: number[] = [];
  for (let day = from; day <= to; day += 1) days.push(day);
  return days;
}

/**
 * The lowest ordinal this date does not already use.
 *
 * Scanning rather than "one past the highest", because a withdrawn row leaves
 * a hole and reusing it keeps the id short and the date's rows contiguous.
 * Either way the answer is a function of the list, so the same list yields the
 * same id — the determinism guarantee has to hold for recovery too.
 */
function nextFreeOrdinal(occurrences: readonly HabitOccurrence[], localDate: string): number {
  const taken = new Set(
    occurrences.filter((entry) => entry.localDate === localDate).map((entry) => entry.ordinal),
  );
  let ordinal = 0;
  while (taken.has(ordinal)) ordinal += 1;
  return ordinal;
}
