/**
 * TEMPORARY — replace with #29's normalizer at integration.
 *
 * Issue #29 (`lib/planning/constraints/normalize.ts`) owns materialising a
 * wall-clock `WorkingWindow` against real dates and turning the result into the
 * free runs a scheduler may place work in. That module did not exist when this
 * track was built, and #30 cannot be written without it, so the arithmetic is
 * reproduced here — *once*, in one file, so the thing to delete is obvious.
 *
 * The sprint design is explicit that this duplication is a defect and not a
 * second opinion: "materialising a wall-clock window against real dates is
 * *arithmetic*, and a second copy of it is the Sprint 06 gap rather than a
 * Sprint 06 check". Two copies will not disagree loudly; they will disagree on
 * one Sunday in October and produce a plan nobody can explain.
 *
 * At integration: delete this file, import `materializeWorkingWindows` /
 * `freeRuns` from `lib/planning/constraints/normalize.ts`, and keep
 * `tests/planning/schedulerPlacement.test.ts` green as the proof the swap was
 * behaviour-preserving. Those tests assert at the scheduler level, so they
 * carry over unchanged — in particular "a wider horizon never yields less
 * availability across a spring-forward date", which is the property the first
 * version of this file got wrong and which #29's normalizer must also hold.
 * Nothing outside `lib/planning/scheduler/` imports this.
 *
 * What it deliberately does *not* do is judge. A gap or a malformed window is
 * returned as a finding for the caller to place in the plan; deciding whether a
 * request is feasible is #29's validator and #31's oracle, and this module must
 * never become a third reading of that question.
 */

import type {
  PlanningReason,
  TimeInterval,
  WorkingWindow,
} from '../../../src/contracts/v1/planningContracts';
import type { FoldPolicy, PlanningHorizon } from '../../../src/contracts/v1/planningContracts';
import {
  instantFromResolution,
  intersectIntervals,
  isPositiveInterval,
  resolveLocalTime,
  toEpochMs,
  toInstant,
  wallClockAt,
  weekdayAt,
  type WallClockParts,
} from '../shared/time';

const MS_PER_DAY = 86_400_000;

export interface MaterializedWindows {
  /** Disjoint, sorted, clipped to the horizon. Empty when nothing is available. */
  readonly intervals: readonly TimeInterval[];
  /** Constraint-level findings, in the shared vocabulary. `itemId` is null. */
  readonly reasons: readonly PlanningReason[];
}

/**
 * The wall-clock fields for `minuteOfDay` on the local calendar date `date`.
 *
 * `MinuteOfDay` ranges 0..1440 inclusive, so minute 1440 is midnight *of the
 * following date* rather than hour 24 of this one. Rolling the date here rather
 * than handing `hour: 24` to `resolveLocalTime` matters: that function verifies
 * a candidate instant by formatting it back and comparing fields, and hour 24
 * never compares equal to anything a clock shows, so a window ending at
 * midnight would be reported as a DST gap every day of the year.
 */
function partsAt(date: WallClockParts, minuteOfDay: number): WallClockParts {
  const dayCarry = Math.floor(minuteOfDay / 1440);
  const withinDay = minuteOfDay - dayCarry * 1440;
  // Pure UTC calendar arithmetic — no zone is involved in "the next date".
  // Read back through `wallClockAt` in UTC rather than through a local `Date`
  // so that no file under this directory constructs a `Date` at all; the
  // boundary test can then forbid the constructor outright instead of trying to
  // distinguish the pure `new Date(ms)` from the ambient `new Date()`.
  const rolled = wallClockAt(Date.UTC(date.year, date.month - 1, date.day) + dayCarry * MS_PER_DAY, 'UTC');
  return {
    year: rolled.year,
    month: rolled.month,
    day: rolled.day,
    hour: Math.floor(withinDay / 60),
    minute: withinDay % 60,
  };
}

/** Sorted union of possibly-overlapping intervals. Abutting runs are joined. */
export function mergeIntervals(intervals: readonly TimeInterval[]): TimeInterval[] {
  const ordered = intervals
    .filter(isPositiveInterval)
    .slice()
    .sort((left, right) => toEpochMs(left.startsAt) - toEpochMs(right.startsAt));

  const merged: { startsAt: number; endsAt: number }[] = [];
  for (const interval of ordered) {
    const startsAt = toEpochMs(interval.startsAt);
    const endsAt = toEpochMs(interval.endsAt);
    const last = merged[merged.length - 1];
    // `>=` rather than `>`: two abutting free runs are one run. Keeping them
    // separate would refuse an item that spans the seam, which is a placement
    // decision made by an artefact of how the windows were written down.
    if (last !== undefined && startsAt <= last.endsAt) {
      last.endsAt = Math.max(last.endsAt, endsAt);
    } else {
      merged.push({ startsAt, endsAt });
    }
  }
  return merged.map((run) => ({ startsAt: toInstant(run.startsAt), endsAt: toInstant(run.endsAt) }));
}

/**
 * The calendar dates, as `[year, month, day]` keys, that a zone shows between
 * two instants — one day of slack either side.
 *
 * Enumerating *local calendar dates* is the whole content of this helper, and
 * the reason it exists rather than a loop that adds 24 hours to a probe. A
 * fixed 24-hour step holds the probe's local time of day constant, which is
 * only true on the 363 days a year the offset does not move. On a
 * spring-forward date the local day is 23 hours long, so a probe phased into
 * the last local hour steps clean over that date and the day is never
 * enumerated at all — the window silently does not exist that Sunday. Worse, it
 * depends on the probe's phase, which comes from the horizon's start instant:
 * moving the horizon start half an hour *earlier* could delete a whole day of
 * availability, so a strictly larger horizon returned strictly less time.
 *
 * The slack either side is because a local date can sit either side of the UTC
 * date at offsets up to ±14 hours; bounding the scan exactly by the horizon
 * would drop the first or last day's availability in roughly half the world's
 * zones.
 *
 * The cursor arithmetic is UTC midnight plus 24 hours, which *is* exact: UTC
 * has no transitions, so it is being used here as a calendar, not as a clock.
 */
function localDatesBetween(fromMs: number, toMs: number, timeZone: string): WallClockParts[] {
  const first = wallClockAt(fromMs - MS_PER_DAY, timeZone);
  const last = wallClockAt(toMs + MS_PER_DAY, timeZone);

  const dates: WallClockParts[] = [];
  let cursor = Date.UTC(first.year, first.month - 1, first.day);
  const end = Date.UTC(last.year, last.month - 1, last.day);
  while (cursor <= end) {
    dates.push(wallClockAt(cursor, 'UTC'));
    cursor += MS_PER_DAY;
  }
  return dates;
}

/**
 * Materialise every recurrence of every window that touches the horizon.
 */
export function materializeWorkingWindows(
  windows: readonly WorkingWindow[],
  horizon: PlanningHorizon,
  foldPolicy: FoldPolicy,
): MaterializedWindows {
  const horizonInterval: TimeInterval = { startsAt: horizon.startsAt, endsAt: horizon.endsAt };
  const reasons: PlanningReason[] = [];
  const collected: TimeInterval[] = [];

  if (!isPositiveInterval(horizonInterval)) {
    return { intervals: [], reasons };
  }

  for (const window of windows) {
    if (window.endMinute <= window.startMinute) {
      reasons.push({
        code: 'INVALID_INTERVAL',
        itemId: null,
        detail: `working window ${window.windowId} ends at or before it starts`,
      });
      continue;
    }

    const dates = localDatesBetween(
      toEpochMs(horizon.startsAt),
      toEpochMs(horizon.endsAt),
      window.timezone,
    );
    for (const date of dates) {
      // The weekday of a calendar date is a property of the date, not of the
      // zone, so it is read off the UTC calendar rather than off an instant —
      // which is what removes the probe phase from the answer entirely.
      const weekday = weekdayAt(Date.UTC(date.year, date.month - 1, date.day), 'UTC');
      if (weekday !== window.weekday) continue;

      const startResolution = resolveLocalTime(partsAt(date, window.startMinute), window.timezone);
      const endResolution = resolveLocalTime(partsAt(date, window.endMinute), window.timezone);

      if (startResolution.kind === 'gap') {
        // The local clock skips this time. The window is shorter that day and
        // resumes at the transition; reporting it *and* using `resumesAt` is
        // what keeps "your Sunday is an hour shorter" explainable rather than
        // silently true.
        reasons.push({
          code: 'NONEXISTENT_LOCAL_TIME',
          itemId: null,
          detail: `working window ${window.windowId} starts in a daylight-saving gap on ${date.year}-${date.month}-${date.day}`,
        });
      }

      const startsAt = startResolution.kind === 'gap'
        ? startResolution.resumesAt
        : instantFromResolution(startResolution, foldPolicy);
      const endsAt = endResolution.kind === 'gap'
        ? endResolution.resumesAt
        : instantFromResolution(endResolution, foldPolicy);
      if (startsAt === null || endsAt === null) continue;

      const clipped = intersectIntervals({ startsAt, endsAt }, horizonInterval);
      if (clipped !== null) collected.push(clipped);
    }
  }

  return { intervals: mergeIntervals(collected), reasons };
}
