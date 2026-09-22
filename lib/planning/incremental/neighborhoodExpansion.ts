/**
 * Smart neighborhood expansion (#524, slice 3): step 7 of the issue's algorithm.
 *
 * When the impacted set as first computed cannot produce a feasible patch,
 * the issue says to widen the affected neighborhood and try again before
 * escalating to a full replan. This module answers *which* frozen blocks join
 * the impacted set next, deterministically, so `freezeResolve.ts` can re-solve
 * a slightly wider patch instead of regenerating a whole day.
 *
 * Pure, like the rest of `lib/planning/`: no clock, no randomness, no
 * persistence, no solver. The same partition and base plan always yield the
 * same widening, which is what keeps the escalation ladder reproducible.
 *
 * ── Two failure shapes, two widenings ────────────────────────────────
 *
 * A solve attempt fails for exactly one of two reasons, and each has its own
 * candidate set:
 *
 *  - **Regression** — an impacted item that had a place in the base plan no
 *    longer has one, because the frozen blocks hold the room it needs. The
 *    widening is the *capacity ring*: frozen blocks whose base reserved
 *    intervals touch or overlap the impacted set's own placements. Touching
 *    counts, not just strict overlap: the block that ends at the exact minute
 *    an impacted block begins is precisely the neighbour standing between it
 *    and more room, and an expansion that only recognised strict overlap
 *    would stare at a wall of abutting blocks and report that there is
 *    nothing to widen into.
 *  - **Invalid request** — the frozen blocks, entered as blocking fixed
 *    events, contradict the request's own fixed events (`FIXED_EVENT_CONFLICT`).
 *    The widening is the *conflict set*: the frozen blocks whose placements
 *    overlap a blocking fixed event. Unfreezing one removes its frozen event
 *    from the request and hands the block back to the solver, which is the
 *    only way the contradiction resolves without touching the user's real
 *    events.
 *
 * Both sets are one ring per call. `freezeResolve.ts` calls again after each
 * re-solve, so the neighborhood grows outward from the impacted set one ring
 * at a time and stops at the smallest widened set that solves — the minimal
 * churn reading of "expand the affected neighborhood".
 *
 * ── What is deliberately not a candidate ─────────────────────────────
 *
 * Hard-edge predecessors of a regressed item are *not* widened in separately.
 * A predecessor whose placement binds a regressed successor's start ends its
 * reserved interval exactly where the successor's begins — the scheduler's
 * prerequisite floor — so it abuts the frontier and the capacity ring already
 * reaches it. A separate predecessor rule would add a second code path that
 * selects the same blocks, which is how speculative vocabularies start.
 *
 * An unplaced frozen block is a candidate for nothing: it has no position to
 * offer, and unfreezing it changes no arithmetic (it contributes no frozen
 * event and no item the solver was placing differently).
 */

import type {
  FixedEvent,
  PlannedItem,
  TimeInterval,
} from '../../../src/contracts/v1/planningContracts';
import type { ScheduleBlock } from '../../../src/contracts/v1/scheduleBlockContracts';
import { compareByCodePoint } from '../shared/compare';
import { intervalsOverlap, toEpochMs } from '../shared/time';

/**
 * The item id a block stands for, or null for a block with no item behind it.
 *
 * `blocks.ts`: the v1 adapter's `itemId` *is* the source id, and only a
 * flexible block is something the solver was asked to place. Shared by
 * `freezeResolve.ts`, which used to keep its own copy.
 */
export function flexibleItemIdOf(block: ScheduleBlock): string | null {
  return block.mobility === 'flexible' ? block.source.id : null;
}

/** Closed-interval intersection: strict overlap, plus the abutting boundary. */
function touchesOrOverlaps(left: TimeInterval, right: TimeInterval): boolean {
  return toEpochMs(left.startsAt) <= toEpochMs(right.endsAt)
    && toEpochMs(right.startsAt) <= toEpochMs(left.endsAt);
}

export interface NeighborhoodExpansionInput {
  /** The partition the last solve attempt used. */
  readonly impactedBlockIds: readonly string[];
  readonly frozenBlockIds: readonly string[];
  readonly blockById: ReadonlyMap<string, ScheduleBlock>;
  /** The base plan's placements, keyed by item id. */
  readonly basePlacements: ReadonlyMap<string, PlannedItem>;
}

/**
 * The capacity ring: frozen blocks standing between the impacted set and the
 * room it needs.
 *
 * The frontier is the base plan's reserved intervals of the impacted items;
 * a frozen block joins when its own base reserved interval touches or
 * overlaps any frontier interval. One ring — the caller re-invokes with the
 * widened partition, so a second ring is the next call's frontier, not this
 * call's loop.
 */
export function computeCapacityRing(input: NeighborhoodExpansionInput): string[] {
  const frontier: TimeInterval[] = [];
  for (const blockId of input.impactedBlockIds) {
    const block = input.blockById.get(blockId);
    if (block === undefined) continue;
    const itemId = flexibleItemIdOf(block);
    if (itemId === null) continue;
    const placed = input.basePlacements.get(itemId);
    if (placed !== undefined) frontier.push(placed.reservedInterval);
  }
  if (frontier.length === 0) return [];

  const ring: string[] = [];
  for (const blockId of input.frozenBlockIds) {
    // The partition is validated by the caller; an unknown id is thrown on
    // there. A missing entry here is skipped only because the ring can add
    // nothing about a block it cannot see.
    const block = input.blockById.get(blockId);
    if (block === undefined) continue;
    const itemId = flexibleItemIdOf(block);
    if (itemId === null) continue;
    const placed = input.basePlacements.get(itemId);
    if (placed === undefined) continue;
    if (frontier.some((interval) => touchesOrOverlaps(interval, placed.reservedInterval))) {
      ring.push(blockId);
    }
  }
  return ring.sort(compareByCodePoint);
}

/**
 * The conflict set: frozen blocks whose placements overlap a blocking fixed
 * event of the request being solved.
 *
 * Reached when the frozen events and the request's own events contradict each
 * other. Strict overlap, not touch: a frozen block that ends at the minute a
 * meeting begins conflicts with nothing, and unfreezing it would churn a
 * block whose position is legal.
 */
export function computeConflictSet(
  input: NeighborhoodExpansionInput,
  fixedEvents: readonly FixedEvent[],
): string[] {
  const blocking = fixedEvents.filter((event) => event.blocking);
  if (blocking.length === 0) return [];

  const conflicted: string[] = [];
  for (const blockId of input.frozenBlockIds) {
    const block = input.blockById.get(blockId);
    if (block === undefined) continue;
    const itemId = flexibleItemIdOf(block);
    if (itemId === null) continue;
    const placed = input.basePlacements.get(itemId);
    if (placed === undefined) continue;
    if (blocking.some((event) => intervalsOverlap(event.interval, placed.reservedInterval))) {
      conflicted.push(blockId);
    }
  }
  return conflicted.sort(compareByCodePoint);
}
