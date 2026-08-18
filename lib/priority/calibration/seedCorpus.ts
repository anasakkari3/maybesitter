/**
 * Building a calibration corpus from the Sprint 04 seed set
 * (Sprint 05, issue #22).
 *
 * SYNTHETIC — ENGINEERING QA ONLY — NOT HUMAN EVIDENCE, on the *pairs*. The
 * commitments in `tests/fixtures/prioritySeedSet.ts` are invented for
 * engineering QA. The verdicts, if any ever exist, would be the only human
 * evidence involved — and today there are none.
 *
 * Provenance is therefore a required argument rather than a default. A caller
 * assembling a corpus has to state which kind of judgments it is holding, and
 * `provenanceOf` derives it from the rows instead of letting anyone assert it:
 * with no judgments at all, the answer is `synthetic_pipeline_proof`, because
 * an empty corpus is not evidence of human preference.
 *
 * Features are extracted at the pair's own declared clock (`SEED_CLOCK`), never
 * at the host's. That is what makes a corpus digest stable across days and a
 * replay from a manifest possible at all.
 */
import type { JudgmentProvenance } from '../../../src/contracts/v1/calibrationContracts';
import type { PairwiseJudgment } from '../../../src/contracts/v1/priorityContracts';
import { PRIORITY_SEED_PAIRS, type PrioritySeedPair } from '../../../tests/fixtures/prioritySeedSet';
import { extractPriorityFeatures } from '../priorityFeatures';
import type {
  CalibrationCorpus,
  CalibrationPair,
  CalibrationSubject,
  HardConstraintDeclaration,
} from './corpus';

/** `language/loadPattern`: the two dimensions the seed set is balanced across. */
export function sliceOf(pair: PrioritySeedPair): string {
  return `${pair.language}/${pair.loadPattern}`;
}

function subjectOf(side: PrioritySeedPair['left'], clock: string): CalibrationSubject {
  return {
    commitmentId: side.commitment.id,
    reason: side.reason,
    features: extractPriorityFeatures({ commitment: side.commitment, reminders: side.reminders, now: clock }),
  };
}

export function calibrationPairOf(pair: PrioritySeedPair): CalibrationPair {
  return {
    pairId: pair.pairId,
    slice: sliceOf(pair),
    left: subjectOf(pair.left, pair.clock),
    right: subjectOf(pair.right, pair.clock),
  };
}

export function buildSeedCorpus(options: {
  /** Which seed split to draw pairs from. `calibration` for tuning, `locked` for the gate. */
  readonly split: PrioritySeedPair['split'];
  readonly judgments: readonly PairwiseJudgment[];
  /**
   * Declared by the caller, never inferred. Required whenever judgments are
   * supplied: nothing in a judgment's shape says whether a person made it, so
   * a guess here would let a synthetic run present itself as human evidence.
   */
  readonly provenance?: JudgmentProvenance;
  readonly hardConstraints?: readonly HardConstraintDeclaration[];
  readonly seedPairs?: readonly PrioritySeedPair[];
}): CalibrationCorpus {
  const pairs = (options.seedPairs ?? PRIORITY_SEED_PAIRS)
    .filter((pair) => pair.split === options.split)
    .map(calibrationPairOf);
  const pairIds = new Set(pairs.map((pair) => pair.pairId));

  // Judgments about the other split are not this corpus's business; carrying
  // them would let a locked-split row widen the calibration denominator.
  const judgments = options.judgments.filter((judgment) => pairIds.has(judgment.pairId));

  // Decided on the *filtered* rows, not the input. A corpus that ends up empty
  // after filtering holds no evidence about anyone, whatever the caller
  // declared — and this is the ordinary shape of the locked corpus once real
  // judgments exist, since the queue withholds locked pairs and ingest rejects
  // them. Checking before the filter let a run with zero rows keep a
  // `human_reviewed` label and suppress the synthetic banner that keys off it.
  const declared = provenanceOfEmptyCorpus(judgments) ?? options.provenance;
  if (declared === undefined) {
    throw new TypeError(
      'calibration: provenance must be declared for a non-empty corpus; it cannot be inferred from the rows',
    );
  }

  return {
    provenance: declared,
    pairs,
    judgments,
    hardConstraints: (options.hardConstraints ?? []).filter((declaration) => pairIds.has(declaration.pairId)),
  };
}

/**
 * Provenance cannot be inferred from the rows.
 *
 * This function previously returned `human_reviewed` for any non-empty judgment
 * set. That is backwards for the only judgments that exist today: synthetic
 * rows are the sole way to exercise the pipeline, so every run stamped its
 * manifest as human evidence — precisely what `JudgmentProvenance` exists to
 * prevent. "The rows exist" is not the same claim as "a person made them", and
 * nothing in a judgment's shape distinguishes one from the other.
 *
 * So provenance is now declared by whoever supplies the rows and travels with
 * the corpus file. A caller loading the committed corpus passes what that file
 * declares; a test constructing rows passes `synthetic_pipeline_proof`. There
 * is no path that guesses.
 *
 * Retained only for the one case that genuinely is decidable: no judgments
 * cannot be evidence about anyone's preferences.
 */
export function provenanceOfEmptyCorpus(judgments: readonly PairwiseJudgment[]): JudgmentProvenance | null {
  return judgments.length === 0 ? 'synthetic_pipeline_proof' : null;
}
