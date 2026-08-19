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
import { compareByCodePoint } from './compare';
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
      // A non-finite priority is not a defect the taxonomy describes, so such
      // an item schedules normally — but `NaN - 0` is `NaN`, and a comparator
      // that returns `NaN` puts the sort into implementation-defined behaviour.
      // Treating it as a tie makes the key inert for that pair and lets the
      // later keys decide; `itemId` is unique, so the order stays total.
      const difference = right.priority - left.priority;
      delta = Number.isNaN(difference) ? 0 : difference;
    } else if (key === 'earliestDeadline') {
      delta = compareNullableInstant(left.earliestDeadline, right.earliestDeadline);
    } else if (key === 'itemId') {
      delta = compareByCodePoint(left.itemId, right.itemId);
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
 * Only `CYCLIC_DEPENDENCY` is computed over this set. `SELF_DEPENDENCY` and
 * `UNKNOWN_DEPENDENCY` are read over *every declared edge* — see
 * `declaredPrerequisites` — and the split is not a matter of taste.
 *
 * A cycle asks "can these be sequenced at all", and edges the config does not
 * consult impose no sequence, so a loop of informational links constrains
 * nothing and refusing it would leave a feasible request unplanned. But an item
 * naming itself, or naming something absent from the request, is a defect in
 * how the request was *written down*. Filtering those by kind made a **static**
 * verdict depend on `PlanningConfig.resourceDependenciesOrder`: the same
 * `PlanningConstraints` reported `UNKNOWN_DEPENDENCY` under one flag and
 * scheduled cleanly under the other. `STATIC_INFEASIBILITY_CODES` means
 * "decidable from the constraints alone", and it is the set #29's validator and
 * #31's oracle are compared on — so a config-dependent answer there is one no
 * change on either sibling track could have reconciled.
 */
function orderingPrerequisites(item: PlanningItem, config: PlanningConfig): string[] {
  return item.dependsOn
    .filter((edge) => edge.kind === 'temporal'
      || (edge.kind === 'resource' && config.resourceDependenciesOrder))
    .map((edge) => edge.dependsOnItemId);
}

/** Every edge as declared, whatever its kind. The integrity codes read this. */
function declaredPrerequisites(item: PlanningItem): string[] {
  return item.dependsOn.map((edge) => edge.dependsOnItemId);
}

/**
 * Item ids that sit on a cycle in the ordering graph.
 *
 * Tarjan's strongly-connected components: a node lies on a cycle exactly when
 * its component has more than one member, or when it has an edge to itself.
 *
 * The previous implementation was a depth-first walk that marked the grey path
 * whenever it found a **back edge**, and it was wrong in a way no small example
 * shows. Given `a → b`, `a → c`, `b → a`, `c → b` the cycle `a → c → b → a`
 * runs through `c`, but by the time `c` is explored `b` has already finished,
 * so `c → b` is a *cross* edge and neither branch fires. `c` was then reported
 * with an attempt code — `BLOCKED_BY_DEPENDENCY`, "you lost to contention" —
 * for an item that cannot start under any schedule at all. Crossing the
 * static/attempt partition is the more serious half of that bug: the partition
 * is what lets a user tell "your request contradicts itself" apart from "your
 * week is full".
 *
 * Reachability per node would give the same answer and is what #31's oracle
 * does. This computes it a different way on purpose: the cross-track comparison
 * is only evidence while the two derivations are independent, and two copies of
 * one walk agree about a shared mistake as readily as about the truth.
 */
export function itemsOnCycles(edges: ReadonlyMap<string, readonly string[]>): Set<string> {
  const index = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const componentStack: string[] = [];
  const onCycle = new Set<string>();
  let counter = 0;

  // Roots are taken in a fixed order so that, although the result is a set and
  // its contents cannot depend on traversal order, a debugger stepping through
  // this sees the same walk on every run.
  for (const root of Array.from(edges.keys()).sort(compareByCodePoint)) {
    if (index.has(root)) continue;

    // Explicit work stack rather than recursion: the depth is the length of a
    // dependency chain, and a deep one should not be the difference between a
    // reported cycle and a stack overflow.
    const work: { node: string; nextEdge: number }[] = [];
    const open = (node: string): void => {
      index.set(node, counter);
      lowLink.set(node, counter);
      counter += 1;
      componentStack.push(node);
      onStack.add(node);
      work.push({ node, nextEdge: 0 });
    };
    open(root);

    while (work.length > 0) {
      const frame = work[work.length - 1];
      const successors = edges.get(frame.node) ?? [];

      if (frame.nextEdge < successors.length) {
        const child = successors[frame.nextEdge];
        frame.nextEdge += 1;
        if (!index.has(child)) {
          open(child);
        } else if (onStack.has(child)) {
          lowLink.set(frame.node, Math.min(lowLink.get(frame.node) as number, index.get(child) as number));
        }
        continue;
      }

      if (lowLink.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        for (;;) {
          const member = componentStack.pop() as string;
          onStack.delete(member);
          component.push(member);
          if (member === frame.node) break;
        }
        if (component.length > 1) {
          for (const member of component) onCycle.add(member);
        } else if ((edges.get(component[0]) ?? []).indexOf(component[0]) !== -1) {
          // A one-node component with a self-edge is still a cycle. In practice
          // `SELF_DEPENDENCY` claims these first, but "on a cycle" should not
          // depend on which check happens to run earlier.
          onCycle.add(component[0]);
        }
      }

      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1];
        lowLink.set(parent.node, Math.min(lowLink.get(parent.node) as number, lowLink.get(frame.node) as number));
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
  onCycle: ReadonlySet<string>,
  knownItemIds: ReadonlySet<string>,
  hasWorkingTime: boolean,
): StaticFinding | null {
  if (item.effort.kind === 'unknown') {
    return { code: 'EFFORT_UNKNOWN', detail: 'no duration estimate' };
  }
  if (!Number.isFinite(item.effort.minutes) || item.effort.minutes <= 0) {
    // `NaN <= 0` is false, so the ordering test alone let a non-finite duration
    // through into arithmetic that produces `NaN` instants.
    return {
      code: 'EFFORT_NOT_POSITIVE',
      detail: `effort is ${String(item.effort.minutes)} minutes`,
    };
  }
  if (!Number.isFinite(item.bufferBeforeMinutes) || !Number.isFinite(item.bufferAfterMinutes)) {
    // The taxonomy has no buffer-specific code and #29 reads this as
    // `EFFORT_NOT_POSITIVE`. Agreeing with the other static reader matters more
    // than the code this track would have picked alone: a disagreement here is
    // exactly what the cross-track comparison exists to surface, and it would
    // be a disagreement about nothing.
    //
    // A *negative* buffer is a different case and is still clamped to zero
    // below — it is representable, the arithmetic survives it, and
    // `reservedInterval` is documented as never narrower than `interval`.
    return { code: 'EFFORT_NOT_POSITIVE', detail: 'a buffer is not a finite number of minutes' };
  }
  const declared = declaredPrerequisites(item);
  if (declared.includes(item.itemId)) {
    return { code: 'SELF_DEPENDENCY', detail: 'the item is its own prerequisite' };
  }
  if (onCycle.has(item.itemId)) {
    return { code: 'CYCLIC_DEPENDENCY', detail: 'the item sits on a dependency cycle' };
  }
  const dangling = declared.filter((id) => !knownItemIds.has(id)).sort(compareByCodePoint);
  if (dangling.length > 0) {
    return {
      code: 'UNKNOWN_DEPENDENCY',
      // Counted, not listed. Naming them leaked the ids of *other* items —
      // identifiers the finding was not even about — into a reason attributed
      // to this one.
      detail: `depends on ${dangling.length} item(s) absent from this request`,
    };
  }

  const horizonStartMs = toEpochMs(constraints.horizon.startsAt);
  const horizonEndMs = toEpochMs(constraints.horizon.endsAt);

  if (item.deadlineAt !== null && item.earliestStartAt !== null
    && toEpochMs(item.deadlineAt) <= toEpochMs(item.earliestStartAt)) {
    return {
      code: 'DEADLINE_BEFORE_EARLIEST_START',
      detail: 'may not start until after it is due',
    };
  }
  if (item.deadlineAt !== null && toEpochMs(item.deadlineAt) <= horizonStartMs) {
    // Only this direction. A deadline at or before the horizon opens leaves no
    // minute this plan could use — every instant it may place work in is
    // already past due.
    //
    // A deadline *after* the horizon ends is not this code and is not a
    // failure at all: such an item is the least constrained thing in the
    // request, and the horizon binds long before the deadline does. Refusing it
    // meant an item due in December went unplanned over a two-week horizon.
    return {
      code: 'DEADLINE_BEYOND_HORIZON',
      detail: 'due at or before the planning horizon opens',
    };
  }

  // Is there any legal start at all, on a timeline where every minute is free?
  // Computed by the same helper placement uses, so the two halves of this
  // module cannot answer the question differently — which they did: the check
  // here demanded the whole reserved span sit inside
  // `[earliestStartAt, deadlineAt]` while placement deliberately let the
  // before-buffer start earlier, so an item with a legal placement was reported
  // `EFFORT_EXCEEDS_ITEM_WINDOW`.
  const bounds = startBounds(item, horizonStartMs, horizonEndMs, horizonStartMs);
  if (bounds.earliestMs > bounds.latestMs) {
    return {
      code: 'EFFORT_EXCEEDS_ITEM_WINDOW',
      detail: `needs ${effortMinutes(item)} minutes of effort; its window admits no legal start`,
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
 * Buffers, clamped at zero rather than allowed to narrow the reservation:
 * `PlannedItem.reservedInterval` is documented as never narrower than
 * `interval`, and the reason taxonomy has no code for a malformed buffer —
 * well-formedness of the request is #29's job, and this module must not invent
 * a code to report it.
 */
function bufferBefore(item: PlanningItem): number {
  return Math.max(0, item.bufferBeforeMinutes);
}
function bufferAfter(item: PlanningItem): number {
  return Math.max(0, item.bufferAfterMinutes);
}
function effortMinutes(item: PlanningItem): number {
  return item.effort.kind === 'known' ? item.effort.minutes : 0;
}

/**
 * The window of instants at which this item's *effort* may begin.
 *
 * Two different things are bounded here, and conflating them is what made the
 * static check and the placement loop disagree:
 *
 *  - `earliestStartAt` and `deadlineAt` bound the **effort**. `deadlineAt` is
 *    documented as "must be *finished* by this instant" and
 *    `PlannedItem.interval` as "the effort itself"; recovery afterwards is not
 *    finishing, so an after-buffer may cross the deadline, and preparation
 *    beforehand may precede `earliestStartAt`.
 *  - The **horizon** bounds the whole reservation. "Nothing is scheduled
 *    outside it" is a statement about time the planner may occupy, and a buffer
 *    occupies time.
 *
 * `floorMs` carries any additional lower bound the caller knows about — the
 * horizon start in the static pass, and prerequisite reservation ends during
 * placement. Returns a possibly-empty range; `earliestMs > latestMs` means no
 * legal start exists even on a completely free timeline.
 */
function startBounds(
  item: PlanningItem,
  horizonStartMs: number,
  horizonEndMs: number,
  floorMs: number,
): { earliestMs: number; latestMs: number } {
  const beforeMs = bufferBefore(item) * MS_PER_MINUTE;
  const afterMs = bufferAfter(item) * MS_PER_MINUTE;
  const effortMs = effortMinutes(item) * MS_PER_MINUTE;

  const earliestMs = Math.max(
    floorMs,
    horizonStartMs + beforeMs,
    item.earliestStartAt === null ? floorMs : toEpochMs(item.earliestStartAt),
  );
  const latestMs = Math.min(
    item.deadlineAt === null ? horizonEndMs : toEpochMs(item.deadlineAt),
    horizonEndMs - afterMs,
  ) - effortMs;

  return { earliestMs, latestMs };
}

/* ── Constraint-level findings ──────────────────────────────────── */

/**
 * A canonical position for each element of an array, independent of the order
 * it arrived in.
 *
 * Findings name windows and events by index rather than by id, because a
 * `windowId` or `eventId` is caller-chosen text and often a description of the
 * user's life. But an index into the *input* array would put the caller's array
 * order into `PlanningReason.detail`, and input order is precisely what must
 * not reach a plan. So elements are numbered by a canonical key instead.
 *
 * Two structurally identical elements can still swap numbers under a reordered
 * input. That is harmless and deliberate: they produce identical findings apart
 * from the number, and `constraintReasons` is sorted by detail before it is
 * returned, so the sorted list is the same either way.
 */
function canonicalPositions(keys: readonly string[]): number[] {
  const ordered = keys
    .map((key, position) => ({ key, position }))
    .sort((left, right) => compareByCodePoint(left.key, right.key) || left.position - right.position);

  const positions = new Array<number>(keys.length);
  ordered.forEach((entry, rank) => {
    positions[entry.position] = rank;
  });
  return positions;
}

function fixedEventFindings(constraints: PlanningConstraints): {
  reasons: PlanningReason[];
  blocking: TimeInterval[];
} {
  const reasons: PlanningReason[] = [];
  const events = constraints.fixedEvents;
  const numbering = canonicalPositions(events.map((event) => [
    event.interval.startsAt,
    event.interval.endsAt,
    String(event.blocking),
    event.eventId,
  ].join('\u0000')));

  const blocking: { interval: TimeInterval; label: number }[] = [];
  events.forEach((event, position) => {
    if (!isPositiveInterval(event.interval)) {
      reasons.push({
        code: 'INVALID_INTERVAL',
        itemId: null,
        detail: `fixed event #${numbering[position]} ends at or before it starts`,
      });
      return;
    }
    if (event.blocking) blocking.push({ interval: event.interval, label: numbering[position] });
  });

  /* Two blocking events on top of each other is a contradiction in the input —
   * the user is claimed to be in two places at once — and it is reported before
   * planning rather than discovered as a scheduling outcome. Both are still
   * subtracted: the plan must not place work in either.
   *
   * A sweep, not a pairwise enumeration. Every pair was O(n^2) in both time and
   * in the size of the returned `Plan`: 200 events from a duplicated calendar
   * feed — an ordinary shape, not an adversarial one — produced 19,900 findings
   * and three quarters of a megabyte of prose inside an object that travels
   * into audit records. Sorting by start and reporting each event that begins
   * before the furthest end seen so far finds the same contradiction, reports
   * at most one finding per event, and misses nothing: an event that overlaps
   * anything at all overlaps something that started no later than it did. */
  const ordered = blocking.slice().sort((left, right) => toEpochMs(left.interval.startsAt) - toEpochMs(right.interval.startsAt)
    || toEpochMs(left.interval.endsAt) - toEpochMs(right.interval.endsAt)
    || left.label - right.label);

  let furthestEndMs = Number.NEGATIVE_INFINITY;
  let furthestLabel = -1;
  for (const entry of ordered) {
    const startsAtMs = toEpochMs(entry.interval.startsAt);
    if (startsAtMs < furthestEndMs) {
      reasons.push({
        code: 'FIXED_EVENT_CONFLICT',
        itemId: null,
        detail: `blocking fixed events #${Math.min(furthestLabel, entry.label)} and #${Math.max(furthestLabel, entry.label)} overlap`,
      });
    }
    const endsAtMs = toEpochMs(entry.interval.endsAt);
    if (endsAtMs > furthestEndMs) {
      furthestEndMs = endsAtMs;
      furthestLabel = entry.label;
    }
  }

  return { reasons, blocking: ordered.map((entry) => entry.interval) };
}

/* ── Placement ──────────────────────────────────────────────────── */

function firstDuplicateItemId(items: readonly PlanningItem[]): string | null {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.itemId)) return item.itemId;
    seen.add(item.itemId);
  }
  return null;
}

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

  const duplicateId = firstDuplicateItemId(constraints.items);
  if (duplicateId !== null) {
    // Thrown for the same reason as an unusable slot grid: there is no reason
    // code for it, and the taxonomy is not the place to invent one — #29 owns
    // whether a request is well formed. Two items sharing an id make
    // `scheduled`, `unscheduled` and every diff keyed by `itemId` ambiguous:
    // the plan would carry two placements under one id, breaking the
    // exactly-once partition, and `diffPlans` would silently keep whichever it
    // saw last.
    throw new TypeError(`duplicate item id in planning request: ${JSON.stringify(duplicateId)}`);
  }

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
    const finding = staticFinding(item, constraints, onCycle, knownItemIds, hasWorkingTime);
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
   *
   * The chain is described by its length and by where it bottoms out, never by
   * listing the ids along it. Those are other items' identifiers, they are
   * caller-chosen text, and a reason attributed to one item has no business
   * carrying them. The two facts a reader actually needs — how far away the
   * real problem is, and what kind of problem it is — both survive.
   */
  function blockedDetail(blockerId: string): string {
    let depth = 1;
    let cursor = blockerId;
    // Bounded by the item count: every hop moves to a distinct already-resolved
    // item, and a repeat would mean a cycle, which the static pass removed.
    while (depth <= constraints.items.length) {
      const reason = unscheduledById.get(cursor);
      if (reason === undefined) break;
      if (reason.code !== 'BLOCKED_BY_DEPENDENCY') {
        return `waiting on an unscheduled prerequisite ${depth} link(s) away; the chain ends in ${reason.code}`;
      }
      const next = (orderingEdges.get(cursor) ?? [])
        .slice()
        .sort(compareByCodePoint)
        .find((id) => unscheduledById.has(id));
      if (next === undefined) break;
      cursor = next;
      depth += 1;
    }
    return `waiting on an unscheduled prerequisite ${depth} link(s) away`;
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
        resolveUnscheduled(item.itemId, 'BLOCKED_BY_DEPENDENCY', 'no resolvable dependency order');
      }
      break;
    }
    const item = remaining.splice(readyIndex, 1)[0];
    const prerequisites = (orderingEdges.get(item.itemId) ?? []).slice().sort(compareByCodePoint);

    const blocker = prerequisites.find((id) => unscheduledById.has(id));
    if (blocker !== undefined) {
      resolveUnscheduled(item.itemId, 'BLOCKED_BY_DEPENDENCY', blockedDetail(blocker));
      continue;
    }

    const bufferBeforeMs = bufferBefore(item) * MS_PER_MINUTE;
    const bufferAfterMs = bufferAfter(item) * MS_PER_MINUTE;
    const effortMs = effortMinutes(item) * MS_PER_MINUTE;

    // The prerequisite floor is stated here as well as being implied by the
    // free runs, because it is the contract's rule ("an item starts only after
    // all its temporal prerequisites' reservedIntervals have ended") and a
    // reader should not have to derive it from interval subtraction.
    let floorMs = horizonStartMs;
    for (const id of prerequisites) {
      const prerequisite = placedById.get(id);
      if (prerequisite !== undefined) {
        floorMs = Math.max(floorMs, toEpochMs(prerequisite.reservedInterval.endsAt));
      }
    }
    const bounds = startBounds(item, horizonStartMs, horizonEndMs, floorMs);

    if (bounds.earliestMs >= horizonEndMs) {
      resolveUnscheduled(item.itemId, 'HORIZON_EXHAUSTED', 'cannot begin before the horizon ends');
      continue;
    }
    if (bounds.earliestMs > bounds.latestMs) {
      // The item had a legal start in the static pass, so if it no longer does
      // the only thing that moved is where its prerequisites finished.
      const code: PlanningReasonCode = prerequisites.length > 0 ? 'DEPENDENCY_TOO_LATE' : 'NO_FEASIBLE_SLOT';
      resolveUnscheduled(item.itemId, code, 'no room left before it is due');
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
      const startMs = alignUp(Math.max(bounds.earliestMs, runStartMs + bufferBeforeMs), horizonStartMs, slotMs);
      const reservedStartMs = startMs - bufferBeforeMs;
      const reservedEndMs = startMs + effortMs + bufferAfterMs;
      // The run bounds the whole reservation — runs are already clipped to the
      // horizon, so this is also what keeps buffers inside it. The deadline
      // bounds only the effort, via `bounds.latestMs`.
      if (reservedStartMs < runStartMs) continue;
      if (reservedEndMs > runEndMs) continue;
      if (startMs > bounds.latestMs) continue;
      placement = {
        itemId: item.itemId,
        interval: { startsAt: toInstant(startMs), endsAt: toInstant(startMs + effortMs) },
        reservedInterval: { startsAt: toInstant(reservedStartMs), endsAt: toInstant(reservedEndMs) },
      };
      break;
    }

    if (placement === null) {
      resolveUnscheduled(item.itemId, 'NO_FEASIBLE_SLOT', 'no free run long enough');
    } else {
      resolveScheduled(placement);
    }
  }

  // Indexed once rather than scanned twice per comparison. The linear search
  // this replaces was O(n^2 log n) and also silently took the first match, so a
  // duplicate id would have ordered one placement by the other's priority —
  // which is now refused outright above, but the index is what makes the
  // lookup total rather than merely usually right.
  const itemsById = new Map(constraints.items.map((item) => [item.itemId, item] as const));
  scheduled.sort((left, right) => comparePlanOrder(
    orderFields(itemsById.get(left.itemId) as PlanningItem, left.interval.startsAt),
    orderFields(itemsById.get(right.itemId) as PlanningItem, right.interval.startsAt),
  ));
  // `unscheduled` is sorted by id alone: `PLAN_ORDERING_KEYS` orders a plan's
  // placements and its first key does not exist for an item that has none, so
  // reusing it here would order by whatever the remaining keys happened to say.
  unscheduled.sort((left, right) => compareByCodePoint(left.itemId, right.itemId));
  constraintReasons.sort((left, right) => compareByCodePoint(left.code, right.code)
    || compareByCodePoint(left.itemId ?? '', right.itemId ?? '')
    || compareByCodePoint(left.detail, right.detail));

  // Computed here rather than as the first statement of this function. The
  // digest is a description of the request, not a gate on it: anything it could
  // object to is something the passes above have already described in the
  // taxonomy, and running it first meant a bad value came back as an exception
  // instead of as the finding both other tracks report for it.
  const inputDigest = planningInputDigest(constraints, config);

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
