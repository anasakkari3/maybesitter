/**
 * Life-State projection contracts (Sprint 02, issue #9).
 *
 * LifeState is a deterministic read model over DomainState covering commitments,
 * availability, load, and recent outcomes. It is produced by a pure function:
 * identical input yields byte-identical output, so a projection can be replayed
 * and compared against a recorded digest.
 *
 * Two invariants shape this contract:
 *
 *  1. Unknown is a first-class value. Every projected field is a Field<T>, so
 *     "zero open commitments" (known, value 0) can never be confused with
 *     "nothing to project from" (unknown, NO_DATA).
 *
 *  2. No model-generated value becomes canonical state. The projection reads
 *     DomainState — itself writable only through the deterministic command path
 *     — and writes nothing.
 */

import type { AckState, CommitmentStatus, DomainState } from '../../domain/stateMachine';

export const LIFE_STATE_SCHEMA_VERSION = 'life-state-v1' as const;

/** Default lookback for recentOutcomes, in days. */
export const DEFAULT_RECENT_OUTCOMES_WINDOW_DAYS = 14;

/* ── Unknown-aware field wrapper ─────────────────────────────────── */

export type UnknownReason =
  /** Nothing in DomainState to derive this field from. */
  | 'NO_DATA'
  /** Data exists but is below the threshold that makes the field meaningful. */
  | 'INSUFFICIENT_DATA'
  /** Deliberately deferred to a later sprint. */
  | 'NOT_IMPLEMENTED';

export interface FieldProvenance {
  readonly source: 'domain_state' | 'deterministic_rule' | 'absent';
  /** ISO timestamp of the newest input that contributed to this field. */
  readonly derivedFrom: string | null;
  /** ISO timestamp of the projection run that produced this field. */
  readonly computedAt: string;
}

export interface KnownField<T> {
  readonly known: true;
  readonly value: T;
  readonly provenance: FieldProvenance;
}

export interface UnknownField {
  readonly known: false;
  readonly reason: UnknownReason;
  readonly provenance: FieldProvenance;
}

/**
 * Every projected field carries freshness and source metadata, and distinguishes
 * "known to be empty/false/zero" from "not known".
 */
export type Field<T> = KnownField<T> | UnknownField;

/* ── Projected views ─────────────────────────────────────────────── */

export interface CommitmentsView {
  /** Count per DomainState commitment status. Absent statuses are omitted. */
  readonly countsByStatus: Readonly<Partial<Record<CommitmentStatus, number>>>;
  readonly openCount: number;
  readonly overdueCount: number;
  readonly openCommitmentIds: readonly string[];
  readonly overdueCommitmentIds: readonly string[];
}

/**
 * A window during which the user has a known commitment.
 *
 * Availability models busy time only. The absence of a busy window means "no
 * known commitment", never "free" — there is no inbound calendar source, so
 * free time cannot be asserted.
 */
export interface BusyWindow {
  readonly commitmentId: string;
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly timezone: string;
  /** scheduled_event carries a real start; due_by is a deadline, not an appointment. */
  readonly kind: 'due_by' | 'scheduled_event';
}

export interface AvailabilityView {
  readonly busyWindows: readonly BusyWindow[];
  /** Commitments with no scheduled or due time, which cannot constrain availability. */
  readonly unscheduledCommitmentCount: number;
}

export interface LoadView {
  /** Sum of agenda urgency scores over open commitments. */
  readonly totalUrgencyScore: number;
  readonly openCount: number;
  readonly overdueCount: number;
  readonly dueSoonCount: number;
  /**
   * Banding on `openCount` alone, via LOAD_BAND_THRESHOLDS. The other counts
   * are reported for consumers to weigh but deliberately do not move the band,
   * so the formula stays exactly the exported thresholds.
   */
  readonly band: LoadBand;
}

export type LoadBand = 'light' | 'moderate' | 'heavy' | 'overloaded';

export interface RecentOutcomesView {
  readonly windowDays: number;
  readonly windowStart: string;
  readonly completedCount: number;
  readonly postponedCount: number;
  readonly ignoredCount: number;
  readonly droppedCount: number;
  /** Count per terminal ack state observed inside the window. */
  readonly countsByAckState: Readonly<Partial<Record<AckState, number>>>;
}

/* ── The projection ──────────────────────────────────────────────── */

export interface LifeState {
  readonly version: typeof LIFE_STATE_SCHEMA_VERSION;
  readonly scopeId: string;
  /** Taken from LifeStateInput.now; the projection never reads the system clock. */
  readonly computedAt: string;
  /** sha256 over the canonicalized input, so a replay can prove input equality. */
  readonly inputDigest: string;
  readonly commitments: Field<CommitmentsView>;
  readonly availability: Field<AvailabilityView>;
  readonly load: Field<LoadView>;
  readonly recentOutcomes: Field<RecentOutcomesView>;
}

export interface LifeStateInput {
  readonly state: DomainState;
  /** ISO timestamp treated as "now". Required, so the projection stays pure. */
  readonly now: string;
  readonly scopeId: string;
  /** recentOutcomes lookback; defaults to DEFAULT_RECENT_OUTCOMES_WINDOW_DAYS. */
  readonly windowDays?: number;
}

/**
 * Load banding thresholds on open commitment count. Frozen and exported so the
 * formula is inspectable and versioned with the schema rather than hidden in
 * the implementation.
 */
export const LOAD_BAND_THRESHOLDS = Object.freeze({
  light: 2,
  moderate: 5,
  heavy: 9,
});

/**
 * Statuses that count as "open" for commitments, availability, and load.
 *
 * `missed` is open, not terminal. The state machine still accepts Complete,
 * Postpone, and MarkAware on a missed commitment, and canEscalate() explicitly
 * includes it — a missed commitment is live work the system is still pressing
 * on. Treating it as finished would understate load for exactly the users
 * carrying the most overdue work.
 */
export const OPEN_COMMITMENT_STATUSES: readonly CommitmentStatus[] = Object.freeze([
  'draft',
  'needs_clarification',
  'pending_confirmation',
  'active',
  'deferred',
  'missed',
]);

/**
 * Statuses that represent a finished commitment, used by recentOutcomes.
 *
 * Deliberately excludes `missed`: missing a deadline is a behavioral signal,
 * but the work is not finished. It is reported through the open counts and
 * through ack states rather than as a completed outcome.
 */
export const TERMINAL_COMMITMENT_STATUSES: readonly CommitmentStatus[] = Object.freeze([
  'completed',
  'dropped',
  'archived',
]);
