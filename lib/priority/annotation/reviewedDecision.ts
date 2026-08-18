/**
 * Construction and validation of a single reviewed decision
 * (Sprint 05, issue #21).
 *
 * ── Why provenance is structural rather than checked at the edges ───
 *
 * `ReviewedDecision.reviewerId` and `decidedAt` are non-optional in the
 * committed contract. Types alone do not survive a `JSON.parse`, an `as unknown
 * as` cast, or a hand-edited file, so the same requirement is enforced twice:
 * once by `createReviewedDecision`, which is the only way to mint a decision,
 * and once by `validateReviewedDecision`, which is the only way a decision
 * enters from outside. A judgment whose author or time is unknown cannot be
 * audited, and an unauditable judgment is not one a ranking may be fitted to.
 *
 * `createReviewedDecision` never spreads its input. Every field of the result is
 * written explicitly, so a forged `version` — or any other property riding along
 * on the input object — has nowhere to land. This is the same technique
 * lib/runtimeMemory/runtimeMemoryStore.ts uses in `buildRecord`, and for the
 * same reason: the caller supplies claims, not record fields.
 *
 * ── Why the id pattern is strict ────────────────────────────────────
 *
 * A decision id reaches the filesystem as `<decisionId>.decision.json` in the
 * file-backed store. An id containing `/`, `\` or `..` would let a caller read
 * or unlink files outside the store directory. Unlike runtime memory ids, these
 * are *caller-supplied* — a reviewer tool picks them — so the guard is the only
 * thing between an ingest file and a path traversal.
 *
 * No function here reads the system clock; `decidedAt` is always supplied. A
 * repo-wide test enforces that for everything under lib/priority.
 */
import type { JudgmentVerdict } from '../../../src/contracts/v1/priorityContracts';
import {
  CALIBRATION_SCHEMA_VERSION,
  type ReviewedDecision,
} from '../../../src/contracts/v1/calibrationContracts';
import type { ValidationIssue } from '../../evaluation/registry/contracts';
import {
  IssueCollector,
  isIsoTimestamp,
  isNonEmptyString,
  isPlainObject,
} from '../../evaluation/registry/validationPrimitives';

export const DECISION_ID_PREFIX = 'dec_';

/**
 * Deliberately narrower than "a non-empty string": no dot, no separator, so no
 * id can name `..` or a path outside the store. Ids that fail it cannot name a
 * decision this store ever wrote, so rejecting them loses nothing.
 */
export const DECISION_ID_PATTERN = /^dec_[A-Za-z0-9_-]{1,120}$/;

export const DECISION_VERDICTS: readonly JudgmentVerdict[] = Object.freeze([
  'left',
  'right',
  'tie',
  'unresolved',
]);

/** The fields a caller may assert. Everything else on the row is assigned here. */
export interface CreateDecisionInput {
  readonly pairId: string;
  readonly reviewerId: string;
  readonly verdict: JudgmentVerdict;
  readonly rationale: string;
  readonly hardConstraintFlag: boolean;
  readonly decidedAt: string;
  /** Optional; defaults to the deterministic id for (pair, reviewer). */
  readonly decisionId?: string;
}

const DECISION_KEYS: readonly string[] = Object.freeze([
  'version',
  'decisionId',
  'pairId',
  'reviewerId',
  'verdict',
  'rationale',
  'hardConstraintFlag',
  'decidedAt',
]);

function fail(message: string): never {
  throw new Error(`annotation decision: ${message}`);
}

/**
 * The canonical id for one reviewer's decision on one pair.
 *
 * Deterministic rather than random so re-importing the same reviewer file twice
 * produces the same id and is caught as a duplicate rather than stored twice
 * under two names. Throws rather than sanitising: silently rewriting an id would
 * make two different reviewers collide into one row.
 */
export function decisionIdFor(pairId: string, reviewerId: string): string {
  if (!isNonEmptyString(pairId)) fail('cannot mint a decision id without a pairId');
  if (!isNonEmptyString(reviewerId)) fail('cannot mint a decision id without a reviewerId');
  const candidate = `${DECISION_ID_PREFIX}${pairId}__${reviewerId}`;
  if (!DECISION_ID_PATTERN.test(candidate)) {
    fail(
      `cannot mint a decision id from pairId '${pairId}' and reviewerId '${reviewerId}': ` +
        `the result must match ${String(DECISION_ID_PATTERN)}. Pass an explicit decisionId instead.`,
    );
  }
  return candidate;
}

/** Returns the id only if it can name a decision this store wrote; otherwise null. */
export function toSafeDecisionId(id: unknown): string | null {
  return typeof id === 'string' && DECISION_ID_PATTERN.test(id) ? id : null;
}

/**
 * The only constructor for a decision.
 *
 * Validates first, then writes every field explicitly. A missing `reviewerId` or
 * `decidedAt` throws here, which is what makes "a decision missing either cannot
 * be constructed" true of a forged input cast through `as unknown as` and not
 * merely of one the compiler can see.
 */
export function createReviewedDecision(input: CreateDecisionInput): ReviewedDecision {
  if (!isPlainObject(input)) fail('input must be an object');
  if (!isNonEmptyString(input.pairId)) fail('pairId must be a non-empty string');
  if (!isNonEmptyString(input.reviewerId)) {
    fail('reviewerId must be a non-empty string: a decision whose author is unknown cannot be audited');
  }
  if (!DECISION_VERDICTS.includes(input.verdict)) {
    fail(`verdict must be one of ${DECISION_VERDICTS.join(' | ')}`);
  }
  if (!isNonEmptyString(input.rationale)) {
    fail('rationale is mandatory and must name a rubric criterion, even for a tie');
  }
  if (typeof input.hardConstraintFlag !== 'boolean') {
    fail('hardConstraintFlag must be a boolean; an absent flag is not the same claim as `false`');
  }
  if (!isIsoTimestamp(input.decidedAt)) {
    fail('decidedAt must be an ISO-8601 timestamp: a decision with no time cannot be audited');
  }

  const decisionId = input.decisionId ?? decisionIdFor(input.pairId, input.reviewerId);
  if (toSafeDecisionId(decisionId) === null) {
    fail(`decisionId '${String(decisionId)}' must match ${String(DECISION_ID_PATTERN)}`);
  }

  return Object.freeze({
    version: CALIBRATION_SCHEMA_VERSION,
    decisionId,
    pairId: input.pairId,
    reviewerId: input.reviewerId,
    verdict: input.verdict,
    rationale: input.rationale,
    hardConstraintFlag: input.hardConstraintFlag,
    decidedAt: input.decidedAt,
  });
}

/**
 * Shape guard for anything read back from disk or handed in as `unknown`.
 *
 * Checked field by field rather than by a cast, because the interesting inputs
 * here are exactly the ones a cast would wave through: a half-written file, a
 * hand-edited row, an export from a different schema version.
 */
export function isReviewedDecision(value: unknown): value is ReviewedDecision {
  if (!isPlainObject(value)) return false;
  return (
    value.version === CALIBRATION_SCHEMA_VERSION &&
    toSafeDecisionId(value.decisionId) !== null &&
    isNonEmptyString(value.pairId) &&
    isNonEmptyString(value.reviewerId) &&
    DECISION_VERDICTS.includes(value.verdict as JudgmentVerdict) &&
    isNonEmptyString(value.rationale) &&
    typeof value.hardConstraintFlag === 'boolean' &&
    isIsoTimestamp(value.decidedAt)
  );
}

export interface DecisionValidationResult {
  readonly valid: boolean;
  readonly issues: readonly ValidationIssue[];
  readonly decision: ReviewedDecision | null;
}

/**
 * Validates one row and reports *why* it failed.
 *
 * `isReviewedDecision` answers yes/no, which is right for a store read where a
 * bad file is skipped. Ingest needs the reason, because a rejected row is
 * returned to a human who has to fix it.
 */
export function validateReviewedDecision(raw: unknown, path = 'decision'): DecisionValidationResult {
  const collector = new IssueCollector();

  if (!isPlainObject(raw)) {
    collector.error('PAD010', path, 'decision must be an object');
    return { ...collector.result(), decision: null };
  }

  for (const key of Object.keys(raw)) {
    if (!DECISION_KEYS.includes(key)) {
      collector.error('PAD019', `${path}.${key}`, `unknown decision field '${key}'`);
    }
  }

  if (raw.version !== CALIBRATION_SCHEMA_VERSION) {
    collector.error(
      'PAD011',
      `${path}.version`,
      `expected '${CALIBRATION_SCHEMA_VERSION}', found ${JSON.stringify(raw.version)}`,
    );
  }
  if (toSafeDecisionId(raw.decisionId) === null) {
    collector.error(
      'PAD012',
      `${path}.decisionId`,
      `decisionId must match ${String(DECISION_ID_PATTERN)}; ids reach the filesystem, so ` +
        'anything that could name a path outside the store is refused',
    );
  }
  if (!isNonEmptyString(raw.pairId)) {
    collector.error('PAD013', `${path}.pairId`, 'pairId must be a non-empty string');
  }
  if (!isNonEmptyString(raw.reviewerId)) {
    collector.error(
      'PAD014',
      `${path}.reviewerId`,
      'reviewerId is mandatory: a decision whose author is unknown cannot be audited, and an ' +
        'unauditable judgment is not one a ranking may be fitted to',
    );
  }
  if (!DECISION_VERDICTS.includes(raw.verdict as JudgmentVerdict)) {
    collector.error('PAD015', `${path}.verdict`, `verdict must be one of ${DECISION_VERDICTS.join(' | ')}`);
  }
  if (!isNonEmptyString(raw.rationale)) {
    collector.error(
      'PAD016',
      `${path}.rationale`,
      'rationale is mandatory and must name a rubric criterion, even for a tie',
    );
  }
  if (typeof raw.hardConstraintFlag !== 'boolean') {
    collector.error(
      'PAD017',
      `${path}.hardConstraintFlag`,
      'hardConstraintFlag must be a boolean; an absent flag is not the same claim as `false`',
    );
  }
  if (!isIsoTimestamp(raw.decidedAt)) {
    collector.error(
      'PAD018',
      `${path}.decidedAt`,
      'decidedAt is mandatory and must be an ISO-8601 timestamp',
    );
  }

  const result = collector.result();
  return {
    ...result,
    decision: result.valid ? Object.freeze(raw as unknown as ReviewedDecision) : null,
  };
}
