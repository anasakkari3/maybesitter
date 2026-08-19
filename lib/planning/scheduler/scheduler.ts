/**
 * The deterministic scheduler (Sprint 07, issue #30).
 *
 * `schedulePlan` is a pure function from a request to a `Plan`: greedy
 * placement of items into the free runs left by the working windows once fixed
 * events and already-placed reservations are subtracted, considered in the
 * total order the contract states.
 *
 * Four properties are structural, and each is arranged for rather than merely
 * true today:
 *
 *  1. **The order is the contract's, applied as data.** `comparePlanOrder`
 *     walks `PLAN_ORDERING_KEYS` rather than hard-coding four comparisons in
 *     the order they happen to be listed there. A scheduler that inlined the
 *     order would keep working after someone changed the contract, and would
 *     then disagree with #31's oracle about what "stable" means — which is a
 *     disagreement no test in this track can see.
 *
 *  2. **Nothing here reads a clock or a random source.** Every instant comes
 *     from the input (`PLANNING_PERSISTENCE_POLICY.noAmbientClock`). This is not
 *     a style rule: a planner that could call `Date.now()` produces a different
 *     plan on every run, and a determinism test that ran twice in the same
 *     millisecond would pass anyway. `tests/planning/schedulerBoundaries.test.ts`
 *     enforces it by reading the source.
 *
 *  3. **Every input item lands in exactly one of `scheduled` / `unscheduled`.**
 *     Not as an invariant someone remembers, but because every item flows
 *     through one `resolve()` call that pushes to exactly one list. An item in
 *     neither is the bug no per-item assertion would catch, and an item in both
 *     is a plan that double-books the user while looking complete.
 *
 *  4. **A lost placement and an impossible item get different vocabulary.**
 *     Static codes are decided before any placement is attempted; attempt codes
 *     only after. The partition is the contract's
 *     (`STATIC_INFEASIBILITY_CODES` / `ATTEMPT_INFEASIBILITY_CODES`) and it is
 *     the difference between telling a user "this needs an estimate" and "this
 *     lost the last free hour to something more important".
 *
 * What this module does *not* do is decide whether the constraints as a whole
 * are feasible. That judgement belongs to #29's validator and, independently,
 * to #31's oracle; a third reading here would be the Sprint 02 failure again —
 * three self-consistent interpretations, three green suites, one wrong answer.
 * The constraint-level findings below are only what placement itself ran into.
 */

import {
  PLANNING_CONTRACT_VERSION,
  PLANNING_SCHEMA_VERSION,
  PLAN_ORDERING_KEYS,
  type Instant,
  type Plan,
  type PlannedItem,
  type PlanningConfig,
  type PlanningConstraints,
  type PlanningItem,
  type PlanningReason,
  type PlanningReasonCode,
  type StaticInfeasibilityCode,
  type TimeInterval,
  type UnscheduledItem,
} from '../../../src/contracts/v1/planningContracts';
import {
  intervalsOverlap,
  isPositiveInterval,
  subtractIntervals,
  toEpochMs,
  toInstant,
} from '../shared/time';
import { planningInputDigest } from './digest';
import { materializeWorkingWindows } from './windows';

const MS_PER_MINUTE = 60_000;

/* ── Ordering ───────────────────────────────────────────────────── */

/**
 * The fields `PLAN_ORDERING_KEYS` names, for one item.
 *
 * `startsAt` is null while an item is still a candidate, because it has no
 * start yet. The key is therefore inert during candidate selection and
 * decisive when the finished plan is sorted — one comparator, used in both
 * places, so "the order candidates are considered in" and "the order the plan
 * is listed in" cannot drift apart.
 */
interface PlanOrderFields {
  readonly startsAt: Instant | null;
  readonly priority: number;
  readonly earliestDeadline: Instant | null;
  readonly itemId: string;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Ascending, with null last. A missing deadline is not an early deadline. */
function compareNullableInstant(left: Instant | null, right: Instant | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return toEpochMs(left) - toEpochMs(right);
}

export function comparePlanOrder(left: PlanOrderFields, right: PlanOrderFields): number {
  for (const key of PLAN_ORDERING_KEYS) {
    let delta = 0;
    if (key === 'startsAt') {
      delta = compareNullableInstant(left.startsAt, right.startsAt);
    } else if (key === '-priority') {
      delta = right.priority - left.priority;
    } else if (key === 'earliestDeadline') {
      delta = compareNullableInstant(left.earliestDeadline, right.earliestDeadline);
    } else if (key === 'itemId') {
      delta = compareCodePoints(left.itemId, right.itemId);
    } else {
      // Unreachable while the contract lists exactly the four keys above. It is
      // here so that adding a fifth key to `PLAN_ORDERING_KEYS` fails loudly
      // instead of being silently skipped, which would leave this scheduler
      // ordering by three keys while the oracle ordered by four.
      throw new TypeError(`unhandled plan ordering key: ${String(key)}`);
    }
    if (delta !== 0) return delta;
  }
  return 0;
}

function orderFields(item: PlanningItem, startsAt: Instant | null): PlanOrderFields {
  return {
    startsAt,
    priority: item.priority,
    earliestDeadline: item.deadlineAt,
    itemId: item.itemId,
  };
}

/* ── Dependencies ───────────────────────────────────────────────── */

/**
 * The prerequisites that actually constrain *when* this item may start.
 *
 * `temporal` always orders. `resource` orders only when the config says so
 * (false in v1). `informational` never orders — it records that one item
 * informs another, which is a fact about content, not about time.
 *
 * All three dependency reason codes below are computed over exactly this set,
 * not over every declared edge. The reason is that #30 answers "why could this
 * not be *placed*", and an edge this config never consults cannot be the
 * answer: reporting `CYCLIC_DEPENDENCY` for a loop of informational links would
 * refuse to schedule a request that is entirely feasible, and would send the
 * user to fix a link that was never going to move anything.
 */
function orderingPrerequisites(item: PlanningItem, config: PlanningConfig): string[] {
  return item.dependsOn
    .filter((edge) => edge.kind === 'temporal'
      || (edge.kind === 'resource' && config.resourceDependenciesOrder))
    .map((edge) => edge.dependsOnItemId);
}

/** Item ids that sit on a cycle of length > 1 in the ordering graph. */
function itemsOnCycles(edges: ReadonlyMap<string, readonly string[]>): Set<string> {
  const onCycle = new Set<string>();
  const state = new Map<string, 'visiting' | 'done'>();
  // Iterative DFS: the recursion depth of a chain of steps is bounded by the
  // item count, and a stack overflow on a pathological request would surface as
  // a crash rather than as a reported cycle.
  for (const root of Array.from(edges.keys()).sort(compareCodePoints)) {
    if (state.get(root) === 'done') continue;
    const path: string[] = [];
    const stack: { node: string; entered: boolean }[] = [{ node: root, entered: false }];
    while (stack.length > 0) {
      const frame = stack.pop() as { node: string; entered: boolean };
      if (frame.entered) {
        state.set(frame.node, 'done');
        path.pop();
        continue;
      }
      if (state.get(frame.node) === 'done') continue;
      if (state.get(frame.node) === 'visiting') {
        // Everything from this node's first appearance on the current path
        // back to here forms the cycle.
        const from = path.indexOf(frame.node);
        for (const node of path.slice(from === -1 ? 0 : from)) onCycle.add(node);
        continue;
      }
      state.set(frame.node, 'visiting');
      path.push(frame.node);
      stack.push({ node: frame.node, entered: true });
      for (const next of (edges.get(frame.node) ?? []).slice().sort(compareCodePoints).reverse()) {
        if (state.get(next) !== 'done') stack.push({ node: next, entered: false });
      }
    }
  }
  return onCycle;
}

/* ── Static findings ────────────────────────────────────────────── */

interface StaticFinding {
  readonly code: StaticInfeasibilityCode;
  readonly detail: string;
}

/**
 * Precedence: item-local defects first, request-shaped ones last.
 *
 * One defect earns one code, following `decompositionContracts`' rule, so an
 * item with an unknown duration inside a request that also has no working
 * windows is reported as `EFFORT_UNKNOWN`. Reporting `NO_WORKING_WINDOW` first
 * would tell the user to fix their calendar for an item that could not have
 * been placed on an empty calendar either.
 */
function staticFinding(
  item: PlanningItem,
  constraints: PlanningConstraints,
  config: PlanningConfig,
  onCycle: ReadonlySet<string>,
  knownItemIds: ReadonlySet<string>,
  hasWorkingTime: boolean,
): StaticFinding | null {
  const prerequisites = orderingPrerequisites(item, config);

  if (item.effort.kind === 'unknown') {
    return { code: 'EFFORT_UNKNOWN', detail: `${item.itemId} has no duration estimate` };
  }
  if (item.effort.minutes <= 0) {
    return {
      code: 'EFFORT_NOT_POSITIVE',
      detail: `${item.itemId} has an effort of ${item.effort.minutes} minutes`,
    };
  }
  if (prerequisites.includes(item.itemId)) {
    return { code: 'SELF_DEPENDENCY', detail: `${item.itemId} is its own prerequisite` };
  }
  if (onCycle.has(item.itemId)) {
    return { code: 'CYCLIC_DEPENDENCY', detail: `${item.itemId} sits on a dependency cycle` };
  }
  const dangling = prerequisites.filter((id) => !knownItemIds.has(id)).sort(compareCodePoints);
  if (dangling.length > 0) {
    return {
      code: 'UNKNOWN_DEPENDENCY',
      detail: `${item.itemId} depends on ${dangling.join(', ')}, absent from this request`,
    };
  }

  const horizonStartMs = toEpochMs(constraints.horizon.startsAt);
  const horizonEndMs = toEpochMs(constraints.horizon.endsAt);

  if (item.deadlineAt !== null && item.earliestStartAt !== null
    && toEpochMs(item.deadlineAt) <= toEpochMs(item.earliestStartAt)) {
    return {
      code: 'DEADLINE_BEFORE_EARLIEST_START',
      detail: `${item.itemId} may not start until after it is due`,
    };
  }
  if (item.deadlineAt !== null) {
    const deadlineMs = toEpochMs(item.deadlineAt);
    // A deadline outside the horizon is reported rather than guessed at in
    // either direction: earlier than the horizon there is no minute this plan
    // could use, and later than it the plan simply does not reach that far —
    // extending the horizon would change the answer, which is what makes this
    // a different message from "there was no room".
    if (deadlineMs < horizonStartMs || deadlineMs > horizonEndMs) {
      return {
        code: 'DEADLINE_BEYOND_HORIZON',
        detail: `${item.itemId} is due outside the planning horizon`,
      };
    }
  }

  // The item's own window, clipped to the horizon, with every minute in it
  // assumed free. Effort that does not fit here cannot fit anywhere.
  const windowStartMs = Math.max(
    horizonStartMs,
    item.earliestStartAt === null ? horizonStartMs : toEpochMs(item.earliestStartAt),
  );
  const windowEndMs = Math.min(
    horizonEndMs,
    item.deadlineAt === null ? horizonEndMs : toEpochMs(item.deadlineAt),
  );
  const reservedMs = reservedMinutes(item) * MS_PER_MINUTE;
  if (windowEndMs - windowStartMs < reservedMs) {
    return {
      code: 'EFFORT_EXCEEDS_ITEM_WINDOW',
      detail: `${item.itemId} needs ${reservedMinutes(item)} minutes and its window holds ${Math.max(0, (windowEndMs - windowStartMs) / MS_PER_MINUTE)}`,
    };
  }

  if (!hasWorkingTime) {
    return {
      code: 'NO_WORKING_WINDOW',
      detail: 'no working window intersects the planning horizon',
    };
  }
  return null;
}

/**
 * Effort plus buffers. Negative buffers are clamped to zero rather than
 * narrowing the reservation: `PlannedItem.reservedInterval` is documented as
 * never narrower than `interval`, and the reason taxonomy has no code for a
 * malformed buffer — well-formedness of the request is #29's job, and this
 * module must not invent a code to report it.
 */
function reservedMinutes(item: PlanningItem): number {
  const effort = item.effort.kind === 'known' ? item.effort.minutes : 0;
  return Math.max(0, item.bufferBeforeMinutes) + effort + Math.max(0, item.bufferAfterMinutes);
}

/* ── Constraint-level findings ──────────────────────────────────── */

function fixedEventFindings(constraints: PlanningConstraints): {
  reasons: PlanningReason[];
  blocking: TimeInterval[];
} {
  const reasons: PlanningReason[] = [];
  const blocking: TimeInterval[] = [];
  const ordered = constraints.fixedEvents
    .slice()
    .sort((left, right) => compareCodePoints(left.eventId, right.eventId));

  for (const event of ordered) {
    if (!isPositiveInterval(event.interval)) {
      reasons.push({
        code: 'INVALID_INTERVAL',
        itemId: null,
        detail: `fixed event ${event.eventId} ends at or before it starts`,
      });
      continue;
    }
    if (event.blocking) blocking.push(event.interval);
  }

  // Two blocking events on top of each other is a contradiction in the input —
  // the user is claimed to be in two places at once — and it is reported before
  // planning rather than discovered as a scheduling outcome. Both are still
  // subtracted: the plan must not place work in either.
  const blockingEvents = ordered.filter((event) => event.blocking && isPositiveInterval(event.interval));
  for (let left = 0; left < blockingEvents.length; left += 1) {
    for (let right = left + 1; right < blockingEvents.length; right += 1) {
      if (intervalsOverlap(blockingEvents[left].interval, blockingEvents[right].interval)) {
        reasons.push({
          code: 'FIXED_EVENT_CONFLICT',
          itemId: null,
          detail: `fixed events ${blockingEvents[left].eventId} and ${blockingEvents[right].eventId} overlap`,
        });
      }
    }
  }
  return { reasons, blocking };
}

/* ── Placement ──────────────────────────────────────────────────── */

/** The first slot boundary at or after `ms`, measured from the horizon start. */
function alignUp(ms: number, originMs: number, stepMs: number): number {
  return originMs + Math.ceil((ms - originMs) / stepMs) * stepMs;
}

function freeRunsAfter(
  base: readonly TimeInterval[],
  occupied: readonly TimeInterval[],
): TimeInterval[] {
  return base.flatMap((run) => subtractIntervals(run, occupied));
}

export function schedulePlan(constraints: PlanningConstraints, config: PlanningConfig): Plan {
  if (!Number.isFinite(config.slotMinutes) || config.slotMinutes <= 0) {
    // Thrown rather than reported: there is no reason code for a malformed
    // config, and silently substituting a default grid would let two callers
    // with different configs produce the same plan while the digest recorded
    // that their inputs differed.
    throw new TypeError(`slotMinutes must be a positive number, received ${String(config.slotMinutes)}`);
  }

  const inputDigest = planningInputDigest(constraints, config);
  const horizonInterval: TimeInterval = {
    startsAt: constraints.horizon.startsAt,
    endsAt: constraints.horizon.endsAt,
  };
  const horizonStartMs = toEpochMs(constraints.horizon.startsAt);
  const horizonEndMs = toEpochMs(constraints.horizon.endsAt);
  const slotMs = config.slotMinutes * MS_PER_MINUTE;

  const constraintReasons: PlanningReason[] = [];
  if (!isPositiveInterval(horizonInterval)) {
    constraintReasons.push({
      code: 'INVALID_INTERVAL',
      itemId: null,
      detail: 'the planning horizon ends at or before it starts',
    });
  }

  const materialized = materializeWorkingWindows(
    constraints.workingWindows,
    constraints.horizon,
    config.foldPolicy,
  );
  constraintReasons.push(...materialized.reasons);

  const fixed = fixedEventFindings(constraints);
  constraintReasons.push(...fixed.reasons);

  const baseRuns = freeRunsAfter(materialized.intervals, fixed.blocking);
  // Measured on the materialised windows, *before* fixed events are subtracted.
  // `NO_WORKING_WINDOW` means the request declares nowhere legal to work; a day
  // that had availability and then lost all of it to meetings is contention,
  // and reporting it as a missing window sends the user to edit their
  // availability rules when what they need to move is a meeting.
  const hasWorkingTime = materialized.intervals.length > 0;
  if (!hasWorkingTime) {
    constraintReasons.push({
      code: 'NO_WORKING_WINDOW',
      itemId: null,
      detail: 'no working window intersects the planning horizon',
    });
  }

  /* Static pass. Nothing has been placed yet, so only static codes can be
   * emitted here — the partition in the contract is enforced by *where* a
   * reason is produced, not by a check after the fact. */
  const knownItemIds = new Set(constraints.items.map((item) => item.itemId));
  const orderingEdges = new Map<string, readonly string[]>(
    constraints.items.map((item) => [item.itemId, orderingPrerequisites(item, config)] as const),
  );
  const onCycle = itemsOnCycles(orderingEdges);

  const scheduled: PlannedItem[] = [];
  const unscheduled: UnscheduledItem[] = [];
  const placedById = new Map<string, PlannedItem>();
  const unscheduledById = new Map<string, PlanningReason>();

  function resolveScheduled(entry: PlannedItem): void {
    scheduled.push(entry);
    placedById.set(entry.itemId, entry);
  }
  function resolveUnscheduled(itemId: string, code: PlanningReasonCode, detail: string): void {
    const reason: PlanningReason = { code, itemId, detail };
    unscheduled.push({ itemId, reason });
    unscheduledById.set(itemId, reason);
  }

  const pending: PlanningItem[] = [];
  for (const item of constraints.items) {
    const finding = staticFinding(item, constraints, config, onCycle, knownItemIds, hasWorkingTime);
    if (finding === null) {
      pending.push(item);
    } else {
      resolveUnscheduled(item.itemId, finding.code, finding.detail);
    }
  }
  pending.sort((left, right) => comparePlanOrder(orderFields(left, null), orderFields(right, null)));

  /**
   * Why the whole chain, not just the nearest link: `BLOCKED_BY_DEPENDENCY` is
   * transitive, and the contract says so explicitly. Repeating the
   * prerequisite's own reason — reporting `EFFORT_UNKNOWN` on an item whose
   * duration is perfectly well known — would name a defect the user cannot find
   * in the item they are looking at.
   */
  function blockedDetail(itemId: string, blockerId: string): string {
    const chain = [itemId];
    let cursor = blockerId;
    // Bounded by the item count: every hop moves to a distinct already-resolved
    // item, and a repeat would mean a cycle, which the static pass removed.
    while (chain.length <= constraints.items.length) {
      chain.push(cursor);
      const reason = unscheduledById.get(cursor);
      if (reason === undefined) break;
      if (reason.code !== 'BLOCKED_BY_DEPENDENCY') {
        return `unscheduled prerequisite; chain ${chain.join(' -> ')} ends at ${cursor} (${reason.code})`;
      }
      const next = (orderingEdges.get(cursor) ?? []).find((id) => unscheduledById.has(id));
      if (next === undefined) break;
      cursor = next;
    }
    return `unscheduled prerequisite; chain ${chain.join(' -> ')}`;
  }

  /* Placement pass. Candidates are taken in plan order, subject to dependency
   * readiness: an item is only considered once every prerequisite that orders
   * it has itself been resolved, so a prerequisite's reservation is always
   * known before a dependent asks where it may start. */
  const remaining = pending.slice();
  while (remaining.length > 0) {
    const readyIndex = remaining.findIndex((item) => (orderingEdges.get(item.itemId) ?? [])
      .every((id) => placedById.has(id) || unscheduledById.has(id)));
    if (readyIndex === -1) {
      // Unreachable: cycles were removed by the static pass, so some item in a
      // non-empty queue always has all prerequisites resolved. Kept so that a
      // future change which breaks that assumption still leaves every item in
      // exactly one output list rather than dropping the remainder silently.
      for (const item of remaining) {
        resolveUnscheduled(item.itemId, 'BLOCKED_BY_DEPENDENCY', `unscheduled prerequisite; ${item.itemId} has no resolvable dependency order`);
      }
      break;
    }
    const item = remaining.splice(readyIndex, 1)[0];
    const prerequisites = (orderingEdges.get(item.itemId) ?? []).slice().sort(compareCodePoints);

    const blocker = prerequisites.find((id) => unscheduledById.has(id));
    if (blocker !== undefined) {
      resolveUnscheduled(item.itemId, 'BLOCKED_BY_DEPENDENCY', blockedDetail(item.itemId, blocker));
      continue;
    }

    const bufferBeforeMs = Math.max(0, item.bufferBeforeMinutes) * MS_PER_MINUTE;
    const bufferAfterMs = Math.max(0, item.bufferAfterMinutes) * MS_PER_MINUTE;
    const effortMs = (item.effort.kind === 'known' ? item.effort.minutes : 0) * MS_PER_MINUTE;
    const totalMs = bufferBeforeMs + effortMs + bufferAfterMs;

    // The earliest instant the *effort* may begin: the horizon, the item's own
    // floor, and every prerequisite's reservation end. The prerequisite bound is
    // stated here as well as being implied by the free runs, because it is the
    // contract's rule ("an item starts only after all its temporal
    // prerequisites' reservedIntervals have ended") and a reader should not have
    // to derive it from interval subtraction.
    let earliestStartMs = Math.max(
      horizonStartMs,
      item.earliestStartAt === null ? horizonStartMs : toEpochMs(item.earliestStartAt),
    );
    for (const id of prerequisites) {
      const prerequisite = placedById.get(id);
      if (prerequisite !== undefined) {
        earliestStartMs = Math.max(earliestStartMs, toEpochMs(prerequisite.reservedInterval.endsAt));
      }
    }
    const latestEndMs = Math.min(
      horizonEndMs,
      item.deadlineAt === null ? horizonEndMs : toEpochMs(item.deadlineAt),
    );

    if (earliestStartMs >= horizonEndMs) {
      resolveUnscheduled(item.itemId, 'HORIZON_EXHAUSTED', `${item.itemId} cannot begin before the horizon ends`);
      continue;
    }
    if (latestEndMs - (earliestStartMs - bufferBeforeMs) < totalMs) {
      // The item fit its own window in the static pass, so if it no longer fits
      // the only thing that moved is where its prerequisites finished.
      const code: PlanningReasonCode = prerequisites.length > 0 ? 'DEPENDENCY_TOO_LATE' : 'NO_FEASIBLE_SLOT';
      resolveUnscheduled(item.itemId, code, `${item.itemId} has no room left before it is due`);
      continue;
    }

    const runs = freeRunsAfter(baseRuns, scheduled.map((entry) => entry.reservedInterval));
    let placement: PlannedItem | null = null;
    for (const run of runs) {
      const runStartMs = toEpochMs(run.startsAt);
      const runEndMs = toEpochMs(run.endsAt);
      // Grid-aligned on the *effort* start, which is the instant a user sees.
      // Within one run the first legal start is also the best one: moving later
      // only pushes the reservation end further past a fixed upper bound.
      const startMs = alignUp(Math.max(earliestStartMs, runStartMs + bufferBeforeMs), horizonStartMs, slotMs);
      const reservedStartMs = startMs - bufferBeforeMs;
      const reservedEndMs = startMs + effortMs + bufferAfterMs;
      if (reservedStartMs < runStartMs) continue;
      if (reservedEndMs > runEndMs) continue;
      if (reservedEndMs > latestEndMs) continue;
      placement = {
        itemId: item.itemId,
        interval: { startsAt: toInstant(startMs), endsAt: toInstant(startMs + effortMs) },
        reservedInterval: { startsAt: toInstant(reservedStartMs), endsAt: toInstant(reservedEndMs) },
      };
      break;
    }

    if (placement === null) {
      resolveUnscheduled(item.itemId, 'NO_FEASIBLE_SLOT', `${item.itemId} found no free run long enough`);
    } else {
      resolveScheduled(placement);
    }
  }

  scheduled.sort((left, right) => {
    const leftItem = constraints.items.find((item) => item.itemId === left.itemId) as PlanningItem;
    const rightItem = constraints.items.find((item) => item.itemId === right.itemId) as PlanningItem;
    return comparePlanOrder(
      orderFields(leftItem, left.interval.startsAt),
      orderFields(rightItem, right.interval.startsAt),
    );
  });
  // `unscheduled` is sorted by id alone: `PLAN_ORDERING_KEYS` orders a plan's
  // placements and its first key does not exist for an item that has none, so
  // reusing it here would order by whatever the remaining keys happened to say.
  unscheduled.sort((left, right) => compareCodePoints(left.itemId, right.itemId));
  constraintReasons.sort((left, right) => compareCodePoints(left.code, right.code)
    || compareCodePoints(left.itemId ?? '', right.itemId ?? '')
    || compareCodePoints(left.detail, right.detail));

  return {
    version: PLANNING_CONTRACT_VERSION,
    schema: PLANNING_SCHEMA_VERSION,
    scopeId: constraints.scopeId,
    // Rebuilt rather than passed through. The caller's object is structurally
    // the same horizon but carries whatever key order that call site wrote, and
    // a plan is compared by serialising it — so echoing the reference makes two
    // runs over the same request differ byte for byte while every scheduling
    // decision in them is identical.
    horizon: { startsAt: constraints.horizon.startsAt, endsAt: constraints.horizon.endsAt },
    scheduled,
    unscheduled,
    constraintReasons,
    inputDigest,
  };
}
