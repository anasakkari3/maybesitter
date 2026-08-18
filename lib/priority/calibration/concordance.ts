/**
 * Pairwise concordance: the calibration objective (Sprint 05, issue #22).
 *
 * The fraction of judged pairs whose ordering a candidate policy reproduces.
 *
 * ── The exclusion rule, inherited rather than reinvented ───────────
 *
 * `unresolved` verdicts leave the denominator entirely — neither concordant nor
 * discordant — exactly as `lib/priority/rubric/agreementReport.ts` excludes them
 * from observed agreement. The two alternatives fail the same way there and
 * here: counting an abstention as concordant makes a corpus of abstentions
 * score 100%, and counting it as discordant punishes a reviewer for following
 * the rubric's abstention rules.
 *
 * Exclusion means the figure is computed over a subset, so its coverage travels
 * with it. `ConcordanceMetric` carries `scorablePairs` and `unscorablePairs`
 * next to the rate for the same reason the agreement report does: concordance
 * over three of forty pairs is a different claim from concordance over forty.
 * `rate` is `null` when nothing was scorable and never silently 0, because 0 is
 * a measurement of total disagreement and the absence of data is not that.
 *
 * ── Two further exclusions, and why they are exclusions ────────────
 *
 *  - **Conflicting verdicts.** Two reviewers who disagree on a pair have not
 *    produced a target ordering, they have produced evidence that the rubric is
 *    ambiguous there. Collapsing them by majority or by last-write-wins would
 *    manufacture a target nobody held and then score the policy against it.
 *    Sprint 05's contract retains conflicts as `DecisionConflict` for the same
 *    reason; this module simply declines to score them.
 *  - **Unknown pairs.** A judgment naming a pair the corpus does not contain
 *    cannot be scored at all. It is counted as unscorable rather than dropped,
 *    so it shrinks the coverage figure instead of silently shrinking the
 *    denominator.
 *
 * ── The unit of the denominator ────────────────────────────────────
 *
 * The unit is the **pair**, and the universe is the union of the corpus's pairs
 * and the pairs someone judged. Denominating against "pairs somebody happened
 * to judge" would render two judgments over a forty-pair corpus as "100% over
 * 2 of 2" — the exact misreading the agreement report's coverage figure exists
 * to prevent.
 *
 * Nothing here reads the clock; every time-derived quantity arrived already
 * measured in the feature vectors.
 */
import type {
  JudgmentVerdict,
  PriorityPolicy,
  PriorityScore,
} from '../../../src/contracts/v1/priorityContracts';
import type { ConcordanceMetric } from '../../../src/contracts/v1/calibrationContracts';
import { rankPriorities, scorePriority } from '../priorityScorer';
import { UNKNOWN_PAIR_SLICE, compareIds, type CalibrationCorpus, type CalibrationSubject } from './corpus';

/** Which side a policy puts first, with `tie` reserved for genuine equivalence. */
export type PredictedOrdering = 'left' | 'right' | 'tie';

export type PairOutcomeStatus = 'concordant' | 'discordant' | 'unscorable';

export type PairOutcomeReason =
  /** Scored: the pair carried a single resolving verdict. */
  | 'SCORED'
  /** Every verdict on the pair was an abstention. */
  | 'UNRESOLVED'
  /** Nobody judged the pair. */
  | 'UNJUDGED'
  /** Reviewers disagreed, so there is no target ordering to reproduce. */
  | 'CONFLICTING_VERDICTS'
  /** A judgment named a pair the corpus does not contain. */
  | 'UNKNOWN_PAIR';

export interface PairOutcome {
  readonly pairId: string;
  readonly slice: string;
  readonly status: PairOutcomeStatus;
  readonly reasonCode: PairOutcomeReason;
  /** The verdict scored against, or null when the pair was unscorable. */
  readonly targetVerdict: JudgmentVerdict | null;
  /** What the candidate policy ordered, or null when it could not be computed. */
  readonly predicted: PredictedOrdering | null;
}

export interface ConcordanceResult {
  readonly overall: ConcordanceMetric;
  readonly bySlice: Readonly<Record<string, ConcordanceMetric>>;
  /** One row per pair in the universe, sorted by pair id. The failure analysis. */
  readonly outcomes: readonly PairOutcome[];
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function scoreSubject(subject: CalibrationSubject, policy: PriorityPolicy): PriorityScore {
  return scorePriority({ features: subject.features, reason: subject.reason, policy });
}

/**
 * The ordering a policy produces over one pair.
 *
 * The winner comes from `rankPriorities` rather than from a comparison written
 * here, so calibration measures the ranking the product actually ships —
 * including its hard-constraint tier and its `commitmentId` tie-break. A second
 * comparator in this file could drift from that one silently.
 *
 * `tie` is decided separately, and deliberately not by asking the ranker: the
 * ranker imposes a total order, so it never returns a tie, and reading its
 * first element as a preference would report the id tie-break as if the policy
 * had an opinion.
 */
export function predictOrdering(left: PriorityScore, right: PriorityScore): PredictedOrdering {
  const leftPinned = left.reasonCodes.includes('HARD_CONSTRAINT_APPLIED');
  const rightPinned = right.reasonCodes.includes('HARD_CONSTRAINT_APPLIED');
  if (leftPinned === rightPinned && left.total === right.total) return 'tie';

  const winner = rankPriorities({ scored: [left, right] })[0];
  return winner.commitmentId === left.commitmentId ? 'left' : 'right';
}

/**
 * The single target verdict for a pair, or null when there is none.
 *
 * Abstentions are dropped first and only here; everything downstream — the
 * denominator, the coverage counts, the failure rows — follows from this one
 * exclusion, so the rule lives in one place.
 */
function targetVerdictFor(verdicts: readonly JudgmentVerdict[]): {
  verdict: JudgmentVerdict | null;
  reason: PairOutcomeReason;
} {
  if (verdicts.length === 0) return { verdict: null, reason: 'UNJUDGED' };
  const resolving = verdicts.filter((verdict) => verdict !== 'unresolved');
  if (resolving.length === 0) return { verdict: null, reason: 'UNRESOLVED' };
  const distinct = Array.from(new Set(resolving));
  if (distinct.length > 1) return { verdict: null, reason: 'CONFLICTING_VERDICTS' };
  return { verdict: distinct[0], reason: 'SCORED' };
}

function emptyTally(): { concordant: number; scorable: number; unscorable: number } {
  return { concordant: 0, scorable: 0, unscorable: 0 };
}

function metricOf(tally: { concordant: number; scorable: number; unscorable: number }): ConcordanceMetric {
  return {
    concordantPairs: tally.concordant,
    scorablePairs: tally.scorable,
    unscorablePairs: tally.unscorable,
    // Null, never 0. See the header.
    rate: tally.scorable === 0 ? null : round4(tally.concordant / tally.scorable),
  };
}

export function evaluateConcordance(corpus: CalibrationCorpus, policy: PriorityPolicy): ConcordanceResult {
  const byPairId = new Map(corpus.pairs.map((pair) => [pair.pairId, pair]));
  const verdictsByPairId = new Map<string, JudgmentVerdict[]>();
  for (const judgment of corpus.judgments) {
    const bucket = verdictsByPairId.get(judgment.pairId) ?? [];
    bucket.push(judgment.verdict);
    verdictsByPairId.set(judgment.pairId, bucket);
  }

  // Union of declared pairs and judged pairs, so a judgment about a pair the
  // corpus lacks widens the coverage denominator rather than vanishing.
  const pairIds = Array.from(
    new Set([...Array.from(byPairId.keys()), ...Array.from(verdictsByPairId.keys())]),
  ).sort(compareIds);

  const overall = emptyTally();
  const sliceTallies = new Map<string, ReturnType<typeof emptyTally>>();
  const outcomes: PairOutcome[] = [];

  for (const pairId of pairIds) {
    const pair = byPairId.get(pairId);
    const slice = pair?.slice ?? UNKNOWN_PAIR_SLICE;
    const sliceTally = sliceTallies.get(slice) ?? emptyTally();
    sliceTallies.set(slice, sliceTally);

    const record = (status: PairOutcomeStatus, reasonCode: PairOutcomeReason, target: JudgmentVerdict | null, predicted: PredictedOrdering | null): void => {
      outcomes.push({ pairId, slice, status, reasonCode, targetVerdict: target, predicted });
      if (status === 'unscorable') {
        overall.unscorable += 1;
        sliceTally.unscorable += 1;
        return;
      }
      overall.scorable += 1;
      sliceTally.scorable += 1;
      if (status === 'concordant') {
        overall.concordant += 1;
        sliceTally.concordant += 1;
      }
    };

    if (pair === undefined) {
      record('unscorable', 'UNKNOWN_PAIR', null, null);
      continue;
    }

    const { verdict, reason } = targetVerdictFor(verdictsByPairId.get(pairId) ?? []);
    if (verdict === null) {
      record('unscorable', reason, null, null);
      continue;
    }

    const predicted = predictOrdering(scoreSubject(pair.left, policy), scoreSubject(pair.right, policy));
    record(predicted === verdict ? 'concordant' : 'discordant', 'SCORED', verdict, predicted);
  }

  const bySlice: Record<string, ConcordanceMetric> = {};
  for (const slice of Array.from(sliceTallies.keys()).sort(compareIds)) {
    bySlice[slice] = metricOf(sliceTallies.get(slice)!);
  }

  return { overall: metricOf(overall), bySlice, outcomes };
}
