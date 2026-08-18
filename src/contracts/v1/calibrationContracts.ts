/**
 * Priority calibration contracts (Sprint 05, issues #21, #22, #23).
 *
 * The apparatus for tuning the Priority policy: a queue to collect ranking
 * judgments, a pipeline to fit weights against them, and a shadow comparison
 * to see what a weight change would do before it changes anything.
 *
 * Three properties are structural here, each because the alternative fails
 * quietly rather than loudly.
 *
 *  1. A calibration result is a *report*, not a config. Nothing in this
 *     contract can swap the shipped policy. Weights fitted to judgments that
 *     nobody made would look exactly like weights fitted to real ones, so the
 *     separation cannot rest on the discipline of whoever runs the pipeline.
 *
 *  2. A judgment corpus states whether it is synthetic, in the data. A
 *     synthetic run proves the pipeline works and says nothing about what a
 *     person would prefer, and a reader of a stored report must be able to
 *     tell which kind they are holding.
 *
 *  3. A shadow comparison distinguishes a rank change caused by missing data
 *     from one caused by different weights. They are different problems with
 *     different fixes, and `dependency`/`effort` are permanently unknown, so
 *     the first category is never empty.
 */

import type { PriorityPolicy, JudgmentVerdict } from './priorityContracts';

export const CALIBRATION_SCHEMA_VERSION = 'priority-calibration-v1' as const;

/* ── Annotation queue (#21) ──────────────────────────────────────── */

/**
 * Where a judgment came from. Recorded on the corpus rather than inferred, so
 * a report can state it and a gate can refuse to treat one as the other.
 */
export type JudgmentProvenance =
  /** Produced by a person following the rubric. */
  | 'human_reviewed'
  /** Generated to exercise the pipeline. Never evidence about preferences. */
  | 'synthetic_pipeline_proof';

export type QueueItemState = 'pending' | 'decided' | 'skipped';

export interface AnnotationQueueItem {
  readonly version: typeof CALIBRATION_SCHEMA_VERSION;
  readonly itemId: string;
  readonly pairId: string;
  readonly leftCommitmentId: string;
  readonly rightCommitmentId: string;
  readonly state: QueueItemState;
  /** Which slice this pair belongs to, for the coverage report. */
  readonly slice: string;
  readonly enqueuedAt: string;
}

/**
 * One reviewer's decision on one pair.
 *
 * `reviewerId` and `decidedAt` are non-optional: a decision whose author or
 * time is unknown cannot be audited, and an unauditable judgment is not one a
 * ranking should be fitted to.
 */
export interface ReviewedDecision {
  readonly version: typeof CALIBRATION_SCHEMA_VERSION;
  readonly decisionId: string;
  readonly pairId: string;
  readonly reviewerId: string;
  readonly verdict: JudgmentVerdict;
  readonly rationale: string;
  /** Reviewer's assertion that a hard constraint forced the ordering. */
  readonly hardConstraintFlag: boolean;
  readonly decidedAt: string;
}

/**
 * Two reviewers who disagreed on the same pair.
 *
 * Retained rather than resolved. Averaging or last-write-wins would destroy
 * the signal at precisely the point where it carries the most information:
 * disagreement usually means the rubric is ambiguous there, which is a fact
 * about the rubric that a collapsed row would hide.
 */
export interface DecisionConflict {
  readonly pairId: string;
  readonly decisionIds: readonly string[];
  readonly verdicts: readonly JudgmentVerdict[];
}

export interface QueueIngestResult {
  readonly accepted: readonly ReviewedDecision[];
  /** Rejected with a reason code, never dropped silently. */
  readonly rejected: readonly { readonly decisionId: string; readonly code: IngestRejectionCode }[];
  readonly conflicts: readonly DecisionConflict[];
}

export type IngestRejectionCode =
  /** The same reviewer already decided this pair. */
  | 'DUPLICATE_DECISION'
  /** The pair appears in the locked evaluation split. */
  | 'LOCKED_SPLIT_LEAKAGE'
  | 'UNKNOWN_PAIR'
  | 'MALFORMED_DECISION';

export interface QueueCoverageReport {
  readonly version: typeof CALIBRATION_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly totalItems: number;
  readonly decidedItems: number;
  readonly pendingItems: number;
  readonly bySlice: Readonly<Record<string, number>>;
  readonly reviewerCount: number;
  readonly conflictCount: number;
  /** True when no decision has been recorded. Reported, not implied by zeros. */
  readonly corpusEmpty: boolean;
}

/* ── Calibration (#22) ───────────────────────────────────────────── */

/**
 * Concordance and its coverage, together.
 *
 * `unresolved` judgments are excluded from the denominator exactly as they are
 * in the Sprint 04 agreement report, so the figure is computed over a subset —
 * and concordance over three of forty pairs is a different claim from
 * concordance over forty.
 */
export interface ConcordanceMetric {
  readonly concordantPairs: number;
  readonly scorablePairs: number;
  readonly unscorablePairs: number;
  /** Null when no pair was scorable; never silently zero. */
  readonly rate: number | null;
}

export interface SliceMetrics {
  readonly slice: string;
  readonly before: ConcordanceMetric;
  readonly after: ConcordanceMetric;
}

/**
 * A candidate rejected outright rather than penalised.
 *
 * Hard-constraint preservation is a filter, not a scoring term: no amount of
 * aggregate improvement may buy a constraint violation, and a weighted penalty
 * would let one.
 */
export interface ConstraintViolation {
  readonly pairId: string;
  readonly pinnedCommitmentId: string;
  readonly outrankedByCommitmentId: string;
}

export interface CalibrationCandidate {
  readonly policy: PriorityPolicy;
  readonly overall: ConcordanceMetric;
  readonly bySlice: readonly SliceMetrics[];
  readonly constraintViolations: readonly ConstraintViolation[];
  /** False whenever any constraint violation is present. */
  readonly admissible: boolean;
}

/**
 * Everything needed to reproduce a run byte-for-byte.
 *
 * The search is a deterministic bounded sweep rather than a stochastic
 * optimiser, because a result that depends on unseeded randomness or the
 * wall clock cannot satisfy "configuration is reproducible from manifest".
 */
export interface CalibrationManifest {
  readonly version: typeof CALIBRATION_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly corpusDigest: string;
  readonly corpusProvenance: JudgmentProvenance;
  readonly basePolicyVersion: string;
  readonly searchSeed: number;
  readonly candidatesEvaluated: number;
  readonly lockedSplitUsed: boolean;
}

export interface CalibrationReport {
  readonly version: typeof CALIBRATION_SCHEMA_VERSION;
  readonly manifest: CalibrationManifest;
  readonly baseline: CalibrationCandidate;
  /** Null when no admissible candidate improved on the baseline. */
  readonly best: CalibrationCandidate | null;
  readonly regressions: readonly SliceMetrics[];
  /**
   * Always true in Sprint 05. A report is not a config: shipping the weights
   * it found is a separate, deliberate act, and with a synthetic corpus it
   * would mean fitting the product's ranking to preferences nobody expressed.
   */
  readonly policyUnchanged: true;
}

/** Result of the single-use locked-split gate. */
export type LockedGateOutcome =
  | 'passed'
  | 'failed'
  /** The corpus held no judgments, so the gate reports nothing rather than a vacuous pass. */
  | 'refused_empty_corpus'
  /** This locked split has already been used for a final gate. */
  | 'refused_already_used';

export interface LockedGateResult {
  readonly outcome: LockedGateOutcome;
  readonly metric: ConcordanceMetric | null;
  readonly reason: string;
}

/* ── Shadow comparison (#23) ─────────────────────────────────────── */

/**
 * Why a commitment's rank moved between two policies.
 *
 * The split is the point of the report. A change driven by an unknown feature
 * is a *data* problem — collect the missing input. A change driven by weights
 * over identical known features is a *policy* problem — the tuning did it.
 * Reporting one number would send a reader to debug the wrong one.
 */
export type DisagreementCause =
  | 'missing_context'
  | 'scorer_disagreement'
  /** Both: features differ in knownness *and* the weights moved. */
  | 'mixed';

export interface RankDisagreement {
  readonly commitmentId: string;
  readonly baselineRank: number;
  readonly candidateRank: number;
  readonly cause: DisagreementCause;
  /** Feature names that were unknown for this commitment, if any. */
  readonly unknownFeatures: readonly string[];
}

export interface ShadowSamplingConfig {
  /** 0..1. 1 compares everything. */
  readonly rate: number;
  /** Seeded so a sampled run is reproducible, not merely cheap. */
  readonly seed: number;
}

export interface ShadowComparisonReport {
  readonly version: typeof CALIBRATION_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly baselinePolicyVersion: string;
  readonly candidatePolicyVersion: string;
  readonly sampling: ShadowSamplingConfig;
  readonly comparedCount: number;
  readonly disagreements: readonly RankDisagreement[];
  /** Counts by cause, so the two problems are never presented as one number. */
  readonly byCause: Readonly<Record<DisagreementCause, number>>;
  /** Kendall tau between the two orderings; null when fewer than two items. */
  readonly rankCorrelation: number | null;
}
