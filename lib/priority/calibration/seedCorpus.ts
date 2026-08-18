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
  readonly hardConstraints?: readonly HardConstraintDeclaration[];
  readonly seedPairs?: readonly PrioritySeedPair[];
}): CalibrationCorpus {
  const pairs = (options.seedPairs ?? PRIORITY_SEED_PAIRS)
    .filter((pair) => pair.split === options.split)
    .map(calibrationPairOf);
  const pairIds = new Set(pairs.map((pair) => pair.pairId));

  return {
    provenance: provenanceOf(options.judgments),
    pairs,
    // Judgments about the other split are not this corpus's business; carrying
    // them would let a locked-split row widen the calibration denominator.
    judgments: options.judgments.filter((judgment) => pairIds.has(judgment.pairId)),
    hardConstraints: (options.hardConstraints ?? []).filter((declaration) => pairIds.has(declaration.pairId)),
  };
}

/**
 * Derived from the rows, not asserted by the caller.
 *
 * There is exactly one way to get `human_reviewed` out of this function, and it
 * requires judgments to exist. An empty corpus is `synthetic_pipeline_proof`
 * because it is not evidence about anyone's preferences.
 */
export function provenanceOf(judgments: readonly PairwiseJudgment[]): JudgmentProvenance {
  return judgments.length === 0 ? 'synthetic_pipeline_proof' : 'human_reviewed';
}
