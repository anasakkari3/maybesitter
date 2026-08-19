/**
 * The feasibility oracle (Sprint 07, issue #31).
 *
 * ── Why this exists at all ──────────────────────────────────────────
 *
 * #29's validator already answers "is this input self-contradictory". This
 * module answers it again, from the contract rather than from that code. The
 * sprint design says why: three tracks implement judgements over one
 * vocabulary, and the roadmap records what happens when two self-consistent
 * readings of a shared vocabulary are never compared — Sprint 02, "91 tests
 * passed while they disagreed".
 *
 * So the one thing this file must not do is import
 * `lib/planning/constraints/validator.ts`, and it does not. Nor does it import
 * anything under `lib/planning/scheduler/`: an oracle that consulted the
 * scheduler would be comparing a thing with itself. What it *does* import is
 * `lib/planning/shared/time.ts` and `lib/planning/constraints/normalize.ts`,
 * because instant/wall-clock arithmetic and the materialisation built on it are
 * not judgements — a second copy of either would be the Sprint 06 gap rather
 * than a Sprint 06 check.
 *
 * That distinction is the whole reason `normalize.ts` is imported by path and
 * never through the `constraints/` barrel. The barrel re-exports the validator,
 * and `tests/planning/planningBoundaries.test.ts` walks the *import closure*, so
 * the barrel would put #29's judgement in this module's closure and make
 * `planningCrossTrack` compare a thing with itself. The guard failing there
 * would be correct behaviour, not an obstacle.
 *
 * This module carried its own `occurrencesOf` through the sprint, because #29
 * did not exist when #31 started. Deleting it at integration found two real
 * defects rather than an adaptation problem — a fold under an unrecognised
 * policy silently resolving to `latest`, and a DST anomaly reported against a
 * horizon it fell outside — and both were fixed at their source, in
 * `shared/time.ts` and in `normalize.ts` respectively. What survives here is
 * the *reading*: which findings those facts earn, which is #31's to decide.
 *
 * Every rule below is derived from the prose attached to its code in
 * `PlanningReasonCode`. Where the derivation required a decision the contract
 * does not spell out, the decision is stated in a comment at the rule, so the
 * cross-track comparison has something to adjudicate rather than a silent
 * difference to absorb.
 *
 * ── Only static codes, ever ─────────────────────────────────────────
 *
 * `FeasibilityVerdict.reasons` is documented as static-only. Nothing here may
 * emit `NO_FEASIBLE_SLOT` and friends: those describe contention, which is only
 * knowable after placement was tried, and an oracle that guessed at them would
 * be a scheduler with no plan to show for it.
 *
 * ── One defect earns one code, and only one defect ──────────────────
 *
 * `decompositionContracts` set the rule and `PlanningReasonCode` restates it
 * for `SELF_DEPENDENCY` over `CYCLIC_DEPENDENCY`. The rule is about one
 * *subject* earning one code — not about a request earning as few as possible.
 *
 * The line this file draws: **a judgement is suppressed only where it would
 * borrow a bound from something already reported invalid.**
 * `EFFORT_EXCEEDS_ITEM_WINDOW` is silent when the effort has no size, when the
 * item's own window was already reported empty, or when it would measure
 * against a horizon that is itself the broken thing. It is *not* silent merely
 * because some unrelated code fired: a dangling dependency edge supplies none
 * of that arithmetic's bounds, and an earlier, wider gate reported one code
 * where the constraints held two.
 *
 * Nothing suppresses `NO_WORKING_WINDOW` on the strength of a window-level
 * finding. See the rule for why that reasoning did not survive.
 *
 * ── No clock, no randomness ─────────────────────────────────────────
 *
 * `assessFeasibility` is a pure function of `(constraints, config)`, per
 * `PLANNING_PERSISTENCE_POLICY.noAmbientClock`. The reason list is sorted into
 * a stated order rather than left in discovery order, so a verdict serialised
 * twice is byte-identical and input array order cannot leak into it.
 *
 * ── Details never carry user text ───────────────────────────────────
 *
 * `PLANNING_PERSISTENCE_POLICY.rawInputInAudit` is false and `PlanningReason`
 * says `detail` "never carries raw user text". **No caller-supplied string of
 * any kind reaches a `detail`** — not a title, not an id, not a zone name, not
 * an instant. Windows, events and items are named by their position in the
 * request; numbers and derived dates are quoted freely.
 *
 * A shape filter is not enough and was tried: 64 characters of
 * `[A-Za-z0-9._:-]` admits `call-dr.cohen-about-the-biopsy`, and a caller
 * chooses ids as freely as titles. `PlanningItem.title` is never read by this
 * module at all, which is the strongest form of the guarantee available.
 */
import {
  MINUTES_PER_DAY,
  STATIC_INFEASIBILITY_CODES,
  type FeasibilityVerdict,
  type PlanningConfig,
  type PlanningConstraints,
  type PlanningItem,
  type PlanningReason,
  type StaticInfeasibilityCode,
  type TimeInterval,
  type WorkingWindow,
} from '../../../src/contracts/v1/planningContracts';
import {
  intervalMinutes,
  intervalsOverlap,
  isPositiveInterval,
  toEpochMs,
} from '../shared/time';
// The one string ordering the sprint sorts by. This module had its own
// `byCodeUnit`, and #30 had three more copies of the same rule; #31 must order
// strings exactly as #30 does, or the cross-track comparison of a verdict
// against a plan becomes a comparison of two sort orders. Importing `shared/`
// is not a track crossing — it is the same leaf `shared/time` already comes
// from, and it carries no judgement. The rule is stricter than the code-unit
// comparison it replaces (it pairs surrogates) and identical on every BMP
// string, which is every id and code this module sorts.
import { compareByCodePoint } from '../shared/compare';
// #29 owns materialising a recurring wall-clock window against real dates.
// Reached by path, never through `../constraints` — see the header.
import {
  freeRunsWithin,
  mergeIntervals,
  normalizeWorkingWindows,
  windowDefect,
  type MaterializedWindow,
  type WindowAnomaly,
} from '../constraints/normalize';

const MS_PER_MINUTE = 60_000;

/**
 * How many overlapping blocking-event pairs are named individually.
 *
 * A bound, not a preference: `PlanningReason` values travel with a plan into
 * audit records, and an unbounded enumeration of a duplicated calendar feed is
 * a memory amplifier rather than a diagnosis. Anything beyond this is reported
 * as a count.
 */
export const MAX_FIXED_EVENT_CONFLICT_REASONS = 32;

function codeRank(code: StaticInfeasibilityCode): number {
  return (STATIC_INFEASIBILITY_CODES as readonly string[]).indexOf(code);
}

function reason(code: StaticInfeasibilityCode, itemId: string | null, detail: string): PlanningReason {
  return Object.freeze({ code, itemId, detail });
}

/**
 * No caller-supplied string ever reaches a `PlanningReason.detail`.
 *
 * An earlier draft quoted ids that "looked safe" — 64 characters of
 * `[A-Za-z0-9._:-]`. That filter admits `call-dr.cohen-about-the-biopsy` and
 * `anasakkari04-gmail.com`, both of which a caller can put in a `windowId` or an
 * `eventId`, and `detail` is the field most likely to reach a log. There is no
 * shape test that separates an identifier from a sentence, because the caller
 * chooses both.
 *
 * So windows, events and items are named by their **position in the request**.
 * The position locates the defect exactly as well and carries nothing. An
 * item's identity is not lost: `PlanningReason.itemId` is a typed field of its
 * own, and repeating the id in the prose would put it in the one place the
 * policy says it must not be.
 *
 * Numbers are quoted freely. A minute count is not user text, and the number is
 * what makes the finding actionable.
 */
function positionRef(kind: string, index: number): string {
  // Windows and events only. Items are located by `PlanningReason.itemId`.
  return `${kind} at position ${index}`;
}

function isFoldPolicy(value: unknown): value is 'earliest' | 'latest' {
  return value === 'earliest' || value === 'latest';
}

/**
 * The wording for a malformed window, or null when it is fine.
 *
 * The *predicate* is #29's `windowDefect`; only the sentence is this module's.
 * Both tracks had arrived at the same rule independently — a sprint sweep of
 * 65,880 cases found them agreeing exactly — and agreement is not the point: a
 * well-formedness check is a *verification predicate*, not a judgement, so by
 * this sprint's own rule two implementations of it are a gap rather than a
 * check. The judgements this module keeps to itself are which contract code a
 * defect earns and how the finding reads.
 *
 * The domain rules are wider than the contract's letter and both tracks agree
 * on the reason. `MinuteOfDay` "ranges 0..1440" and `Weekday` is 0..6; a window
 * claiming minute 2000 or day 7 denotes no interval on any clock face, so its
 * availability would either appear from nowhere or vanish without a word, and
 * the overload judgement built on `availableMinutes` inherits the error either
 * way. An unknown zone is the same defect once more: `Intl` *throws* on one, and
 * that throw used to escape `assessFeasibility` and take the corpus gate with
 * it — the one function whose whole job is to return a list of problems.
 *
 * No caller-supplied string appears in the result. The zone name is a caller
 * string like any other, so the sentence describes the defect and never quotes
 * it; numbers are quoted freely, and they are what makes the finding actionable.
 */
function windowDefectDetail(window: WorkingWindow): string | null {
  const defect = windowDefect(window);
  if (defect === null) return null;
  switch (defect) {
    case 'weekday':
      return `weekday ${String(window.weekday)} is outside 0..6`;
    case 'start_minute':
      return `startMinute ${String(window.startMinute)} is not a whole minute in 0..${MINUTES_PER_DAY}`;
    case 'end_minute':
      return `endMinute ${String(window.endMinute)} is not a whole minute in 0..${MINUTES_PER_DAY}`;
    case 'end_not_after_start':
      return `endMinute ${String(window.endMinute)} does not follow startMinute ${String(window.startMinute)}`;
    default:
      return 'the named time zone is not one this runtime knows';
  }
}

interface MaterialisedWindows {
  /** Every occurrence #29 materialised, already clipped to the horizon. */
  readonly windows: readonly MaterializedWindow[];
  /** Every anomalous local boundary it met on the way. */
  readonly anomalies: readonly WindowAnomaly[];
  /** The occurrences unioned: how much distinct working time exists. */
  readonly working: readonly TimeInterval[];
}

/**
 * Materialise the working windows across the horizon **once**, and return
 * everything this module ever wants from that walk.
 *
 * Two decisions meet in this function and both are load-bearing.
 *
 * **The walk is #29's.** `normalizeWorkingWindows` maps a recurring wall-clock
 * rule onto real dates, and that is arithmetic rather than judgement — the
 * sprint's rule is that two implementations of a judgement check each other
 * while two copies of arithmetic are a gap waiting for whichever caller falls
 * into it. This module carried its own copy for two rounds because
 * `lib/planning/constraints/` did not exist on the branch it was written on;
 * the copy is gone now and must not come back. What stays this module's own is
 * the judgement built on top: which contract code each finding earns.
 *
 * **The single pass is this module's.** `assessFeasibility` used to walk the
 * windows three times over identical inputs — once for transition anomalies,
 * once for the working union, and again inside the free-time subtraction — a
 * constant factor of three on the hottest path in the package, which the corpus
 * gate runs once per scenario. Returning the occurrences *and* their anomalies
 * *and* their union from one call is also the only thing that keeps them
 * consistent: an anomaly found in one walk and capacity computed in another are
 * two answers about the same window, and nothing would force them to agree.
 *
 * The horizon needs no guard here. `normalizeWorkingWindows` returns nothing for
 * a horizon that is not a positive interval, because a degenerate horizon has no
 * dates in it; saying so a second time would be a second answer to "is this
 * input usable" depending on which caller asked first.
 */
function materialiseWindows(
  constraints: PlanningConstraints,
  config: PlanningConfig,
): MaterialisedWindows {
  const normalized = normalizeWorkingWindows(constraints.workingWindows, constraints.horizon, config);
  return {
    windows: normalized.windows,
    anomalies: normalized.anomalies,
    // Unioned, not concatenated. Two windows a user wrote as 09:00-17:00 and
    // 12:00-20:00 are eleven hours of availability, not sixteen, and a count
    // that double-counted them would make an overloaded plan read as
    // comfortable. `mergeIntervals` is #29's, and it replaced one more copy of
    // one more piece of arithmetic that used to live here as `unionIntervals`.
    working: mergeIntervals(normalized.windows.map((occurrence) => occurrence.interval)),
  };
}

export function workingIntervalsInHorizon(
  constraints: PlanningConstraints,
  config: PlanningConfig,
): readonly TimeInterval[] {
  return materialiseWindows(constraints, config).working;
}

/**
 * Working time inside the horizon that no blocking fixed event has taken.
 *
 * This is the capacity side of an overload judgement and nothing more. It says
 * how much legal, unclaimed time exists; it does not say whether any particular
 * item fits in a contiguous run of it, which is placement and belongs to #30.
 *
 * `freeRunsWithin` is #29's, and it subtracts only `blocking` events — the same
 * rule the local `blockingCover` applied, for the same reason: a non-blocking
 * event is one the user said work may happen inside, and removing it would
 * shrink the day on the strength of a flag that says the opposite.
 */
export function freeWorkingIntervals(
  constraints: PlanningConstraints,
  config: PlanningConfig,
): readonly TimeInterval[] {
  return freeRunsWithin(materialiseWindows(constraints, config).windows, constraints.fixedEvents);
}

/* ── Dependency analysis ─────────────────────────────────────────── */

/**
 * The edges that force ordering, given the config.
 *
 * `informational` never orders. `resource` orders only when
 * `PlanningConfig.resourceDependenciesOrder` says so, which is false in v1. A
 * cycle made entirely of edges that force no ordering is not a contradiction:
 * nothing has to happen before anything else, so there is nothing to be
 * impossible about. Counting it would report a defect that constrains no plan.
 */
function orderingEdges(item: PlanningItem, config: PlanningConfig): readonly string[] {
  return item.dependsOn
    .filter((edge) => edge.kind === 'temporal' || (edge.kind === 'resource' && config.resourceDependenciesOrder))
    .map((edge) => edge.dependsOnItemId);
}

/**
 * The ids that lie on a cycle of length greater than one.
 *
 * Every item on the cycle is named, not just the one a walk happened to enter
 * by. A message naming one arbitrary member sends a maintainer to break the
 * wrong edge, and which member gets named would depend on input array order —
 * which is exactly the kind of leak `PLAN_ORDERING_KEYS` exists to close.
 */
function itemsOnCycles(items: readonly PlanningItem[], config: PlanningConfig): ReadonlySet<string> {
  const successors = new Map<string, readonly string[]>();
  for (const item of items) {
    successors.set(item.itemId, orderingEdges(item, config).filter((id) => id !== item.itemId));
  }

  const onCycle = new Set<string>();
  for (const item of items) {
    // Depth-first reachability from each item back to itself. The item counts
    // are small (a planning request is a person's week), and an explicit stack
    // keeps this free of recursion limits on a pathological graph.
    const seen = new Set<string>();
    const stack = (successors.get(item.itemId) ?? []).slice();
    while (stack.length > 0) {
      const next = stack.pop() as string;
      if (next === item.itemId) {
        onCycle.add(item.itemId);
        break;
      }
      if (seen.has(next)) continue;
      seen.add(next);
      const onward = successors.get(next);
      if (onward !== undefined) for (const id of onward) stack.push(id);
    }
  }
  return onCycle;
}

/* ── The verdict ─────────────────────────────────────────────────── */

/**
 * The static half of feasibility, derived from the constraints alone.
 *
 * Throws on an unparseable instant rather than reporting an infeasibility:
 * a malformed timestamp is not a statement about the user's week, and folding
 * it into `reasons` would let a parse error present itself as a scheduling
 * finding. `lib/planning/shared/time.ts` takes the same position and for the
 * same reason.
 */
export function assessFeasibility(
  constraints: PlanningConstraints,
  config: PlanningConfig,
): FeasibilityVerdict {
  const reasons: PlanningReason[] = [];

  const horizon: TimeInterval = { startsAt: constraints.horizon.startsAt, endsAt: constraints.horizon.endsAt };
  const horizonStartMs = toEpochMs(horizon.startsAt);
  const horizonEndMs = toEpochMs(horizon.endsAt);
  const horizonValid = horizonEndMs > horizonStartMs;

  /* Constraint-level: intervals. */

  if (!horizonValid) {
    // No instants quoted: `startsAt` is a caller-supplied string like every
    // other, and there is only one horizon, so naming it locates the defect.
    reasons.push(reason('INVALID_INTERVAL', null, 'the horizon ends at or before it starts'));
  }

  constraints.workingWindows.forEach((window, index) => {
    const defect = windowDefectDetail(window);
    if (defect === null) return;
    reasons.push(reason('INVALID_INTERVAL', null, `${positionRef('working window', index)}: ${defect}`));
  });

  constraints.fixedEvents.forEach((event, index) => {
    if (isPositiveInterval(event.interval)) return;
    reasons.push(reason(
      'INVALID_INTERVAL',
      null,
      // A zero-length event occupies no time while claiming a position: it
      // conflicts with nothing and nothing conflicts with it, so no overlap
      // assertion anywhere could see it. That is the whole reason it is a code.
      `${positionRef('fixed event', index)} ends at or before it starts`,
    ));
  });

  /* The one materialisation. Every window-derived finding below reads from it. */

  const materialised = materialiseWindows(constraints, config);

  /* Constraint-level: DST anomalies in window starts. */

  const seenAnomalies = new Set<string>();
  for (const anomaly of materialised.anomalies) {
    // Only `start` boundaries. #29 records an anomalous *end* too, because an
    // end landing in a fold silently changes the length of the day and a report
    // of why capacity moved needs somewhere to look. But the contract's two DST
    // codes are defined over a window that *starts* in an anomaly, and
    // inventing a third code here would put a vocabulary in the plan that
    // neither #29 nor #30 has seen.
    if (anomaly.boundary !== 'start') continue;
    // A fold is a *finding* only when the config declined to resolve it. With a
    // policy this runtime knows, the contract says the ambiguity is "resolved,
    // not reported", and #29 has already resolved it.
    if (anomaly.kind === 'fold' && isFoldPolicy(config.foldPolicy)) continue;
    // #29 emits one record per anomalous boundary per occurrence, and two
    // occurrences of one window can share a local date at the edges of the scan.
    const key = `${anomaly.kind}:${anomaly.windowIndex}:${anomaly.localDate}`;
    if (seenAnomalies.has(key)) continue;
    seenAnomalies.add(key);
    reasons.push(
      anomaly.kind === 'gap'
        ? reason(
            'NONEXISTENT_LOCAL_TIME',
            null,
            `${positionRef('working window', anomaly.windowIndex)} starts in a transition gap `
              + `on ${anomaly.localDate}`,
          )
        : reason(
            'AMBIGUOUS_LOCAL_TIME',
            null,
            `${positionRef('working window', anomaly.windowIndex)} starts in a transition fold `
              + `on ${anomaly.localDate} and the config states no fold policy`,
          ),
    );
  }


  /* Constraint-level: is there anywhere legal at all? */

  const working = materialised.working;
  const availableIntervals = freeRunsWithin(materialised.windows, constraints.fixedEvents);
  const availableMinutes = availableIntervals.reduce((total, span) => total + intervalMinutes(span), 0);

  // An earlier draft suppressed this whenever some window had already been
  // reported malformed, on the ground that a code which only ever co-occurs
  // with another is not independent evidence. That ground does not hold, and
  // the suppression was removed rather than tested:
  //
  //  - NO_WORKING_WINDOW fires on its own (no windows supplied, or a weekday the
  //    horizon never reaches), and INVALID_INTERVAL fires on its own (one bad
  //    window among four good ones). They co-occur only when the malformed
  //    window happened to be the *only* source of time — and there both are
  //    true, at different scopes: one names a window, one describes the request.
  //  - The contract's "one defect earns one code" precedent is about one *item*
  //    earning one code, not about findings with different subjects.
  //  - Suppressing it hid a real answer to "can anything be placed at all"
  //    behind an unrelated field-level complaint.
  //
  // The horizon remains a gate. With a degenerate horizon, "no window intersects
  // it" is trivially true of every input ever submitted, so the code would carry
  // no information at all — that one really is purely derived.
  if (working.length === 0 && horizonValid) {
    reasons.push(reason(
      'NO_WORKING_WINDOW',
      null,
      constraints.workingWindows.length === 0
        ? 'no working windows were supplied'
        : `none of the ${constraints.workingWindows.length} working window(s) yields time inside the horizon`,
    ));
  }

  /* Constraint-level: the user in two places at once. */

  const blocking = constraints.fixedEvents
    .map((event, index) => ({ event, index }))
    .filter((entry) => entry.event.blocking && isPositiveInterval(entry.event.interval))
    .sort((left, right) => {
      const byStart = toEpochMs(left.event.interval.startsAt) - toEpochMs(right.event.interval.startsAt);
      if (byStart !== 0) return byStart;
      const byEnd = toEpochMs(left.event.interval.endsAt) - toEpochMs(right.event.interval.endsAt);
      // Position last, and it is unique, so the order is total and neither input
      // array order nor sort stability can reach the output.
      return byEnd !== 0 ? byEnd : left.index - right.index;
    });

  // A sweep, not every pair. Pairwise enumeration is quadratic in a shape that
  // occurs for ordinary reasons — a duplicated calendar feed — and it was
  // measured at 19,900 reasons and 874 KB of `detail` for 200 events, which then
  // travel with the plan into audit records. #29's validator was bounded for
  // exactly this after a Sprint 06 draft produced 1.12 MB of `detail`; running
  // into it again here would be a regression into a failure this repository has
  // already paid for and written down.
  //
  // The sweep is complete for the question the cross-track test asks. That
  // comparison is over code *sets*: if any two blocking events overlap, sorting
  // by start guarantees at least one adjacent-in-sweep pair does too, so the
  // code is emitted whenever it is true. What is bounded is how many times.
  let openEnd = -Infinity;
  let openIndex = -1;
  let conflictsFound = 0;
  for (const entry of blocking) {
    const startsAt = toEpochMs(entry.event.interval.startsAt);
    const endsAt = toEpochMs(entry.event.interval.endsAt);
    // Strict `<`, matching the shared `intervalsOverlap`: abutting events share
    // the instant one ends and the other begins and do not conflict. A local
    // `<=` here would make the oracle refuse back-to-back meetings that #30
    // places deliberately, and both would be self-consistent.
    if (openIndex >= 0 && startsAt < openEnd) {
      conflictsFound += 1;
      if (conflictsFound <= MAX_FIXED_EVENT_CONFLICT_REASONS) {
        reasons.push(reason(
          'FIXED_EVENT_CONFLICT',
          null,
          `blocking fixed events at positions ${openIndex} and ${entry.index} overlap`,
        ));
      }
    }
    if (endsAt > openEnd) {
      openEnd = endsAt;
      openIndex = entry.index;
    }
  }
  if (conflictsFound > MAX_FIXED_EVENT_CONFLICT_REASONS) {
    // Reported as a count rather than dropped. Truncating in silence would let a
    // calendar with thousands of collisions look like one with a few dozen.
    reasons.push(reason(
      'FIXED_EVENT_CONFLICT',
      null,
      `${conflictsFound - MAX_FIXED_EVENT_CONFLICT_REASONS} further overlapping blocking event(s) `
        + 'were found and not enumerated individually',
    ));
  }

  /* Per item. */

  const knownIds = new Set(constraints.items.map((item) => item.itemId));
  const onCycle = itemsOnCycles(constraints.items, config);
  let demandMinutes = 0;

  constraints.items.forEach((item) => {
    // No locator in the prose at all, and not even a position. `PlanningReason`
    // carries `itemId` as a typed field of its own, so the prose adds nothing by
    // repeating it — and repeating it is how a title-shaped id reaches a log.
    //
    // Position would have been the safe substitute, and is what windows and
    // events use because they have no id field to fall back on. It is wrong
    // here: a position is a fact about the input *array*, so two requests that
    // differ only in item order would produce different `detail` bytes for the
    // same finding. `PLAN_ORDERING_KEYS` exists to keep input array order out of
    // planning output; a diagnostic that leaked it would be the same defect one
    // field over.
    const itemReasons: PlanningReason[] = [];

    const effortMinutes = item.effort.kind === 'known' ? item.effort.minutes : null;
    const effortMalformed = item.effort.kind === 'known'
      && !(Number.isFinite(effortMinutes) && (effortMinutes as number) > 0);

    // A buffer is protected time around the item. Negative protected time is not
    // a small number, it is a contradiction, and `Infinity` is not a duration at
    // all. Both belong to `EFFORT_NOT_POSITIVE`, which the contract now states
    // covers the buffers and not the effort alone. Zero stays legitimate: an
    // item with no recovery time is an ordinary item.
    const malformedBuffers: string[] = [];
    if (!Number.isFinite(item.bufferBeforeMinutes) || item.bufferBeforeMinutes < 0) {
      malformedBuffers.push(`bufferBeforeMinutes ${String(item.bufferBeforeMinutes)}`);
    }
    if (!Number.isFinite(item.bufferAfterMinutes) || item.bufferAfterMinutes < 0) {
      malformedBuffers.push(`bufferAfterMinutes ${String(item.bufferAfterMinutes)}`);
    }

    if (item.effort.kind === 'unknown') {
      itemReasons.push(reason('EFFORT_UNKNOWN', item.itemId, "the item's duration is unknown, so no slot can be sized for it"));
    }
    if (effortMalformed || malformedBuffers.length > 0) {
      // One reason, whichever terms are at fault, because they are all the same
      // defect: a duration in this item is not a duration.
      const faults = (effortMalformed ? [`effort ${String(effortMinutes)}`] : []).concat(malformedBuffers);
      itemReasons.push(reason(
        'EFFORT_NOT_POSITIVE',
        item.itemId,
        `not a usable duration: ${faults.join(', ')} minute(s)`,
      ));
    }

    // Nothing is floored, and that is the point.
    //
    // An earlier draft ran every term through `Math.max(0, …)`. It looked like
    // defensive arithmetic and it was a **silent repair**, in the one direction
    // that must never be silent: a negative buffer became a *feasible* verdict.
    // Three readings of one input then gave three answers — #29 reported
    // EFFORT_NOT_POSITIVE, this file reported nothing, #30 placed the item — and
    // it broke the only assertion spanning all three, that a static
    // contradiction both readers agree on is never scheduled. A sprint fuzzer
    // hit the shape 3,735 times.
    //
    // The flooring was also inconsistent with itself: `Number.isFinite` guarded
    // the demand sum but not the effort-window arithmetic, so an `Infinity`
    // buffer produced EFFORT_EXCEEDS_ITEM_WINDOW here and nothing there.
    //
    // A malformed item contributes no demand at all, exactly as an unknown
    // effort does. `demandMinutes` is a sum of *stated* durations; an item whose
    // stated durations contradict themselves has none to state. Flooring would
    // invent one and summing raw would let it discount the well-formed items
    // around it — an overloaded week reading as comfortable because one row was
    // broken.
    if (item.effort.kind === 'known' && !effortMalformed && malformedBuffers.length === 0) {
      demandMinutes += item.effort.minutes + item.bufferBeforeMinutes + item.bufferAfterMinutes;
    }

    const earliestMs = item.earliestStartAt === null ? null : toEpochMs(item.earliestStartAt);
    const deadlineMs = item.deadlineAt === null ? null : toEpochMs(item.deadlineAt);

    // Deadlines are exclusive, so a deadline equal to the earliest start leaves
    // an empty window rather than an instant of room.
    if (earliestMs !== null && deadlineMs !== null && deadlineMs <= earliestMs) {
      itemReasons.push(reason(
        'DEADLINE_BEFORE_EARLIEST_START',
        item.itemId,
        'the item may not start before its own deadline',
      ));
    }

    // One-sided, and the asymmetry is the whole content of the rule.
    //
    // A deadline at or before the horizon's first instant leaves no time inside
    // the plan to do the work: deadlines are exclusive, so `<=` and not `<`.
    //
    // A deadline *after* the horizon ends is **not** reported at all. An earlier
    // draft read the code symmetrically, on the ground that "the plan does not
    // reach that far" is true in both directions. It is, and it is the wrong
    // conclusion: an item due next month, in a two-week plan, is the *least*
    // constrained thing in the request — the horizon binds first and the item
    // schedules normally. Reporting it turned every long-dated commitment into
    // an infeasibility, which is most of the forward-looking work a planner
    // exists to place. The merge-owned cross-track test caught it from both
    // sides at once: #29 emitted nothing, and #30's scheduler placed the item
    // this file had just declared unplaceable.
    if (deadlineMs !== null && horizonValid && deadlineMs <= horizonStartMs) {
      itemReasons.push(reason(
        'DEADLINE_BEYOND_HORIZON',
        item.itemId,
        'the deadline falls at or before the first instant of the planning horizon',
      ));
    }

    const selfDependent = item.dependsOn.some((edge) => edge.dependsOnItemId === item.itemId);
    if (selfDependent) {
      itemReasons.push(reason('SELF_DEPENDENCY', item.itemId, 'the item depends on itself'));
    } else if (onCycle.has(item.itemId)) {
      // Precedence stated by the contract: a self-edge earns SELF_DEPENDENCY and
      // not also CYCLIC_DEPENDENCY.
      itemReasons.push(reason('CYCLIC_DEPENDENCY', item.itemId, 'the item lies on a dependency cycle'));
    }

    const dangling = item.dependsOn
      .filter((edge) => edge.dependsOnItemId !== item.itemId && !knownIds.has(edge.dependsOnItemId))
      .length;
    if (dangling > 0) {
      // Every kind, including `informational`. Those edges force no ordering,
      // but an edge pointing at nothing is a broken reference rather than a
      // scheduling preference.
      itemReasons.push(reason(
        'UNKNOWN_DEPENDENCY',
        item.itemId,
        `${dangling} dependency edge(s) name no item in this request`,
      ));
    }

    // Suppressed only where this judgement would *borrow a bound* from something
    // already reported invalid. The earlier "otherwise clean" gate was wider
    // than that and wrong for it: an item with a dangling dependency edge and an
    // effort window too small for its own effort has two independent defects,
    // and the dependency graph supplies neither of the bounds this arithmetic
    // uses. Silencing the second made the oracle report one code where the
    // constraints hold two.
    //
    // The three borrowings, each of which really does make the result derived:
    //  1. no size to compare — the effort is unknown or not positive, or a
    //     buffer is not a duration, all already reported;
    //  2. the item's own window was already reported empty
    //     (DEADLINE_BEFORE_EARLIEST_START);
    //  3. a bound was taken from the horizon and the horizon is the thing that
    //     is broken — either it is itself degenerate, or the deadline sits at or
    //     before its start, already reported as DEADLINE_BEYOND_HORIZON.
    //     Without (3) an inverted horizon manufactured a spurious finding
    //     against *every* item in the request.
    const emptyOwnWindow = itemReasons.some((found) => found.code === 'DEADLINE_BEFORE_EARLIEST_START');
    const borrowsBrokenHorizon = (earliestMs === null || deadlineMs === null) && !horizonValid;
    // `<=`, tracking the rule above exactly: whenever DEADLINE_BEYOND_HORIZON is
    // reported for a borrowed lower bound, the arithmetic it would feed is the
    // consequence of that same finding.
    const deadlinePrecedesHorizon = earliestMs === null && deadlineMs !== null && horizonValid
      && deadlineMs <= horizonStartMs;

    if (
      effortMinutes !== null && effortMinutes > 0 && malformedBuffers.length === 0
      && !emptyOwnWindow && !borrowsBrokenHorizon && !deadlinePrecedesHorizon
    ) {
      const lowerMs = earliestMs !== null ? earliestMs : horizonStartMs;
      const upperMs = deadlineMs !== null ? deadlineMs : horizonEndMs;
      // No flooring: the suppression above guarantees both buffers are finite
      // and non-negative by the time this runs.
      const requiredMinutes = effortMinutes + item.bufferBeforeMinutes + item.bufferAfterMinutes;
      const windowMinutes = (upperMs - lowerMs) / MS_PER_MINUTE;
      if (windowMinutes < requiredMinutes) {
        itemReasons.push(reason(
          'EFFORT_EXCEEDS_ITEM_WINDOW',
          item.itemId,
          `the item needs ${requiredMinutes} minute(s) including buffers but its window holds ${windowMinutes}`,
        ));
      }
    }

    for (const found of itemReasons) reasons.push(found);
  });

  /* Ordering: constraint-level findings first, then by item, then by code. */

  const sorted = reasons.slice().sort((left, right) => {
    const leftItem = left.itemId ?? '';
    const rightItem = right.itemId ?? '';
    if (leftItem !== rightItem) {
      if (left.itemId === null) return -1;
      if (right.itemId === null) return 1;
      return compareByCodePoint(leftItem, rightItem);
    }
    const rank = codeRank(left.code as StaticInfeasibilityCode) - codeRank(right.code as StaticInfeasibilityCode);
    return rank !== 0 ? rank : compareByCodePoint(left.detail, right.detail);
  });

  return Object.freeze({
    feasible: sorted.length === 0,
    reasons: Object.freeze(sorted),
    availableMinutes,
    demandMinutes,
  });
}
