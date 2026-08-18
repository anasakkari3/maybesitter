/**
 * Hard-constraint preservation, as a filter (Sprint 05, issue #22).
 *
 * A candidate that reorders a constrained pair is rejected outright. It is not
 * penalised, not weighted, not traded off. The distinction is the whole point:
 * a penalty term has a price, and any candidate whose aggregate concordance
 * improves by more than that price buys the violation. There is no number that
 * makes inverting a commitment the user pinned an acceptable trade, so there is
 * no number in this module.
 *
 * ── Two kinds of constraint ────────────────────────────────────────
 *
 *  1. **Structural pin.** One side is a high-importance commitment the *user
 *     set themselves*, which `priorityScorer` marks with
 *     `HARD_CONSTRAINT_APPLIED` and `rankPriorities` places in its own ordering
 *     tier. No weight can invert it, because the tier carries zero points — so
 *     under the shipped ranker this check finds nothing, by construction.
 *     It is kept for the case that matters: the day the comparator changes, or
 *     a consumer orders by `.total` instead of calling `rankPriorities`
 *     (`lib/utils/agendaScoring.ts` returns `.total` today), the pin stops being
 *     structural and this becomes the thing that notices.
 *
 *  2. **Declared constraint.** A reviewer asserted, via
 *     `ReviewedDecision.hardConstraintFlag`, that a pair's ordering was forced.
 *     Nothing structural protects those, so weights can and do invert them, and
 *     this is where the filter earns its keep.
 *
 * ── Whether a side is pinned is asked of the scorer, not re-derived ─
 *
 * Pinned-ness is read off `PriorityScore.reasonCodes`, which is the scorer's own
 * statement about the constraint it applied. Re-deriving it from the feature
 * vector here would create a second definition of "pinned" that could drift
 * from the one the ranking actually uses — and the drift would show up as a
 * calibration that approves a candidate the ranker treats differently.
 */
import type { ConstraintViolation } from '../../../src/contracts/v1/calibrationContracts';
import type { PriorityPolicy, PriorityScore } from '../../../src/contracts/v1/priorityContracts';
import { rankPriorities } from '../priorityScorer';
import { scoreSubject } from './concordance';
import { compareIds, type CalibrationCorpus, type CalibrationPair } from './corpus';

export interface ConstraintCheck {
  readonly violations: readonly ConstraintViolation[];
  /** Pairs where exactly one side is user-pinned. Reported so "no violations" is readable. */
  readonly structuralPinPairs: number;
  /** Pairs carrying a reviewer's hard-constraint declaration. */
  readonly declaredConstraintPairs: number;
}

function isPinned(score: PriorityScore): boolean {
  return score.reasonCodes.includes('HARD_CONSTRAINT_APPLIED');
}

/** The commitment the shipped ranker puts first. Not a comparator written here. */
function rankedWinner(left: PriorityScore, right: PriorityScore): string {
  return rankPriorities({ scored: [left, right] })[0].commitmentId;
}

function otherSideOf(pair: CalibrationPair, commitmentId: string): string {
  return commitmentId === pair.left.commitmentId ? pair.right.commitmentId : pair.left.commitmentId;
}

export function checkConstraints(corpus: CalibrationCorpus, policy: PriorityPolicy): ConstraintCheck {
  const byPairId = new Map(corpus.pairs.map((pair) => [pair.pairId, pair]));
  const declarationsByPairId = new Map<string, string[]>();
  for (const declaration of corpus.hardConstraints) {
    const pair = byPairId.get(declaration.pairId);
    if (pair === undefined) continue;
    if (
      declaration.pinnedCommitmentId !== pair.left.commitmentId &&
      declaration.pinnedCommitmentId !== pair.right.commitmentId
    ) {
      // Malformed rather than unsatisfiable: the declaration names a commitment
      // that is not in the pair it constrains, so there is nothing to check and
      // silently skipping it would drop a stated constraint on the floor.
      throw new TypeError(
        `calibration constraints: declaration '${declaration.declaredBy}' pins ` +
          `'${declaration.pinnedCommitmentId}', which is not a side of pair '${declaration.pairId}'`,
      );
    }
    const bucket = declarationsByPairId.get(declaration.pairId) ?? [];
    bucket.push(declaration.pinnedCommitmentId);
    declarationsByPairId.set(declaration.pairId, bucket);
  }

  const violations = new Map<string, ConstraintViolation>();
  let structuralPinPairs = 0;
  let declaredConstraintPairs = 0;

  for (const pair of corpus.pairs.slice().sort((left, right) => compareIds(left.pairId, right.pairId))) {
    const leftScore = scoreSubject(pair.left, policy);
    const rightScore = scoreSubject(pair.right, policy);
    const winner = rankedWinner(leftScore, rightScore);

    const pinnedIds = new Set<string>();

    const leftPinned = isPinned(leftScore);
    const rightPinned = isPinned(rightScore);
    // Both pinned is not a pin of one over the other: the user asserted both,
    // and the constraint says nothing about which of two pinned items comes
    // first. That ordering is the weights' business.
    if (leftPinned !== rightPinned) {
      structuralPinPairs += 1;
      pinnedIds.add(leftPinned ? pair.left.commitmentId : pair.right.commitmentId);
    }

    const declared = declarationsByPairId.get(pair.pairId) ?? [];
    if (declared.length > 0) declaredConstraintPairs += 1;
    for (const pinnedCommitmentId of declared) pinnedIds.add(pinnedCommitmentId);

    for (const pinnedCommitmentId of Array.from(pinnedIds).sort(compareIds)) {
      if (winner === pinnedCommitmentId) continue;
      violations.set(`${pair.pairId}::${pinnedCommitmentId}`, {
        pairId: pair.pairId,
        pinnedCommitmentId,
        outrankedByCommitmentId: otherSideOf(pair, pinnedCommitmentId),
      });
    }
  }

  return {
    violations: Array.from(violations.values()).sort(
      (left, right) =>
        compareIds(left.pairId, right.pairId) || compareIds(left.pinnedCommitmentId, right.pinnedCommitmentId),
    ),
    structuralPinPairs,
    declaredConstraintPairs,
  };
}
