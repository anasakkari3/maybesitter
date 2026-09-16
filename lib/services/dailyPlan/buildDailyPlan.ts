/**
 * A day's commitments, busy time and routine, turned into a planning request
 * (UC-3.10a, #194).
 *
 * Pure. It takes a clock reading nowhere: the caller has already decided which
 * local date is being planned and has loaded everything the mapping reads. That
 * is the same rule `PLANNING_PERSISTENCE_POLICY.noAmbientClock` puts on the
 * scheduler itself, and it is what makes "two runs on the same input produce the
 * same `inputDigest`" a property a test can assert rather than a hope.
 *
 * It also writes nothing, and can write nothing: it has no storage adapter, no
 * transaction, and no import that reaches one. `PLANNING_PERSISTENCE_POLICY`
 * says `planCanPersist: false` and `originalCommitmentRemainsCanonical: true`,
 * and the shape of this module is how the first half of that is kept — the plan
 * is a proposal about time that is derived from commitments and never edits
 * them. `tests/dailyPlan/dailyPlanBoundaries.test.ts` holds the second half.
 *
 * ── The busy-block seam ──────────────────────────────────────────
 *
 * Acceptance criterion 1 is that no scheduled work lands inside a busy block.
 * The calendar source those blocks come from is UC-3.2 (#186) and **does not
 * exist yet**, so this module does not import one. It declares the narrowest
 * shape it needs — an id and a half-open interval — and takes a list of them as
 * an argument, defaulted to empty by `NO_BUSY_BLOCKS`.
 *
 * The criterion is therefore provable *here*, today, against injected blocks,
 * and unprovable end-to-end until #186 supplies a real reader. Those are two
 * different claims and the report says so rather than letting a green unit test
 * stand in for a calendar nobody has connected.
 *
 * ── Yesterday's work rolls into today ────────────────────────────
 *
 * #383's owner decision, and this module implements the planner half of it: an
 * active commitment whose date has passed is due *today* here — its deadline is
 * the end of the day being planned (`deadlineFor`) and a start instant that has
 * already gone by stops pinning it (`pinnedStartOf`). Before that rule it was
 * admitted to the plan with a deadline behind the horizon, which no scheduler
 * can satisfy, so a backlog came back as `DEADLINE_BEYOND_HORIZON` every
 * morning for ever.
 *
 * The list half of the same rule — `listTodayRanked` and `listUpcomingRanked`,
 * which today match a past day with neither filter and drop it from the user's
 * view entirely — is **not** in this module and is not done. #383 is the one
 * place that rule is written down, and both halves answer to it.
 */
import type { Commitment } from '../../../src/domain/stateMachine';
import type { UserRoutineProfile } from '../../../src/contracts/v1/routineContracts';
import type {
  FixedEvent,
  Instant,
  PlanningConfig,
  PlanningConstraints,
  PlanningItem,
  Weekday,
  WorkingWindow,
} from '../../../src/contracts/v1/planningContracts';
import { instantFromResolution, resolveLocalTime, toEpochMs, weekdayAt } from '../../planning/shared/time';
import { fixedEndFor } from '../timeCollision';

/** The grid a plan is placed on. Fifteen minutes is the issue's decision. */
export const PLAN_SLOT_MINUTES = 15;
/**
 * How long an unestimated commitment is assumed to take.
 *
 * `Commitment` carries no duration, so every item would otherwise be
 * `Effort.unknown` — which the scheduler reports rather than places, and a plan
 * that places nothing is not a plan. Thirty minutes is stated once, here, and
 * is the only invented number in the mapping.
 */
export const DEFAULT_EFFORT_MINUTES = 30;
/** A commitment with a fixed start occupies this much of the day. */
export const DEFAULT_FIXED_EVENT_MINUTES = 30;
/** Used when the routine profile names no focus window and no sleep window. */
export const FALLBACK_WINDOW = Object.freeze({ startMinute: 8 * 60, endMinute: 20 * 60 });

/**
 * Time the user is already committed to elsewhere.
 *
 * Deliberately not `BusyWindow`, `FixedEvent` or anything #186 may choose: this
 * is the *narrowest* thing the mapping needs, so that the adapter #186 writes
 * can be a three-field projection rather than a dependency this module took on
 * a contract it cannot see yet.
 */
export interface BusyBlock {
  readonly blockId: string;
  readonly startsAt: Instant;
  /** Exclusive, like every other interval in the planning contracts. */
  readonly endsAt: Instant;
}

/** How busy blocks are fetched. UC-3.2 (#186) supplies the real one. */
export type BusyBlockReader = (
  uid: string,
  window: { readonly startsAt: Instant; readonly endsAt: Instant },
) => Promise<readonly BusyBlock[]>;

/**
 * The default reader: there are no busy blocks.
 *
 * Empty rather than throwing, because a missing calendar integration must not
 * stop a user's plan being built — it only means the plan is built against
 * fewer constraints than it eventually will be.
 */
export const NO_BUSY_BLOCKS: BusyBlockReader = async () => [];

export interface DailyPlanInputArgs {
  readonly uid: string;
  /** The local calendar date being planned, `YYYY-MM-DD`. */
  readonly date: string;
  readonly timezone: string;
  readonly commitments: readonly Commitment[];
  readonly busyBlocks: readonly BusyBlock[];
  readonly profile: UserRoutineProfile | null;
}

export interface DailyPlanInput {
  readonly constraints: PlanningConstraints;
  readonly config: PlanningConfig;
}

/**
 * `earliest` throughout: the plan, the horizon and the delivery instant all
 * resolve an ambiguous local time the same way, so a fall-back Sunday cannot
 * have its plan built under one reading of the day and delivered under another.
 */
export const DAILY_PLAN_CONFIG: PlanningConfig = Object.freeze({
  slotMinutes: PLAN_SLOT_MINUTES,
  foldPolicy: 'earliest',
  resourceDependenciesOrder: false,
});

/** Local midnight on `date`, as an instant. A gap resumes at the transition. */
function localMidnight(date: string, timezone: string, dayOffset = 0): Instant {
  const [year, month, day] = date.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + dayOffset));
  const resolution = resolveLocalTime(
    {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour: 0,
      minute: 0,
    },
    timezone,
  );
  // Some zones move their clock at midnight (America/Santiago has done so), so
  // "local 00:00" is a time that need not exist. The day then starts at the
  // instant the clock jumps to; it does not start an hour early.
  if (resolution.kind === 'gap') return resolution.resumesAt;
  const instant = instantFromResolution(resolution, DAILY_PLAN_CONFIG.foldPolicy);
  if (!instant) throw new Error(`could not resolve local midnight on ${date} in ${timezone}`);
  return instant;
}

/** `HH:mm` as minutes from local midnight, or null when it is not `HH:mm`. */
function minuteOfDay(value: string): number | null {
  const match = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** A wall-clock window as one or two non-wrapping minute ranges. */
function minuteRanges(window: { start: string; end: string } | null): Array<[number, number]> {
  if (!window) return [];
  const start = minuteOfDay(window.start);
  const end = minuteOfDay(window.end);
  if (start === null || end === null) return [];
  if (start === end) return [];
  // A window that reads backwards wraps midnight — 22:00 to 06:00 is the usual
  // sleep window. `WorkingWindow` forbids wrapping (it makes "which weekday?"
  // ambiguous exactly at a DST transition), so it becomes two ranges.
  return start < end ? [[start, end]] : [[start, 1440], [0, end]];
}

function subtractRanges(base: Array<[number, number]>, cuts: Array<[number, number]>): Array<[number, number]> {
  return base.reduce<Array<[number, number]>>((runs, run) => {
    let current: Array<[number, number]> = [run];
    for (const [cutStart, cutEnd] of cuts) {
      current = current.flatMap(([start, end]) => {
        if (cutEnd <= start || cutStart >= end) return [[start, end] as [number, number]];
        const left: Array<[number, number]> = start < cutStart ? [[start, cutStart]] : [];
        const right: Array<[number, number]> = cutEnd < end ? [[cutEnd, end]] : [];
        return [...left, ...right];
      });
    }
    return [...runs, ...current];
  }, []);
}

/**
 * The wall-clock windows the user is willing to work in on `date`.
 *
 * The routine profile's focus windows when it has any. Otherwise the issue's
 * fallback — 08:00 to 20:00 minus whatever the profile calls sleep — which is a
 * guess, and is why it is only reached when the user has told us nothing.
 */
export function workingWindowsFor(
  profile: UserRoutineProfile | null,
  timezone: string,
  weekday: Weekday,
): WorkingWindow[] {
  const focus = (profile?.focusWindows ?? []).flatMap((window) => minuteRanges(window));
  const ranges = focus.length > 0
    ? focus
    : subtractRanges([[FALLBACK_WINDOW.startMinute, FALLBACK_WINDOW.endMinute]], minuteRanges(profile?.sleepWindow ?? null));

  return ranges.map(([startMinute, endMinute], index) => ({
    windowId: `w${index}`,
    weekday,
    startMinute,
    endMinute,
    timezone,
  }));
}

/** The instant a commitment is pinned to, or null when it floats. */
export function fixedStartOf(commitment: Commitment): Instant | null {
  if (commitment.postponedUntil) return commitment.postponedUntil;
  if (commitment.timeSpec.kind === 'scheduled_event') {
    return commitment.timeSpec.remindAt ?? commitment.timeSpec.dueAt;
  }
  return null;
}

// `fixedEndFor` — how long a pinned commitment occupies — now lives in
// `../timeCollision`, which needs the identical rule for a collision
// candidate's duration. Two copies of "how long is this commitment" in two
// files is how the planner and the device calendar came to disagree in the
// first place; see that module's doc comment for the full account.

/** Confirmed, still open, and not already done or abandoned. */
export function isPlannable(commitment: Commitment): boolean {
  return commitment.status === 'active' || commitment.status === 'deferred';
}

const PRIORITY_RANK: Record<Commitment['priority']['level'], number> = { high: 3, normal: 2, low: 1 };

/**
 * Whether a floating commitment belongs in today's plan.
 *
 * Either it is due on or before the day being planned — **including a day that
 * has already passed**, see `rollsIntoDay` — or it has no due date at all and
 * the user has marked it as mattering. A commitment with no date and no stated
 * importance is not pulled into today: the plan is meant to be what
 * realistically fits, and a backlog poured into a morning is the opposite.
 */
export function belongsToDay(commitment: Commitment, dayEndsAt: Instant): boolean {
  const dueAt = commitment.timeSpec.dueAt;
  if (dueAt) return toEpochMs(dueAt) < toEpochMs(dayEndsAt);
  return commitment.priority.level !== 'low';
}

/**
 * Whether an instant is behind the day being planned.
 *
 * The test for "yesterday's work", which #383 decides **rolls into today**: an
 * active commitment whose date has passed is treated as due today by the
 * planner, not as a date behind the horizon.
 */
export function rollsIntoDay(instant: Instant, dayStartsAt: Instant): boolean {
  return toEpochMs(instant) < toEpochMs(dayStartsAt);
}

/**
 * The instant an item has to be finished by, under #383's rule.
 *
 * A due date behind the horizon becomes the end of the day being planned.
 * Passing it through verbatim — which this did — puts the deadline *before* the
 * horizon opens, and `schedulePlan` answers `DEADLINE_BEYOND_HORIZON` for every
 * such item: the scheduler can never place it, so the morning explanation
 * reports the user's entire backlog as "did not fit", every day, permanently.
 * For a user with a backlog, which is this product's core user, that is the
 * whole plan.
 *
 * Today's own deadlines are still passed through, so an item due at 11:00 is
 * not placed at 16:00 merely because the afternoon was emptier.
 */
export function deadlineFor(
  commitment: Commitment,
  dayStartsAt: Instant,
  dayEndsAt: Instant,
): Instant | null {
  const dueAt = commitment.timeSpec.dueAt;
  if (!dueAt) return null;
  return rollsIntoDay(dueAt, dayStartsAt) ? dayEndsAt : dueAt;
}

/**
 * The absolute span of one local day.
 *
 * Exported because the busy-block reader has to be asked for a window before
 * the constraints can be built, and asking it for "the day" in local terms
 * would push this same arithmetic into #186.
 */
export function dayHorizon(date: string, timezone: string): { startsAt: Instant; endsAt: Instant } {
  return { startsAt: localMidnight(date, timezone), endsAt: localMidnight(date, timezone, 1) };
}

export function buildDailyPlanInput(args: DailyPlanInputArgs): DailyPlanInput {
  const { startsAt, endsAt } = dayHorizon(args.date, args.timezone);
  const weekday = weekdayAt(toEpochMs(startsAt), args.timezone) as Weekday;

  const plannable = args.commitments.filter(isPlannable);

  const fromBusy: FixedEvent[] = args.busyBlocks.map((block) => ({
    eventId: `busy:${block.blockId}`,
    interval: { startsAt: block.startsAt, endsAt: block.endsAt },
    sourceCommitmentId: null,
    blocking: true,
  }));

  // A commitment pinned to an instant that has already passed is not pinned any
  // more — #383 again. Left as a `FixedEvent` it would be a blocking interval
  // outside the horizon, which blocks nothing and hides the item from the plan
  // altogether: it is neither placed nor reported as unplaced, because only
  // floating items become `PlanningItem`s. Rolled forward, it is a floating
  // item due today like any other piece of yesterday's work.
  const pinnedStartOf = (commitment: Commitment): Instant | null => {
    const start = fixedStartOf(commitment);
    return start !== null && !rollsIntoDay(start, startsAt) ? start : null;
  };

  const fromCommitments: FixedEvent[] = plannable.flatMap((commitment) => {
    const start = pinnedStartOf(commitment);
    if (!start) return [];
    return [{
      eventId: `commitment:${commitment.id}`,
      interval: { startsAt: start, endsAt: fixedEndFor(commitment, start) },
      sourceCommitmentId: commitment.id,
      blocking: true,
    }];
  });

  const items: PlanningItem[] = plannable
    .filter((commitment) => pinnedStartOf(commitment) === null && belongsToDay(commitment, endsAt))
    .map((commitment) => ({
      itemId: commitment.id,
      title: commitment.title,
      effort: { kind: 'known', minutes: DEFAULT_EFFORT_MINUTES },
      earliestStartAt: null,
      // The commitment's own deadline when it has one and it is not behind the
      // horizon; the end of today when it is. See `deadlineFor`.
      deadlineAt: deadlineFor(commitment, startsAt, endsAt),
      priority: PRIORITY_RANK[commitment.priority.level],
      dependsOn: [],
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
    }));

  return {
    constraints: {
      // The scope is the day, not the account: two accounts planning the same
      // date must not collide, and one account's Tuesday and Wednesday are two
      // different planning runs with two different digests.
      scopeId: `${args.uid}:${args.date}`,
      timezone: args.timezone,
      horizon: { startsAt, endsAt },
      workingWindows: workingWindowsFor(args.profile, args.timezone, weekday),
      // Busy time first, so a reader of the stored request sees the calendar
      // before the commitments derived from it. Order is part of the digest.
      fixedEvents: [...fromBusy, ...fromCommitments],
      items,
    },
    config: DAILY_PLAN_CONFIG,
  };
}
