/**
 * The single-use locked-split gate (Sprint 05, issue #22).
 *
 * The final check: does a policy hold up on judgments it was never fitted to?
 * The answer is only worth having once, and only when there is something to
 * measure. Both of those are enforced here rather than left to process.
 *
 * ── Refusing an empty corpus ───────────────────────────────────────
 *
 * A gate that reports `passed` over zero judgments is worse than no gate. It
 * emits the same word a real pass emits, it appears in the same report field,
 * and it certifies nothing — so it converts an absence of evidence into
 * displayed confidence. `data/quality/priority-judgments.json` holds zero rows
 * today, so this is the branch the gate is actually in, not a defensive
 * hypothetical.
 *
 * The refusal generalises to a corpus that has rows but nothing scorable — all
 * abstentions, say. `refused_empty_corpus` covers both, and the `reason` states
 * which: a rate of `null` cannot clear any threshold, and dressing that up as
 * `failed` would blame the policy for the corpus. The metric is still returned
 * in that case, because "we looked at one pair and could not score it" is a
 * different and more useful statement than "there was nothing here".
 *
 * ── Single use, and why failure also consumes ──────────────────────
 *
 * Measuring against a held-out split spends it: after the first look it is no
 * longer held out, and a second run is optimisation against the test set
 * performed one attempt at a time. The ledger of used split ids is therefore
 * checked *before* anything else, so a re-run cannot present itself as an empty
 * corpus and slip past.
 *
 * A failing gate consumes the split exactly as a passing one does. If failure
 * were free, the cheapest response to a red gate would be a small tweak and
 * another run, which is the leak this whole mechanism exists to close. A
 * *refusal* does not consume, because nothing was measured — the split was
 * never spent.
 *
 * The ledger is a value in and a value out. No file, no module-level mutable
 * set, no clock: whoever owns the persistence owns the decision to persist, and
 * a test can exercise the second-use branch without touching a disk.
 */
import type { LockedGateOutcome, LockedGateResult } from '../../../src/contracts/v1/calibrationContracts';
import type { PriorityPolicy } from '../../../src/contracts/v1/priorityContracts';
import { evaluateConcordance } from './concordance';
import type { CalibrationCorpus } from './corpus';

export interface LockedGateInput {
  /** Identity of the locked split *version*, matching the seed-set lock ledger. */
  readonly splitId: string;
  readonly corpus: CalibrationCorpus;
  readonly policy: PriorityPolicy;
  /** Inclusive lower bound on concordance, in 0..1. */
  readonly minimumConcordance: number;
  /** Splits already spent. Supplied by the caller; this module stores nothing. */
  readonly usedSplitIds: readonly string[];
}

export interface LockedGateRun {
  readonly result: LockedGateResult;
  /** The ledger after this call: unchanged on a refusal, appended otherwise. */
  readonly usedSplitIds: readonly string[];
}

function resultOf(outcome: LockedGateOutcome, reason: string, metric: LockedGateResult['metric']): LockedGateResult {
  return { outcome, metric, reason };
}

export function runLockedGate(input: LockedGateInput): LockedGateRun {
  const { splitId, corpus, policy, minimumConcordance, usedSplitIds } = input;

  if (typeof minimumConcordance !== 'number' || !(minimumConcordance >= 0 && minimumConcordance <= 1)) {
    throw new TypeError(
      `locked gate: minimumConcordance must be a rate in 0..1, received ${JSON.stringify(minimumConcordance)}`,
    );
  }
  if (typeof splitId !== 'string' || splitId.length === 0) {
    throw new TypeError('locked gate: splitId is required; an unnamed split cannot be recorded as used');
  }

  // First, before anything is measured. A second look must not be able to
  // report itself as some other kind of non-answer.
  if (usedSplitIds.includes(splitId)) {
    return {
      result: resultOf(
        'refused_already_used',
        `locked split '${splitId}' has already been used for a final gate; ` +
          'a second measurement against a held-out split is optimisation against the test set',
        null,
      ),
      usedSplitIds,
    };
  }

  if (corpus.judgments.length === 0) {
    return {
      result: resultOf(
        'refused_empty_corpus',
        `locked split '${splitId}' carries no judgments; ` +
          'a gate reporting a pass over zero judgments would manufacture confidence rather than measure it',
        null,
      ),
      usedSplitIds,
    };
  }

  const metric = evaluateConcordance(corpus, policy).overall;

  if (metric.rate === null) {
    return {
      result: resultOf(
        'refused_empty_corpus',
        `locked split '${splitId}' holds ${corpus.judgments.length} judgment row(s) but no scorable pair ` +
          `(${metric.unscorablePairs} unscorable); there is no rate to compare against a threshold`,
        metric,
      ),
      usedSplitIds,
    };
  }

  const passed = metric.rate >= minimumConcordance;
  return {
    result: resultOf(
      passed ? 'passed' : 'failed',
      `concordance ${metric.rate} over ${metric.scorablePairs} of ${metric.scorablePairs + metric.unscorablePairs} pairs ` +
        `against a minimum of ${minimumConcordance}`,
      metric,
    ),
    // Consumed on pass and on fail alike. See the header.
    usedSplitIds: [...usedSplitIds, splitId],
  };
}
