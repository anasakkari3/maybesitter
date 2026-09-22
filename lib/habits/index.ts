/**
 * Habits: executable demand on future time (#520).
 *
 * The domain half. What is deliberately absent is the translation from a
 * `HabitOccurrence` to a schedule block or a `PlanningItem`, and the routes —
 * both belong to the adapter, which is the only thing allowed to call the
 * scheduler. Nothing under this directory imports `lib/planning/scheduler`,
 * and `tests/habits/habitBoundaries.test.ts` asserts it.
 */
export {
  addDays,
  daysBetweenInclusive,
  fromCivilDays,
  periodIndexOf,
  periodStartOf,
  toCivilDays,
  weekdayOfLocalDate,
  type CivilDays,
} from './civilDate';
export {
  byDateThenOrdinal,
  canonicalWeekOffsets,
  checkHorizon,
  demandDates,
  liveOccurrencesInPeriod,
  materializeHabitOccurrences,
  occurrenceIdFor,
  occurrencesPerWeek,
  type MaterializationResult,
} from './materialize';
export {
  recoverSkippedOccurrence,
  type HabitRecoveryDeclineReason,
  type HabitRecoveryOutcome,
  type HabitRecoveryRequest,
} from './recovery';
export {
  buildHabitProposal,
  confirmHabitProposal,
  type HabitProposalInput,
} from './proposal';
export { StorageHabitStore, createStorageHabitStore } from './habitStore';
