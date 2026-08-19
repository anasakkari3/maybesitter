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
import { compareByCodePoint } from '../shared/compare';
import { planningInputDigest } from './digest';
// #29 owns turning a recurring wall-clock `WorkingWindow` into absolute
// intervals. This track carried its own `windows.ts` copy while #29 did not
// exist; that file is gone and this is the import that replaces it.
//
// Reached at `constraints/normalize` rather than at the `constraints/` barrel
// on purpose. The barrel also re-exports `validator.ts`, and
// `tests/planning/planningBoundaries.test.ts` walks the *import closure* — so
// the barrel would put #29's judgement in the scheduler's closure and fail the
// guard that keeps placement from reading the static verdict it is supposed to
// be checked against. Materialising a window is arithmetic and may cross that
// line; validating constraints is a judgement and may not.
import { mergeIntervals, normalizeWorkingWindows } from '../constraints/normalize';

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
      delta = right.priority - left.priority;
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

/** Item ids that sit on a cycle of length > 1 in the ordering graph. */
function itemsOnCycles(edges: ReadonlyMap<string, readonly string[]>): Set<string> {
  const onCycle = new Set<string>();
  const state = new Map<string, 'visiting' | 'done'>();
  // Iterative DFS: the recursion depth of a chain of steps is bounded by the
  // item count, and a stack overflow on a pathological request would surface as
  // a crash rather than as a reported cycle.
  for (const root of Array.from(edges.keys()).sort(compareByCodePoint)) {
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
      for (const next of (edges.get(frame.node) ?? []).slice().sort(compareByCodePoint).reverse()) {
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
  onCycle: ReadonlySet<string>,
  knownItemIds: ReadonlySet<string>,
  hasWorkingTime: boolean,
): StaticFinding | null {
  if (item.effort.kind === 'unknown') {
    return { code: 'EFFORT_UNKNOWN', detail: `${item.itemId} has no duration estimate` };
  }
  if (item.effort.minutes <= 0) {
    return {
      code: 'EFFORT_NOT_POSITIVE',
      detail: `${item.itemId} has an effort of ${item.effort.minutes} minutes`,
    };
  }
  const declared = declaredPrerequisites(item);
  if (declared.includes(item.itemId)) {
    return { code: 'SELF_DEPENDENCY', detail: `${item.itemId} is its own prerequisite` };
  }
  if (onCycle.has(item.itemId)) {
    return { code: 'CYCLIC_DEPENDENCY', detail: `${item.itemId} sits on a dependency cycle` };
  }
  const dangling = declared.filter((id) => !knownItemIds.has(id)).sort(compareByCodePoint);
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
      detail: `${item.itemId} is due at or before the planning horizon opens`,
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
      detail: `${item.itemId} needs ${effortMinutes(item)} minutes of effort and its window admits no legal start`,
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

function fixedEventFindings(constraints: PlanningConstraints): {
  reasons: PlanningReason[];
  blocking: TimeInterval[];
} {
  const reasons: PlanningReason[] = [];
  const blocking: TimeInterval[] = [];
  const ordered = constraints.fixedEvents
    .slice()
    .sort((left, right) => compareByCodePoint(left.eventId, right.eventId));

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

  /* Two shapes meet here. #29's normalizer answers in *occurrences* —
   * one `MaterializedWindow` per weekday the horizon touches, each still
   * carrying which window it came from and how its local boundaries resolved —
   * while placement needs a disjoint cover and a flat reason list. The
   * translation is below and is the only thing this module does with windows;
   * none of the arithmetic is repeated.
   *
   * `normalizeWorkingWindows` takes the whole config rather than a `foldPolicy`
   * because the fold rule is config-level and #29 states it once. */
  const normalized = normalizeWorkingWindows(constraints.workingWindows, constraints.horizon, config);

  /* Occurrences may overlap — two windows can describe the same afternoon —
   * and placement must not see that stretch twice or a reservation could be
   * made against capacity that does not exist. #29's `mergeIntervals` is the
   * union, abutting runs included, so an item spanning a seam between two
   * windows the user happened to write separately is still placeable. */
  const windowIntervals = mergeIntervals(normalized.windows.map((occurrence) => occurrence.interval));

  /* A window #29 could not materialise at all. Named by index rather than by
   * `windowId`: the index is what the normalizer reports, and #29's validator
   * reports the same defect the same way, so the two readings of one bad window
   * line up instead of being two sentences about it. The wording stays generic
   * because the normalizer's malformed set is wider than "ends before it
   * starts" — a weekday outside 0..6, a non-integer minute and a zone this
   * runtime does not know all land here, and each of them denotes a window that
   * occurs on no clock face rather than one that is merely backwards. */
  for (const index of normalized.malformedWindowIndices) {
    constraintReasons.push({
      code: 'INVALID_INTERVAL',
      itemId: null,
      detail: `working window at index ${index} is not a well-formed recurring interval`,
    });
  }

  /* Only a *start* landing in a forward transition becomes a reason, which is
   * what `NONEXISTENT_LOCAL_TIME` describes. #29 also records anomalous *ends*
   * and folds; an anomalous end shortens the day and is already visible in the
   * interval, and a fold is resolved by `config.foldPolicy` rather than
   * reported — the contract calls it "resolved, not reported", which is why
   * this module never emits `AMBIGUOUS_LOCAL_TIME`. */
  for (const anomaly of normalized.anomalies) {
    if (anomaly.boundary !== 'start' || anomaly.kind !== 'gap') continue;
    constraintReasons.push({
      code: 'NONEXISTENT_LOCAL_TIME',
      itemId: null,
      detail: `working window at index ${anomaly.windowIndex} starts in a daylight-saving gap `
        + `on ${anomaly.localDate}`,
    });
  }

  const fixed = fixedEventFindings(constraints);
  constraintReasons.push(...fixed.reasons);

  const baseRuns = freeRunsAfter(windowIntervals, fixed.blocking);
  // Measured on the materialised windows, *before* fixed events are subtracted.
  // `NO_WORKING_WINDOW` means the request declares nowhere legal to work; a day
  // that had availability and then lost all of it to meetings is contention,
  // and reporting it as a missing window sends the user to edit their
  // availability rules when what they need to move is a meeting.
  const hasWorkingTime = windowIntervals.length > 0;
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
      // Sorted before choosing, like every other traversal in this file. A bare
      // `.find` over `dependsOn` walks the edges in the order the caller
      // happened to declare them, so an item with two unscheduled prerequisites
      // produced a different chain — and therefore a different
      // `PlanningReason.detail` inside the returned `Plan` — for two requests
      // the digest reported identical. That inverts the property the digest
      // exists to provide: `sameInputDigest` would read true for a replay that
      // produced a different plan.
      const next = (orderingEdges.get(cursor) ?? [])
        .slice()
        .sort(compareByCodePoint)
        .find((id) => unscheduledById.has(id));
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
    const prerequisites = (orderingEdges.get(item.itemId) ?? []).slice().sort(compareByCodePoint);

    const blocker = prerequisites.find((id) => unscheduledById.has(id));
    if (blocker !== undefined) {
      resolveUnscheduled(item.itemId, 'BLOCKED_BY_DEPENDENCY', blockedDetail(item.itemId, blocker));
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
      resolveUnscheduled(item.itemId, 'HORIZON_EXHAUSTED', `${item.itemId} cannot begin before the horizon ends`);
      continue;
    }
    if (bounds.earliestMs > bounds.latestMs) {
      // The item had a legal start in the static pass, so if it no longer does
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
      resolveUnscheduled(item.itemId, 'NO_FEASIBLE_SLOT', `${item.itemId} found no free run long enough`);
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
