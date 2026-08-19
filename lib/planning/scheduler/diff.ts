/**
 * Plan diff (Sprint 07, issue #30): what changed between two plans, and whether
 * the two were even answering the same question.
 *
 * `sameInputDigest` is the field that makes the rest of the diff mean anything.
 * A list of moves computed across two *different* requests is not churn, it is
 * two unrelated plans laid side by side, and a replanning policy that measured
 * stability from such a diff would be measuring its own input changes. The flag
 * is reported rather than enforced — comparing two plans from different inputs
 * is a legitimate thing to want — but it is reported, so the caller cannot fail
 * to notice.
 *
 * Two absences are deliberate, because `PlanItemChange` has no shape for them
 * and inventing one here would put a second vocabulary next to the contract's:
 *
 *  - An item unscheduled in both plans *for the same reason* produces no
 *    change. `unchanged` carries `at: TimeInterval`, so it can only describe an
 *    item that has a placement; a "still not scheduled" entry would have to
 *    fabricate one.
 *  - An item unscheduled in the previous plan and absent from the next produces
 *    no change either. `removed` carries `from: TimeInterval` — the thing that
 *    was removed is a *placement*, and an item that never had one has nothing
 *    to report losing.
 *
 * Comparison is on `interval`, the effort itself, not on `reservedInterval`. A
 * user asked to move something is being asked about the work; a buffer that
 * changed while the work stayed put is a change to the request, not to the
 * plan, and it will show up in `sameInputDigest` where it belongs.
 */

import type {
  Plan,
  PlanDiff,
  PlanItemChange,
  PlanningReasonCode,
  TimeInterval,
} from '../../../src/contracts/v1/planningContracts';
import { minutesBetween, toEpochMs } from '../shared/time';

function sameInterval(left: TimeInterval, right: TimeInterval): boolean {
  // Compared as instants rather than as strings: `2026-08-17T09:00:00Z` and
  // `2026-08-17T09:00:00.000Z` are the same moment, and a plan that had been
  // round-tripped through a different serialiser would otherwise report every
  // item as having moved by zero minutes.
  return toEpochMs(left.startsAt) === toEpochMs(right.startsAt)
    && toEpochMs(left.endsAt) === toEpochMs(right.endsAt);
}

function placements(plan: Plan): Map<string, TimeInterval> {
  return new Map(plan.scheduled.map((entry) => [entry.itemId, entry.interval] as const));
}

function reasonCodes(plan: Plan): Map<string, PlanningReasonCode> {
  return new Map(plan.unscheduled.map((entry) => [entry.itemId, entry.reason.code] as const));
}

export function diffPlans(previous: Plan, next: Plan): PlanDiff {
  const previousPlacements = placements(previous);
  const nextPlacements = placements(next);
  const previousReasons = reasonCodes(previous);
  const nextReasons = reasonCodes(next);

  const itemIds = Array.from(new Set(([] as string[]).concat(
    Array.from(previousPlacements.keys()),
    Array.from(nextPlacements.keys()),
    Array.from(previousReasons.keys()),
    Array.from(nextReasons.keys()),
  // Sorted by code point, never `localeCompare`: the latter depends on the
  // runtime's ICU data and default locale, and a diff whose order changed with
  // the machine it ran on could not be compared between two runs.
  ))).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  const changes: PlanItemChange[] = [];
  for (const itemId of itemIds) {
    const from = previousPlacements.get(itemId);
    const to = nextPlacements.get(itemId);

    if (from !== undefined && to !== undefined) {
      if (sameInterval(from, to)) {
        changes.push({ kind: 'unchanged', itemId, at: to });
      } else {
        changes.push({
          kind: 'moved',
          itemId,
          from,
          to,
          // Signed, not absolute: "moved 90 minutes" without a direction cannot
          // distinguish work pulled forward from work pushed past a deadline.
          // Issue #31's churn metric takes the magnitude it wants.
          shiftMinutes: minutesBetween(from.startsAt, to.startsAt),
        });
      }
      continue;
    }
    if (to !== undefined) {
      changes.push({ kind: 'added', itemId, to });
      continue;
    }
    if (from !== undefined) {
      changes.push({ kind: 'removed', itemId, from });
      continue;
    }

    const previousCode = previousReasons.get(itemId);
    const nextCode = nextReasons.get(itemId);
    if (previousCode !== undefined && nextCode !== undefined && previousCode !== nextCode) {
      changes.push({ kind: 'reason_changed', itemId, from: previousCode, to: nextCode });
    }
  }

  return { changes, sameInputDigest: previous.inputDigest === next.inputDigest };
}
