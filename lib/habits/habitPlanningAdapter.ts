/**
 * Habit occurrences, as ordinary planning items (#520).
 *
 * This is the whole of what the scheduler is told about habits, which is
 * nothing. The issue's constraint is explicit — *"Do not modify schedulePlan to
 * understand 'habits'. The adapter owns that translation"* — and it is kept
 * here structurally rather than by discipline: this module imports the planning
 * contracts and emits `PlanningItem`s, and nothing under `lib/planning/`
 * imports this file or knows the word habit. A habit occurrence reaches the
 * solver as a title, an effort, two bounds and, sometimes, a protection. The
 * solver has been able to read all five since #522.
 *
 * It is shaped after `buildDailyPlanInput` (`lib/services/dailyPlan/`), which
 * does the same job for commitments, and it is pure for the same reason: no
 * clock, no storage, no randomness, so the same occurrences on the same day
 * produce the same request and therefore the same `inputDigest`. The one
 * calendar fact it needs — where the local day starts and ends — it takes from
 * that module's exported `dayHorizon` rather than deriving a second answer.
 *
 * ── What this module does not read ───────────────────────────────
 *
 * `cadence`, `minimumOccurrences`, `maximumOccurrences` and `recoveryPolicy`
 * are all absent below, and their absence is the division of labour between
 * the two lanes of #520 rather than an omission. They decide *which dated
 * occurrences exist*, which is materialization's question and is answered
 * before this module is called. By the time an occurrence is here, the decision
 * that it should happen today has been taken; this module only says how it is
 * offered to the planner. An adapter that re-read the cadence would be a second
 * materializer, and the two would disagree on exactly the weeks that matter.
 *
 * ── How `flexibility` is honoured ────────────────────────────────
 *
 * `protected_flexible` becomes a `PlacementProtection` with
 * `origin: 'habit_policy'` — the origin #522 added to the contract for this
 * adapter before it existed. That makes the occurrence's preferred placement a
 * planning *objective*: `compareProtectionRetention` offers it a free run
 * first, `retainedStartMs` says which run it would rather have, and a hard
 * constraint still beats it. Which is what a protected habit is: the seven
 * o'clock run stays at seven until a meeting takes the hour.
 *
 * `flexible` becomes an item with **no `protection` key at all**, and that is a
 * decision rather than a default. Writing `{ ownership: 'flexible', ... }`
 * would type-check, be inert at the solver, and silently break the carry-
 * forward seam: `projectBlockProtectionIntoPlanningConstraints` leaves an item
 * alone once it "already states its own protection", so a flexible habit that
 * stated an inert one would lose a protection the *user* had put on that block
 * by dragging it, on the next regeneration and every one after. The absence is
 * load-bearing and `habitPlanningAdapter.test.ts` fails when it is filled in.
 *
 * ── How `preferredWindows` are honoured, and where they are not ──
 *
 * A preferred window is a preference, and the planner has exactly one lever
 * that is a preference rather than a bound: the protection objective. So for a
 * `protected_flexible` habit the earliest preferred window becomes the
 * protection's `preferredInterval` — tried first, yielded when something harder
 * demands the slot — which is precisely the semantics the window is asking for.
 *
 * For a plain `flexible` habit there is no such lever, and this module does not
 * invent one. The two available alternatives are both worse than doing nothing:
 * narrowing `earliestStartAt`/`deadlineAt` to the window turns a preference
 * into a hard constraint and makes a habit unschedulable on a busy morning —
 * reported as `EFFORT_EXCEEDS_ITEM_WINDOW`, which would not be true of it — and
 * giving it a protection is the lie the paragraph above rejects. So the
 * materialized windows are returned *beside* the items, on
 * `HabitPlanningRequest.preferredWindows`, for a caller that can record them
 * (`ScheduleBlockPlacement.preferredWindows` is the field #521 left empty for
 * exactly this), and a flexible habit's window reaches no solver lever in v1.
 * That is the one place this adapter honours `preferredWindows` partially, and
 * closing it means giving `PlanningItem` a preference field — a change to the
 * planner's vocabulary, which is the change this issue forbids.
 */
import type {
  Instant,
  PlacementProtection,
  PlanningItem,
  TimeInterval,
} from '../../src/contracts/v1/planningContracts';
import type { ScheduleBlockSource } from '../../src/contracts/v1/scheduleBlockContracts';
import { dayHorizon } from '../services/dailyPlan/buildDailyPlan';
import { toEpochMs, toInstant } from '../planning/shared/time';
import {
  isOpenOccurrence,
  type HabitDefinition,
  type HabitOccurrence,
  type TimeWindow,
} from './habitTypes';

/**
 * The priority a habit occurrence carries into the plan.
 *
 * The one invented number in this mapping, stated once, the way
 * `DEFAULT_EFFORT_MINUTES` is stated once in `buildDailyPlan`. A habit is not
 * priority-scored — nothing in `HabitDefinition` ranks it — and `priority` is a
 * required field, so a number has to be chosen. Two, which is what
 * `buildDailyPlan` gives a `normal` commitment: a habit therefore orders below
 * the things the user called important and above the things they called
 * unimportant, which is the least surprising of the three places it could sit.
 *
 * It is deliberately *not* derived from `flexibility`. Protection is not
 * priority — `planningContracts` says so where `PlacementProtection` is
 * declared — and making a protected habit outrank an unprotected one here
 * would quietly reintroduce the derivation that type exists to forbid.
 */
export const HABIT_PRIORITY = 2;

export interface HabitPlanningArgs {
  /** Every habit the occurrences might belong to, keyed however the caller holds them. */
  readonly definitions: readonly HabitDefinition[];
  /** The occurrences materialization produced. Ones for other days are ignored. */
  readonly occurrences: readonly HabitOccurrence[];
  /** The local date being planned, `YYYY-MM-DD`. */
  readonly localDate: string;
  readonly timezone: string;
  /**
   * The floor the caller's plan is already applying to its other items (#500),
   * or null. Passed in rather than derived, because a habit must not be placed
   * in the morning that has already gone by *and* must not disagree with the
   * commitments beside it about when that morning ended. `buildDailyPlan`'s
   * `earliestPlaceableStart` is the one place that instant is computed.
   */
  readonly earliestStartAt: Instant | null;
  /**
   * Where a protected occurrence was last kept, by occurrence id.
   *
   * The seam for the user's own hand. `protectionAfterMove` (#522) rules that
   * "a habit policy's protection that the user then dragged is still the
   * habit's protection, now preferring where the person put it" — and this
   * adapter would otherwise overwrite that every morning with the policy
   * window, because an item that states its own protection is not re-projected
   * from the stored block. So the caller passes what the user kept, and it wins
   * over the definition's window. Empty or absent means nobody has moved
   * anything and the window is the preference.
   */
  readonly retainedStarts?: ReadonlyMap<string, Instant>;
}

export interface HabitPlanningRequest {
  /** One item per open occurrence on `localDate`, in occurrence-id order. */
  readonly items: readonly PlanningItem[];
  /** `itemId` -> the schedule source, for `reconcileScheduleBlocks`. */
  readonly sources: ReadonlyMap<string, ScheduleBlockSource>;
  /**
   * `itemId` -> every preferred window, materialized on `localDate`.
   *
   * Beside the items rather than on them: see the header. A caller writing
   * blocks can record these on `ScheduleBlockPlacement.preferredWindows`; the
   * solver is not given them.
   */
  readonly preferredWindows: ReadonlyMap<string, readonly TimeInterval[]>;
}

/**
 * A wall-clock preferred window as an absolute interval on one local day.
 *
 * Built off the day's own start instant rather than by re-resolving a local
 * time, so a window is measured from the same midnight the horizon is — on a
 * spring-forward day the horizon already starts at the instant the clock
 * jumped to, and a window measured from a nominal 00:00 would sit an hour out
 * of step with the plan it is a preference inside.
 *
 * Null for a window that is not a well-formed range, which is `INVALID_INTERVAL`'s
 * rule applied one level up: a zero-length or backwards preference states no
 * position, and a preference that states no position must not become one.
 */
export function materializePreferredWindow(
  window: TimeWindow,
  dayStartsAt: Instant,
): TimeInterval | null {
  const { startMinute, endMinute } = window;
  if (!Number.isFinite(startMinute) || !Number.isFinite(endMinute)) return null;
  if (endMinute <= startMinute) return null;
  const dayStartMs = toEpochMs(dayStartsAt);
  return {
    startsAt: toInstant(dayStartMs + startMinute * 60_000),
    endsAt: toInstant(dayStartMs + endMinute * 60_000),
  };
}

/**
 * Which preferred window a placement is preferred inside.
 *
 * The earliest one, by start. Deterministic because the plan has to be — two
 * builds of the same day must not prefer two different mornings — and earliest
 * rather than longest because a habit with both a morning and an evening
 * window is asking for the morning and settling for the evening. `sort` is on
 * a copy: the caller's definition is not this function's to reorder.
 */
export function preferredPlacementWindow(
  windows: readonly TimeWindow[],
  dayStartsAt: Instant,
): TimeInterval | null {
  const materialized = windows
    .map((window) => materializePreferredWindow(window, dayStartsAt))
    .filter((interval): interval is TimeInterval => interval !== null)
    .sort((left, right) => toEpochMs(left.startsAt) - toEpochMs(right.startsAt));
  return materialized[0] ?? null;
}

/**
 * The protection an occurrence carries into the plan, or null for none.
 *
 * Null — *the key absent*, see the header — for a `flexible` habit, which is
 * the case that has to keep working for the carry-forward seam to survive.
 *
 * `maxShiftMinutes` is null because a `HabitDefinition` states no bound. Null
 * is not "no bound is wanted", it is "this habit has not named one", and
 * `PlacementProtection` reads the two the same way on purpose: the placement is
 * still an objective, there is simply no distance at which moving it becomes a
 * refusal. Inventing a bound here would refuse to schedule a habit on a busy
 * day and report `PROTECTED_SHIFT_EXCEEDED` about a limit the user never set.
 */
export function habitProtection(
  definition: HabitDefinition,
  occurrence: HabitOccurrence,
  dayStartsAt: Instant,
  retainedStart: Instant | undefined,
): PlacementProtection | null {
  if (definition.flexibility !== 'protected_flexible') return null;

  const preferredInterval = retainedStart === undefined
    ? preferredPlacementWindow(definition.preferredWindows, dayStartsAt)
    // What the user kept is a placement, so it is as long as the occurrence
    // is — not as long as the window the habit would otherwise prefer.
    : {
        startsAt: retainedStart,
        endsAt: toInstant(toEpochMs(retainedStart) + occurrence.durationMinutes * 60_000),
      };

  return {
    ownership: 'protected_flexible',
    origin: 'habit_policy',
    // Null is a real case and not a failure: a habit with no preferred window
    // and no kept placement is protected in principle with nothing yet to
    // retain, which `retainedStartMs` is written to answer.
    preferredInterval,
    maxShiftMinutes: null,
  };
}

/** `{ kind: 'habit_occurrence', id }` — the solver's `itemId` is the occurrence id. */
export function habitScheduleSource(occurrenceId: string): ScheduleBlockSource {
  return { kind: 'habit_occurrence', id: occurrenceId };
}

/**
 * The occurrences of one local day, as planning items.
 *
 * Three filters, each of which is a thing that would otherwise be scheduled
 * wrongly rather than a tidiness:
 *
 *  - **the day.** An occurrence for another date is dropped. The caller loads a
 *    day, but a materializer that produced tomorrow's occurrence a day early
 *    would otherwise have it placed today, inside a horizon it does not belong
 *    to and against a deadline that is not its own.
 *  - **the state.** Only `pending` and `scheduled` are still work. A completed,
 *    skipped or recovered occurrence offered to the planner is time reserved
 *    for something that already happened — the user's evening given back to a
 *    run they went on this morning.
 *  - **the definition.** An occurrence whose habit is `paused`, `archived` or
 *    missing is dropped. Pausing a habit that keeps being scheduled is not a
 *    pause, and an occurrence with no definition has no title, no duration
 *    policy and no flexibility — there is nothing to place it as.
 *
 * Sorted by occurrence id so the request is a function of its content and not
 * of the order a store happened to return rows in. That is the same rule
 * `reconcileScheduleBlocks` sorts by, and it is what keeps `inputDigest` stable
 * across two reads of the same day.
 */
export function buildHabitPlanningRequest(args: HabitPlanningArgs): HabitPlanningRequest {
  const { startsAt, endsAt } = dayHorizon(args.localDate, args.timezone);
  const retained = args.retainedStarts ?? new Map<string, Instant>();
  const byHabitId = new Map(args.definitions.map((definition) => [definition.habitId, definition]));

  const planned = [...args.occurrences]
    .filter((occurrence) => occurrence.localDate === args.localDate && isOpenOccurrence(occurrence))
    .sort((left, right) => (left.occurrenceId < right.occurrenceId ? -1 : left.occurrenceId > right.occurrenceId ? 1 : 0))
    .flatMap((occurrence) => {
      const definition = byHabitId.get(occurrence.habitId);
      if (definition === undefined || definition.status !== 'active') return [];
      const protection = habitProtection(definition, occurrence, startsAt, retained.get(occurrence.occurrenceId));
      const item: PlanningItem = {
        itemId: occurrence.occurrenceId,
        title: definition.title,
        // Verbatim, including a duration that cannot be placed. A zero or
        // negative one earns `EFFORT_NOT_POSITIVE` from the validator, which is
        // true of it; repairing it here would place a block of invented length
        // and report success. The occurrence's duration rather than the
        // definition's, because a recovered or shortened occurrence is the one
        // being scheduled.
        effort: { kind: 'known', minutes: occurrence.durationMinutes },
        earliestStartAt: args.earliestStartAt,
        // The end of the day it belongs to. An occurrence is *dated* — that is
        // what materialization decided — so a habit that did not fit today is
        // reported as not having fitted today, rather than sliding into
        // tomorrow where a second occurrence is already waiting for it.
        deadlineAt: endsAt,
        priority: HABIT_PRIORITY,
        dependsOn: [],
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        // Spread, so a flexible habit's item has no `protection` key at all
        // rather than an explicit null. See the header: the difference is what
        // keeps a user's own dragged protection from being erased every
        // regeneration.
        ...(protection === null ? {} : { protection }),
      };
      const windows = definition.preferredWindows
        .map((window) => materializePreferredWindow(window, startsAt))
        .filter((interval): interval is TimeInterval => interval !== null);
      return [{ item, windows }];
    });

  return {
    items: planned.map((entry) => entry.item),
    sources: new Map(planned.map((entry) => [entry.item.itemId, habitScheduleSource(entry.item.itemId)])),
    preferredWindows: new Map(planned.map((entry) => [entry.item.itemId, entry.windows])),
  };
}
