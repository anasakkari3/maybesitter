/**
 * Habits, the adapter half (#520).
 *
 * `lib/habits/` is the domain: what a habit is, which dates its rule implies,
 * what a skip may recover into. None of it may import the scheduler, a model,
 * the extractor or a service — `tests/habits/habitBoundaries.test.ts` reads the
 * source and enforces that, and criterion 3 there says in so many words that
 * the translation from an occurrence to a `PlanningItem` belongs to the
 * adapter, not to that directory.
 *
 * This directory is the adapter. It is allowed the imports the domain is not,
 * and it holds the four things that need them:
 *
 *   `habitOccurrenceStore`  where materialized dates are kept
 *   `habitService`          the domain's pure functions joined to both stores
 *   `habitPlanningAdapter`  one occurrence -> one ordinary `PlanningItem`
 *   `habitApi` / `occurrenceOutcome`   what the routes may say and be told
 *
 * The split is not bookkeeping. It is what lets the boundary test keep passing
 * exactly as the domain lane wrote it, with no line relaxed to accommodate this
 * lane — which is the only honest way to land two halves of one issue.
 */
export {
  StorageHabitOccurrenceStore,
  createStorageHabitOccurrenceStore,
  isHabitOccurrence,
  isOpenOccurrence,
  type HabitOccurrenceOutcome,
  type HabitOccurrenceStore,
  type OccurrenceTransition,
} from './habitOccurrenceStore';
export {
  DEFAULT_HORIZON_DAYS,
  applyOccurrenceOutcome,
  createHabitServices,
  createHabitWithOccurrences,
  horizonFrom,
  loadHabitDemand,
  patchHabitWithOccurrences,
  removeHabitWithOccurrences,
  resyncHabitOccurrences,
  todayLocalDateFor,
  type CreatedHabit,
  type HabitServices,
  type OccurrenceOutcomeResult,
} from './habitService';
export {
  HABIT_PRIORITY,
  buildHabitPlanningRequest,
  habitProtection,
  habitScheduleSource,
  materializePreferredWindow,
  preferredPlacementWindow,
  type HabitPlanningArgs,
  type HabitPlanningRequest,
} from './habitPlanningAdapter';
export {
  HabitValidationError,
  checkHabitPatchBody,
  checkNewHabitBody,
  habitValidationResponse,
  parseHabitId,
  parseOccurrenceId,
  presentHabit,
  presentOccurrence,
} from './habitApi';
export { respondToOccurrenceOutcome, type OccurrenceParams } from './occurrenceOutcome';
