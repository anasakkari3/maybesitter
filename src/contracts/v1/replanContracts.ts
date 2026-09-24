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
import type { Plan, PlanDiff, PlannedItem, PlanningHorizon, TimeInterval } from './planningContracts';
import type { UserPlanStatus } from './userStateProjectionContracts';
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
  /**
   * The account turned continuous replanning off (#523, AC 9).
   *
   * Not produced by `evaluateStateChangeImpact`, which is pure and reads no
   * settings: it is the reason the *service* records when it short-circuits
   * before the pipeline. It lives in this vocabulary rather than reusing
   * `digests_unchanged` because the pair `(changeId, reason)` is an audit
   * record, and "the digests matched" would be a false statement about a
   * change nobody looked at.
   */
  'continuous_replan_disabled',
  /**
   * The person dismissed the day's plan (#610).
   *
   * Service-only, like `continuous_replan_disabled`: a dismissed plan is never
   * replanned or patched, so the service stops before the pipeline and records
   * this rather than a verdict nobody reached.
   */
  'plan_dismissed',
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

/* ── Continuous replanning pipeline & user control (#523, slice 2) ─ */

/**
 * How the user controls replan applications.
 *
 *  - `automatic_time_only`: Default. Time-only shifts within acceptable churn
 *    threshold are applied automatically; additions, dropped items, or excessive
 *    churn require explicit confirmation (staged as a proposal).
 *  - `always_require_confirmation`: Every replan requires user confirmation;
 *    staged as a proposal and never auto-applied.
 *  - `silent_auto`: Applies replans autonomously regardless of churn magnitude,
 *    as long as constraints are feasible.
 */
export const USER_CONTROL_MODES = Object.freeze([
  'automatic_time_only',
  'always_require_confirmation',
  'silent_auto',
] as const);

export type UserControlMode = (typeof USER_CONTROL_MODES)[number];

/** What the policy layer decides should happen to a solved replan. */
export const REPLAN_POLICY_ACTIONS = Object.freeze([
  /** The new plan is applied directly to the active plan. */
  'auto_apply',
  /** Staged as a proposal for the user to review. */
  'propose_for_review',
  /** The diff contains no meaningful changes; discarded as a no-op. */
  'discard',
] as const);

export type ReplanPolicyAction = (typeof REPLAN_POLICY_ACTIONS)[number];

/** Machine-readable reason code for why the policy made its decision. */
export const REPLAN_POLICY_REASONS = Object.freeze([
  'no_changes',
  'time_shift_within_threshold',
  'contains_removals',
  'contains_additions',
  'churn_exceeded_threshold',
  'user_requires_confirmation',
  'plan_stale_only',
  'infeasible_plan',
] as const);

export type ReplanPolicyReason = (typeof REPLAN_POLICY_REASONS)[number];

export interface ReplanPolicyConfig {
  readonly userControlMode: UserControlMode;
  /** Maximum churn in minutes allowed for automatic time-only replans. Default: 60 minutes. */
  readonly maxAutoChurnMinutes?: number;
  /** Whether a PLAN_STALE decision triggers a replan or only flags the plan. Default: false. */
  readonly replanOnStale?: boolean;
}

export interface ReplanPolicyDecision {
  readonly action: ReplanPolicyAction;
  readonly reason: ReplanPolicyReason;
  readonly userControlMode: UserControlMode;
  readonly diff: PlanDiff;
}

/* ── Deduped replan queue ────────────────────────────────────────── */

export const REPLAN_REQUEST_STATUSES = Object.freeze([
  'enqueued',
  'in_progress',
  'completed',
  'failed',
  'superseded',
] as const);

export type ReplanRequestStatus = (typeof REPLAN_REQUEST_STATUSES)[number];

export const REPLAN_TRIGGERS = Object.freeze([
  'event_impact',
  'watcher',
  'manual',
  'stale_refresh',
] as const);

export type ReplanTrigger = (typeof REPLAN_TRIGGERS)[number];

export interface ReplanRequest {
  readonly requestId: string;
  readonly scopeId: string;
  readonly date: string;
  readonly trigger: ReplanTrigger;
  readonly causeChangeIds: readonly string[];
  readonly enqueuedAt: string;
  readonly priority: 'immediate' | 'background';
  readonly status: ReplanRequestStatus;
  readonly baseGeneration?: number;
}

export interface ReplanQueueEntry {
  readonly request: ReplanRequest;
  readonly deduplicatedCount: number;
}

/* ── Continuous replanning pipeline result ───────────────────────── */

export interface ContinuousReplanPipelineResult {
  readonly scopeId: string;
  readonly date: string;
  readonly impact: PlanImpact;
  readonly enqueued: boolean;
  readonly queueEntry: ReplanQueueEntry | null;
  /**
   * The change ids whose *own* impact required this replan (#527, AC 2).
   *
   * `queueEntry.request.causeChangeIds` is every id in the batch, because the
   * queue's job is to record what one replan request subsumes — two watchers
   * firing in one sweep are one request whatever each of them did. That is the
   * right answer for a queue and the wrong answer for attribution: a stored
   * plan that named a monitor whose change was evaluated `NO_EFFECT` would
   * tell the user a monitor moved their day when it did not.
   *
   * So this is the narrower set: the members of every coalesced group whose
   * impact decision equals the decision that got past the branch — all of the
   * group's ids, not just its representative, because a burst's members are
   * one underlying event and each carries its own firing. Empty whenever no
   * replan ran. Additive and derived; it changes nothing the queue, the
   * planner closure or the policy layer sees.
   */
  readonly impactingChangeIds: readonly string[];
  readonly basePlan: Plan | null;
  readonly newPlan: Plan | null;
  readonly diff: PlanDiff | null;
  readonly policyDecision: ReplanPolicyDecision | null;
  readonly planStatus: UserPlanStatus;
}

export const CONTINUOUS_REPLAN_POLICY = Object.freeze({
  defaultUserControlMode: 'automatic_time_only' as UserControlMode,
  defaultMaxAutoChurnMinutes: 60,
  mutatesCommitments: false,
  providerSpecificBranchesAllowed: false,
  replanOnStaleDefault: false,
});

