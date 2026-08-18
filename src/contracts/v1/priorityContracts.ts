/**
 * Priority Engine contracts (Sprint 04, issues #17, #18, #19).
 *
 * Ranking that can explain itself: a feature vector traceable to source state,
 * and a score whose breakdown reconciles numerically with its own total.
 *
 * Two properties carry the weight here.
 *
 *  1. The breakdown *is* the computation. `total` is the sum of the components
 *     emitted, not a figure computed separately that the components try to
 *     account for afterwards. An explanation assembled alongside a total it did
 *     not produce can drift from it silently; one that is the total cannot.
 *
 *  2. Unknown is not zero. `Commitment` carries no dependency and no effort
 *     field, so those features are absent rather than low. Scoring them as zero
 *     would invent a signal and rank a commitment as if we had measured
 *     something we never had.
 */

import type { Field } from './lifeStateContracts';

export const PRIORITY_SCHEMA_VERSION = 'priority-v1' as const;

/* ── Features (#17) ──────────────────────────────────────────────── */

/**
 * Names the state a feature was derived from, so "each feature traces to
 * source state" is a property of the data rather than a claim in a comment.
 */
export interface FeatureEvidence {
  /** e.g. 'commitment.timeSpec.dueAt', 'reminder:rem_123', 'feedback:window14d'. */
  readonly source: string;
  /** ISO timestamp of the newest input that contributed, or null if none did. */
  readonly observedAt: string | null;
}

export interface FeatureValue<T> {
  readonly value: T;
  readonly evidence: readonly FeatureEvidence[];
}

/**
 * A feature is unknown-aware for the same reason LifeState fields are: a
 * feature that is absent must not be readable as a measured low value.
 */
export type PriorityFeature<T> = Field<FeatureValue<T>>;

export interface UrgencyFeature {
  /** Hours past the deadline, or 0 when not overdue. */
  readonly hoursOverdue: number;
  /** 0..1 closeness within the due-soon window; 0 when outside it. */
  readonly dueSoonCloseness: number;
}

export interface ImportanceFeature {
  readonly level: 'low' | 'normal' | 'high';
  /** True when the user set the level themselves rather than it being inferred. */
  readonly userSet: boolean;
}

export interface LatenessFeature {
  readonly snoozedCount: number;
  readonly postponed: boolean;
  readonly deferred: boolean;
}

export interface UserPressureFeature {
  readonly ignoredCount: number;
  /** True when the most recent ignore falls inside the recency window. */
  readonly ignoredRecently: boolean;
}

/**
 * `dependency` and `effort` are typed `PriorityFeature<never>` deliberately:
 * `never` admits no value, so the type itself permits only the unknown variant
 * and a future contributor cannot quietly start populating them without
 * changing the contract first.
 */
export interface PriorityFeatures {
  readonly version: typeof PRIORITY_SCHEMA_VERSION;
  readonly commitmentId: string;
  /** Taken from the caller's `now`; extraction never reads the system clock. */
  readonly computedAt: string;
  readonly urgency: PriorityFeature<UrgencyFeature>;
  readonly importance: PriorityFeature<ImportanceFeature>;
  readonly lateness: PriorityFeature<LatenessFeature>;
  readonly userPressure: PriorityFeature<UserPressureFeature>;
  /** No source state exists on Commitment. Always unknown in v1. */
  readonly dependency: PriorityFeature<never>;
  /** No source state exists on Commitment. Always unknown in v1. */
  readonly effort: PriorityFeature<never>;
}

/* ── Scoring (#18) ───────────────────────────────────────────────── */

/**
 * The band a commitment sits in, selected by its situation rather than
 * extracted from it — which is why it is a score component and not a feature.
 */
export type PriorityReason = 'overdue' | 'due_soon' | 'active' | 'pending';

export type ScoreComponentCode =
  | 'reason_base'
  | 'urgency'
  | 'importance'
  | 'lateness'
  | 'user_pressure'
  /**
   * The band cap, emitted as a negative adjustment when it binds.
   *
   * The four band components can reach 1350 against a cap of 999, and the cap
   * binds precisely on the most overdue, highest-priority, most-delayed items —
   * exactly where a user most needs the explanation to be true. Without this
   * term the breakdown would over-report by up to 351 points on those items.
   */
  | 'band_clamp'
  /** The total cap, same reasoning. */
  | 'total_clamp';

export interface ScoreComponent {
  readonly code: ScoreComponentCode;
  /** Signed. Clamp components are negative when they bind, zero otherwise. */
  readonly points: number;
  /** Which feature or rule produced this, or null for structural terms. */
  readonly evidence: string | null;
}

export type ReasonCode =
  | 'OVERDUE'
  | 'DUE_SOON'
  | 'HIGH_IMPORTANCE'
  | 'REPEATEDLY_DELAYED'
  | 'RECENTLY_IGNORED'
  | 'BAND_CAPPED'
  /** A hard constraint moved this item, overriding its computed position. */
  | 'HARD_CONSTRAINT_APPLIED';

export interface PriorityScore {
  readonly version: typeof PRIORITY_SCHEMA_VERSION;
  readonly commitmentId: string;
  /**
   * Invariant: equals the sum of `components[].points`, including when either
   * clamp binds. This is testable arithmetic, not a convention.
   */
  readonly total: number;
  readonly components: readonly ScoreComponent[];
  readonly reasonCodes: readonly ReasonCode[];
  /** Travels with the score so a stored ranking says which policy produced it. */
  readonly policyVersion: string;
}

/* ── Policy (#18) ────────────────────────────────────────────────── */

/**
 * Weights and caps as data rather than literals, so a policy change is a
 * config change with a version rather than an edit to the scorer.
 */
export interface PriorityPolicy {
  readonly version: string;
  readonly reasonBase: Readonly<Record<PriorityReason, number>>;
  readonly bandCap: number;
  readonly totalCap: number;
  readonly weights: {
    readonly urgencyOverduePerHour: number;
    readonly urgencyOverdueMax: number;
    readonly urgencyDueSoonMax: number;
    readonly importanceHigh: number;
    readonly importanceNormal: number;
    readonly latenessPerSnooze: number;
    readonly latenessSnoozeMax: number;
    readonly latenessPostponed: number;
    readonly latenessDeferred: number;
    readonly userPressureRecent: number;
    readonly userPressureStale: number;
  };
}

export interface ScorePriorityInput {
  readonly features: PriorityFeatures;
  readonly reason: PriorityReason;
  readonly policy: PriorityPolicy;
}

/**
 * Ranking input. `now` is explicit so ranking is reproducible, and ties break
 * on `commitmentId` by code-unit comparison — never `localeCompare`, whose
 * result depends on the host's locale.
 */
export interface RankPrioritiesInput {
  readonly scored: readonly PriorityScore[];
}

/* ── Evaluation (#19) ────────────────────────────────────────────── */

export type JudgmentVerdict = 'left' | 'right' | 'tie' | 'unresolved';

/**
 * One reviewed comparison. `unresolved` is a first-class verdict: a genuinely
 * ambiguous pair must be recordable as ambiguous rather than forced into a
 * preference that was never held.
 */
export interface PairwiseJudgment {
  readonly pairId: string;
  readonly leftCommitmentId: string;
  readonly rightCommitmentId: string;
  readonly verdict: JudgmentVerdict;
  readonly annotatorId: string;
  readonly rationale: string;
  readonly judgedAt: string;
}

export interface AgreementReport {
  readonly version: typeof PRIORITY_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly pairCount: number;
  readonly annotatorCount: number;
  /** Null when there are too few judgments to compute one honestly. */
  readonly observedAgreement: number | null;
  readonly unresolvedCount: number;
  readonly disagreements: readonly string[];
  /**
   * True when no judgments have been supplied. Sprint 04 ships the ingestion
   * point empty and wired; a report over an empty corpus must say so rather
   * than presenting zeros as if they were measurements.
   */
  readonly corpusEmpty: boolean;
}
