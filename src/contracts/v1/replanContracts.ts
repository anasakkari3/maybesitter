/**
 * Event-driven replanning contracts (#523, slice 1): the impact decision.
 *
 * The watcher work (#525/#527) already ships the *entry* of the pipeline —
 * `PlanningStateChange`, the normalized, content-free statement that something
 * in a scope changed. This file contracts the next step and only the next
 * step: reading one such change against the current plan and answering,
 * deterministically, whether the plan can possibly be affected. Enqueueing a
 * deduped replan request, running the canonical scheduler, diffing the result
 * (`PlanDiff` already exists for that) and deciding between a proposed patch
 * and an automatic time-only replan are the deliberate follow-up slices; no
 * type here names a queue, a scheduler call, or a user-control mode.
 *
 * ── The evaluator judges the change, not the world ─────────────────
 *
 * `evaluateStateChangeImpact` answers "does *this change* move a planner
 * input". It does not re-derive the plan's validity from scratch: a conflict
 * that already existed was reported by the change that created it, and a
 * metadata edit that happens to describe an already-conflicting event is still
 * a metadata edit. That is what makes "calendar description changed but the
 * interval didn't" a `NO_EFFECT` even when the event sits on top of a block —
 * the alternative is an evaluator that re-fires yesterday's conflict on every
 * keystroke, which is the burst problem restated.
 *
 * ── Digests are over normalized planner-facing state ───────────────
 *
 * The readiness example ("payload updated but the normalized band didn't
 * change → NO_EFFECT") only works if `beforeDigest`/`afterDigest` hash the
 * *normalized* planner input, not the provider payload. Producers already
 * uphold this: the watcher engine digests normalized observed state, and a
 * provider adapter emitting a change digests its normalized projection. The
 * evaluator therefore treats equal digests as "nothing the planner reads has
 * moved" without knowing which provider or payload sits behind them — the
 * issue's "no provider-specific planner branches" criterion, kept as the
 * absence of a branch rather than as a rule anyone has to remember.
 *
 * ── Unknown fields are planner-relevant ────────────────────────────
 *
 * `changedFields` is a normalized vocabulary, not provider field names. A
 * change whose every field is in `NON_PLANNING_CHANGE_FIELDS` cannot move a
 * planner input and is `NO_EFFECT` — the "non-planning metadata triggers zero
 * planner calls" criterion. A field in *neither* vocabulary falls through to
 * the conservative answer, because dismissing a field nobody recognised is
 * exactly how a real change gets silenced by a stale allow-list.
 */

import { MODULE_CONTRACT_VERSION } from './moduleContracts';
import type { PlannedItem, PlanningHorizon, TimeInterval } from './planningContracts';
import type { PlanningStateChange } from './watcherContracts';

export const REPLAN_CONTRACT_VERSION = MODULE_CONTRACT_VERSION;

/* ── The decision ────────────────────────────────────────────────── */

/**
 * What the evaluator answers, in the issue's own words.
 *
 * The tiers are ordered by what the pipeline may do with them:
 *
 *  - `NO_EFFECT` — the change cannot affect the current plan. Nothing is
 *    marked, nothing is queued, and no planner call exists to make.
 *  - `PLAN_STALE` — a planner input moved, but no scheduled placement is
 *    directly contradicted: freed capacity, a deadline that shifted, a
 *    readiness band that changed, a blocking event that overlaps nothing.
 *    The plan is still *valid*; it no longer reflects current inputs.
 *  - `REPLAN_REQUIRED` — the change directly invalidates a placement the
 *    current plan makes (a blocking event now overlaps a scheduled block's
 *    reserved interval). Only this tier ever justifies a replan request.
 */
export const PLAN_IMPACT_DECISIONS = Object.freeze([
  'NO_EFFECT',
  'PLAN_STALE',
  'REPLAN_REQUIRED',
] as const);

export type PlanImpactDecision = (typeof PLAN_IMPACT_DECISIONS)[number];

/**
 * Why the evaluator answered what it answered, as a code.
 *
 * Codes, not prose: the decision travels with the change id into the audit
 * trail (the issue's "replan reason is auditable" criterion), and a code can
 * be counted and asserted where a sentence cannot. The pipeline follow-up
 * stamps the wall-clock time; the evaluator itself reads no clock.
 */
export const PLAN_IMPACT_REASONS = Object.freeze([
  /** `beforeDigest` equals `afterDigest`: the normalized planner input did not move. */
  'digests_unchanged',
  /** Every declared field is known non-planning metadata. */
  'non_planning_fields_only',
  /** There is no current plan in the change's scope for anything to affect. */
  'no_current_plan',
  /** The change names a different scope than the plan being evaluated. */
  'different_scope',
  /** The entity's interval lies entirely outside the plan's horizon. */
  'outside_horizon',
  /** A blocking interval overlaps a scheduled block's reserved interval. */
  'overlaps_scheduled_block',
  /** A planner input moved and no rule above could clear it. */
  'planner_input_changed',
] as const);

export type PlanImpactReason = (typeof PLAN_IMPACT_REASONS)[number];

/** One change, evaluated. The pair `(changeId, reason)` is the audit record. */
export interface PlanImpact {
  readonly changeId: string;
  readonly scopeId: string;
  readonly decision: PlanImpactDecision;
  readonly reason: PlanImpactReason;
}

/* ── What the evaluator reads ────────────────────────────────────── */

/**
 * The current plan, reduced to what an impact judgement reads.
 *
 * `scheduled` carries the solver's `PlannedItem`s because the conflict check
 * compares **reserved** intervals — effort plus buffers — which is the same
 * convention the scheduler's own conflict checks use. A view that carried only
 * effort intervals would clear a change that lands inside a buffer, and a
 * replanning pipeline that misses buffer collisions reintroduces the exact
 * bug `reservedInterval` was added to make representable.
 */
export interface PlanImpactView {
  readonly scopeId: string;
  readonly horizon: PlanningHorizon;
  readonly scheduled: readonly PlannedItem[];
}

/**
 * The planner-relevant facts of the changed entity *after* the change,
 * normalized by the producer.
 *
 * Time-occupying sources (calendar, a timed commitment, an external task with
 * a slot) supply this; sources whose effect is not a span of time (readiness,
 * a habit policy, a watcher firing) pass null and are judged on digests and
 * fields alone. `interval: null` means the entity occupies no time now — a
 * cancellation or a deletion — which frees capacity rather than contradicting
 * a placement.
 *
 * Instants and a boolean only: the content-free rule of
 * `PlanningStateChange` holds here too, because a provider payload has no
 * field that survives projection into these two.
 */
export interface ChangedEntityFacts {
  readonly interval: TimeInterval | null;
  readonly blocking: boolean;
}

/* ── The field vocabularies ──────────────────────────────────────── */

/**
 * Normalized field names that never move a planner input.
 *
 * A change declaring only these is `NO_EFFECT` without the plan being
 * consulted beyond existence. The list is deliberately short and deliberately
 * frozen: every entry is a display or bookkeeping property, and a producer
 * that names a new one here is asserting the same about it.
 */
export const NON_PLANNING_CHANGE_FIELDS = Object.freeze([
  'title',
  'description',
  'location',
  'attendees',
  'notes',
  'color',
  'url',
  'etag',
] as const);

/**
 * The normalized fields that move planner inputs, as data.
 *
 * Not consulted by the evaluator — an unlisted field is already treated as
 * relevant by falling through — but exported so producers and auditors share
 * one vocabulary rather than each keeping a private copy. `digest` is listed
 * because it is what a `replan_if_impacted` watcher declares; it is relevant
 * by construction, since the watcher fired on a real transition.
 */
export const PLANNER_INPUT_CHANGE_FIELDS = Object.freeze([
  'interval',
  'startsAt',
  'endsAt',
  'blocking',
  'status',
  'cancelled',
  'deadlineAt',
  'earliestStartAt',
  'effort',
  'durationMinutes',
  'priority',
  'dependsOn',
  'protection',
  'band',
  'readinessBand',
  'normalizedSignals',
  'policy',
  'flexibility',
  'digest',
] as const);

/* ── Burst handling ──────────────────────────────────────────────── */

/**
 * The default window a burst coalesces within: one minute.
 *
 * One provider refresh fans out into a handful of change notifications that
 * land within seconds of each other; the watcher sweep ticks per minute. A
 * minute covers the first and cannot merge two genuinely separate edits a
 * person makes apart. The window is anchored at a group's first change, not
 * its latest — a sliding anchor would let a steady drip of notifications
 * coalesce forever, and "bounded" is the word the issue uses.
 */
export const REPLAN_BURST_WINDOW_MS = 60_000;

/**
 * One deduplicated, coalesced burst member. `representative` is the latest
 * change of the group — the one carrying the newest state digest — and the
 * only one the pipeline evaluates.
 */
export interface CoalescedStateChange {
  readonly representative: PlanningStateChange;
  /** How many changes this group absorbed, including the representative. */
  readonly coalescedCount: number;
  readonly changeIds: readonly string[];
  readonly firstOccurredAt: string;
  readonly lastOccurredAt: string;
}

/* ── Policy ──────────────────────────────────────────────────────── */

export const REPLAN_EVALUATOR_POLICY = Object.freeze({
  /** The evaluator branches on normalized fields and digests, never on a provider. */
  providerSpecificBranchesAllowed: false,
  /** Evaluation is a judgement; scheduling belongs to the follow-up pipeline. */
  evaluatorCallsPlanner: false,
  /** Neither the evaluator nor coalescing ever touches canonical Commitments. */
  mutatesCommitments: false,
  /** Every instant arrives as input; `occurredAt` values are compared, never read off a clock. */
  ambientClockAllowed: false,
});
