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
 *  1. **A judgement is suppressed only when it borrows a bound from something
 *     already reported invalid.** Nothing wider.
 *
 *     This is the integration ruling, and it is stated here because all three
 *     tracks derived a suppression rule independently and all three came out
 *     different. The loose version — "one defect earns one code" — reads as
 *     "one item earns one code" on a bad day, and that is how this module
 *     briefly came to hide a real finding: an item stating both of its own
 *     bounds borrows nothing from the horizon, so an inverted horizon must not
 *     silence the verdict on its window. It also came to suppress
 *     `NO_WORKING_WINDOW` when every window was malformed, which borrows nothing
 *     either — "these windows are unusable" and "you have no availability" are
 *     two facts, and a reader needs both.
 *
 *     Applied here, the principle licenses exactly four suppressions:
 *     `NO_WORKING_WINDOW` and `DEADLINE_BEYOND_HORIZON` under an inverted
 *     horizon (both read the horizon), `EFFORT_EXCEEDS_ITEM_WINDOW` when the
 *     window it measures was already reported (inverted, out of reach, or
 *     leaning on a bad horizon), and `CYCLIC_DEPENDENCY` under
 *     `SELF_DEPENDENCY`, which the contract states outright. Each is pinned by a
 *     test asserting the *exact* code set rather than membership.
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
 * **Strongly connected components, not a back-edge walk.** This was a
 * depth-first search that marked the current gray path whenever it found a back
 * edge, copied from `lib/decomposition/engine/validator.ts`, and it silently
 * missed members. Given `a -> b, a -> c, b -> a, c -> b`, the item `c` sits on
 * the cycle `a -> c -> b -> a`, but by the time `c` is visited `b` has already
 * finished, so `c -> b` is a *cross* edge: not a back edge, not an unvisited
 * node, so neither branch fires and `c` is reported feasible. It can never
 * start. The integration fuzzer found it in 13 of 40,000 cases; a fixed table of
 * 44 hand-written graphs had not.
 *
 * A node is on a cycle exactly when its strongly connected component has more
 * than one member — self-edges being already excluded, an SCC of one is
 * acyclic. That is a reachability question, and answering it directly is why
 * #31's oracle was right. Tarjan's algorithm computes every component in one
 * pass, so this costs the same single walk the broken version did.
 *
 * Iterative with an explicit stack, for the reason the Sprint 06 module records:
 * the recursive form cost one JS frame per edge, and a few thousand chained
 * items threw a `RangeError` out past the only `try`/`catch` on the path — so a
 * deep graph produced no verdict at all rather than a wrong one, which is the
 * harder failure to notice.
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
  const index = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onComponentStack = new Set<string>();
  const componentStack: string[] = [];
  let nextIndex = 0;

  for (const root of Array.from(known)) {
    if (index.has(root)) continue;

    index.set(root, nextIndex);
    lowLink.set(root, nextIndex);
    nextIndex += 1;
    componentStack.push(root);
    onComponentStack.add(root);
    const work: { readonly id: string; edgeIndex: number }[] = [{ id: root, edgeIndex: 0 }];

    while (work.length > 0) {
      const frame = work[work.length - 1];
      const outgoing = edges.get(frame.id) ?? [];

      if (frame.edgeIndex < outgoing.length) {
        const next = outgoing[frame.edgeIndex];
        frame.edgeIndex += 1;
        if (!index.has(next)) {
          index.set(next, nextIndex);
          lowLink.set(next, nextIndex);
          nextIndex += 1;
          componentStack.push(next);
          onComponentStack.add(next);
          work.push({ id: next, edgeIndex: 0 });
        } else if (onComponentStack.has(next)) {
          // The edge reaches a node still open in this component. A cross edge
          // to a *closed* node is correctly ignored here — it cannot join two
          // components — which is precisely the case the old walk conflated
          // with "not on a cycle".
          lowLink.set(frame.id, Math.min(lowLink.get(frame.id) as number, index.get(next) as number));
        }
        continue;
      }

      work.pop();
      const parent = work[work.length - 1];
      if (parent !== undefined) {
        lowLink.set(parent.id, Math.min(lowLink.get(parent.id) as number, lowLink.get(frame.id) as number));
      }
      if (lowLink.get(frame.id) === index.get(frame.id)) {
        const component: string[] = [];
        for (;;) {
          const member = componentStack.pop() as string;
          onComponentStack.delete(member);
          component.push(member);
          if (member === frame.id) break;
        }
        if (component.length > 1) {
          for (const member of component) inCycle.add(member);
        }
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

  // Suppressed under an inverted horizon, and *only* there. This judgement asks
  // whether any window falls inside the horizon, so it borrows the horizon —
  // which was just reported invalid — and the answer it would give is an
  // artefact of that.
  //
  // It is deliberately not suppressed when every window is malformed, though the
  // one-defect-one-code instinct says otherwise. It borrows nothing from the
  // windows: "these two windows are unusable" and "you now have no availability
  // at all" are two independent facts, and a reader needs both.
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

    // Buffers are guarded exactly as effort is, and for a sharper reason. They
    // are summed into the time an item requires, so a `NaN` buffer makes
    // `required` NaN and `required > available` false — the window check falls
    // through and the item is reported as perfectly feasible. A negative buffer
    // does the same by shrinking `required` below the effort the item actually
    // needs. Both are *false feasible*, which is the worse direction: an
    // unreported contradiction reaches #30, which places nothing and reports
    // `NO_FEASIBLE_SLOT` contention for what was a contradiction in the input,
    // and no test of either module sees a problem.
    //
    // Zero is admitted, and must be: buffers default to zero throughout an
    // ordinary request, so a guard demanding a positive number would report
    // every item in it.
    const bufferUsable = (minutes: number): boolean => Number.isFinite(minutes) && minutes >= 0;
    const buffersUsable = bufferUsable(item.bufferBeforeMinutes) && bufferUsable(item.bufferAfterMinutes);

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
    } else if (!buffersUsable) {
      // Reported under the same code as a bad effort, because it is the same
      // defect: a duration field on this item is not a usable number of minutes,
      // so the total time the item requires cannot be computed. The frozen
      // taxonomy has no separate code for a buffer, and inventing a private one
      // is what a shared vocabulary exists to prevent.
      reasons.push(reason(
        'EFFORT_NOT_POSITIVE',
        item.itemId,
        'a buffer is not a finite, non-negative number of minutes, so the total time this item '
        + 'requires cannot be computed',
      ));
    }

    // The item's own window, before any working window or fixed event is
    // consulted. A null bound falls back to the horizon rather than to
    // infinity: an item with no `earliestStartAt` may start when the plan does,
    // and treating the bound as unbounded would call a half-hour horizon roomy
    // enough for a day of work.
    const windowStartMs = item.earliestStartAt === null ? horizonStartMs : toEpochMs(item.earliestStartAt);
    const windowEndMs = item.deadlineAt === null ? horizonEndMs : toEpochMs(item.deadlineAt);

    // An item stating both of its own bounds borrows nothing from the horizon,
    // so it is judged on them whatever the horizon says. Only an item leaning on
    // a substituted bound has to wait for the horizon to be sound — the
    // suppression is per item and per bound, not a flag over the whole request.
    // Written as one predicate because both item-window codes below consult it:
    // gating one and not the other left `DEADLINE_BEFORE_EARLIEST_START` firing
    // under an inverted horizon while its sibling stayed silent, which is two
    // definitions of "the item's own window" for #31 to have to guess between.
    const windowSelfSpecified = item.earliestStartAt !== null && item.deadlineAt !== null;
    const windowJudgeable = windowSelfSpecified || horizonUsable;

    // Speaks only about the two bounds the item itself states. A null
    // `earliestStartAt` is deliberately *not* substituted from the horizon here,
    // even though the window check below does substitute it: the ruling on
    // DEADLINE_BEYOND_HORIZON gives "the deadline is before the plan begins" its
    // own code, so this one is left saying exactly one thing and has no
    // substitution to have an opinion about.
    const deadlineBeforeStart = windowSelfSpecified && windowEndMs <= windowStartMs;
    if (deadlineBeforeStart) {
      reasons.push(reason(
        'DEADLINE_BEFORE_EARLIEST_START',
        item.itemId,
        'the deadline is at or before the earliest start the item may take, so its own window is '
        + 'empty before any other constraint is consulted; an absent earliest start is the '
        + 'horizon\'s',
      ));
    }

    // A deadline at or before the horizon start: the item cannot be finished
    // within this plan's reach at all, which is an ordinary daily input — a
    // stale or missed commitment — rather than an edge case.
    //
    // The *other* direction is deliberately not reported. A deadline after
    // `horizon.endsAt` makes the horizon the binding constraint, and the item is
    // the least constrained thing in the request: an item due in a month, planned
    // over a fortnight, is placed like anything else. Reporting it would be a
    // manufactured failure. This module used to report exactly that, and it put
    // this validator and #31's oracle in *disjoint* disagreement on the same
    // input — the worst shape a disagreement can take, since neither side looks
    // partially right. The ruling is recorded in the contract at integration.
    const deadlineOutsideHorizon =
      horizonUsable && item.deadlineAt !== null && toEpochMs(item.deadlineAt) <= horizonStartMs;
    if (deadlineOutsideHorizon) {
      reasons.push(reason(
        'DEADLINE_BEYOND_HORIZON',
        item.itemId,
        'the deadline falls at or before the start of the planning horizon, so the item cannot be '
        + 'finished within this plan\'s reach',
      ));
    }

    // Skipped when a duration this check sums is unusable, or when the window it
    // measures has itself already been reported — inverted by the item's own
    // bounds, out of the plan's reach, or leaning on a horizon that is not an
    // interval. Every one of those is the suppression principle rather than a
    // taste: this check borrows a bound from something already reported invalid,
    // so the answer it would give is an artefact of that finding.
    // `deadlineOutsideHorizon` suppresses this only when the window actually
    // leans on the horizon. An item stating both of its own bounds borrows
    // nothing, and 10,000 minutes not fitting in one day is true whatever the
    // horizon says — the ruling is per item and per *bound*, not per request,
    // and reading it per request was the same mistake one level down from where
    // I first made it.
    const windowMeasuresAReportedBound =
      deadlineBeforeStart || (deadlineOutsideHorizon && !windowSelfSpecified);

    if (effortUsable && buffersUsable && windowJudgeable && !windowMeasuresAReportedBound) {
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
