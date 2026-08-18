/**
 * Behavioural feedback contracts (Sprint 03, issues #13, #14, #15).
 *
 * An append-only log of what the user did with what we proposed, the
 * deterministic aggregates derived from it, and the user's ability to correct
 * the record.
 *
 * Three distinctions carry the weight here, and each exists because collapsing
 * it would misrepresent the user:
 *
 *  1. `undo` versus revocation. `undo` is a behaviour the user performed — they
 *     reversed a real action, and that is itself an outcome worth learning
 *     from. Revocation is the user correcting *our record of them*: "you
 *     misread me, do not learn from this." Recording a revocation as an `undo`
 *     event would turn the user's correction of our mistake into another
 *     behaviour we learn from.
 *
 *  2. `occurredAt` versus `recordedAt`. Aggregation windows key off when the
 *     behaviour happened, never when we managed to store it, so an event that
 *     arrives late still lands in the window it belongs to.
 *
 *  3. Events versus the migration baseline. The legacy counters this sprint
 *     inherits carry no per-event timestamps, so they can contribute to
 *     lifetime totals but can never be placed in a time window. That is stated
 *     in the data itself, not only in prose.
 */

export const FEEDBACK_EVENT_SCHEMA_VERSION = 'feedback-event-v1' as const;

/**
 * Default aggregation window, in days. Deliberately equal to
 * DEFAULT_RECENT_OUTCOMES_WINDOW_DAYS from the LifeState contract: the two
 * windows describe the same span of a user's recent behaviour, and a reader
 * comparing them should see one number, not two that happen to match.
 */
export const DEFAULT_FEEDBACK_WINDOW_DAYS = 14;

/* ── Events ──────────────────────────────────────────────────────── */

export type FeedbackOutcome =
  | 'accept'
  | 'edit'
  | 'reject'
  | 'defer'
  | 'complete'
  | 'ignore'
  /** The user reversed a previous action. A behaviour, not a correction. */
  | 'undo';

export type FeedbackActor = 'user' | 'system';

export type FeedbackSource =
  /** The user acted in the app. */
  | 'mobile_action'
  /** Time passed and the system observed the consequence. */
  | 'scheduler'
  /** Pre-event-log history carried over as a baseline; see FeedbackBaseline. */
  | 'migration_baseline';

export interface FeedbackEvent {
  readonly version: typeof FEEDBACK_EVENT_SCHEMA_VERSION;
  readonly id: string;
  readonly scopeId: string;
  readonly outcome: FeedbackOutcome;
  /** The commitment or proposal this outcome concerns. */
  readonly subjectId: string;
  readonly actor: FeedbackActor;
  readonly source: FeedbackSource;
  /** When the behaviour happened. Aggregation windows key off this. */
  readonly occurredAt: string;
  /** When the event was stored. Later than occurredAt for a late arrival. */
  readonly recordedAt: string;
  /** Deterministic; a repeated append with the same key is a no-op. */
  readonly idempotencyKey: string;
  /**
   * Set when the user revokes the event as mistaken. The event is never
   * deleted or rewritten: it leaves every future aggregate but stays visible
   * in history, so the user can see that their correction was applied.
   */
  readonly revokedAt?: string;
}

/**
 * Caller-supplied fields only. `id`, `version`, `recordedAt`, `idempotencyKey`
 * and `revokedAt` are server-assigned and are never accepted from a caller.
 */
export interface AppendFeedbackEventInput {
  readonly scopeId: string;
  readonly outcome: FeedbackOutcome;
  readonly subjectId: string;
  readonly actor: FeedbackActor;
  readonly source: Exclude<FeedbackSource, 'migration_baseline'>;
  readonly occurredAt: string;
}

export interface FeedbackEventQuery {
  readonly scopeId: string;
  /** Newest-first when true, which is what a history view wants. */
  readonly newestFirst?: boolean;
  readonly limit?: number;
  /** Revoked events are included by default: history must show corrections. */
  readonly includeRevoked?: boolean;
}

export interface FeedbackEventStore {
  /**
   * Appends an event, or returns the existing one unchanged when an event with
   * the same idempotencyKey is already present. Never edits in place.
   */
  append(input: AppendFeedbackEventInput, recordedAt: string): FeedbackEvent;
  get(id: string): FeedbackEvent | null;
  list(query: FeedbackEventQuery): readonly FeedbackEvent[];
  /**
   * Marks an event as revoked by the user. Returns false if not found, or if
   * it is already revoked — revoking twice is not an error, but it must not
   * move the timestamp and rewrite when the correction happened.
   */
  revoke(id: string, at: string): boolean;
  /** Removes every event in a scope. Returns the number deleted. */
  deleteScope(scopeId: string): number;
  readBaseline(scopeId: string): FeedbackBaseline | null;
  writeBaseline(baseline: FeedbackBaseline): void;
}

export interface FeedbackEventStoreOptions {
  readonly dataDir?: string;
}

/* ── Migration baseline ──────────────────────────────────────────── */

/** The legacy counter names carried over from behaviorFeedbackService. */
export type LegacyCounterName =
  | 'ignoredSuggestions'
  | 'completedActions'
  | 'delayedActions'
  | 'clarificationSuccesses'
  | 'clarificationFailures';

/**
 * The pre-event-log history for one scope.
 *
 * The legacy store held counters with a single scope-level `updatedAt`, so
 * there is no way to know when any individual outcome happened. The counters
 * are therefore preserved verbatim and never expanded into events: synthesising
 * timestamps would invent history that did not happen, and would pile every
 * fabricated event onto one instant, corrupting precisely the windowed
 * aggregates this sprint produces.
 */
export interface FeedbackBaseline {
  readonly version: typeof FEEDBACK_EVENT_SCHEMA_VERSION;
  readonly scopeId: string;
  readonly counters: Readonly<Record<LegacyCounterName, number>>;
  /** The legacy scope-level updatedAt — the only time information available. */
  readonly lastUpdatedAt: string | null;
  /**
   * Always true. Stated in the data rather than only in documentation, so no
   * consumer can mistake the baseline for something placeable in a window.
   */
  readonly timestampsUnavailable: true;
  readonly migratedAt: string;
}

/* ── Aggregation ─────────────────────────────────────────────────── */

export interface FeedbackAggregationInput {
  readonly events: readonly FeedbackEvent[];
  readonly baseline: FeedbackBaseline | null;
  readonly scopeId: string;
  /** ISO; the aggregation never reads the system clock. */
  readonly now: string;
  /** Defaults to DEFAULT_FEEDBACK_WINDOW_DAYS. */
  readonly windowDays?: number;
}

/** Counts of each outcome inside the window. Absent outcomes are omitted. */
export type OutcomeCounts = Readonly<Partial<Record<FeedbackOutcome, number>>>;

export interface FeedbackAggregates {
  readonly version: typeof FEEDBACK_EVENT_SCHEMA_VERSION;
  readonly scopeId: string;
  readonly computedAt: string;
  /** sha256 over the canonicalized input, so a replay can prove equality. */
  readonly inputDigest: string;
  readonly windowDays: number;
  readonly windowStart: string;
  /** Windowed counts, revoked events excluded. */
  readonly windowed: OutcomeCounts;
  /**
   * Lifetime counts, revoked events excluded, plus the migration baseline.
   * Separate from `windowed` because the baseline cannot be placed in a window.
   */
  readonly lifetime: OutcomeCounts;
  /** True when a baseline contributed, so a reader knows totals predate the log. */
  readonly includesMigrationBaseline: boolean;
  /** Events revoked by the user, reported so a correction is visible, never hidden. */
  readonly revokedCount: number;
  /**
   * Events whose recordedAt fell in a later window than their occurredAt.
   * Reported rather than absorbed, so lateness stays measurable.
   */
  readonly lateEventCount: number;
}

/**
 * The cross-user view. Counts only: it carries no scopeId, no subjectId, and no
 * per-event row, so an aggregate across users can never become a way to read one
 * user's history.
 */
export interface GlobalFeedbackAggregates {
  readonly version: typeof FEEDBACK_EVENT_SCHEMA_VERSION;
  readonly computedAt: string;
  readonly windowDays: number;
  readonly windowStart: string;
  readonly windowed: OutcomeCounts;
  readonly scopeCount: number;
}

/* ── History surface (#15) ───────────────────────────────────────── */

/**
 * One row of the user-facing history.
 *
 * `description` states what was observed, never what the user prefers: an
 * observation is a fact about a single moment, and promoting it to a claim
 * about the person is the thing this screen exists to make visible rather than
 * to do silently.
 */
export interface FeedbackHistoryRow {
  readonly id: string;
  readonly outcome: FeedbackOutcome;
  readonly subjectId: string;
  readonly occurredAt: string;
  readonly revokedAt: string | null;
  readonly canRevoke: boolean;
}

export interface FeedbackHistoryResponse {
  readonly version: typeof FEEDBACK_EVENT_SCHEMA_VERSION;
  readonly rows: readonly FeedbackHistoryRow[];
  /** Present when the scope has pre-event-log history that has no rows. */
  readonly baselineNotice: {
    readonly counters: Readonly<Record<LegacyCounterName, number>>;
    readonly lastUpdatedAt: string | null;
  } | null;
}
