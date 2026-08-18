/**
 * The on-disk reviewed-decision corpus (Sprint 05, issue #21).
 *
 * This file is the ingestion point, and the file it reads contains **zero
 * rows**. That is deliberate and load-bearing, for the same reason
 * lib/priority/rubric/judgmentCorpus.ts says it: the corpus is human judgment
 * data, none has been collected, and rows written by engineering would read as
 * reviewer evidence while being nothing of the kind. Issue #22 fits ranking
 * weights against exactly this file, so a fabricated row here becomes a
 * miscalibrated ordering there — and the resulting weights would look exactly
 * like weights fitted to real preferences.
 *
 * `tests/priority/annotationCoverage.test.ts` asserts the corpus is empty with
 * both exits closed: valid rows fail the count check, invalid rows fail the
 * validity check. It is designed to fail the moment rows appear, so the first
 * real annotations arrive in a commit that names who reviewed and when.
 *
 * Reading is separated from parsing so the parser stays pure and testable
 * against constructed inputs, and the only filesystem access sits at the top —
 * the same split judgmentCorpus.ts uses against its CLI.
 *
 * `provenance` is stated in the data rather than inferred. A synthetic run
 * proves the pipeline works and says nothing about what a person would prefer,
 * and a reader of a stored corpus must be able to tell which kind they hold.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  CALIBRATION_SCHEMA_VERSION,
  type JudgmentProvenance,
  type ReviewedDecision,
} from '../../../src/contracts/v1/calibrationContracts';
import type { ValidationIssue } from '../../evaluation/registry/contracts';
import {
  IssueCollector,
  isIsoTimestamp,
  isNonEmptyString,
  isPlainObject,
} from '../../evaluation/registry/validationPrimitives';
import { RUBRIC_VERSION } from '../../../tests/fixtures/prioritySeedSet';
import { validateReviewedDecision } from './reviewedDecision';

/**
 * Resolved from this module rather than `process.cwd()`, so a CLI, a test and an
 * editor task all read the same file regardless of where they were launched.
 */
export const DECISION_CORPUS_PATH = fileURLToPath(
  new URL('../../../data/quality/priority-annotation-decisions.json', import.meta.url),
);

export const JUDGMENT_PROVENANCES: readonly JudgmentProvenance[] = Object.freeze([
  'human_reviewed',
  'synthetic_pipeline_proof',
]);

const CORPUS_KEYS: readonly string[] = Object.freeze([
  'contractVersion',
  'provenance',
  'rubricVersion',
  'exportedAt',
  'decisions',
]);

export interface DecisionCorpusLoadResult {
  readonly valid: boolean;
  readonly issues: readonly ValidationIssue[];
  /** Only rows that validated, and only when the whole corpus validated. */
  readonly decisions: readonly ReviewedDecision[];
  /** Reported, never implied by a zero count elsewhere. */
  readonly corpusEmpty: boolean;
  readonly provenance: JudgmentProvenance | null;
  readonly rubricVersion: string | null;
  readonly contractVersion: string | null;
}

export function readDecisionCorpusFile(path: string = DECISION_CORPUS_PATH): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

/**
 * Validates a corpus and reports why it failed.
 *
 * All-or-nothing on the rows: a corpus with one bad row loads as zero rows plus
 * the reason, rather than as the rows that happened to parse. A silently
 * shortened corpus changes what a calibration is fitted to without telling
 * anyone, which is the failure mode this whole track is built around.
 */
export function parseDecisionCorpus(raw: unknown): DecisionCorpusLoadResult {
  const collector = new IssueCollector();

  if (!isPlainObject(raw)) {
    collector.error('PDC001', 'corpus', 'decision corpus must be an object');
    return {
      ...collector.result(),
      decisions: [],
      corpusEmpty: true,
      provenance: null,
      rubricVersion: null,
      contractVersion: null,
    };
  }

  for (const key of Object.keys(raw)) {
    if (!CORPUS_KEYS.includes(key)) {
      collector.error('PDC004', `corpus.${key}`, `unknown corpus field '${key}'`);
    }
  }

  if (raw.contractVersion !== CALIBRATION_SCHEMA_VERSION) {
    collector.error(
      'PDC002',
      'corpus.contractVersion',
      `expected '${CALIBRATION_SCHEMA_VERSION}', found ${JSON.stringify(raw.contractVersion)}`,
    );
  }

  if (!JUDGMENT_PROVENANCES.includes(raw.provenance as JudgmentProvenance)) {
    collector.error(
      'PDC003',
      'corpus.provenance',
      `provenance must be one of ${JUDGMENT_PROVENANCES.join(' | ')}; a corpus that does not state ` +
        'whether it is reviewer evidence or a pipeline proof cannot be told apart from one that is',
    );
  } else if (raw.provenance === 'human_reviewed' && Array.isArray(raw.decisions) && raw.decisions.length === 0) {
    // A file with no decisions holds no reviewer evidence, whatever it says.
    // Rejected rather than silently downgraded: the claim and the rows
    // disagree, and quietly picking one would hide that somebody wrote a label
    // no data supports.
    collector.error(
      'PDC004',
      'corpus.provenance',
      "a corpus with zero decisions cannot be 'human_reviewed'; ship it as " +
        "'synthetic_pipeline_proof' until real reviewer rows exist",
    );
  }

  const rubricVersion = typeof raw.rubricVersion === 'string' ? raw.rubricVersion : null;
  if (!isNonEmptyString(raw.rubricVersion)) {
    collector.error('PDC005', 'corpus.rubricVersion', 'rubricVersion is required');
  } else if (rubricVersion !== RUBRIC_VERSION) {
    // A warning, not an error: decisions collected under an older rubric are
    // real decisions. They are simply not comparable with newer ones, and that
    // has to be visible rather than fatal.
    collector.warn(
      'PDC006',
      'corpus.rubricVersion',
      `decisions were collected under '${rubricVersion}' but the current rubric is '${RUBRIC_VERSION}'; ` +
        'they are not comparable across rubric versions',
    );
  }

  if (raw.exportedAt !== undefined && !isIsoTimestamp(raw.exportedAt)) {
    collector.error('PDC007', 'corpus.exportedAt', 'exportedAt, when present, must be an ISO-8601 timestamp');
  }

  if (!Array.isArray(raw.decisions)) {
    collector.error('PDC010', 'corpus.decisions', 'decisions must be an array');
    return {
      ...collector.result(),
      decisions: [],
      corpusEmpty: true,
      provenance: null,
      rubricVersion,
      contractVersion: typeof raw.contractVersion === 'string' ? raw.contractVersion : null,
    };
  }

  const accepted: ReviewedDecision[] = [];
  const seenPairReviewer = new Set<string>();
  const seenDecisionIds = new Set<string>();

  raw.decisions.forEach((row, index) => {
    const path = `corpus.decisions[${index}]`;
    const validation = validateReviewedDecision(row, path);
    collector.merge(validation.issues);
    if (!validation.decision) return;

    const decision = validation.decision;
    const pairReviewerKey = `${decision.pairId}::${decision.reviewerId}`;
    if (seenPairReviewer.has(pairReviewerKey)) {
      collector.error(
        'PDC020',
        path,
        `reviewer '${decision.reviewerId}' decided pair '${decision.pairId}' more than once; a repeated ` +
          "row weights one person's opinion by however many times it appears",
      );
    }
    seenPairReviewer.add(pairReviewerKey);

    if (seenDecisionIds.has(decision.decisionId)) {
      collector.error('PDC021', `${path}.decisionId`, `duplicate decisionId '${decision.decisionId}'`);
    }
    seenDecisionIds.add(decision.decisionId);

    accepted.push(decision);
  });

  const result = collector.result();
  return {
    valid: result.valid,
    issues: result.issues,
    decisions: result.valid ? Object.freeze(accepted) : Object.freeze([]),
    corpusEmpty: !result.valid || accepted.length === 0,
    provenance: result.valid ? (raw.provenance as JudgmentProvenance) : null,
    rubricVersion,
    contractVersion: typeof raw.contractVersion === 'string' ? raw.contractVersion : null,
  };
}

/**
 * Loads and validates the shipped corpus.
 *
 * Expected result today: `valid: true`, `corpusEmpty: true`, zero decisions.
 * See `tests/priority/annotationCoverage.test.ts`, and
 * `docs/quality/PRIORITY_ANNOTATION_QUEUE.md` §5 for how a future maintainer
 * supplies real ones.
 */
export function loadShippedDecisionCorpus(options?: { path?: string }): DecisionCorpusLoadResult {
  return parseDecisionCorpus(readDecisionCorpusFile(options?.path));
}
