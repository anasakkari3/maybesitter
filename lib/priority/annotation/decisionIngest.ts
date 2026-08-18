/**
 * Ingest for reviewed Priority decisions (Sprint 05, issue #21).
 *
 * The boundary a decision crosses to become evidence. Four refusals, each
 * returned with a code rather than dropped, because a row that vanishes without
 * a reason is a row a maintainer will re-submit unchanged.
 *
 * ── Order of checks, and why it is this order ───────────────────────
 *
 *  1. `MALFORMED_DECISION` — shape and provenance. Nothing downstream can be
 *     decided about a row whose pairId or reviewerId is not a string.
 *  2. `LOCKED_SPLIT_LEAKAGE` — before the unknown-pair check, deliberately. The
 *     queue withholds locked pairs, so a locked pair is *also* absent from the
 *     queue; reporting `UNKNOWN_PAIR` would send a maintainer to add it to the
 *     queue, which is the exact opposite of what must happen.
 *  3. `UNKNOWN_PAIR` — a verdict about a pair nobody defined refers to nothing.
 *  4. `DUPLICATE_DECISION` — last, because it is the only check that depends on
 *     which rows were accepted before it.
 *
 * Leakage is decided against the locked split itself, never against what the
 * queue happens to hold. A queue built before a pair was locked still lists it;
 * a policy fitted on that pair and then validated on it produces a number that
 * measures nothing at all, so the split — not the queue — is the authority.
 *
 * Duplicates are refused per (pair, reviewer) rather than per row id: two
 * submissions from one person are not two data points, and accepting both
 * weights that person's opinion by however many times they pressed send.
 *
 * ── Conflicts are computed, never resolved ──────────────────────────
 *
 * Disagreement between two reviewers is reported as a `DecisionConflict` over
 * both retained rows. `unresolved` is excluded from conflict detection and
 * counted separately, exactly as Sprint 04's agreement report excludes it from
 * the agreement denominator: an abstention is neither agreement nor
 * disagreement, and treating it as a conflict would push a reviewer to guess
 * rather than abstain.
 *
 * No function here reads the system clock.
 */
import {
  type AnnotationQueueItem,
  type DecisionConflict,
  type IngestRejectionCode,
  type QueueIngestResult,
  type ReviewedDecision,
} from '../../../src/contracts/v1/calibrationContracts';
import type { ValidationIssue } from '../../evaluation/registry/contracts';
import { IssueCollector, isPlainObject } from '../../evaluation/registry/validationPrimitives';
import { lockedSplitPairs } from '../../../tests/fixtures/prioritySeedSet';
import type { AnnotationBatch } from './annotationQueue';
import { detectDecisionConflicts, type DecisionStore } from './decisionStore';
import { validateReviewedDecision } from './reviewedDecision';

export interface IngestOptions {
  /** The queue reviewers were handed. Defines which pairs exist. */
  readonly queue: readonly AnnotationQueueItem[];
  /**
   * The held-out evaluation split. Defaults to the committed one. Leakage is
   * decided against this, never against the queue, so a stale queue cannot
   * launder a pair that has since been locked.
   */
  readonly lockedPairIds?: readonly string[];
  /** Decisions already recorded, so a duplicate across sessions is still a duplicate. */
  readonly existing?: readonly ReviewedDecision[];
}

/**
 * Extends the committed `QueueIngestResult` rather than replacing it.
 *
 * The contract fixes what a consumer may rely on; these add the *reasons*. A
 * rejection carrying only a code tells a maintainer that a row is malformed but
 * not which field, which is not enough to fix it.
 */
export interface DecisionIngestOutcome extends QueueIngestResult {
  readonly issues: readonly ValidationIssue[];
  /** Abstentions among accepted rows. Reported, never folded into conflicts. */
  readonly unresolvedCount: number;
  /** Pairs where at least one reviewer abstained; a rubric-ambiguity signal in its own right. */
  readonly abstainedPairIds: readonly string[];
}

/** Code-unit ordering, never localeCompare. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A traceable name for a row too malformed to carry an id.
 *
 * The committed contract types `rejected[].decisionId` as a `string`, so a
 * placeholder is needed rather than a null; the row index makes it possible to
 * find the offending row in the source file.
 */
function rejectionIdFor(raw: unknown, index: number): string {
  const candidate = isPlainObject(raw) ? raw.decisionId : undefined;
  return typeof candidate === 'string' && candidate.trim().length > 0
    ? candidate
    : `(unidentified row ${index})`;
}

/**
 * Validates and screens a set of rows.
 *
 * Pure: it writes nothing. `ingestIntoStore` is the version with a write path,
 * and keeping them separate means the screening logic can be exercised against
 * constructed inputs without a filesystem — the same split
 * lib/priority/rubric/judgmentCorpus.ts uses against its parser.
 */
export function ingestDecisions(
  rows: readonly unknown[],
  options: IngestOptions,
): DecisionIngestOutcome {
  const collector = new IssueCollector();
  const knownPairIds = new Set(options.queue.map((item) => item.pairId));
  const lockedPairIds = new Set(
    options.lockedPairIds ?? lockedSplitPairs().map((pair) => pair.pairId),
  );

  const existing = options.existing ?? [];
  const seenPairReviewer = new Set(existing.map((row) => `${row.pairId}::${row.reviewerId}`));
  const seenDecisionIds = new Set(existing.map((row) => row.decisionId));

  const accepted: ReviewedDecision[] = [];
  const rejected: { decisionId: string; code: IngestRejectionCode }[] = [];

  rows.forEach((raw, index) => {
    const path = `decisions[${index}]`;
    const validation = validateReviewedDecision(raw, path);
    collector.merge(validation.issues);
    if (!validation.decision) {
      rejected.push({ decisionId: rejectionIdFor(raw, index), code: 'MALFORMED_DECISION' });
      return;
    }

    const decision = validation.decision;

    // Locked-split leakage first: a locked pair is also absent from the queue,
    // and 'UNKNOWN_PAIR' would name the wrong problem.
    if (lockedPairIds.has(decision.pairId)) {
      collector.error(
        'PAI010',
        `${path}.pairId`,
        `'${decision.pairId}' belongs to the locked evaluation split; a judgment on it would let a ` +
          'policy tuned on this pair be validated against the same pair',
      );
      rejected.push({ decisionId: decision.decisionId, code: 'LOCKED_SPLIT_LEAKAGE' });
      return;
    }

    if (!knownPairIds.has(decision.pairId)) {
      collector.error(
        'PAI011',
        `${path}.pairId`,
        `no queue item names pair '${decision.pairId}'; a verdict about a pair nobody defined refers to nothing`,
      );
      rejected.push({ decisionId: decision.decisionId, code: 'UNKNOWN_PAIR' });
      return;
    }

    const pairReviewerKey = `${decision.pairId}::${decision.reviewerId}`;
    if (seenPairReviewer.has(pairReviewerKey)) {
      collector.error(
        'PAI012',
        path,
        `reviewer '${decision.reviewerId}' already decided pair '${decision.pairId}'; a second row would ` +
          "weight one person's opinion by however many times it was submitted",
      );
      rejected.push({ decisionId: decision.decisionId, code: 'DUPLICATE_DECISION' });
      return;
    }
    if (seenDecisionIds.has(decision.decisionId)) {
      collector.error('PAI013', `${path}.decisionId`, `'${decision.decisionId}' has already been ingested`);
      rejected.push({ decisionId: decision.decisionId, code: 'DUPLICATE_DECISION' });
      return;
    }

    seenPairReviewer.add(pairReviewerKey);
    seenDecisionIds.add(decision.decisionId);
    accepted.push(decision);
  });

  // Conflicts span the accepted batch and what was already stored: a
  // disagreement that arrives one reviewer per session is still a disagreement.
  const conflicts: readonly DecisionConflict[] = detectDecisionConflicts([...existing, ...accepted]);
  const abstentions = accepted.filter((decision) => decision.verdict === 'unresolved');

  return {
    accepted: Object.freeze(accepted),
    rejected: Object.freeze(rejected),
    conflicts,
    issues: collector.result().issues,
    unresolvedCount: abstentions.length,
    abstainedPairIds: Object.freeze(
      Array.from(new Set(abstentions.map((decision) => decision.pairId))).sort(byCodeUnit),
    ),
  };
}

/**
 * Screens rows and writes the survivors.
 *
 * The store's own append-only and duplicate guards still apply; they are the
 * last line rather than the first, so a caller who skips ingest cannot write a
 * row that ingest would have refused.
 */
export function ingestIntoStore(
  rows: readonly unknown[],
  store: DecisionStore,
  options: Omit<IngestOptions, 'existing'>,
): DecisionIngestOutcome {
  const outcome = ingestDecisions(rows, { ...options, existing: store.list() });
  for (const decision of outcome.accepted) {
    store.append({
      pairId: decision.pairId,
      reviewerId: decision.reviewerId,
      verdict: decision.verdict,
      rationale: decision.rationale,
      hardConstraintFlag: decision.hardConstraintFlag,
      decidedAt: decision.decidedAt,
      decisionId: decision.decisionId,
    });
  }
  return { ...outcome, conflicts: store.conflicts() };
}

/* ── Orientation ────────────────────────────────────────────────── */

export interface BatchOrientationResult {
  readonly valid: boolean;
  readonly issues: readonly ValidationIssue[];
}

/**
 * Checks that a returned batch still describes the pairs the queue describes.
 *
 * A `ReviewedDecision` carries `pairId` and `verdict` but *not* the orientation
 * the reviewer saw, so if a pair's left and right were ever swapped between
 * export and ingest, a verdict of `left` would silently refer to a different
 * commitment — the same failure Sprint 04's judgment loader guards with PRJ022,
 * which it can do because `PairwiseJudgment` carries both commitment ids.
 *
 * The batch file the reviewer worked from *does* carry the orientation, so
 * verifying the batch against the current queue closes the gap at the only place
 * the information still exists. Run it before ingesting the decisions that came
 * back with the batch.
 */
export function verifyBatchOrientation(
  batch: AnnotationBatch,
  queue: readonly AnnotationQueueItem[],
): BatchOrientationResult {
  const collector = new IssueCollector();
  const byPairId = new Map(queue.map((item) => [item.pairId, item] as const));

  batch.items.forEach((item, index) => {
    const path = `batch.items[${index}]`;
    const current = byPairId.get(item.pairId);
    if (!current) {
      collector.error('PAI031', `${path}.pairId`, `the queue no longer holds pair '${item.pairId}'`);
      return;
    }
    if (
      current.leftCommitmentId !== item.leftCommitmentId ||
      current.rightCommitmentId !== item.rightCommitmentId
    ) {
      collector.error(
        'PAI030',
        path,
        `the batch orients '${item.pairId}' as ${item.leftCommitmentId} / ${item.rightCommitmentId}, ` +
          `but the queue now orients it as ${current.leftCommitmentId} / ${current.rightCommitmentId}; ` +
          "a verdict of 'left' would refer to a different commitment",
      );
    }
  });

  return collector.result();
}
