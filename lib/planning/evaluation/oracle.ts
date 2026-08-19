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
 * `lib/planning/shared/time.ts`, because instant/wall-clock arithmetic is not a
 * judgement — a second copy of it would be the Sprint 06 gap rather than a
 * Sprint 06 check.
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
 * ── One defect earns one code ───────────────────────────────────────
 *
 * `decompositionContracts` set the rule and `PlanningReasonCode` restates it
 * for `SELF_DEPENDENCY` over `CYCLIC_DEPENDENCY`. It is applied consistently
 * here, and the two places it goes beyond the contract's letter are called out
 * where they happen: `EFFORT_EXCEEDS_ITEM_WINDOW` is only considered for an
 * item that is otherwise clean, and `NO_WORKING_WINDOW` is suppressed when a
 * window-level finding already explains why there is no time. Both are the
 * difference between a maintainer reading one finding and reading three that
 * co-vary.
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
 * says `detail` "never carries raw user text". Every message here is built from
 * ids, minute counts and dates. `PlanningItem.title` is never read by this
 * module at all, which is the strongest form of that guarantee available.
 */
import {
  MINUTES_PER_DAY,
  STATIC_INFEASIBILITY_CODES,
  type FeasibilityVerdict,
  type FixedEvent,
  type Instant,
  type PlanningConfig,
  type PlanningConstraints,
  type PlanningItem,
  type PlanningReason,
  type StaticInfeasibilityCode,
  type TimeInterval,
  type WorkingWindow,
} from '../../../src/contracts/v1/planningContracts';
import {
  instantFromResolution,
  intersectIntervals,
  intervalMinutes,
  intervalsOverlap,
  isPositiveInterval,
  resolveLocalTime,
  subtractIntervals,
  toEpochMs,
  toInstant,
  wallClockAt,
  type WallClockParts,
} from '../shared/time';

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

/** Code-unit ordering, never `localeCompare`: a verdict must not depend on the host locale. */
function byCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function codeRank(code: StaticInfeasibilityCode): number {
  return (STATIC_INFEASIBILITY_CODES as readonly string[]).indexOf(code);
}

function reason(code: StaticInfeasibilityCode, itemId: string | null, detail: string): PlanningReason {
  return Object.freeze({ code, itemId, detail });
}

/**
 * A caller-supplied identifier, reduced to something safe to quote.
 *
 * Ids in this repository are machine-minted, but `PlanningConstraints` arrives
 * from a request and every string in it is as untrusted as a title. Sprint 06
 * found a corpus row that put a user's sentence verbatim into three issue
 * messages by way of an "id". The position of the row locates the defect just
 * as well and carries nothing, so anything that does not look like an id is
 * replaced by its index.
 */
function safeRef(value: unknown, index: number, kind: string): string {
  if (typeof value === 'string' && value.length > 0 && value.length <= 64 && /^[A-Za-z0-9._:-]+$/.test(value)) {
    return value;
  }
  return `${kind}#${index}`;
}

/* ── Window materialisation ──────────────────────────────────────── */

/**
 * A single occurrence of a recurring wall-clock window on one local date.
 *
 * `interval` is null when the occurrence could not be resolved to instants at
 * all — the ambiguous-fold case. `probe` is a best-effort span used only to ask
 * whether the occurrence is anywhere near the horizon, so that a transition
 * anomaly on a date the plan never reaches is not reported as a finding about
 * this plan.
 */
interface WindowOccurrence {
  readonly windowId: string;
  readonly windowIndex: number;
  readonly localDate: string;
  readonly interval: TimeInterval | null;
  readonly probe: TimeInterval;
  readonly anomaly: 'none' | 'nonexistent' | 'ambiguous';
}

function isFoldPolicy(value: unknown): value is 'earliest' | 'latest' {
  return value === 'earliest' || value === 'latest';
}

/** Civil (zone-free) arithmetic: a UTC midnight marker plus a minute count. */
function civilPartsAt(dayMarkerMs: number, minuteOfDay: number): WallClockParts {
  const moment = new Date(dayMarkerMs + minuteOfDay * MS_PER_MINUTE);
  return {
    year: moment.getUTCFullYear(),
    month: moment.getUTCMonth() + 1,
    day: moment.getUTCDate(),
    hour: moment.getUTCHours(),
    minute: moment.getUTCMinutes(),
  };
}

function civilDayMarker(parts: WallClockParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day);
}

function isoDate(dayMarkerMs: number): string {
  return new Date(dayMarkerMs).toISOString().slice(0, 10);
}

/**
 * Whether a working window is well-formed enough to materialise.
 *
 * The contract states `INVALID_INTERVAL` for `endMinute <= startMinute`. The
 * domain check is the same code for a reason the contract implies rather than
 * states: `MinuteOfDay` "ranges 0..1440", and a window claiming minute 2000
 * denotes no interval on any clock face. Silently accepting it would add 560
 * minutes of capacity that no clock ever showed, and the overload judgement
 * built on `availableMinutes` would then read as free time that does not exist.
 * That is a capacity bug, not a tidiness one, which is why it is reported here
 * rather than clamped.
 */
function windowDefect(window: WorkingWindow): string | null {
  if (!Number.isInteger(window.startMinute) || !Number.isInteger(window.endMinute)) {
    return 'window minutes must be integers';
  }
  if (window.startMinute < 0 || window.startMinute >= MINUTES_PER_DAY) {
    return `startMinute ${window.startMinute} is outside 0..${MINUTES_PER_DAY - 1}`;
  }
  if (window.endMinute < 0 || window.endMinute > MINUTES_PER_DAY) {
    return `endMinute ${window.endMinute} is outside 0..${MINUTES_PER_DAY}`;
  }
  if (window.endMinute <= window.startMinute) {
    return `endMinute ${window.endMinute} does not follow startMinute ${window.startMinute}`;
  }
  return null;
}

/**
 * Every occurrence of every well-formed window that could touch the horizon.
 *
 * Days are walked in the window's own zone, one civil day at a time, from a day
 * before the horizon starts to a day after it ends. The one-day margin is not
 * padding: a window in `Asia/Kolkata` starting at 09:00 local begins at 03:30Z,
 * so the local date that supplies the horizon's first minutes is the previous
 * one for zones east of UTC and the next one for zones west of it.
 */
function occurrencesOf(
  window: WorkingWindow,
  windowIndex: number,
  horizon: TimeInterval,
  foldPolicy: unknown,
): readonly WindowOccurrence[] {
  const zone = window.timezone;
  const horizonStartMs = toEpochMs(horizon.startsAt);
  const horizonEndMs = toEpochMs(horizon.endsAt);

  const firstDay = civilDayMarker(wallClockAt(horizonStartMs - MS_PER_DAY, zone));
  const lastDay = civilDayMarker(wallClockAt(horizonEndMs + MS_PER_DAY, zone));

  const occurrences: WindowOccurrence[] = [];
  for (let day = firstDay; day <= lastDay; day += MS_PER_DAY) {
    if (new Date(day).getUTCDay() !== window.weekday) continue;

    const startResolution = resolveLocalTime(civilPartsAt(day, window.startMinute), zone);
    const endResolution = resolveLocalTime(civilPartsAt(day, window.endMinute), zone);

    // The probe answers "is this occurrence anywhere near the horizon" even when
    // the occurrence itself is undecidable, so an unresolved fold six months
    // away is not reported as a finding about this plan.
    const probeStart = startResolution.kind === 'exact'
      ? startResolution.instant
      : startResolution.kind === 'gap' ? startResolution.resumesAt : startResolution.firstInstant;
    const probeEnd = endResolution.kind === 'exact'
      ? endResolution.instant
      : endResolution.kind === 'gap' ? endResolution.resumesAt : endResolution.secondInstant;
    const probe: TimeInterval = { startsAt: probeStart, endsAt: probeEnd };

    let anomaly: WindowOccurrence['anomaly'] = 'none';
    let startInstant: Instant | null;
    if (startResolution.kind === 'exact') {
      startInstant = startResolution.instant;
    } else if (startResolution.kind === 'gap') {
      // The clock skipped the window's start. `LocalTimeResolution` says the
      // window resumes at the instant the clock jumps to, so the day is shorter
      // rather than absent — and the fact is reported, because a caller that
      // budgeted the full window would be over by exactly the transition.
      anomaly = 'nonexistent';
      startInstant = startResolution.resumesAt;
    } else if (isFoldPolicy(foldPolicy)) {
      startInstant = instantFromResolution(startResolution, foldPolicy);
    } else {
      // Two candidates an hour apart and no stated policy. Taking either would
      // silently choose a side the config declined to choose, so the occurrence
      // contributes nothing and the ambiguity is reported instead.
      anomaly = 'ambiguous';
      startInstant = null;
    }

    let endInstant: Instant | null;
    if (endResolution.kind === 'exact') {
      endInstant = endResolution.instant;
    } else if (endResolution.kind === 'gap') {
      // No code here: the contract scopes both DST codes to a window that
      // *starts* in an anomaly. An end swallowed by a gap shortens the window
      // and is not a separate contradiction.
      endInstant = endResolution.resumesAt;
    } else if (isFoldPolicy(foldPolicy)) {
      endInstant = instantFromResolution(endResolution, foldPolicy);
    } else {
      endInstant = null;
    }

    const interval = startInstant !== null && endInstant !== null
      && toEpochMs(endInstant) > toEpochMs(startInstant)
      ? { startsAt: startInstant, endsAt: endInstant }
      : null;

    occurrences.push({
      windowId: safeRef(window.windowId, windowIndex, 'window'),
      windowIndex,
      localDate: isoDate(day),
      interval,
      probe,
      anomaly,
    });
  }
  return occurrences;
}

/** Merge overlapping and abutting intervals into a sorted, disjoint cover. */
function unionIntervals(intervals: readonly TimeInterval[]): readonly TimeInterval[] {
  const ordered = intervals
    .filter(isPositiveInterval)
    .slice()
    .sort((left, right) => toEpochMs(left.startsAt) - toEpochMs(right.startsAt));

  const merged: { startsAt: number; endsAt: number }[] = [];
  for (const interval of ordered) {
    const startsAt = toEpochMs(interval.startsAt);
    const endsAt = toEpochMs(interval.endsAt);
    const open = merged.length > 0 ? merged[merged.length - 1] : null;
    // Abutting runs are joined: 09:00-12:00 and 12:00-17:00 are eight hours of
    // capacity, and leaving them as two rows would let a caller that measured
    // "the longest free run" report three hours when there are eight.
    if (open === null || startsAt > open.endsAt) merged.push({ startsAt, endsAt });
    else if (endsAt > open.endsAt) open.endsAt = endsAt;
  }
  return merged.map((span) => ({ startsAt: toInstant(span.startsAt), endsAt: toInstant(span.endsAt) }));
}

/**
 * The working time inside the horizon, before anything is subtracted.
 *
 * Unioned rather than summed. Two windows a user wrote as 09:00-17:00 and
 * 12:00-20:00 are eleven hours of availability, not sixteen, and an
 * `availableMinutes` that double-counted them would make an overloaded plan
 * read as comfortable.
 */
export function workingIntervalsInHorizon(
  constraints: PlanningConstraints,
  config: PlanningConfig,
): readonly TimeInterval[] {
  const horizon: TimeInterval = { startsAt: constraints.horizon.startsAt, endsAt: constraints.horizon.endsAt };
  if (!isPositiveInterval(horizon)) return [];

  const pieces: TimeInterval[] = [];
  constraints.workingWindows.forEach((window, index) => {
    if (windowDefect(window) !== null) return;
    for (const occurrence of occurrencesOf(window, index, horizon, config.foldPolicy)) {
      if (occurrence.interval === null) continue;
      const clipped = intersectIntervals(occurrence.interval, horizon);
      if (clipped !== null) pieces.push(clipped);
    }
  });
  return unionIntervals(pieces);
}

/** The blocking fixed events, as a disjoint cover. Non-blocking events are not time taken. */
function blockingCover(events: readonly FixedEvent[]): readonly TimeInterval[] {
  return unionIntervals(events.filter((event) => event.blocking).map((event) => event.interval));
}

/**
 * Working time inside the horizon that no blocking fixed event has taken.
 *
 * This is the capacity side of an overload judgement and nothing more. It says
 * how much legal, unclaimed time exists; it does not say whether any particular
 * item fits in a contiguous run of it, which is placement and belongs to #30.
 */
export function freeWorkingIntervals(
  constraints: PlanningConstraints,
  config: PlanningConfig,
): readonly TimeInterval[] {
  const cover = blockingCover(constraints.fixedEvents);
  const free: TimeInterval[] = [];
  for (const working of workingIntervalsInHorizon(constraints, config)) {
    for (const remaining of subtractIntervals(working, cover)) free.push(remaining);
  }
  return free;
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
    reasons.push(reason(
      'INVALID_INTERVAL',
      null,
      `horizon ends at or before it starts (${horizon.startsAt} .. ${horizon.endsAt})`,
    ));
  }

  let windowLevelFinding = false;
  constraints.workingWindows.forEach((window, index) => {
    const defect = windowDefect(window);
    if (defect === null) return;
    windowLevelFinding = true;
    reasons.push(reason(
      'INVALID_INTERVAL',
      null,
      `working window ${safeRef(window.windowId, index, 'window')}: ${defect}`,
    ));
  });

  constraints.fixedEvents.forEach((event, index) => {
    if (isPositiveInterval(event.interval)) return;
    reasons.push(reason(
      'INVALID_INTERVAL',
      null,
      // A zero-length event occupies no time while claiming a position: it
      // conflicts with nothing and nothing conflicts with it, so no overlap
      // assertion anywhere could see it. That is the whole reason it is a code.
      `fixed event ${safeRef(event.eventId, index, 'event')} ends at or before it starts`,
    ));
  });

  /* Constraint-level: DST anomalies in window starts. */

  if (horizonValid) {
    const seenAnomalies = new Set<string>();
    constraints.workingWindows.forEach((window, index) => {
      if (windowDefect(window) !== null) return;
      for (const occurrence of occurrencesOf(window, index, horizon, config.foldPolicy)) {
        if (occurrence.anomaly === 'none') continue;
        if (intersectIntervals(occurrence.probe, horizon) === null) continue;
        const key = `${occurrence.anomaly}:${occurrence.windowId}:${occurrence.localDate}`;
        if (seenAnomalies.has(key)) continue;
        seenAnomalies.add(key);
        windowLevelFinding = true;
        reasons.push(
          occurrence.anomaly === 'nonexistent'
            ? reason(
                'NONEXISTENT_LOCAL_TIME',
                null,
                `working window ${occurrence.windowId} starts in a transition gap on ${occurrence.localDate} `
                  + `in ${window.timezone}`,
              )
            : reason(
                'AMBIGUOUS_LOCAL_TIME',
                null,
                `working window ${occurrence.windowId} starts in a transition fold on ${occurrence.localDate} `
                  + `in ${window.timezone} and the config states no fold policy`,
              ),
        );
      }
    });
  }

  /* Constraint-level: is there anywhere legal at all? */

  const working = workingIntervalsInHorizon(constraints, config);
  const availableIntervals = freeWorkingIntervals(constraints, config);
  const availableMinutes = availableIntervals.reduce((total, span) => total + intervalMinutes(span), 0);

  // Suppressed when the input is already known malformed. "Your horizon is
  // degenerate" and "and therefore you have no windows" are one defect, and a
  // second code that only ever co-occurs with the first tells a maintainer
  // nothing while making the two look like independent evidence.
  if (working.length === 0 && horizonValid && !windowLevelFinding) {
    reasons.push(reason(
      'NO_WORKING_WINDOW',
      null,
      constraints.workingWindows.length === 0
        ? 'no working windows were supplied'
        : `none of the ${constraints.workingWindows.length} working window(s) occurs inside the horizon`,
    ));
  }

  /* Constraint-level: the user in two places at once. */

  const blocking = constraints.fixedEvents
    .map((event, index) => ({ event, index }))
    .filter((entry) => entry.event.blocking && isPositiveInterval(entry.event.interval))
    .sort((left, right) =>
      byCodeUnit(
        safeRef(left.event.eventId, left.index, 'event'),
        safeRef(right.event.eventId, right.index, 'event'),
      ),
    );

  for (let outer = 0; outer < blocking.length; outer += 1) {
    for (let inner = outer + 1; inner < blocking.length; inner += 1) {
      // Through the shared `intervalsOverlap`, so abutting events do not
      // conflict. A local `<=` here would make the oracle refuse back-to-back
      // meetings that #30 places deliberately, and both would be self-consistent.
      if (!intervalsOverlap(blocking[outer].event.interval, blocking[inner].event.interval)) continue;
      const left = safeRef(blocking[outer].event.eventId, blocking[outer].index, 'event');
      const right = safeRef(blocking[inner].event.eventId, blocking[inner].index, 'event');
      reasons.push(reason(
        'FIXED_EVENT_CONFLICT',
        null,
        `blocking fixed events ${left} and ${right} overlap`,
      ));
    }
  }

  /* Per item. */

  const knownIds = new Set(constraints.items.map((item) => item.itemId));
  const onCycle = itemsOnCycles(constraints.items, config);
  let demandMinutes = 0;

  constraints.items.forEach((item, index) => {
    const ref = safeRef(item.itemId, index, 'item');
    const itemReasons: PlanningReason[] = [];

    const effortMinutes = item.effort.kind === 'known' ? item.effort.minutes : null;
    if (item.effort.kind === 'unknown') {
      itemReasons.push(reason('EFFORT_UNKNOWN', item.itemId, `item ${ref} has no known duration`));
    } else if (!(effortMinutes !== null && Number.isFinite(effortMinutes) && effortMinutes > 0)) {
      itemReasons.push(reason(
        'EFFORT_NOT_POSITIVE',
        item.itemId,
        `item ${ref} has an effort of ${String(effortMinutes)} minutes`,
      ));
    }

    // Demand floors each term at zero. A negative row is already reported as
    // EFFORT_NOT_POSITIVE, and letting it subtract would quietly discount the
    // demand of the well-formed items around it — an overloaded week would then
    // read as feasible because one row was malformed.
    if (item.effort.kind === 'known') {
      demandMinutes += Math.max(0, Number.isFinite(item.effort.minutes) ? item.effort.minutes : 0)
        + Math.max(0, Number.isFinite(item.bufferBeforeMinutes) ? item.bufferBeforeMinutes : 0)
        + Math.max(0, Number.isFinite(item.bufferAfterMinutes) ? item.bufferAfterMinutes : 0);
    }

    const earliestMs = item.earliestStartAt === null ? null : toEpochMs(item.earliestStartAt);
    const deadlineMs = item.deadlineAt === null ? null : toEpochMs(item.deadlineAt);

    // Deadlines are exclusive, so a deadline equal to the earliest start leaves
    // an empty window rather than an instant of room.
    if (earliestMs !== null && deadlineMs !== null && deadlineMs <= earliestMs) {
      itemReasons.push(reason(
        'DEADLINE_BEFORE_EARLIEST_START',
        item.itemId,
        `item ${ref} may not start before its own deadline`,
      ));
    }

    if (deadlineMs !== null && horizonValid && (deadlineMs > horizonEndMs || deadlineMs < horizonStartMs)) {
      // Symmetric on purpose. The code's prose — "the plan simply does not reach
      // that far, and extending the horizon would change the answer" — is as
      // true of a deadline the horizon starts after as of one it ends before.
      itemReasons.push(reason(
        'DEADLINE_BEYOND_HORIZON',
        item.itemId,
        `item ${ref} has a deadline outside the horizon`,
      ));
    }

    const selfDependent = item.dependsOn.some((edge) => edge.dependsOnItemId === item.itemId);
    if (selfDependent) {
      itemReasons.push(reason('SELF_DEPENDENCY', item.itemId, `item ${ref} depends on itself`));
    } else if (onCycle.has(item.itemId)) {
      // Precedence stated by the contract: a self-edge earns SELF_DEPENDENCY and
      // not also CYCLIC_DEPENDENCY.
      itemReasons.push(reason('CYCLIC_DEPENDENCY', item.itemId, `item ${ref} lies on a dependency cycle`));
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
        `item ${ref} has ${dangling} dependency edge(s) naming no item in this request`,
      ));
    }

    // Considered only for an item that is otherwise clean. "Your effort does not
    // fit" is derived arithmetic, and an item whose effort is unknown, whose
    // window is empty, or whose deadline is outside the horizon has already been
    // told the thing that is wrong with it. Reporting the derived consequence
    // too gives a maintainer two findings that always move together.
    if (itemReasons.length === 0 && effortMinutes !== null && effortMinutes > 0) {
      const lowerMs = earliestMs !== null ? earliestMs : horizonStartMs;
      const upperMs = deadlineMs !== null ? deadlineMs : horizonEndMs;
      const requiredMinutes = effortMinutes
        + Math.max(0, item.bufferBeforeMinutes)
        + Math.max(0, item.bufferAfterMinutes);
      const windowMinutes = (upperMs - lowerMs) / MS_PER_MINUTE;
      if (windowMinutes < requiredMinutes) {
        itemReasons.push(reason(
          'EFFORT_EXCEEDS_ITEM_WINDOW',
          item.itemId,
          `item ${ref} needs ${requiredMinutes} minute(s) including buffers but its window holds ${windowMinutes}`,
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
      return byCodeUnit(leftItem, rightItem);
    }
    const rank = codeRank(left.code as StaticInfeasibilityCode) - codeRank(right.code as StaticInfeasibilityCode);
    return rank !== 0 ? rank : byCodeUnit(left.detail, right.detail);
  });

  return Object.freeze({
    feasible: sorted.length === 0,
    reasons: Object.freeze(sorted),
    availableMinutes,
    demandMinutes,
  });
}
