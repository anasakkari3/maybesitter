/**
 * Planning contracts (Sprint 07, issues #29, #30, #31).
 *
 * Planning takes what the user has committed to and asks a narrower question
 * than Priority did: not "what matters most" but "when, if ever, does this
 * fit". The answer is a *plan* — a proposal about time — and like every other
 * intelligence module output it is offered, never written (see
 * `PLANNING_PERSISTENCE_POLICY`).
 *
 * Five things here are structural rather than conventional, each because the
 * alternative fails quietly.
 *
 *  1. **Every interval is half-open, `[startsAt, endsAt)`.** The end instant is
 *     *not* part of the interval. A meeting ending at 10:00 and one starting at
 *     10:00 do not overlap. Stated once, here, because the alternative is three
 *     tracks each picking a convention: #29's validator would report a conflict
 *     that #30's scheduler had deliberately produced, and both would pass their
 *     own suites. This is issue #29's "end times are exclusive and documented"
 *     acceptance criterion, and it is documented *in the type* rather than in a
 *     comment on one implementation. See `TimeInterval`.
 *
 *  2. **Unknown effort is a variant, not a sentinel.** `durationMinutes: 0` and
 *     `durationMinutes: null` both read as a number to arithmetic, and a plan
 *     that silently placed a zero-length task would satisfy every overlap check
 *     while telling the user nothing. `Effort` makes "we do not know how long
 *     this takes" a case a caller must destructure, which is issue #29's
 *     "unknown duration is handled explicitly". See `Effort`.
 *
 *  3. **One vocabulary of "why not", shared by three independent readers.**
 *     #29's validator decides feasibility from constraints alone, #30's
 *     scheduler decides it by trying, and #31's oracle decides it a third time
 *     as an independent check. Sprint 06 shipped exactly this shape and its
 *     lesson is recorded in the roadmap: two self-consistent readings of a
 *     shared vocabulary leave both suites green and the disagreement invisible.
 *     So the codes live here and no track owns them, and they are *partitioned*
 *     — see `STATIC_INFEASIBILITY_CODES` — so that "which of us should have
 *     caught this" has a typed answer rather than a convention.
 *
 *  4. **Determinism is a property of the contract, not of an implementation.**
 *     Issue #30 requires that the same inputs and config produce the same plan.
 *     A scheduler that iterates a `Map`, ties on priority, and breaks the tie by
 *     insertion order is deterministic on one machine and on one input
 *     ordering. `PLAN_ORDERING_KEYS` states the total order explicitly, so
 *     "stable" means the same thing to the scheduler that produces a plan and
 *     to the oracle that checks one.
 *
 *  5. **A working window is wall-clock; an instant is absolute.** "I work
 *     09:00-17:00 on Tuesdays" is a statement about a clock on a wall in a
 *     named zone, and it maps to a different number of UTC minutes on the two
 *     days a year the offset changes. Keeping the two representations distinct
 *     in the type system is what makes the DST cases in issue #31 expressible
 *     at all; collapsing them to "just store UTC" is the bug those cases exist
 *     to find. See `WorkingWindow` and `LocalTimeResolution`.
 */

import { MODULE_CONTRACT_VERSION } from './moduleContracts';

export const PLANNING_CONTRACT_VERSION = MODULE_CONTRACT_VERSION;
export const PLANNING_SCHEMA_VERSION = 'planning-v1' as const;

/* ── Time ────────────────────────────────────────────────────────── */

/**
 * An absolute instant, as an ISO-8601 string in UTC with a `Z` suffix.
 *
 * A string rather than a number because every other contract in this repo
 * carries times as ISO strings (`BusyWindow.startsAt`, `Field.observedAt`), and
 * a planning module that spoke epoch-millis would need a conversion at every
 * boundary — which is where off-by-one-hour bugs live.
 */
export type Instant = string;

/**
 * A half-open interval `[startsAt, endsAt)` on the absolute timeline.
 *
 * The end instant is excluded. Two non-empty intervals overlap when
 * `a.startsAt < b.endsAt && b.startsAt < a.endsAt` — note the strict
 * comparisons, which is the whole content of "exclusive": abutting intervals
 * share an instant and do not conflict.
 *
 * `endsAt` must be strictly after `startsAt`. A zero-length interval is not a
 * degenerate case to tolerate, it is `INVALID_INTERVAL`: it occupies no time
 * while claiming a position, so it neither conflicts with anything nor can be
 * conflicted with, and it would silently satisfy every overlap assertion a test
 * could make about it.
 *
 * That last sentence is load-bearing and the formula above does not deliver it
 * on its own. Applied to `[09:00, 09:00)` and `[08:00, 10:00)` the textbook
 * comparison returns *true*, because an empty interval's start precedes the
 * other's end and vice versa. The empty set intersects nothing, so the shared
 * `intervalsOverlap` guards emptiness first and returns false. Well-formedness
 * is checked separately, once, by the `INVALID_INTERVAL` rule — a conflict
 * check that also policed its inputs would give two different answers to
 * "is this schedulable" depending on which caller asked.
 */
export interface TimeInterval {
  readonly startsAt: Instant;
  readonly endsAt: Instant;
}

/**
 * A wall-clock time of day, as minutes from local midnight.
 *
 * Ranges 0..1440 inclusive of the upper bound, because a window ending at
 * midnight ends at minute 1440 of the day it started, not minute 0 of the next
 * one. Making the end exclusive (rule 1) and the domain 0..1440 is what lets
 * "09:00 until midnight" be one window rather than a window plus a special
 * case.
 */
export type MinuteOfDay = number;

export const MINUTES_PER_DAY = 1440;

/** 0 = Sunday, matching `Date.prototype.getUTCDay`. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * What a wall-clock time means on a given date in a given zone.
 *
 * Most local times denote exactly one instant. Two per year do not, and both
 * failure modes are real bugs rather than trivia:
 *
 * - `gap` — the local time does not exist. On the spring-forward date, 02:30
 *   is skipped entirely. A working window covering it is shorter that day, and
 *   a scheduler that assumed existence would place work in a slot that never
 *   occurred.
 * - `fold` — the local time occurs twice, an hour apart, on the fall-back
 *   date. A window is *longer* that day. Choosing an instant requires a stated
 *   policy, not a first-match-wins accident, because the two candidate answers
 *   differ by 3.6 million milliseconds.
 *
 * Returning this instead of a bare `Instant` forces both cases to be handled
 * where they arise. This is the primitive behind issue #29's "time-zone/DST
 * normalization" deliverable and issue #31's "DST and boundary cases are
 * included" acceptance criterion.
 */
export type LocalTimeResolution =
  | { readonly kind: 'exact'; readonly instant: Instant }
  | {
      /** The local time is skipped by a forward transition. */
      readonly kind: 'gap';
      /** The instant the local clock jumps to. The window resumes here. */
      readonly resumesAt: Instant;
    }
  | {
      /** The local time occurs twice. Both candidates are given, in order. */
      readonly kind: 'fold';
      readonly firstInstant: Instant;
      readonly secondInstant: Instant;
    };

/**
 * Which side of a fold to take when a local time is ambiguous.
 *
 * Stated in the config rather than decided per call site, so that a plan and a
 * later replay of that plan resolve the same local time the same way. `earliest`
 * is the default because it maximises the usable window: the first occurrence
 * of 01:30 is followed by a second one, so treating a window as starting at the
 * earlier instant makes the longer day genuinely longer.
 */
export type FoldPolicy = 'earliest' | 'latest';

/* ── Constraints (#29) ───────────────────────────────────────────── */

/**
 * A recurring stretch of wall-clock time the user is willing to work in.
 *
 * Wall-clock, not absolute: this is a rule about a clock face in `timezone`,
 * materialised against real dates by the normalizer. `endMinute` is exclusive
 * (rule 1), so 09:00-17:00 is `{ startMinute: 540, endMinute: 1020 }` and does
 * not include the instant 17:00.
 *
 * A window with `endMinute <= startMinute` does not wrap to the next day; it is
 * `INVALID_INTERVAL`. Overnight availability is two windows, one per weekday,
 * because a wrapping window makes "which weekday is this?" ambiguous exactly
 * when a DST transition lands inside it.
 */
export interface WorkingWindow {
  readonly windowId: string;
  readonly weekday: Weekday;
  readonly startMinute: MinuteOfDay;
  /** Exclusive. See rule 1. */
  readonly endMinute: MinuteOfDay;
  /** IANA zone name, e.g. `Asia/Jerusalem`. The window's clock face. */
  readonly timezone: string;
}

/**
 * Time that is already spoken for and cannot be moved.
 *
 * Absolute rather than wall-clock: a fixed event is a thing that happens at an
 * instant, and it stays at that instant when the offset changes around it.
 * `sourceCommitmentId` links back to Life-State's `BusyWindow` where one
 * exists, and is null for events supplied directly to a planning request.
 */
export interface FixedEvent {
  readonly eventId: string;
  readonly interval: TimeInterval;
  readonly sourceCommitmentId: string | null;
  /** Whether other work may be placed inside this event. Meetings: false. */
  readonly blocking: boolean;
}

/**
 * How long something takes.
 *
 * See rule 2. `unknown` is not "zero" and not "we will guess" — it is a state
 * the planner reports rather than resolves, because inventing a duration
 * produces a plan that looks feasible and is not.
 */
export type Effort =
  | { readonly kind: 'known'; readonly minutes: number }
  | { readonly kind: 'unknown' };

/**
 * Why one item must wait for another.
 *
 * Mirrors `DependencyKind` in `decompositionContracts` deliberately — Sprint
 * 06's steps become Sprint 07's planning items, and a scheduler that had to
 * translate between two dependency vocabularies would be the place the
 * translation is wrong. `temporal` forces ordering; `resource` and
 * `informational` are recorded but do not, on their own, force it in v1.
 */
export type PlanningDependencyKind = 'temporal' | 'resource' | 'informational';

export interface PlanningDependency {
  readonly dependsOnItemId: string;
  readonly kind: PlanningDependencyKind;
}

/**
 * One thing the planner is asked to place.
 *
 * `bufferBeforeMinutes` / `bufferAfterMinutes` are protected time *around* the
 * item, not part of its effort. Keeping them separate is what lets a plan say
 * "this took 30 minutes and needed 15 minutes of recovery" rather than
 * inflating the effort and then being unable to report either number.
 *
 * `priority` is the Sprint 04-05 priority score, higher meaning more important.
 * It orders candidates; it never overrides a hard constraint.
 */
export interface PlanningItem {
  readonly itemId: string;
  readonly title: string;
  readonly effort: Effort;
  /**
   * The **effort** may not start before this instant. Null means no lower bound.
   *
   * The effort, not the reserved span: a before-buffer may legally sit earlier
   * than this. Stated because one track checked feasibility against the reserved
   * span while placing against the effort, and so refused items it could
   * demonstrably have placed.
   */
  readonly earliestStartAt: Instant | null;
  /**
   * The **effort** must be finished by this instant, exclusive. Null means no
   * deadline.
   *
   * An after-buffer may extend past it. Recovery time is not finishing, and a
   * deadline is a statement about when the work is done.
   */
  readonly deadlineAt: Instant | null;
  readonly priority: number;
  readonly dependsOn: readonly PlanningDependency[];
  readonly bufferBeforeMinutes: number;
  readonly bufferAfterMinutes: number;
}

/**
 * The window of absolute time the planner may place work in.
 *
 * Half-open like every other interval. Nothing is scheduled outside it, and an
 * item whose deadline falls beyond `endsAt` is reported rather than dropped —
 * see `DEADLINE_BEYOND_HORIZON`.
 */
export interface PlanningHorizon {
  readonly startsAt: Instant;
  readonly endsAt: Instant;
}

/**
 * Everything the planner is given. The complete input to a planning run.
 *
 * `timezone` is the scope's default zone, used for windows that do not name
 * their own and for rendering. It does not change the meaning of any `Instant`.
 */
export interface PlanningConstraints {
  readonly scopeId: string;
  readonly timezone: string;
  readonly horizon: PlanningHorizon;
  readonly workingWindows: readonly WorkingWindow[];
  readonly fixedEvents: readonly FixedEvent[];
  readonly items: readonly PlanningItem[];
}

/**
 * Knobs that change the plan. Part of the determinism contract: issue #30's
 * "same inputs *and config* produce the same plan" means this record is an
 * input, and a plan is only reproducible when it is replayed alongside one.
 */
export interface PlanningConfig {
  /** Placement granularity. Slots start on multiples of this from the horizon. */
  readonly slotMinutes: number;
  readonly foldPolicy: FoldPolicy;
  /** Whether `resource` dependencies force ordering. False in v1. */
  readonly resourceDependenciesOrder: boolean;
}

/* ── The shared vocabulary of "why not" ──────────────────────────── */

/**
 * Why something cannot be planned.
 *
 * Read rule 3 first: three tracks implement judgements over this list and none
 * of them owns it.
 *
 * The list is partitioned. **Static** codes are decidable by looking at the
 * constraints alone, with no scheduling attempt — a contradiction is present in
 * the input. #29's validator reports exactly these, and #31's oracle
 * independently derives exactly these, which is what makes the two comparable
 * on the same input. **Attempt** codes only become true once placement has been
 * tried and lost; they describe contention, not contradiction, and only #30 can
 * emit them.
 *
 * The distinction is not stylistic. "This item was impossible from the start"
 * and "this item lost to a higher-priority item for the last free hour" are
 * different messages to a user and different bugs to an engineer, and a single
 * flat list would let a scheduler report the second when the first was true.
 *
 * "Constraints alone" means *without attempting placement*. `PlanningConfig` is
 * an input to the static judgement, not an exception to it — both #29's
 * validator and #31's oracle take one. What the partition forbids is a static
 * verdict that changes with a config flag *for a code whose meaning does not
 * mention ordering*: see the ruling under `SELF_DEPENDENCY` below, which the
 * three tracks derived three different ways before it was written down here.
 *
 * **The suppression rule.** When one finding would be derived from data another
 * finding has already condemned, only the first is reported. A judgement is
 * suppressed *if and only if it borrows a bound from something already reported
 * malformed* — no wider. An inverted horizon suppresses findings that read their
 * window from the horizon; it does not suppress a finding about an item whose
 * own `earliestStartAt` and `deadlineAt` contradict each other, because that
 * item borrows nothing. Correspondingly, two independent defects earn two codes:
 * every working window being malformed yields both `INVALID_INTERVAL` and
 * `NO_WORKING_WINDOW`, which are two true facts rather than one fact told twice.
 *
 * **Multiplicity is not contracted.** Whether three mutually-overlapping fixed
 * events yield two reasons or three, and whether two dangling edges on one item
 * yield one reason carrying a count or two reasons, is left to each
 * implementation. Only the *set* of codes is compared across tracks. What is
 * contracted is that the count stays bounded: an O(n²) enumeration of pairs is a
 * defect, because reasons travel with plans into audit records and Sprint 06
 * shipped a draft that produced 1.12 MB of `detail` before it was capped.
 *
 * Static codes:
 * - `INVALID_INTERVAL`        — an interval with `endsAt <= startsAt`, or a
 *                               working window with `endMinute <= startMinute`.
 *                               Covers the degenerate zero-length case; see
 *                               `TimeInterval`.
 *                               Also carries exactly four window defects that
 *                               are not interval defects and have no better
 *                               code in this frozen list:
 *                                 (a) `weekday` outside 0..6 or non-integral;
 *                                 (b) `startMinute` outside 0..1440, NaN, or
 *                                     non-integral;
 *                                 (c) `endMinute` likewise;
 *                                 (d) a `timezone` this runtime's IANA data
 *                                     does not know.
 *                               (b) and (c) are not implied by the rule above:
 *                               `NaN <= 540` and `1441 <= 540` are both false,
 *                               so `endMinute <= startMinute` never fires on
 *                               them, and an unguarded NaN reaches
 *                               `resolveLocalTime` and yields corrupt instants.
 *                               Licensed here rather than decided per track,
 *                               because a malformed window that is *silently
 *                               dropped* reports `NO_WORKING_WINDOW` instead —
 *                               telling the user they have no availability when
 *                               what they have is a typo. An unknown zone must
 *                               likewise be reported rather than thrown on:
 *                               a validator that raises cannot return the
 *                               finding list it exists to return.
 * - `EFFORT_UNKNOWN`          — the item's duration is unknown, so no slot can
 *                               be sized for it. Reported, never guessed.
 * - `EFFORT_NOT_POSITIVE`     — a `known` effort of zero or less.
 * - `DEADLINE_BEFORE_EARLIEST_START` — the item's own window is empty before
 *                               any other constraint is consulted.
 * - `DEADLINE_BEYOND_HORIZON` — the deadline falls at or before
 *                               `horizon.startsAt`, so the item cannot be
 *                               finished anywhere this plan reaches. Distinct
 *                               from having no time: extending the horizon
 *                               backwards would change the answer.
 *                               **One-sided, deliberately.** An earlier reading
 *                               of this line as "outside the horizon in either
 *                               direction" made a deadline *after*
 *                               `horizon.endsAt` unschedulable, which refuses
 *                               the least constrained item in a request — with
 *                               a two-week horizon it refuses most long-lead
 *                               work. When the deadline sits beyond the
 *                               horizon's end the horizon simply binds first,
 *                               and the item is placed normally.
 * - `EFFORT_EXCEEDS_ITEM_WINDOW` — effort plus buffers does not fit between
 *                               `earliestStartAt` and `deadlineAt` even if
 *                               every minute between them were free.
 * - `NO_WORKING_WINDOW`       — no working window exists at all, or none
 *                               intersects the horizon. There is nowhere legal
 *                               to put anything.
 * - `SELF_DEPENDENCY`         — an item depending on itself, **whatever the
 *                               edge's `kind`**. Takes precedence over
 *                               `CYCLIC_DEPENDENCY`, following the rule
 *                               `decompositionContracts` set: one defect earns
 *                               one code.
 * - `CYCLIC_DEPENDENCY`       — a cycle of length > 1 **in the ordering graph**:
 *                               `temporal` edges, plus `resource` edges when
 *                               `resourceDependenciesOrder` is set. A loop of
 *                               edges that force no order is not a
 *                               contradiction, and refusing it would leave a
 *                               placeable request unplanned while sending the
 *                               user to break a link that never moved anything.
 * - `UNKNOWN_DEPENDENCY`      — an edge pointing at no item in this request,
 *                               **whatever the edge's `kind`**.
 *
 *   The `kind`-independence of the two malformed-edge codes, against the
 *   `kind`-sensitivity of the cycle code, is a ruling rather than a nuance. The
 *   three tracks each derived it separately and one derived it differently, and
 *   the argument that settles it needs no reading of the prose above: filtering
 *   these two by kind makes the *same* `PlanningConstraints` produce a
 *   different **static** verdict depending on `resourceDependenciesOrder` —
 *   an edge naming a nonexistent item was reported under one flag and silently
 *   accepted under the other. A static code that moves with a config flag
 *   cannot be agreed on by a validator and an oracle that derive it from the
 *   constraints, so no change on their side could have reconciled it. A
 *   malformed edge is malformed whatever it would have meant; a cycle is a
 *   statement about order and is read against the edges that carry order.
 * - `FIXED_EVENT_CONFLICT`    — two blocking fixed events overlap each other.
 *                               A contradiction in the input, not a scheduling
 *                               outcome: the user is claimed to be in two
 *                               places at once before planning begins.
 * - `NONEXISTENT_LOCAL_TIME`  — a working window starts in a DST gap.
 * - `AMBIGUOUS_LOCAL_TIME`    — a working window starts in a DST fold and the
 *                               config does not say which side to take. With a
 *                               `foldPolicy` set this is resolved, not
 *                               reported; it exists for callers that choose to
 *                               surface the ambiguity instead.
 *
 * Attempt codes:
 * - `NO_FEASIBLE_SLOT`        — free time existed but never a contiguous run
 *                               long enough, once fixed events and
 *                               already-placed items were subtracted.
 * - `BLOCKED_BY_DEPENDENCY`   — a prerequisite went unscheduled, so this item
 *                               could not be placed either. The reason is
 *                               *transitive* and says so, rather than repeating
 *                               the prerequisite's own reason as if it were
 *                               this item's.
 * - `DEPENDENCY_TOO_LATE`     — every prerequisite was placed, but the earliest
 *                               they all finish leaves no room before this
 *                               item's deadline.
 * - `HORIZON_EXHAUSTED`       — the horizon ended before this item's turn came.
 */
export type PlanningReasonCode =
  // static
  | 'INVALID_INTERVAL'
  | 'EFFORT_UNKNOWN'
  | 'EFFORT_NOT_POSITIVE'
  | 'DEADLINE_BEFORE_EARLIEST_START'
  | 'DEADLINE_BEYOND_HORIZON'
  | 'EFFORT_EXCEEDS_ITEM_WINDOW'
  | 'NO_WORKING_WINDOW'
  | 'SELF_DEPENDENCY'
  | 'CYCLIC_DEPENDENCY'
  | 'UNKNOWN_DEPENDENCY'
  | 'FIXED_EVENT_CONFLICT'
  | 'NONEXISTENT_LOCAL_TIME'
  | 'AMBIGUOUS_LOCAL_TIME'
  // attempt
  | 'NO_FEASIBLE_SLOT'
  | 'BLOCKED_BY_DEPENDENCY'
  | 'DEPENDENCY_TOO_LATE'
  | 'HORIZON_EXHAUSTED';

/**
 * The static half of `PlanningReasonCode`, as a value.
 *
 * Exported as data because the cross-track test needs to *filter* by it at
 * runtime: #29's validator and #31's oracle are compared on the codes they both
 * claim to decide, and that comparison cannot be written against a type alone.
 * Frozen so a track cannot narrow the comparison by mutating the array it is
 * being judged against.
 */
export const STATIC_INFEASIBILITY_CODES = Object.freeze([
  'INVALID_INTERVAL',
  'EFFORT_UNKNOWN',
  'EFFORT_NOT_POSITIVE',
  'DEADLINE_BEFORE_EARLIEST_START',
  'DEADLINE_BEYOND_HORIZON',
  'EFFORT_EXCEEDS_ITEM_WINDOW',
  'NO_WORKING_WINDOW',
  'SELF_DEPENDENCY',
  'CYCLIC_DEPENDENCY',
  'UNKNOWN_DEPENDENCY',
  'FIXED_EVENT_CONFLICT',
  'NONEXISTENT_LOCAL_TIME',
  'AMBIGUOUS_LOCAL_TIME',
] as const) satisfies readonly PlanningReasonCode[];

export const ATTEMPT_INFEASIBILITY_CODES = Object.freeze([
  'NO_FEASIBLE_SLOT',
  'BLOCKED_BY_DEPENDENCY',
  'DEPENDENCY_TOO_LATE',
  'HORIZON_EXHAUSTED',
] as const) satisfies readonly PlanningReasonCode[];

export type StaticInfeasibilityCode = (typeof STATIC_INFEASIBILITY_CODES)[number];
export type AttemptInfeasibilityCode = (typeof ATTEMPT_INFEASIBILITY_CODES)[number];

/**
 * One finding. `itemId` is null for findings about the constraints as a whole
 * (a bad horizon, no working windows at all) rather than about one item.
 *
 * `detail` is for humans and never carries raw user text, matching the audit
 * policy Sprint 06 set for `DecompositionViolation.detail`.
 *
 * **"Raw user text" includes identifiers.** `windowId`, `eventId`, `itemId`,
 * `scopeId` and `sourceCommitmentId` are all chosen by whoever built the
 * request, and an id is a free string that people fill with content: one track
 * shipped details reading `working window call-dr.cohen-about-the-biopsy` and
 * `item tell-my-manager-i-am-quitting` while passing a test that checked only
 * that `title` was absent. A character-class filter does not help, because the
 * problem is not the characters.
 *
 * So a `detail` names windows and events **by position**, carries numbers
 * derived from the input (minutes, counts, local dates), and carries nothing
 * else. `itemId` is exempt only because the contract gives it its own field
 * above; it is not repeated in the prose. Reasons travel with plans into audit
 * records, which is the whole reason `rawInputInAudit` is false.
 */
export interface PlanningReason {
  readonly code: PlanningReasonCode;
  readonly itemId: string | null;
  readonly detail: string;
}

/* ── Plans (#30) ─────────────────────────────────────────────────── */

/**
 * An item placed in time.
 *
 * `interval` is the effort itself. `reservedInterval` additionally covers the
 * buffers, and is what conflict checks compare — two items whose efforts abut
 * but whose buffers overlap *do* conflict, and a plan that reported only
 * `interval` would make that unrepresentable.
 */
export interface PlannedItem {
  readonly itemId: string;
  readonly interval: TimeInterval;
  /** `interval` widened by the item's buffers. Never narrower than `interval`. */
  readonly reservedInterval: TimeInterval;
}

/** An item the planner could not place, and why. */
export interface UnscheduledItem {
  readonly itemId: string;
  readonly reason: PlanningReason;
}

/**
 * The output of a planning run.
 *
 * `inputDigest` is a hash of the constraints and config that produced it. It is
 * what makes issue #30's replay requirement checkable: a replayed plan is only
 * meaningfully "the same" if it was produced from the same inputs, and a digest
 * turns that from a claim into an assertion. It never contains user text — it
 * is a hash, and the hash is over a canonical serialisation.
 *
 * `scheduled` and `unscheduled` together cover every input item exactly once.
 * An item in neither is a planner bug that no per-item assertion would catch.
 */
export interface Plan {
  readonly version: typeof PLANNING_CONTRACT_VERSION;
  readonly schema: typeof PLANNING_SCHEMA_VERSION;
  readonly scopeId: string;
  readonly horizon: PlanningHorizon;
  readonly scheduled: readonly PlannedItem[];
  readonly unscheduled: readonly UnscheduledItem[];
  /** Findings about the constraints themselves, not attributable to one item. */
  readonly constraintReasons: readonly PlanningReason[];
  readonly inputDigest: string;
}

/**
 * The total order a plan's `scheduled` list is sorted by, and the order
 * candidates are considered in.
 *
 * Stated as data so that #30's scheduler and #31's oracle sort the same way.
 * Applied in sequence, each key breaking the previous key's ties; the final key
 * is `itemId`, which is unique, so the order is total and no implementation
 * detail (map iteration, input array order, sort stability) can leak into it.
 *
 * `-priority` sorts higher priority first. `earliestDeadline` puts an item with
 * a deadline before one without.
 */
export const PLAN_ORDERING_KEYS = Object.freeze([
  'startsAt',
  '-priority',
  'earliestDeadline',
  'itemId',
] as const);

/* ── Plan diff (#30) ─────────────────────────────────────────────── */

/**
 * How one item's placement changed between two plans.
 *
 * `moved` carries both intervals because "it moved" without saying where is not
 * actionable, and the churn metric in issue #31 measures *how far*, which needs
 * both ends.
 */
export type PlanItemChange =
  | { readonly kind: 'added'; readonly itemId: string; readonly to: TimeInterval }
  | { readonly kind: 'removed'; readonly itemId: string; readonly from: TimeInterval }
  | {
      readonly kind: 'moved';
      readonly itemId: string;
      readonly from: TimeInterval;
      readonly to: TimeInterval;
      readonly shiftMinutes: number;
    }
  | { readonly kind: 'unchanged'; readonly itemId: string; readonly at: TimeInterval }
  /** Was unscheduled, still unscheduled — but for a different stated reason. */
  | {
      readonly kind: 'reason_changed';
      readonly itemId: string;
      readonly from: PlanningReasonCode;
      readonly to: PlanningReasonCode;
    };

export interface PlanDiff {
  readonly changes: readonly PlanItemChange[];
  /** True when both plans were produced from identical inputs. */
  readonly sameInputDigest: boolean;
}

/* ── Scenarios and the oracle (#31) ──────────────────────────────── */

/**
 * What a scenario is testing. Named rather than free-text so the corpus can be
 * required to cover each kind — a suite with no DST scenario should fail to
 * assemble, not quietly pass.
 */
export type PlanningScenarioKind =
  | 'feasible'
  | 'overload'
  | 'conflict'
  | 'dependency'
  | 'dst'
  | 'boundary'
  | 'multilingual'
  | 'change';

/**
 * Whether a scenario may inform tuning.
 *
 * Issue #31's "locked cases never enter tuning" acceptance criterion. Carried
 * in the data rather than implied by which file a row sits in, for the reason
 * Sprint 05 gave: a corpus that has to be *trusted* to be described correctly
 * will eventually be described incorrectly.
 */
export type ScenarioLockState = 'locked' | 'tunable';

/**
 * What a scenario asserts about its own outcome.
 *
 * Every field is machine-checkable — issue #31's third acceptance criterion.
 * There is deliberately no free-text "expected behaviour" field: a claim a test
 * cannot evaluate is documentation, and documentation that looks like an
 * assertion is worse than none.
 *
 * `expectedScheduledItemIds` is a set, not an order: the plan's ordering is
 * pinned separately by `PLAN_ORDERING_KEYS`, and duplicating it here would give
 * two sources of truth for the same property.
 */
export interface ScenarioExpectation {
  readonly expectedScheduledItemIds: readonly string[];
  /** Item id → the reason code it must be unscheduled for. */
  readonly expectedUnscheduledReasons: Readonly<Record<string, PlanningReasonCode>>;
  /** Constraint-level codes the scenario must produce, as a set. */
  readonly expectedConstraintCodes: readonly PlanningReasonCode[];
}

export interface PlanningScenario {
  readonly scenarioId: string;
  readonly kind: PlanningScenarioKind;
  readonly lockState: ScenarioLockState;
  readonly locale: string;
  readonly constraints: PlanningConstraints;
  readonly config: PlanningConfig;
  readonly expectation: ScenarioExpectation;
  /** Why this case exists — especially why an expected failure is correct. */
  readonly note: string;
}

/**
 * The oracle's verdict on a set of constraints, computed independently of the
 * scheduler.
 *
 * This is the second reading described in rule 3. It answers only the static
 * question — is this input self-contradictory — because that is the only
 * question answerable without reimplementing the scheduler, and an "oracle"
 * that reimplemented the scheduler would be comparing a thing with itself.
 */
export interface FeasibilityVerdict {
  readonly feasible: boolean;
  /** Static codes only. See `STATIC_INFEASIBILITY_CODES`. */
  readonly reasons: readonly PlanningReason[];
  /**
   * Total minutes of working time inside the horizon, after subtracting
   * blocking fixed events. The capacity side of an overload judgement.
   */
  readonly availableMinutes: number;
  /** Total effort plus buffers over items with known effort. */
  readonly demandMinutes: number;
}

/**
 * Quality metrics over a plan. Issue #31's third deliverable.
 *
 * `churnMinutes` is defined against a *previous* plan and is zero when there is
 * none — not null, because a metric that is sometimes absent forces every
 * consumer to branch, and "nothing moved" is the honest reading of a first run.
 */
export interface PlanQualityMetrics {
  readonly scheduledCount: number;
  readonly unscheduledCount: number;
  /** Scheduled count over total item count; 1 when there are no items. */
  readonly placementRate: number;
  /** Sum of absolute shifts, in minutes, against a previous plan. */
  readonly churnMinutes: number;
  /** Unscheduled counts per reason code, for the codes that occurred. */
  readonly unscheduledByReason: Readonly<Partial<Record<PlanningReasonCode, number>>>;
  /** Working minutes used over working minutes available; 0 when none. */
  readonly utilization: number;
}

/* ── Policy ──────────────────────────────────────────────────────── */

export const PLANNING_PERSISTENCE_POLICY = Object.freeze({
  /** A plan is a proposal about time. It is never canonical user state. */
  planCanPersist: false,
  confirmationRequired: true,
  adapterOwnsCanonicalWrites: true,
  rawInputInAudit: false,
  /** Planning never edits the commitments it schedules. */
  originalCommitmentRemainsCanonical: true,
  /** The planner reads a clock only through an explicit `now`/horizon input. */
  noAmbientClock: true,
});
