/**
 * The judgment corpus a candidate policy is scored against
 * (Sprint 05, issue #22).
 *
 * ── Status ─────────────────────────────────────────────────────────
 *
 * **No reviewed judgments exist.** `data/quality/priority-judgments.json`
 * carries zero rows, and Sprint 05 does not add any. The corpora this module
 * describes are therefore, today, exclusively `synthetic_pipeline_proof`: rows
 * constructed in tests to prove the pipeline runs. They say nothing about what
 * a person would prefer, and the type says so in the data rather than in a
 * comment, because a reader of a stored report must be able to tell which kind
 * they are holding.
 *
 * ── Why the corpus carries feature vectors, not commitments ────────
 *
 * A `CalibrationPair` holds `PriorityFeatures`, already extracted at a stated
 * instant, rather than `Commitment` records. Extraction is the only step that
 * needs a clock; scoring and ranking do not. Freezing the vectors at the corpus
 * boundary means a calibration run has no clock-dependent step at all, which is
 * what makes "re-running from a manifest produces byte-identical output" a
 * property of the code rather than a property of when you ran it.
 *
 * ── The digest ─────────────────────────────────────────────────────
 *
 * `computeCorpusDigest` reuses `canonicalJson`/`sha256Hex` from
 * lib/evaluation/registry/fingerprint.ts rather than adding a third
 * canonicaliser to the repo. It sorts pairs and judgments first, so the digest
 * is a function of the *set*: reordering rows in a file is not a change to the
 * corpus, and a digest that said otherwise would force spurious mismatches on
 * replay. `provenance` is inside the digest, so a corpus relabelled from
 * synthetic to human is a different corpus and a manifest minted against the
 * old label will refuse to replay against the new one.
 */
import type {
  PairwiseJudgment,
  PriorityFeatures,
  PriorityReason,
} from '../../../src/contracts/v1/priorityContracts';
import type { JudgmentProvenance, ReviewedDecision } from '../../../src/contracts/v1/calibrationContracts';
import { canonicalJson, sha256Hex } from '../../evaluation/registry/fingerprint';

/** One side of a judged pair, with its features already extracted. */
export interface CalibrationSubject {
  readonly commitmentId: string;
  readonly features: PriorityFeatures;
  /** The band this side sits in. Selected by situation, so it is an input here. */
  readonly reason: PriorityReason;
}

export interface CalibrationPair {
  readonly pairId: string;
  /** Which slice this pair belongs to, for the before/after slice metrics. */
  readonly slice: string;
  readonly left: CalibrationSubject;
  readonly right: CalibrationSubject;
}

/**
 * A pair whose ordering a reviewer asserted was *forced* — the hard-constraint
 * flag on a `ReviewedDecision`, carried into calibration.
 *
 * This is not a preference to be traded against other preferences. A candidate
 * that inverts it is rejected outright, whatever it does to the aggregate.
 */
export interface HardConstraintDeclaration {
  readonly pairId: string;
  /** The commitment the constraint requires to rank above the other. */
  readonly pinnedCommitmentId: string;
  /** Which decision asserted it, so the rejection can be traced to a reviewer. */
  readonly declaredBy: string;
}

export interface CalibrationCorpus {
  /**
   * Recorded, never inferred. A gate can refuse to treat one kind as the other
   * only if the corpus states which it is.
   */
  readonly provenance: JudgmentProvenance;
  readonly pairs: readonly CalibrationPair[];
  readonly judgments: readonly PairwiseJudgment[];
  readonly hardConstraints: readonly HardConstraintDeclaration[];
}

/** Slice attributed to a judgment naming a pair the corpus does not contain. */
export const UNKNOWN_PAIR_SLICE = '(unknown pair)';

/** Code-unit comparison, never localeCompare: ordering must not depend on the host. */
export function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The canonical form the digest is taken over.
 *
 * Deliberately the *whole* corpus, features included. A run replayed against a
 * corpus whose feature vectors were re-extracted at a different instant is not
 * a replay of the same run, and a digest over ids alone would call it one.
 */
export function canonicalCorpus(corpus: CalibrationCorpus): unknown {
  return {
    provenance: corpus.provenance,
    pairs: corpus.pairs
      .slice()
      .sort((left, right) => compareIds(left.pairId, right.pairId))
      .map((pair) => ({
        pairId: pair.pairId,
        slice: pair.slice,
        left: { commitmentId: pair.left.commitmentId, reason: pair.left.reason, features: pair.left.features },
        right: { commitmentId: pair.right.commitmentId, reason: pair.right.reason, features: pair.right.features },
      })),
    judgments: corpus.judgments
      .slice()
      .sort(
        (left, right) =>
          compareIds(left.pairId, right.pairId) || compareIds(left.annotatorId, right.annotatorId),
      ),
    hardConstraints: corpus.hardConstraints
      .slice()
      .sort((left, right) => compareIds(left.pairId, right.pairId) || compareIds(left.declaredBy, right.declaredBy)),
  };
}

export function computeCorpusDigest(corpus: CalibrationCorpus): string {
  return sha256Hex(canonicalJson(canonicalCorpus(corpus)));
}

/**
 * Lifts `ReviewedDecision.hardConstraintFlag` into declarations.
 *
 * `tie` and `unresolved` are skipped even when flagged: a constraint that does
 * not name a winner cannot be checked, and inventing one from the flag alone
 * would fabricate the very thing the flag was asserting.
 */
export function hardConstraintsFromDecisions(
  decisions: readonly ReviewedDecision[],
  pairs: readonly CalibrationPair[],
): readonly HardConstraintDeclaration[] {
  const byPairId = new Map(pairs.map((pair) => [pair.pairId, pair]));
  const declarations: HardConstraintDeclaration[] = [];

  for (const decision of decisions) {
    if (!decision.hardConstraintFlag) continue;
    if (decision.verdict !== 'left' && decision.verdict !== 'right') continue;
    const pair = byPairId.get(decision.pairId);
    if (pair === undefined) continue;
    declarations.push({
      pairId: decision.pairId,
      pinnedCommitmentId: decision.verdict === 'left' ? pair.left.commitmentId : pair.right.commitmentId,
      declaredBy: decision.decisionId,
    });
  }

  return declarations.sort(
    (left, right) => compareIds(left.pairId, right.pairId) || compareIds(left.declaredBy, right.declaredBy),
  );
}
