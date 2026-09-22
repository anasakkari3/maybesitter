/**
 * ⚠️ PLACEHOLDER — habit domain types, stood up by the adapter lane (#520).
 *
 * **This file is scaffolding and is expected to be deleted.** Issue #520 is
 * split across two lanes: one owns the habit domain model and the
 * materialization that turns a cadence into dated occurrences, and this one
 * owns the scheduler adapter and the API routes. The two were built in
 * parallel against a written contract, and what follows is this lane's local
 * transcription of that contract so that the adapter and the routes could be
 * implemented, typed and tested before the domain lane landed.
 *
 * When the domain lane's real types arrive, this module is replaced by a
 * re-export of them and the reconciliation is a compile error wherever the two
 * disagree — which is the point of transcribing the contract in a type rather
 * than in a comment. The fields below are the contract as this lane received
 * it; anything it had to *invent* because the contract did not say is called
 * out in place, and those are the reconciliation points:
 *
 *  1. `TimeWindow` — the contract names the type and not its shape. It is read
 *     here as a wall-clock range in minutes from local midnight, `[startMinute,
 *     endMinute)`, which is `WorkingWindow`'s convention in
 *     `planningContracts` minus the weekday and the zone (a habit's preferred
 *     window is a statement about a clock face; which dates it applies to is
 *     the cadence's business, and the zone is the scope's). If the domain lane
 *     makes it an absolute `TimeInterval` instead, the adapter's
 *     `materializePreferredWindow` is the one function that changes.
 *  2. `scopeId` is carried on the definition per the contract. The API routes
 *     never read it from a request body — it is the verified uid — for the
 *     reason `watcherApi` states: a body that can choose the tree is a body
 *     that can choose somebody else's tree.
 *  3. `HabitOccurrence` carries no placement, so "where this habit was last
 *     kept" cannot come from an occurrence. The adapter takes it as a separate,
 *     optional input; see `retainedStarts` there.
 */
import type { MinuteOfDay } from '../../src/contracts/v1/planningContracts';

/** How often a habit is meant to happen. Read by materialization, never by the adapter. */
export type HabitCadence =
  | { readonly kind: 'weekly_count'; readonly count: number }
  | { readonly kind: 'weekdays'; readonly weekdays: readonly number[] };

/**
 * A stretch of wall-clock time a habit would rather happen in.
 *
 * `endMinute` is exclusive, like every other interval this repo plans over.
 * See reconciliation point 1 above.
 */
export interface TimeWindow {
  readonly startMinute: MinuteOfDay;
  readonly endMinute: MinuteOfDay;
}

/**
 * Whose decision a habit's position is.
 *
 * This is the field the adapter translates into `PlacementProtection`, and the
 * translation is the whole reason the scheduler needs no new concept: see
 * `habitPlanningAdapter`.
 */
export type HabitFlexibility = 'flexible' | 'protected_flexible';

/** What happens to a missed occurrence. Materialization's business, not the adapter's. */
export type HabitRecoveryPolicy = 'skip' | 'retry_same_day' | 'recover_within_period';

export type HabitStatus = 'active' | 'paused' | 'archived';

export type HabitSource = 'user_created' | 'goal_confirmed' | 'onboarding_confirmed';

export interface HabitDefinition {
  readonly habitId: string;
  readonly scopeId: string;
  readonly title: string;
  readonly cadence: HabitCadence;
  readonly durationMinutes: number;
  readonly preferredWindows: readonly TimeWindow[];
  readonly minimumOccurrences: number;
  readonly maximumOccurrences: number;
  readonly flexibility: HabitFlexibility;
  readonly recoveryPolicy: HabitRecoveryPolicy;
  readonly status: HabitStatus;
  readonly source: HabitSource;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * The five states an occurrence can be in.
 *
 * `recovered` is reachable only from the recovery machinery the domain lane
 * owns; the two API routes in this lane produce `completed` and `skipped` and
 * nothing else. It is in the union because the adapter has to decide what to
 * do with one, and the answer — like `completed` and `skipped` — is that it is
 * not offered to the planner again.
 */
export type HabitOccurrenceState = 'pending' | 'scheduled' | 'completed' | 'skipped' | 'recovered';

export interface HabitOccurrence {
  readonly occurrenceId: string;
  readonly habitId: string;
  /** The local calendar date this occurrence belongs to, `YYYY-MM-DD`. */
  readonly localDate: string;
  readonly state: HabitOccurrenceState;
  readonly durationMinutes: number;
}

/**
 * The occurrence states that are still work the planner could be asked to place.
 *
 * Exported and named because three readers ask the same question — the
 * adapter, the skip/complete routes, and their tests — and a fourth copy of
 * `state === 'pending' || state === 'scheduled'` is how the adapter and the
 * routes come to disagree about what "done" means.
 */
export const OPEN_OCCURRENCE_STATES: readonly HabitOccurrenceState[] = Object.freeze([
  'pending',
  'scheduled',
]);

export function isOpenOccurrence(occurrence: HabitOccurrence): boolean {
  return OPEN_OCCURRENCE_STATES.includes(occurrence.state);
}

/** The terminal states the two occurrence routes can put an occurrence into. */
export type HabitOccurrenceOutcome = 'completed' | 'skipped';
