/**
 * The decomposition corpora, the annotation queue and review ingest
 * (Sprint 06, issue #26).
 *
 * ── Status: the pipeline is real, the review is not ─────────────────
 *
 * #26 asks for a *reviewed* dataset and no reviewer exists. What ships is the
 * whole apparatus — schema, queue, ingest checks, conflict retention,
 * provenance verification — plus a seed corpus every row of which is
 * `provenance: 'synthetic'`, and a reviewed corpus holding **zero rows**. This
 * is the rule Sprint 04 set with its empty judgment corpus and Sprint 05 kept:
 * a dataset that claims review it never had corrupts every number computed
 * from it afterwards, invisibly, because a metric over fabricated labels looks
 * exactly like a metric over real ones.
 *
 * `verifyReviewedProvenance` and `promoteToReviewed` are the two places that
 * make the claim checkable rather than conventional: a row may say
 * `human_reviewed` only when a review row names it, a reviewer and a time.
 * `tests/decomposition/datasetCorpus.test.ts` runs that over the shipped files,
 * so the first reviewed row has to arrive in the same commit as the evidence
 * for it.
 *
 * ── Three files, three roles ────────────────────────────────────────
 *
 *  - `decomposition-seed-examples.json`   — synthetic rows. Proves the pipeline runs.
 *  - `decomposition-reviewed-examples.json` — human-approved rows. Ships empty.
 *  - `decomposition-annotation-reviews.json` — the reviewer decisions. Ships empty.
 *
 * The role is written in the file rather than inferred from its name, and rows
 * are validated against it. A corpus that has to be trusted to be described
 * correctly will eventually be described incorrectly, and the name of a file is
 * exactly the kind of thing a copy-paste changes without changing what is in it.
 *
 * ── Nothing is withheld from this queue ─────────────────────────────
 *
 * Sprint 05's Priority queue withholds the locked split, because a judgment on
 * a locked pair is the signal a policy is *fitted* to and reviewing it destroys
 * the hold-out. The direction is opposite here: review produces the ground
 * truth *labels*, and a locked-test split nobody labelled is not a test set at
 * all. What must not happen here is an edit after sealing, which is
 * `splits.ts`'s checksum, not a queue filter. Copying the Priority rule across
 * would have left the held-out split permanently unlabelled — the right-looking
 * mistake.
 *
 * ── Disagreement is retained, never resolved ────────────────────────
 *
 * Two reviewers who disagree produce two rows and one reported conflict.
 * Collapsing them to a majority would delete the only signal that says the
 * annotation guide is ambiguous, which is the thing a guide gets revised from.
 * `unresolved` is excluded from conflict detection and counted separately: an
 * abstention is neither agreement nor disagreement, and treating it as a
 * conflict pushes a reviewer to guess rather than abstain.
 *
 * No function here reads the system clock; every timestamp is supplied.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { ValidationIssue, ValidationResult } from '../../evaluation/registry/contracts';
import {
  IssueCollector,
  isIsoTimestamp,
  isNonEmptyString,
  isPlainObject,
} from '../../evaluation/registry/validationPrimitives';
import {
  DECOMPOSITION_SCHEMA_VERSION,
  type AnnotationProvenance,
  type DecompositionExample,
  type DecompositionLabelKind,
  type DecompositionStepProposal,
} from '../../../src/contracts/v1/decompositionContracts';
import {
  exceedsValidationLimits,
  isSafeRef,
  validateDecompositionExample,
} from './example';
import { DECOMPOSITION_SPLITS, assignSplit, type DecompositionSplit } from './splits';

export const DECOMPOSITION_CORPUS_CONTRACT_VERSION = '1.0.0' as const;

export const DECOMPOSITION_LABEL_KINDS: readonly DecompositionLabelKind[] = Object.freeze([
  'atomic',
  'multi_step',
  'do_not_split',
]);

export const ANNOTATION_PROVENANCES: readonly AnnotationProvenance[] = Object.freeze([
  'synthetic',
  'human_reviewed',
]);

/** Which claim the rows in a file are allowed to make. */
export type DecompositionCorpusRole = 'seed' | 'reviewed';

/**
 * Resolved from this module rather than `process.cwd()`, so a CLI, a test and
 * an editor task all read the same file regardless of where they were launched.
 */
export const DECOMPOSITION_SEED_CORPUS_PATH = fileURLToPath(
  new URL('../../../data/quality/decomposition-seed-examples.json', import.meta.url),
);
export const DECOMPOSITION_REVIEWED_CORPUS_PATH = fileURLToPath(
  new URL('../../../data/quality/decomposition-reviewed-examples.json', import.meta.url),
);
export const DECOMPOSITION_REVIEW_LOG_PATH = fileURLToPath(
  new URL('../../../data/quality/decomposition-annotation-reviews.json', import.meta.url),
);

/**
 * How a corpus row is named in an issue message or path.
 *
 * `exampleId` is constrained only by `isNonEmptyString`, and a corpus file is a
 * trust boundary: a crafted row put the sentence
 * "I owe Ahmed 40000 for the abortion clinic" verbatim into three issue
 * messages. This is the same argument `stepRef` makes for `stepId` — a
 * caller-supplied string is as untrusted as the source text — applied to the
 * other caller-supplied string in this module.
 *
 * The row's position is always sufficient to find it, so an id that fails
 * `isSafeRef` is replaced by one. Real corpus ids pass, which is the only
 * reason to keep them at all.
 */
function exampleRef(exampleId: unknown, index: number): string {
  return isSafeRef(exampleId) ? `'${exampleId}'` : `#${index}`;
}

/**
 * The same, where no position is available — a thrown error names one example.
 * "the example" is vague and safe; a leaked sentence is precise and not.
 */
function exampleLabel(exampleId: unknown): string {
  return isSafeRef(exampleId) ? `'${exampleId}'` : 'the example';
}

function fail(message: string): never {
  throw new Error(`decomposition corpus: ${message}`);
}

/** Code-unit ordering, never localeCompare: these files are committed. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/* ── Reviews ────────────────────────────────────────────────────── */

/**
 * `approve` accepts the row as labelled. `relabel` names a different label.
 * `reject` says the example should not be in the corpus at all — a source text
 * that is unusable, not a label that is wrong. `unresolved` is an abstention.
 *
 * Reject and relabel are separate because merging them would make "this row is
 * mislabelled" and "this row should not exist" the same edit, and only one of
 * them changes the size of the corpus.
 */
export type DecompositionReviewVerdict = 'approve' | 'relabel' | 'reject' | 'unresolved';

export const REVIEW_VERDICTS: readonly DecompositionReviewVerdict[] = Object.freeze([
  'approve',
  'relabel',
  'reject',
  'unresolved',
]);

export const REVIEW_ID_PREFIX = 'drv_';

/**
 * Deliberately narrower than "a non-empty string": no dot, no separator. Review
 * ids are caller-supplied and end up naming rows in an import file, so an id
 * that could name `..` or a path is refused rather than sanitised — a sanitised
 * id can collide with a different reviewer's, silently merging two people's
 * opinions into one row.
 */
export const REVIEW_ID_PATTERN = /^drv_[A-Za-z0-9_-]{1,160}$/;

export interface DecompositionReview {
  readonly version: typeof DECOMPOSITION_SCHEMA_VERSION;
  readonly reviewId: string;
  readonly exampleId: string;
  readonly reviewerId: string;
  readonly verdict: DecompositionReviewVerdict;
  /** The label the reviewer proposes. Non-null exactly when `verdict` is `relabel`. */
  readonly label: DecompositionLabelKind | null;
  /** Whether the reviewer checked each span against the source text by hand. */
  readonly spansVerified: boolean;
  readonly rationale: string;
  readonly reviewedAt: string;
}

/** The fields a caller may assert. Everything else on the row is assigned here. */
export interface CreateReviewInput {
  readonly exampleId: string;
  readonly reviewerId: string;
  readonly verdict: DecompositionReviewVerdict;
  readonly label: DecompositionLabelKind | null;
  readonly spansVerified: boolean;
  readonly rationale: string;
  readonly reviewedAt: string;
  /** Optional; defaults to the deterministic id for (example, reviewer). */
  readonly reviewId?: string;
}

const REVIEW_KEYS: readonly string[] = Object.freeze([
  'version',
  'reviewId',
  'exampleId',
  'reviewerId',
  'verdict',
  'label',
  'spansVerified',
  'rationale',
  'reviewedAt',
]);

/**
 * The canonical id for one reviewer's review of one example.
 *
 * Deterministic rather than random, so re-importing the same reviewer file
 * twice produces the same id and is caught as a duplicate instead of stored
 * twice under two names.
 */
export function reviewIdFor(exampleId: string, reviewerId: string): string {
  if (!isNonEmptyString(exampleId)) fail('cannot mint a review id without an exampleId');
  if (!isNonEmptyString(reviewerId)) fail('cannot mint a review id without a reviewerId');
  const candidate = `${REVIEW_ID_PREFIX}${exampleId}__${reviewerId}`;
  if (!REVIEW_ID_PATTERN.test(candidate)) {
    fail(
      `cannot mint a review id from exampleId '${exampleId}' and reviewerId '${reviewerId}': ` +
        `the result must match ${String(REVIEW_ID_PATTERN)}. Pass an explicit reviewId instead.`,
    );
  }
  return candidate;
}

/**
 * The only constructor for a review.
 *
 * Validates first, then writes every field explicitly rather than spreading the
 * input, so a forged `version` — or any other property riding along on the
 * caller's object — has nowhere to land. The caller supplies claims, not record
 * fields; this is the technique `lib/priority/annotation/reviewedDecision.ts`
 * uses, for the same reason.
 *
 * `reviewerId` and `reviewedAt` are required here *and* in
 * `validateDecompositionReview`, because a type does not survive a `JSON.parse`
 * or a hand-edited file, and a review whose author or time is unknown cannot be
 * audited.
 */
export function createDecompositionReview(input: CreateReviewInput): DecompositionReview {
  if (!isPlainObject(input)) fail('review input must be an object');
  if (!isNonEmptyString(input.exampleId)) fail('exampleId is required');
  if (!isNonEmptyString(input.reviewerId)) fail('reviewerId is required: an anonymous review cannot be audited');
  if (REVIEW_VERDICTS.indexOf(input.verdict) < 0) fail(`verdict must be one of ${REVIEW_VERDICTS.join(' | ')}`);
  if (!isIsoTimestamp(input.reviewedAt)) {
    fail('reviewedAt must be an ISO-8601 timestamp; this module reads no clock of its own');
  }
  if (typeof input.spansVerified !== 'boolean') fail('spansVerified must be a boolean');
  if (!isNonEmptyString(input.rationale)) fail('rationale is required');

  if (input.verdict === 'relabel') {
    if (input.label === null || DECOMPOSITION_LABEL_KINDS.indexOf(input.label) < 0) {
      fail("a 'relabel' review must name the label it proposes; otherwise nobody can act on it");
    }
  } else if (input.label !== null) {
    fail(
      `a '${input.verdict}' review must leave label null: a label beside a verdict that does not change one ` +
        'reads as a second, contradictory opinion',
    );
  }

  return Object.freeze({
    version: DECOMPOSITION_SCHEMA_VERSION,
    reviewId: input.reviewId ?? reviewIdFor(input.exampleId, input.reviewerId),
    exampleId: input.exampleId,
    reviewerId: input.reviewerId,
    verdict: input.verdict,
    label: input.label,
    spansVerified: input.spansVerified,
    rationale: input.rationale,
    reviewedAt: input.reviewedAt,
  });
}

export interface ReviewValidationResult {
  readonly issues: readonly ValidationIssue[];
  /** Null unless every field validated. */
  readonly review: DecompositionReview | null;
}

/** The only way a review enters from outside this process. */
export function validateDecompositionReview(raw: unknown, path = 'review'): ReviewValidationResult {
  const collector = new IssueCollector();

  if (!isPlainObject(raw)) {
    collector.error('DXR001', path, 'review must be an object');
    return { issues: collector.result().issues, review: null };
  }
  for (const key of Object.keys(raw)) {
    if (REVIEW_KEYS.indexOf(key) < 0) collector.error('DXR002', `${path}.${key}`, `unknown review field '${key}'`);
  }
  if (raw.version !== DECOMPOSITION_SCHEMA_VERSION) {
    collector.error(
      'DXR003',
      `${path}.version`,
      `expected '${DECOMPOSITION_SCHEMA_VERSION}', found ${JSON.stringify(raw.version)}`,
    );
  }
  if (typeof raw.reviewId !== 'string' || !REVIEW_ID_PATTERN.test(raw.reviewId)) {
    collector.error('DXR004', `${path}.reviewId`, `reviewId must match ${String(REVIEW_ID_PATTERN)}`);
  }
  if (!isNonEmptyString(raw.exampleId)) collector.error('DXR005', `${path}.exampleId`, 'exampleId is required');
  if (!isNonEmptyString(raw.reviewerId)) {
    collector.error('DXR006', `${path}.reviewerId`, 'reviewerId is required: an anonymous review cannot be audited');
  }
  if (REVIEW_VERDICTS.indexOf(raw.verdict as DecompositionReviewVerdict) < 0) {
    collector.error('DXR007', `${path}.verdict`, `verdict must be one of ${REVIEW_VERDICTS.join(' | ')}`);
  }
  if (raw.verdict === 'relabel') {
    if (DECOMPOSITION_LABEL_KINDS.indexOf(raw.label as DecompositionLabelKind) < 0) {
      collector.error('DXR008', `${path}.label`, "a 'relabel' review must name the label it proposes");
    }
  } else if (raw.label !== null) {
    collector.error('DXR009', `${path}.label`, `a '${String(raw.verdict)}' review must leave label null`);
  }
  if (typeof raw.spansVerified !== 'boolean') {
    collector.error('DXR010', `${path}.spansVerified`, 'spansVerified must be a boolean');
  }
  if (!isNonEmptyString(raw.rationale)) collector.error('DXR011', `${path}.rationale`, 'rationale is required');
  if (!isIsoTimestamp(raw.reviewedAt)) {
    collector.error('DXR012', `${path}.reviewedAt`, 'reviewedAt must be an ISO-8601 timestamp');
  }

  const result = collector.result();
  return { issues: result.issues, review: result.valid ? (raw as unknown as DecompositionReview) : null };
}

/* ── Review log file ────────────────────────────────────────────── */

export interface ReviewLogLoadResult {
  readonly valid: boolean;
  readonly issues: readonly ValidationIssue[];
  readonly reviews: readonly DecompositionReview[];
  /** Reported, never implied by a zero count elsewhere. */
  readonly corpusEmpty: boolean;
}

export function readReviewLogFile(path: string = DECOMPOSITION_REVIEW_LOG_PATH): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

/**
 * All-or-nothing on the rows. A log with one bad row loads as zero rows plus
 * the reason, rather than as the rows that happened to parse: a silently
 * shortened log changes who is on record as having reviewed what.
 */
export function parseReviewLog(raw: unknown): ReviewLogLoadResult {
  const collector = new IssueCollector();

  if (!isPlainObject(raw)) {
    collector.error('DXL001', 'log', 'review log must be an object');
    return { ...collector.result(), reviews: [], corpusEmpty: true };
  }
  if (raw.contractVersion !== DECOMPOSITION_CORPUS_CONTRACT_VERSION) {
    collector.error(
      'DXL002',
      'log.contractVersion',
      `expected '${DECOMPOSITION_CORPUS_CONTRACT_VERSION}', found ${JSON.stringify(raw.contractVersion)}`,
    );
  }
  if (!Array.isArray(raw.reviews)) {
    collector.error('DXL003', 'log.reviews', 'reviews must be an array');
    return { ...collector.result(), reviews: [], corpusEmpty: true };
  }

  const accepted: DecompositionReview[] = [];
  const seen = new Set<string>();
  raw.reviews.forEach((row, index) => {
    const validation = validateDecompositionReview(row, `log.reviews[${index}]`);
    collector.merge(validation.issues);
    if (!validation.review) return;
    const key = `${validation.review.exampleId}::${validation.review.reviewerId}`;
    if (seen.has(key)) {
      collector.error(
        'DXL004',
        `log.reviews[${index}]`,
        `reviewer '${validation.review.reviewerId}' reviewed '${validation.review.exampleId}' more than once; ` +
          "a repeated row weights one person's opinion by however many times it appears",
      );
    }
    seen.add(key);
    accepted.push(validation.review);
  });

  const result = collector.result();
  return {
    valid: result.valid,
    issues: result.issues,
    reviews: result.valid ? Object.freeze(accepted) : Object.freeze([]),
    corpusEmpty: !result.valid || accepted.length === 0,
  };
}

export function loadShippedReviewLog(options?: { readonly path?: string }): ReviewLogLoadResult {
  return parseReviewLog(readReviewLogFile(options?.path));
}

/* ── Example corpus files ───────────────────────────────────────── */

const CORPUS_KEYS: readonly string[] = Object.freeze([
  'contractVersion',
  'schema',
  'role',
  'note',
  'examples',
]);

const EXAMPLE_KEYS: readonly string[] = Object.freeze([
  'exampleId',
  'locale',
  'sourceText',
  'label',
  'provenance',
  'expectedSteps',
  'note',
]);

const STEP_KEYS: readonly string[] = Object.freeze([
  'stepId',
  'title',
  'sourceSpans',
  'inferred',
  'dependsOn',
  'statedTiming',
  'statedOwner',
]);

const SPAN_KEYS: readonly string[] = Object.freeze(['start', 'end', 'text']);

/**
 * Shape-checks one `expectedSteps` element before anything reads it.
 *
 * `validateDecompositionExample` takes a typed `DecompositionExample` and
 * trusts its shape, which is correct for a typed caller and wrong for JSON.
 * Casting a parsed row straight to the type turned this function — the corpus
 * gate, the trust boundary for everything arriving as a file — into a source of
 * raw `TypeError`s: a null step, a numeric title, a missing `dependsOn` and
 * four other shapes each crashed it. A gate that throws instead of reporting is
 * not a gate, because the caller cannot tell a malformed file from a bug.
 *
 * Answers in this module's own `DXC0xx` vocabulary. The shared violation codes
 * describe a decomposition that is wrong; these describe a file that is not a
 * decomposition at all, and #27 never sees one.
 */
function validateStepShape(raw: unknown, path: string, collector: IssueCollector): boolean {
  if (!isPlainObject(raw)) {
    collector.error('DXC033', path, 'expected step must be an object');
    return false;
  }
  for (const key of Object.keys(raw)) {
    if (STEP_KEYS.indexOf(key) < 0) collector.error('DXC033', `${path}.${key}`, `unknown step field '${key}'`);
  }

  let ok = true;
  const require = (condition: boolean, field: string, message: string) => {
    if (!condition) {
      collector.error('DXC033', `${path}.${field}`, message);
      ok = false;
    }
  };

  require(isNonEmptyString(raw.stepId), 'stepId', 'stepId must be a non-empty string');
  require(typeof raw.title === 'string', 'title', 'title must be a string');
  require(typeof raw.inferred === 'boolean', 'inferred', 'inferred must be a boolean');
  require(
    raw.statedTiming === null || typeof raw.statedTiming === 'string',
    'statedTiming',
    'statedTiming must be a string or null',
  );
  require(
    raw.statedOwner === null || typeof raw.statedOwner === 'string',
    'statedOwner',
    'statedOwner must be a string or null',
  );

  if (!Array.isArray(raw.sourceSpans)) {
    require(false, 'sourceSpans', 'sourceSpans must be an array');
  } else {
    raw.sourceSpans.forEach((span, index) => {
      const spanPath = `${path}.sourceSpans[${index}]`;
      if (!isPlainObject(span)) {
        collector.error('DXC033', spanPath, 'span must be an object');
        ok = false;
        return;
      }
      for (const key of Object.keys(span)) {
        if (SPAN_KEYS.indexOf(key) < 0) collector.error('DXC033', `${spanPath}.${key}`, `unknown span field '${key}'`);
      }
      if (!Number.isInteger(span.start) || !Number.isInteger(span.end) || typeof span.text !== 'string') {
        collector.error('DXC033', spanPath, 'span needs integer start and end and a string text');
        ok = false;
      }
    });
  }

  if (!Array.isArray(raw.dependsOn)) {
    require(false, 'dependsOn', 'dependsOn must be an array');
  } else {
    raw.dependsOn.forEach((edge, index) => {
      const edgePath = `${path}.dependsOn[${index}]`;
      if (
        !isPlainObject(edge) ||
        !isNonEmptyString(edge.dependsOnStepId) ||
        (edge.kind !== 'temporal' && edge.kind !== 'resource' && edge.kind !== 'informational')
      ) {
        collector.error('DXC033', edgePath, 'edge needs a dependsOnStepId and a kind of temporal|resource|informational');
        ok = false;
      }
    });
  }

  return ok;
}

export interface ParseExampleCorpusOptions {
  /**
   * The reviews backing any `human_reviewed` row in this file.
   *
   * Defaults to **empty**, which means a reviewed row fails unless the caller
   * supplies its evidence. That direction is deliberate. The alternative — read
   * the shipped review log from in here — would make the parser do I/O and
   * would make "no evidence" the quiet success case; this way the parser stays
   * pure and the unsafe direction is the one a caller has to ask for.
   */
  readonly reviews?: readonly DecompositionReview[];
}

export interface ExampleCorpusLoadResult {
  readonly valid: boolean;
  readonly issues: readonly ValidationIssue[];
  /** Only rows that validated, and only when the whole corpus validated. */
  readonly examples: readonly DecompositionExample[];
  readonly corpusEmpty: boolean;
  readonly role: DecompositionCorpusRole | null;
}

export function readExampleCorpusFile(path: string = DECOMPOSITION_SEED_CORPUS_PATH): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

/**
 * Validates a corpus file and reports why it failed.
 *
 * The provenance a row is allowed to claim is decided by the file's `role`,
 * which is the check that makes "Sprint 06 ships no reviewed rows" a property
 * of the data rather than of a convention nobody enforces. Rows are also run
 * through `validateDecompositionExample`: ground truth that violates the shared
 * vocabulary is worse than a wrong model, because every score computed against
 * it is measured off a broken ruler.
 */
export function parseExampleCorpus(
  raw: unknown,
  options: ParseExampleCorpusOptions = {},
): ExampleCorpusLoadResult {
  const collector = new IssueCollector();

  if (!isPlainObject(raw)) {
    collector.error('DXC001', 'corpus', 'example corpus must be an object');
    return { ...collector.result(), examples: [], corpusEmpty: true, role: null };
  }
  for (const key of Object.keys(raw)) {
    if (CORPUS_KEYS.indexOf(key) < 0) collector.error('DXC002', `corpus.${key}`, `unknown corpus field '${key}'`);
  }
  if (raw.contractVersion !== DECOMPOSITION_CORPUS_CONTRACT_VERSION) {
    collector.error(
      'DXC003',
      'corpus.contractVersion',
      `expected '${DECOMPOSITION_CORPUS_CONTRACT_VERSION}', found ${JSON.stringify(raw.contractVersion)}`,
    );
  }
  if (raw.schema !== DECOMPOSITION_SCHEMA_VERSION) {
    collector.error(
      'DXC004',
      'corpus.schema',
      `expected '${DECOMPOSITION_SCHEMA_VERSION}', found ${JSON.stringify(raw.schema)}`,
    );
  }
  if (raw.role !== 'seed' && raw.role !== 'reviewed') {
    collector.error(
      'DXC005',
      'corpus.role',
      "role must be 'seed' or 'reviewed'; a corpus that does not state which claim its rows may make cannot " +
        'be told apart from one whose rows make the wrong one',
    );
  }
  if (!isNonEmptyString(raw.note)) {
    collector.error('DXC006', 'corpus.note', 'note is required: a data file with no stated purpose acquires one');
  }
  if (!Array.isArray(raw.examples)) {
    collector.error('DXC007', 'corpus.examples', 'examples must be an array');
    return { ...collector.result(), examples: [], corpusEmpty: true, role: null };
  }

  const role = raw.role === 'seed' || raw.role === 'reviewed' ? (raw.role as DecompositionCorpusRole) : null;
  const accepted: DecompositionExample[] = [];
  const seenIds = new Set<string>();

  raw.examples.forEach((row, index) => {
    const path = `corpus.examples[${index}]`;
    if (!isPlainObject(row)) {
      collector.error('DXC010', path, 'example must be an object');
      return;
    }
    for (const key of Object.keys(row)) {
      if (EXAMPLE_KEYS.indexOf(key) < 0) collector.error('DXC011', `${path}.${key}`, `unknown example field '${key}'`);
    }
    if (!isNonEmptyString(row.exampleId)) {
      collector.error('DXC012', `${path}.exampleId`, 'exampleId is required');
      return;
    }
    if (seenIds.has(row.exampleId)) {
      collector.error('DXC013', `${path}.exampleId`, `duplicate exampleId ${exampleRef(row.exampleId, index)}`);
    }
    seenIds.add(row.exampleId);

    if (!isNonEmptyString(row.locale)) collector.error('DXC014', `${path}.locale`, 'locale is required');
    if (typeof row.sourceText !== 'string' || row.sourceText.length === 0) {
      collector.error('DXC015', `${path}.sourceText`, 'sourceText must be a non-empty string');
    }
    if (DECOMPOSITION_LABEL_KINDS.indexOf(row.label as DecompositionLabelKind) < 0) {
      collector.error('DXC016', `${path}.label`, `label must be one of ${DECOMPOSITION_LABEL_KINDS.join(' | ')}`);
    }
    if (ANNOTATION_PROVENANCES.indexOf(row.provenance as AnnotationProvenance) < 0) {
      collector.error('DXC017', `${path}.provenance`, `provenance must be one of ${ANNOTATION_PROVENANCES.join(' | ')}`);
    } else if (role === 'seed' && row.provenance !== 'synthetic') {
      collector.error(
        'DXC020',
        `${path}.provenance`,
        `${exampleRef(row.exampleId, index)} claims '${String(row.provenance)}' in a seed file. Seed rows are written by ` +
          'engineering to prove the pipeline runs; a reviewed claim here is a claim no reviewer backs',
      );
    } else if (role === 'reviewed' && row.provenance !== 'human_reviewed') {
      collector.error(
        'DXC021',
        `${path}.provenance`,
        `${exampleRef(row.exampleId, index)} claims '${String(row.provenance)}' in the reviewed corpus; synthetic rows belong ` +
          'in the seed file, where nothing downstream will read them as evidence',
      );
    }
    if (!Array.isArray(row.expectedSteps)) {
      collector.error('DXC018', `${path}.expectedSteps`, 'expectedSteps must be an array');
      return;
    }
    if (!isNonEmptyString(row.note)) {
      collector.error(
        'DXC019',
        `${path}.note`,
        'note is required, especially on a do_not_split row: why it must not split is the whole content of the label',
      );
    }

    // Shape before semantics: `validateDecompositionExample` takes a typed
    // example and trusts it, so a row that is not one must be stopped here
    // rather than cast past the type system into a TypeError.
    let shapeOk = true;
    (row.expectedSteps as unknown[]).forEach((step, stepIndex) => {
      if (!validateStepShape(step, `${path}.expectedSteps[${stepIndex}]`, collector)) shapeOk = false;
    });
    if (!shapeOk) return;

    // Size before semantics. Overlap analysis is bounded per step pair, but a
    // row carrying thousands of spans still costs time to compare and produced,
    // before that change, 1,279,201 issues and 253 MB of message strings out of
    // 1,600 spans. A corpus file is a trust boundary; oversized input is
    // refused here rather than absorbed.
    const breach = exceedsValidationLimits(row.expectedSteps as DecompositionStepProposal[]);
    if (breach !== null) {
      collector.error(
        'DXC034',
        breach.stepIndex === null ? `${path}.expectedSteps` : `${path}.expectedSteps[${breach.stepIndex}]`,
        `${breach.limit} is ${breach.observed}, above the limit of ${breach.allowed}; no decomposition of one ` +
          'sentence reaches this, and analysing it costs more than refusing it',
      );
      return;
    }

    const example = row as unknown as DecompositionExample;
    const validation = validateDecompositionExample(example);
    collector.merge(validation.corpusIssues);
    for (const violation of validation.violations) {
      collector.error(
        'DXC030',
        `${path}`,
        `${violation.code}: ${violation.detail}. Ground truth that breaks the shared vocabulary makes every ` +
          'score computed against it a measurement off a broken ruler',
      );
    }
    accepted.push(example);
  });

  // Provenance is checked *here*, not only in the loader above it. This
  // function is exported from evaluation/index.ts and is directly reachable, so
  // a check that lived only one level up was one import away from being
  // bypassed — and an in-process caller is exactly how the next maintainer will
  // reach it.
  collector.merge(verifyReviewedProvenance({ examples: accepted, reviews: options.reviews ?? [] }).issues);

  const result = collector.result();
  return {
    valid: result.valid,
    issues: result.issues,
    examples: result.valid ? Object.freeze(accepted) : Object.freeze([]),
    corpusEmpty: !result.valid || accepted.length === 0,
    role,
  };
}

export interface LoadCorpusOptions {
  readonly path?: string;
  /** Overrides the file read. For tests; the shipped path is the default. */
  readonly raw?: unknown;
  /** Defaults to the committed review log. Only meaningful for the reviewed role. */
  readonly reviews?: readonly DecompositionReview[];
}

/**
 * Loads a corpus file **and refuses one playing the other role**.
 *
 * The role guard is the second door found around the honesty check.
 * `verifyReviewedProvenance` skips every row that is not `human_reviewed`, so a
 * file with no reviewed rows in it passes the check meant to police reviewed
 * rows — and `loadReviewedCorpus` pointed at the seed file therefore returned
 * all 23 synthetic rows and called them valid. The function whose entire job is
 * "return only rows a person approved" was handing back rows nobody had looked
 * at. Neither the provenance check nor the row-level `role` check
 * (`DXC020`/`DXC021`) can catch that on its own: both are about the rows, and
 * this is about which file you opened.
 *
 * A corpus that fails yields zero rows, never the rows it just refused.
 */
function loadCorpusForRole(
  raw: unknown,
  expectedRole: DecompositionCorpusRole,
  reviews: readonly DecompositionReview[],
): ExampleCorpusLoadResult {
  const parsed = parseExampleCorpus(raw, { reviews });
  if (parsed.role === expectedRole) return parsed;

  const collector = new IssueCollector();
  collector.error(
    'DXC022',
    'corpus.role',
    `this loader reads the '${expectedRole}' corpus but the file declares role ` +
      `${JSON.stringify(parsed.role)}; the two corpora make different claims about their rows and are not ` +
      'interchangeable',
  );
  return {
    valid: false,
    issues: Object.freeze([...parsed.issues, ...collector.result().issues]),
    examples: Object.freeze([]),
    corpusEmpty: true,
    role: parsed.role,
  };
}

export function loadSeedCorpus(options?: LoadCorpusOptions): ExampleCorpusLoadResult {
  const raw =
    options?.raw !== undefined
      ? options.raw
      : readExampleCorpusFile(options?.path ?? DECOMPOSITION_SEED_CORPUS_PATH);
  // No reviews: a seed file may not carry a reviewed row at all (DXC020), so
  // supplying evidence for one would be answering a question it cannot ask.
  return loadCorpusForRole(raw, 'seed', []);
}

/** Retained as the documented name for the reviewed loader's options. */
export type LoadReviewedCorpusOptions = LoadCorpusOptions;

/**
 * Loads the reviewed corpus, checks its rows are backed, and checks it is
 * actually the reviewed corpus.
 *
 * A corpus that fails yields zero rows, not the rows that happened to pass. A
 * partly-trusted corpus of human judgements is not a corpus of human
 * judgements.
 */
export function loadReviewedCorpus(options?: LoadReviewedCorpusOptions): ExampleCorpusLoadResult {
  const raw =
    options?.raw !== undefined
      ? options.raw
      : readExampleCorpusFile(options?.path ?? DECOMPOSITION_REVIEWED_CORPUS_PATH);
  return loadCorpusForRole(raw, 'reviewed', options?.reviews ?? loadShippedReviewLog().reviews);
}

/* ── Provenance ─────────────────────────────────────────────────── */

/**
 * Whether one review is evidence that `example` was approved as it stands.
 *
 * Extracted so `verifyReviewedProvenance` and `promoteToReviewed` cannot
 * diverge. They did: the minter refused an abstention and the verifier accepted
 * one, and since the verifier is the half wired into the shipped-file guard,
 * the weaker of the two was what actually ran. A rule enforced in two places by
 * two pieces of code is a rule enforced by whichever is laxer.
 *
 * Where each verdict lands, and why:
 *
 *  - `approve` is the only affirmative judgement. It is evidence.
 *  - `reject` says the row is unusable. Reading it as approval would certify
 *    the exact row the one person who looked at it threw out.
 *  - `unresolved` is an abstention. Someone who abstained is precisely someone
 *    who did not judge the row.
 *  - `relabel` is evidence **only for the label the reviewer proposed**. If the
 *    caller has not applied it, promoting the row would stamp `human_reviewed`
 *    on the label the reviewer rejected and silently discard the one they asked
 *    for — the reviewer's judgement inverted, then certified.
 */
export function isBackingReview(
  example: Pick<DecompositionExample, 'exampleId' | 'label' | 'expectedSteps'>,
  review: DecompositionReview,
): boolean {
  if (review.exampleId !== example.exampleId) return false;

  // The whole row is re-validated, not just author and time. A type does not
  // survive a JSON.parse or a hand-edited file, and a bare object literal
  // carrying four plausible fields — no version, no reviewId, no rationale —
  // used to mint a `human_reviewed` row. Evidence is checked before it is
  // counted as evidence.
  if (validateDecompositionReview(review).review === null) return false;

  // `spansVerified` is load-bearing or it is a lie. An approval certifies the
  // whole row, spans included; a reviewer who did not look at them has not
  // certified them. A row carrying no spans has nothing to verify, and
  // demanding an attestation about nothing is how a checkbox becomes a reflex —
  // so the requirement is conditional on there being something to check.
  if (exampleCarriesSpans(example) && !review.spansVerified) return false;

  if (review.verdict === 'approve') return true;
  return review.verdict === 'relabel' && review.label === example.label;
}

function exampleCarriesSpans(example: Pick<DecompositionExample, 'expectedSteps'>): boolean {
  return example.expectedSteps.some((step) => step.sourceSpans.length > 0);
}

export interface VerifyReviewedProvenanceOptions {
  readonly examples: readonly DecompositionExample[];
  readonly reviews: readonly DecompositionReview[];
}

/**
 * Checks that every row claiming human review has a review behind it.
 *
 * This is the honesty rule made checkable. `human_reviewed` is a claim about
 * the world, and the only thing that makes it true is a named person having
 * looked at the row at a stated time. Without this check the label is a string
 * anyone can type, and every metric computed downstream inherits it.
 */
export function verifyReviewedProvenance(options: VerifyReviewedProvenanceOptions): ValidationResult {
  const collector = new IssueCollector();
  const backing = new Map<string, DecompositionReview[]>();
  for (const row of options.reviews) {
    const existing = backing.get(row.exampleId);
    if (existing) existing.push(row);
    else backing.set(row.exampleId, [row]);
  }

  let index = -1;
  for (const example of options.examples) {
    index += 1;
    if (example.provenance !== 'human_reviewed') continue;
    const reviews = (backing.get(example.exampleId) ?? []).filter((row) => isBackingReview(example, row));
    if (reviews.length === 0) {
      collector.error(
        'DXP010',
        `examples[${exampleRef(example.exampleId, index)}].provenance`,
        `${exampleRef(example.exampleId, index)} claims 'human_reviewed' but no review approves it as labelled. A rejection, ` +
          'an abstention, and a relabel the row has not had applied are all reviews — none of them is an ' +
          'approval. A dataset that claims review it never had corrupts every number computed from it ' +
          'afterwards, and does so invisibly',
      );
    }
  }

  return collector.result();
}

/**
 * The only way to mint a `human_reviewed` row.
 *
 * Throws when no review backs it, rather than returning a synthetic row: a
 * function that silently downgrades would let a caller believe it promoted
 * something. Every field is written explicitly so a caller cannot smuggle one
 * in through the example object.
 */
export function promoteToReviewed(
  example: DecompositionExample,
  reviews: readonly DecompositionReview[],
): DecompositionExample {
  const backing = reviews.filter((row) => isBackingReview(example, row));
  if (backing.length === 0) {
    // Name the near miss. A relabel the caller forgot to apply is the failure
    // most likely to read as a bug in this function rather than as a step
    // skipped in the promotion, so it is called out by name.
    const pendingRelabel = reviews.filter(
      (row) => row.exampleId === example.exampleId && row.verdict === 'relabel' && row.label !== example.label,
    );
    const unchecked = reviews.filter(
      (row) =>
        row.exampleId === example.exampleId &&
        !row.spansVerified &&
        exampleCarriesSpans(example) &&
        validateDecompositionReview(row).review !== null,
    );
    if (unchecked.length > 0) {
      fail(
        `${exampleLabel(example.exampleId)} carries source spans and its only reviews were filed with ` +
          "spansVerified: false. An approval that did not check the spans is not evidence that the spans " +
          'are right, and promoting the row would certify offsets nobody read',
      );
    }
    if (pendingRelabel.length > 0) {
      fail(
        `${exampleLabel(example.exampleId)} is labelled '${example.label}' but its only reviews propose a relabel to ` +
          `'${String(pendingRelabel[0].label)}'. Apply the relabel to the row and promote that one, or the ` +
          'stamped row would certify the label the reviewer rejected',
      );
    }
    fail(
      `${exampleLabel(example.exampleId)} has no 'approve' review from a named reviewer at a stated time, so it cannot be ` +
        "promoted to 'human_reviewed'. A reject and an abstention are reviews; neither is an approval",
    );
  }
  return Object.freeze({
    exampleId: example.exampleId,
    locale: example.locale,
    sourceText: example.sourceText,
    label: example.label,
    provenance: 'human_reviewed' as AnnotationProvenance,
    expectedSteps: example.expectedSteps,
    note: example.note,
  });
}

/* ── Queue ──────────────────────────────────────────────────────── */

export type QueueItemState = 'pending' | 'decided' | 'skipped';

export const QUEUE_ITEM_STATES: readonly QueueItemState[] = Object.freeze(['pending', 'decided', 'skipped']);

export const QUEUE_ITEM_ID_PREFIX = 'dq_';
export const QUEUE_ITEM_ID_PATTERN = /^dq_[A-Za-z0-9_-]{1,140}$/;

export interface DecompositionQueueItem {
  readonly version: typeof DECOMPOSITION_SCHEMA_VERSION;
  readonly itemId: string;
  readonly exampleId: string;
  readonly locale: string;
  /** The label the reviewer is asked to confirm or replace. */
  readonly proposedLabel: DecompositionLabelKind;
  /** Carried so coverage can be read per split; the queue withholds nothing. */
  readonly split: DecompositionSplit;
  readonly expectedStepCount: number;
  readonly state: QueueItemState;
  readonly enqueuedAt: string;
}

/** Throws rather than sanitising: a rewritten id could collide with another example's. */
export function queueItemIdFor(exampleId: string): string {
  const candidate = `${QUEUE_ITEM_ID_PREFIX}${exampleId}`;
  if (!isNonEmptyString(exampleId) || !QUEUE_ITEM_ID_PATTERN.test(candidate)) {
    fail(
      `cannot mint a queue item id from example id ${JSON.stringify(exampleId)}: ` +
        `the result must match ${String(QUEUE_ITEM_ID_PATTERN)}`,
    );
  }
  return candidate;
}

export interface BuildQueueOptions {
  readonly examples: readonly DecompositionExample[];
  /** Supplied, never read from a clock. */
  readonly enqueuedAt: string;
}

export interface DecompositionQueueBuild {
  readonly items: readonly DecompositionQueueItem[];
}

/**
 * Builds the queue a reviewer is handed.
 *
 * Deterministic: examples are ordered by id, every timestamp is the supplied
 * one, and no id is random — so two runs over an unchanged corpus produce byte
 * identical output, which is what makes a batch exportable, reviewable offline
 * and re-importable as the same batch.
 */
export function buildDecompositionQueue(options: BuildQueueOptions): DecompositionQueueBuild {
  if (!isPlainObject(options)) fail('options must be an object');
  if (!isIsoTimestamp(options.enqueuedAt)) {
    fail('enqueuedAt must be an ISO-8601 timestamp; the queue reads no clock of its own');
  }
  const examples = options.examples.slice().sort((a, b) => byCodeUnit(a.exampleId, b.exampleId));

  return Object.freeze({
    items: Object.freeze(
      examples.map((example) =>
        Object.freeze({
          version: DECOMPOSITION_SCHEMA_VERSION,
          itemId: queueItemIdFor(example.exampleId),
          exampleId: example.exampleId,
          locale: example.locale,
          proposedLabel: example.label,
          split: assignSplit(example.exampleId),
          expectedStepCount: example.expectedSteps.length,
          state: 'pending' as QueueItemState,
          enqueuedAt: options.enqueuedAt,
        }),
      ),
    ),
  });
}

/**
 * Marks every item that carries at least one review as `decided`.
 *
 * Derived from the reviews rather than mutated as a side effect of ingest, so
 * the queue can always be recomputed from (corpus, reviews) and cannot drift
 * out of step with the log.
 */
export function applyReviewsToQueue(
  items: readonly DecompositionQueueItem[],
  reviews: readonly DecompositionReview[],
): readonly DecompositionQueueItem[] {
  const reviewed = new Set(reviews.map((row) => row.exampleId));
  return Object.freeze(
    items.map((item) =>
      // A review wins over a skip: the item demonstrably was reviewed, and
      // leaving it `skipped` would understate coverage.
      reviewed.has(item.exampleId) && item.state !== 'decided'
        ? Object.freeze({ ...item, state: 'decided' as QueueItemState })
        : item,
    ),
  );
}

/**
 * Marks one item skipped.
 *
 * Refuses to skip a decided item: overwriting `decided` with `skipped` would
 * erase the fact that a review exists while leaving the review itself in the
 * log, and the two would then disagree about what happened.
 */
export function markQueueItemSkipped(
  items: readonly DecompositionQueueItem[],
  itemId: string,
): readonly DecompositionQueueItem[] {
  const target = items.find((item) => item.itemId === itemId);
  if (!target) fail(`unknown queue item '${String(itemId)}'`);
  if (target.state === 'decided') {
    fail(`'${itemId}' is already decided; skipping it would contradict a review that exists`);
  }
  return Object.freeze(
    items.map((item) =>
      item.itemId === itemId ? Object.freeze({ ...item, state: 'skipped' as QueueItemState }) : item,
    ),
  );
}

/* ── Conflicts ──────────────────────────────────────────────────── */

export interface DecompositionReviewConflict {
  readonly exampleId: string;
  readonly reviewerIds: readonly string[];
  readonly verdicts: readonly DecompositionReviewVerdict[];
  readonly labels: readonly (DecompositionLabelKind | null)[];
}

/**
 * Computes disagreement. Never resolves it.
 *
 * Abstentions are excluded, as Sprint 04's agreement report excludes them from
 * its denominator: an abstention is neither agreement nor disagreement, and
 * counting it as a conflict would push a reviewer to guess rather than abstain.
 */
export function detectReviewConflicts(
  reviews: readonly DecompositionReview[],
): readonly DecompositionReviewConflict[] {
  const grouped = new Map<string, DecompositionReview[]>();
  for (const row of reviews) {
    if (row.verdict === 'unresolved') continue;
    const existing = grouped.get(row.exampleId);
    if (existing) existing.push(row);
    else grouped.set(row.exampleId, [row]);
  }

  const conflicts: DecompositionReviewConflict[] = [];
  grouped.forEach((rows, exampleId) => {
    if (rows.length < 2) return;
    const positions = new Set(rows.map((row) => `${row.verdict}::${String(row.label)}`));
    if (positions.size < 2) return;
    const ordered = rows.slice().sort((a, b) => byCodeUnit(a.reviewerId, b.reviewerId));
    conflicts.push(
      Object.freeze({
        exampleId,
        reviewerIds: Object.freeze(ordered.map((row) => row.reviewerId)),
        verdicts: Object.freeze(ordered.map((row) => row.verdict)),
        labels: Object.freeze(ordered.map((row) => row.label)),
      }),
    );
  });

  return Object.freeze(conflicts.slice().sort((a, b) => byCodeUnit(a.exampleId, b.exampleId)));
}

/* ── Ingest ─────────────────────────────────────────────────────── */

export type ReviewRejectionCode = 'MALFORMED_REVIEW' | 'UNKNOWN_EXAMPLE' | 'DUPLICATE_REVIEW';

export interface ReviewIngestOutcome {
  readonly accepted: readonly DecompositionReview[];
  readonly rejected: readonly { readonly reviewId: string; readonly code: ReviewRejectionCode }[];
  readonly conflicts: readonly DecompositionReviewConflict[];
  readonly issues: readonly ValidationIssue[];
  /** Abstentions among accepted rows. Reported, never folded into conflicts. */
  readonly unresolvedCount: number;
}

export interface IngestReviewsOptions {
  /** The queue reviewers were handed. Defines which examples exist. */
  readonly queue: readonly DecompositionQueueItem[];
  /** Reviews already recorded, so a duplicate across sessions is still a duplicate. */
  readonly existing?: readonly DecompositionReview[];
}

/**
 * The boundary a review crosses to become evidence.
 *
 * Three refusals, each returned with a code rather than dropped, because a row
 * that vanishes without a reason is a row a maintainer will resubmit unchanged.
 * Checked in this order: shape (nothing downstream can be decided about a row
 * whose exampleId is not a string), then whether the example exists (a verdict
 * about a row nobody defined refers to nothing), then duplication (the only
 * check that depends on which rows were accepted before it).
 *
 * Duplicates are refused per (example, reviewer) rather than per row id: two
 * submissions from one person are not two data points, and accepting both
 * weights that person's opinion by however many times they pressed send.
 */
export function ingestReviews(
  rows: readonly unknown[],
  options: IngestReviewsOptions,
): ReviewIngestOutcome {
  const collector = new IssueCollector();
  const knownExampleIds = new Set(options.queue.map((item) => item.exampleId));
  const existing = options.existing ?? [];
  const seenPairs = new Set(existing.map((row) => `${row.exampleId}::${row.reviewerId}`));

  const accepted: DecompositionReview[] = [];
  const rejected: { reviewId: string; code: ReviewRejectionCode }[] = [];

  rows.forEach((raw, index) => {
    const path = `reviews[${index}]`;
    const validation = validateDecompositionReview(raw, path);
    collector.merge(validation.issues);
    if (!validation.review) {
      const candidate = isPlainObject(raw) ? raw.reviewId : undefined;
      rejected.push({
        reviewId: isNonEmptyString(candidate) ? candidate : `(unidentified row ${index})`,
        code: 'MALFORMED_REVIEW',
      });
      return;
    }

    const row = validation.review;
    if (!knownExampleIds.has(row.exampleId)) {
      collector.error(
        'DXI010',
        `${path}.exampleId`,
        `no queue item names example ${exampleLabel(row.exampleId)}; a verdict about a row nobody defined refers to nothing`,
      );
      rejected.push({ reviewId: row.reviewId, code: 'UNKNOWN_EXAMPLE' });
      return;
    }

    const key = `${row.exampleId}::${row.reviewerId}`;
    if (seenPairs.has(key)) {
      collector.error(
        'DXI011',
        path,
        `reviewer '${row.reviewerId}' already reviewed ${exampleLabel(row.exampleId)}; a second row would weight one ` +
          "person's opinion by however many times it was submitted",
      );
      rejected.push({ reviewId: row.reviewId, code: 'DUPLICATE_REVIEW' });
      return;
    }
    seenPairs.add(key);
    accepted.push(row);
  });

  // Conflicts span the accepted batch and what was already stored: a
  // disagreement that arrives one reviewer per session is still a disagreement.
  const conflicts = detectReviewConflicts([...existing, ...accepted]);

  return Object.freeze({
    accepted: Object.freeze(accepted),
    rejected: Object.freeze(rejected),
    conflicts,
    issues: collector.result().issues,
    unresolvedCount: accepted.filter((row) => row.verdict === 'unresolved').length,
  });
}

/* ── Store ──────────────────────────────────────────────────────── */

export interface ReviewStore {
  list(): readonly DecompositionReview[];
  append(review: DecompositionReview): void;
  conflicts(): readonly DecompositionReviewConflict[];
}

/**
 * Append-only, with the same (example, reviewer) guard as ingest.
 *
 * The guard is duplicated deliberately: ingest is the front door and this is
 * the last line, so a caller who writes directly cannot store a row ingest
 * would have refused.
 */
export function createInMemoryReviewStore(initial: readonly DecompositionReview[] = []): ReviewStore {
  const rows: DecompositionReview[] = initial.slice();
  const seen = new Set(rows.map((row) => `${row.exampleId}::${row.reviewerId}`));

  return {
    list: () => Object.freeze(rows.slice()),
    append: (review: DecompositionReview) => {
      const key = `${review.exampleId}::${review.reviewerId}`;
      if (seen.has(key)) {
        fail(`reviewer '${review.reviewerId}' has already reviewed '${review.exampleId}'`);
      }
      seen.add(key);
      rows.push(review);
    },
    conflicts: () => detectReviewConflicts(rows),
  };
}

/* ── Coverage ───────────────────────────────────────────────────── */

export interface ReviewCoverageReport {
  readonly generatedAt: string;
  readonly totalItems: number;
  readonly reviewedItems: number;
  readonly pendingItems: number;
  /** Items nobody will review. Neither reviewed nor pending. */
  readonly skippedItems: number;
  /** Rows, not items: two reviewers on one example are two reviews and one reviewed item. */
  readonly reviewCount: number;
  readonly reviewerIds: readonly string[];
  /** Queue composition, so a `reviewedBySplit` of zeros has a denominator. */
  readonly itemsBySplit: Readonly<Record<string, number>>;
  readonly reviewedBySplit: Readonly<Record<string, number>>;
  readonly conflictCount: number;
  readonly unresolvedCount: number;
  /** Reported, never implied by a page of zeros. */
  readonly corpusEmpty: boolean;
  readonly status: 'CORPUS EMPTY' | 'REPORTED';
}

export interface BuildReviewCoverageOptions {
  /** Required. This report is a committed artifact; the caller owns the clock. */
  readonly generatedAt: string;
  readonly items: readonly DecompositionQueueItem[];
  readonly reviews: readonly DecompositionReview[];
}

export function buildReviewCoverage(options: BuildReviewCoverageOptions): ReviewCoverageReport {
  if (!isIsoTimestamp(options?.generatedAt)) {
    fail('generatedAt must be an ISO-8601 timestamp; this builder reads no clock of its own');
  }
  const reviewedExampleIds = new Set(options.reviews.map((row) => row.exampleId));

  const itemsBySplit: Record<string, number> = {};
  const reviewedBySplit: Record<string, number> = {};
  // Every split gets a key, at zero if nobody reviewed it. An absent key and a
  // zero read identically only to someone who already knows the vocabulary.
  for (const split of DECOMPOSITION_SPLITS) {
    itemsBySplit[split] = 0;
    reviewedBySplit[split] = 0;
  }

  let reviewedItems = 0;
  let pendingItems = 0;
  let skippedItems = 0;
  for (const item of options.items) {
    itemsBySplit[item.split] = (itemsBySplit[item.split] ?? 0) + 1;
    if (reviewedExampleIds.has(item.exampleId) || item.state === 'decided') {
      reviewedItems += 1;
      reviewedBySplit[item.split] = (reviewedBySplit[item.split] ?? 0) + 1;
    } else if (item.state === 'skipped') {
      skippedItems += 1;
    } else {
      pendingItems += 1;
    }
  }

  return Object.freeze({
    generatedAt: options.generatedAt,
    totalItems: options.items.length,
    reviewedItems,
    pendingItems,
    skippedItems,
    reviewCount: options.reviews.length,
    reviewerIds: Object.freeze(
      Array.from(new Set(options.reviews.map((row) => row.reviewerId))).sort(byCodeUnit),
    ),
    itemsBySplit: Object.freeze(itemsBySplit),
    reviewedBySplit: Object.freeze(reviewedBySplit),
    conflictCount: detectReviewConflicts(options.reviews).length,
    unresolvedCount: options.reviews.filter((row) => row.verdict === 'unresolved').length,
    corpusEmpty: options.reviews.length === 0,
    status: options.reviews.length === 0 ? 'CORPUS EMPTY' : 'REPORTED',
  });
}
