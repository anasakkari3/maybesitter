/**
 * Static feasibility validation of a set of planning constraints.
 *
 * This answers one question and refuses the neighbouring one: *is this input
 * self-contradictory*, decided by looking at the constraints alone with no
 * placement attempted. It emits only `STATIC_INFEASIBILITY_CODES`. It never
 * emits an attempt code, however obvious the contention looks from here.
 *
 * That refusal is the whole reason this module is separable from #30's
 * scheduler, and it is not a stylistic preference. The sprint design records
 * why, twice over: Sprint 02 shipped 91 green tests over three modules that
 * read one contract three ways, and Sprint 06 shipped two self-consistent
 * readings of a shared vocabulary whose disagreement was invisible to both
 * suites. So this sprint partitions the vocabulary and has #31's oracle derive
 * the static half independently, and the merge-owned cross-track test compares
 * the two on exactly that partition. A `NO_FEASIBLE_SLOT` emitted here — and
 * "every window is booked solid" really does look decidable from where this
 * function stands — would put the two sides in disagreement about a code
 * neither of them was asked about.
 *
 * Four rules govern what comes out.
 *
 *  1. **One defect earns one code.** Several conditions imply each other: a
 *     deadline before the earliest start also leaves no room for the effort, an
 *     item depending on itself is also in a cycle, an inverted horizon also
 *     contains no working time. Reporting every technically-true code hands a
 *     reader four findings for one defect with no signal about the cause.
 *     Precedence is expressed by skipping the implied check, and it is pinned by
 *     tests asserting the *exact* code set rather than membership. The contract
 *     states one of these orderings outright — `SELF_DEPENDENCY` over
 *     `CYCLIC_DEPENDENCY` — and the rest follow the same principle.
 *
 *  2. **A finding about an item carries its `itemId`; a finding about the
 *     constraints carries null.** `CYCLIC_DEPENDENCY` is per item rather than
 *     per cycle, which is a deliberate departure from the decomposition
 *     validator's per-proposal cycle finding. Two reasons: #30 must attach a
 *     reason to each `UnscheduledItem` and a null-itemId finding cannot be
 *     attached to anything, and the contract's ruling that `SELF_DEPENDENCY`
 *     takes precedence over `CYCLIC_DEPENDENCY` is incoherent unless the two are
 *     attributed the same way.
 *
 *  3. **`detail` never repeats user-chosen text.** Reasons travel with a plan
 *     and into audit records, matching the `rawInputInAudit: false` policy that
 *     Sprint 06 set for `DecompositionViolation.detail`. A `windowId`, an
 *     `eventId` and a `title` are all chosen by whoever built the request, so
 *     findings name windows and events by *position*, and numbers derived from
 *     the input (minutes, counts, local dates) are the only other thing a detail
 *     carries. An `itemId` is exempt only because the contract puts it in its
 *     own field; it is not repeated in the prose.
 *
 *  4. **Nothing is repaired.** A malformed working window is skipped and
 *     reported; it is never read as wrapping to the next day, never clamped into
 *     range. An unknown effort is reported and never estimated. The planner's
 *     value is that a plan it produces is one the constraints actually admit,
 *     and every repair is a place where that stops being true silently.
 *
 * There is no ambient clock here. Every instant comes from the horizon, the
 * items or the events passed in.
 */

import type {
  FixedEvent,
  PlanningConfig,
  PlanningConstraints,
  PlanningDependencyKind,
  PlanningItem,
  PlanningReason,
  StaticInfeasibilityCode,
} from '../../../src/contracts/v1/planningContracts';
import {
  intervalsOverlap,
  isPositiveInterval,
  minutesBetween,
  toEpochMs,
} from '../shared/time';
import { normalizeWorkingWindows } from './normalize';

export interface ConstraintValidationOptions {
  /**
   * Report `AMBIGUOUS_LOCAL_TIME` for a window starting in a DST fold, even
   * though `PlanningConfig.foldPolicy` has already resolved it.
   *
   * Off by default, because the contract is explicit: "with a `foldPolicy` set
   * this is resolved, not reported; it exists for callers that choose to
   * surface the ambiguity instead". `foldPolicy` is not optional on
   * `PlanningConfig`, so it is *always* set, and a validator that reported the
   * ambiguity regardless would mark every fall-back Sunday infeasible for a
   * user whose configuration had already answered the question. An opt-in is
   * the only shape the contract's sentence leaves room for: the caller is
   * electing to be told the question was asked, not asking for it to be
   * decided.
   */
  readonly surfaceFoldAmbiguity?: boolean;
}

/** Only the static half of the taxonomy is constructible through this. */
type StaticReason = PlanningReason & { readonly code: StaticInfeasibilityCode };

function reason(code: StaticInfeasibilityCode, itemId: string | null, detail: string): StaticReason {
  return { code, itemId, detail };
}

/**
 * Whether a dependency edge forces an ordering under this config.
 *
 * Only ordering edges can make a cycle unschedulable. The contract says
 * `resource` and `informational` are *recorded* but do not, on their own, force
 * ordering in v1, and `PlanningConfig.resourceDependenciesOrder` promotes the
 * first of the two. A cycle of edges that force no order is not a contradiction,
 * and reporting one would mark a perfectly placeable pair of items impossible.
 *
 * `SELF_DEPENDENCY` and `UNKNOWN_DEPENDENCY` deliberately do *not* consult this:
 * an edge naming nothing, or naming its own item, is malformed input whatever it
 * would have meant.
 */
function forcesOrdering(kind: PlanningDependencyKind, config: PlanningConfig): boolean {
  if (kind === 'temporal') return true;
  return kind === 'resource' && config.resourceDependenciesOrder === true;
}

/**
 * The items that sit on a cycle in the ordering graph, excluding self-edges and
 * edges to items absent from the request.
 *
 * Both exclusions matter. A self-edge is reported as `SELF_DEPENDENCY` and would
 * otherwise surface here as well, against the contract's stated precedence; a
 * dangling edge cannot be part of a cycle at all, and following it would either
 * crash or invent one.
 *
 * Iterative with an explicit stack, for the reason
 * `lib/decomposition/engine/validator.ts` records: the recursive version cost
 * one JS frame per edge, and a few thousand chained items threw a `RangeError`
 * out past the only `try`/`catch` on the path — so a deep graph produced no
 * verdict at all rather than a wrong one, which is the harder failure to notice.
 */
function itemsInCycle(
  items: readonly PlanningItem[],
  config: PlanningConfig,
): ReadonlySet<string> {
  const known = new Set(items.map((item) => item.itemId));
  const edges = new Map<string, readonly string[]>();
  for (const item of items) {
    edges.set(
      item.itemId,
      item.dependsOn
        .filter((dependency) => forcesOrdering(dependency.kind, config))
        .map((dependency) => dependency.dependsOnItemId)
        .filter((id) => id !== item.itemId && known.has(id)),
    );
  }

  const inCycle = new Set<string>();
  const state = new Map<string, 'visiting' | 'done'>();
  // The current gray path, mirrored as a map from id to its index in it, so
  // both "is this a back edge?" and "where does the cycle start?" are O(1).
  const path: string[] = [];
  const onPath = new Map<string, number>();

  for (const root of Array.from(known)) {
    if (state.has(root)) continue;
    const stack: { readonly id: string; edgeIndex: number }[] = [{ id: root, edgeIndex: 0 }];
    state.set(root, 'visiting');
    onPath.set(root, path.length);
    path.push(root);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const outgoing = edges.get(frame.id) ?? [];
      if (frame.edgeIndex < outgoing.length) {
        const next = outgoing[frame.edgeIndex];
        frame.edgeIndex += 1;
        const cycleStart = onPath.get(next);
        if (cycleStart !== undefined) {
          for (let index = cycleStart; index < path.length; index += 1) {
            inCycle.add(path[index]);
          }
        } else if (!state.has(next)) {
          state.set(next, 'visiting');
          onPath.set(next, path.length);
          path.push(next);
          stack.push({ id: next, edgeIndex: 0 });
        }
      } else {
        stack.pop();
        onPath.delete(frame.id);
        path.pop();
        state.set(frame.id, 'done');
      }
    }
  }
  return inCycle;
}

/**
 * Blocking fixed events that collide with an earlier one, by a sweep.
 *
 * One finding per *event that collides with something before it*, not one per
 * colliding pair. Two hundred overlapping events — an ordinary shape for a
 * calendar export with a duplicated feed — have 19,900 colliding pairs, and a
 * reason list travels with the plan and into audit records, so the pairwise
 * report is an unbounded payload on a path nobody inspects. Sprint 06's
 * validator was capped for exactly this after a draft produced 1.12 MB of
 * `detail`; a sweep avoids ever building the report rather than truncating it
 * afterwards.
 *
 * Nothing is lost that the verdict turns on. If any two blocking events overlap,
 * then in start order some event begins before the running maximum end, so the
 * contradiction is always found — what a sweep gives up is enumerating every
 * pair expressing it, which is diagnosis rather than judgement.
 */
function conflictingEventPairs(
  fixedEvents: readonly FixedEvent[],
): { readonly index: number; readonly withIndex: number }[] {
  const blocking = fixedEvents
    .map((event, index) => ({ event, index }))
    .filter((entry) => entry.event.blocking && isPositiveInterval(entry.event.interval))
    .sort(
      (left, right) =>
        toEpochMs(left.event.interval.startsAt) - toEpochMs(right.event.interval.startsAt)
        || toEpochMs(left.event.interval.endsAt) - toEpochMs(right.event.interval.endsAt)
        || left.index - right.index,
    );

  const conflicts: { index: number; withIndex: number }[] = [];
  let furthest: { readonly event: FixedEvent; readonly index: number } | null = null;
  for (const entry of blocking) {
    // Compared through the shared `intervalsOverlap` rather than an inlined
    // `<`, so "abutting events do not conflict" means here exactly what it
    // means in #30 and #31. An inlined `<=` on one side would produce a
    // validator that refuses back-to-back meetings and a scheduler that permits
    // them, and both would be self-consistent.
    if (furthest !== null && intervalsOverlap(entry.event.interval, furthest.event.interval)) {
      conflicts.push({ index: entry.index, withIndex: furthest.index });
    }
    if (furthest === null || toEpochMs(entry.event.interval.endsAt) > toEpochMs(furthest.event.interval.endsAt)) {
      furthest = entry;
    }
  }
  return conflicts.sort((left, right) => left.index - right.index || left.withIndex - right.withIndex);
}

/**
 * Decide whether a set of constraints contradicts itself, from the constraints
 * alone.
 *
 * Deterministic and pure: the same constraints, config and options always
 * produce the same reasons in the same order. Findings about the constraints as
 * a whole come first, in the order the checks run; findings about items follow,
 * in the order the items were given. Ordering is stable rather than sorted, so a
 * caller comparing two reports of the same input compares like with like.
 *
 * Throws — rather than reporting — on an instant that does not parse. The
 * shared time module throws on purpose, because `NaN` propagates through every
 * comparison as `false` and would turn "this item conflicts" into "this item
 * does not conflict"; swallowing that here would mean inventing a code the
 * shared vocabulary does not contain, which is precisely what a shared taxonomy
 * exists to prevent. Producing a well-formed `Instant` belongs to the boundary
 * that accepts the request.
 */
export function validateConstraints(
  constraints: PlanningConstraints,
  config: PlanningConfig,
  options: ConstraintValidationOptions = {},
): PlanningReason[] {
  const reasons: StaticReason[] = [];
  const { horizon, items } = constraints;

  const horizonStartMs = toEpochMs(horizon.startsAt);
  const horizonEndMs = toEpochMs(horizon.endsAt);
  const horizonUsable = horizonEndMs > horizonStartMs;

  if (!horizonUsable) {
    reasons.push(reason(
      'INVALID_INTERVAL',
      null,
      'the planning horizon does not end after it starts, so it holds no time',
    ));
  }

  const normalized = normalizeWorkingWindows(constraints.workingWindows, horizon, config);

  for (const index of normalized.malformedWindowIndices) {
    reasons.push(reason(
      'INVALID_INTERVAL',
      null,
      `working window at index ${index} is not a well-formed recurring interval: `
      + 'it needs a weekday in 0..6, whole start and end minutes in 0..1440 with the end after the '
      + 'start, and a time zone this runtime knows',
    ));
  }

  for (const event of constraints.fixedEvents.map((value, index) => ({ value, index }))) {
    if (!isPositiveInterval(event.value.interval)) {
      // The case `TimeInterval` names: it occupies no time while claiming a
      // position, so it conflicts with nothing and nothing conflicts with it —
      // no overlap assertion anywhere could see it.
      reasons.push(reason(
        'INVALID_INTERVAL',
        null,
        `fixed event at index ${event.index} does not end after it starts`,
      ));
    }
  }

  for (const conflict of conflictingEventPairs(constraints.fixedEvents)) {
    reasons.push(reason(
      'FIXED_EVENT_CONFLICT',
      null,
      `blocking fixed event at index ${conflict.index} overlaps the blocking fixed event at `
      + `index ${conflict.withIndex}; the request claims the user is in two places at once`,
    ));
  }

  for (const anomaly of normalized.anomalies) {
    // Only a *start* is reported, which is what the contract's two codes
    // describe. An anomalous end changes the length of the day and is visible in
    // the materialised interval; inventing a third code for it here would put a
    // vocabulary in this module that #31's oracle has never seen.
    if (anomaly.boundary !== 'start') continue;
    if (anomaly.kind === 'gap') {
      reasons.push(reason(
        'NONEXISTENT_LOCAL_TIME',
        null,
        `working window at index ${anomaly.windowIndex} starts at a local time skipped by a `
        + `forward transition on ${anomaly.localDate}; it resumes when the clock does and is `
        + 'that much shorter',
      ));
    } else if (options.surfaceFoldAmbiguity === true) {
      reasons.push(reason(
        'AMBIGUOUS_LOCAL_TIME',
        null,
        `working window at index ${anomaly.windowIndex} starts at a local time that occurs twice `
        + `on ${anomaly.localDate}; the configured fold policy chose between them`,
      ));
    }
  }

  // Only asked when the horizon is usable: an inverted horizon contains no
  // working time by construction, and saying so as well would send the reader to
  // the windows, which may be perfectly fine.
  if (horizonUsable && normalized.windows.length === 0) {
    reasons.push(reason(
      'NO_WORKING_WINDOW',
      null,
      `none of the ${constraints.workingWindows.length} working window(s) supplied yields any time `
      + 'inside the planning horizon, so there is nowhere legal to put anything',
    ));
  }

  /* ── Items ─────────────────────────────────────────────────────── */

  const knownItemIds = new Set(items.map((item) => item.itemId));
  const cyclic = itemsInCycle(items, config);

  for (const item of items) {
    const effortKnown = item.effort.kind === 'known';
    const effortMinutes = item.effort.kind === 'known' ? item.effort.minutes : Number.NaN;
    const effortUsable = effortKnown && Number.isFinite(effortMinutes) && effortMinutes > 0;

    if (!effortKnown) {
      reasons.push(reason(
        'EFFORT_UNKNOWN',
        item.itemId,
        'effort is unknown, so no slot can be sized for this item; it is reported, never guessed',
      ));
    } else if (!effortUsable) {
      reasons.push(reason(
        'EFFORT_NOT_POSITIVE',
        item.itemId,
        'known effort is not a positive, finite number of minutes',
      ));
    }

    // The item's own window, before any working window or fixed event is
    // consulted. A null bound falls back to the horizon rather than to
    // infinity: an item with no `earliestStartAt` may start when the plan does,
    // and treating the bound as unbounded would call a half-hour horizon roomy
    // enough for a day of work.
    const windowStartMs = item.earliestStartAt === null ? horizonStartMs : toEpochMs(item.earliestStartAt);
    const windowEndMs = item.deadlineAt === null ? horizonEndMs : toEpochMs(item.deadlineAt);

    const deadlineBeforeStart =
      item.deadlineAt !== null && item.earliestStartAt !== null && windowEndMs <= windowStartMs;
    if (deadlineBeforeStart) {
      reasons.push(reason(
        'DEADLINE_BEFORE_EARLIEST_START',
        item.itemId,
        'the deadline is at or before the earliest start, so the item\'s own window is empty '
        + 'before any other constraint is consulted',
      ));
    }

    if (horizonUsable && item.deadlineAt !== null && toEpochMs(item.deadlineAt) > horizonEndMs) {
      // Distinct from having no time. The plan does not reach that far, and
      // extending the horizon would change the answer — which is a different
      // thing to tell a user, and nothing else in the vocabulary says it.
      reasons.push(reason(
        'DEADLINE_BEYOND_HORIZON',
        item.itemId,
        'the deadline falls after the end of the planning horizon; extending the horizon would '
        + 'change this answer',
      ));
    }

    // Skipped when the effort is unusable, when the item's window is already
    // known empty, or when the horizon this check borrows its missing bounds
    // from is not an interval at all. Each of those would make this check true
    // as a *consequence*, and one defect earns one code — an inverted horizon
    // that also reported every item as too large for its window would bury the
    // one finding a reader can act on under one per item.
    if (effortUsable && !deadlineBeforeStart && horizonUsable) {
      // Buffers are protected time *around* the item and the contract keeps
      // them out of `Effort` on purpose, so a plan can report "this took 30
      // minutes and needed 15 minutes of recovery" rather than inflating one
      // number and losing both. A check that compared effort alone would call
      // this feasible, and #30 would then fail to place it and report
      // contention for what was a contradiction.
      const required = effortMinutes + item.bufferBeforeMinutes + item.bufferAfterMinutes;
      const available = Math.max(0, minutesBetween(
        item.earliestStartAt === null ? horizon.startsAt : item.earliestStartAt,
        item.deadlineAt === null ? horizon.endsAt : item.deadlineAt,
      ));
      if (required > available) {
        reasons.push(reason(
          'EFFORT_EXCEEDS_ITEM_WINDOW',
          item.itemId,
          `effort plus buffers needs ${required} minutes and the item's own window holds `
          + `${available}, even if every minute of it were free`,
        ));
      }
    }

    // Edges are deduplicated by target first. Two edges to the same item with
    // different kinds are one edge in the graph, and reporting the same missing
    // target twice would bill one mistake twice.
    const targets = Array.from(new Set(item.dependsOn.map((dependency) => dependency.dependsOnItemId)));
    let selfDependent = false;
    for (const target of targets) {
      if (target === item.itemId) {
        selfDependent = true;
        reasons.push(reason('SELF_DEPENDENCY', item.itemId, 'the item depends on itself'));
      } else if (!knownItemIds.has(target)) {
        reasons.push(reason(
          'UNKNOWN_DEPENDENCY',
          item.itemId,
          'a dependency names an item absent from this request',
        ));
      }
    }

    // The contract's stated precedence, following the rule
    // `decompositionContracts` set: a self-edge is a cycle of length one, and
    // one defect earns one code. Other items on the same longer cycle still
    // earn theirs — the precedence is per item, not per cycle.
    if (!selfDependent && cyclic.has(item.itemId)) {
      reasons.push(reason(
        'CYCLIC_DEPENDENCY',
        item.itemId,
        'the item sits on a cycle of ordering dependencies, so nothing in that cycle can start',
      ));
    }
  }

  return reasons;
}
