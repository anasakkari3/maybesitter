/**
 * Deterministic, checksum-protected train / valid / locked-test splits
 * (Sprint 06, issue #26).
 *
 * ── Assignment is a digest of the example id, and nothing else ──────
 *
 * Not iteration order, not a clock, not unseeded randomness. Each of those
 * produces a *different* held-out set on each run, and a held-out set that
 * changes between runs is not held out — it is a sample, and a model measured
 * on it has quietly been measured on rows it was fitted to.
 *
 * The alternative that looks better and is worse: sorting the corpus by digest
 * and cutting at quantiles. That gives exact proportions, and it re-points the
 * locked set every time an example is added, because every row's rank moves.
 * A per-id bucket gives approximate proportions and the property that actually
 * matters — a row's split is decided the moment it gets an id and never moves
 * again. `assignment does not depend on which other examples exist` is the test
 * that pins it.
 *
 * `SPLIT_ASSIGNMENT_VERSION` is part of the hashed input, so re-splitting the
 * corpus is possible but cannot happen by accident: it requires a new version
 * string, and a manifest sealed under the old one then refuses to verify rather
 * than silently describing a different partition.
 *
 * ── Why membership checks are not enough ────────────────────────────
 *
 * Membership is derived from ids, so editing a row's `sourceText` or its
 * `expectedSteps` while leaving the id alone passes every membership check
 * ever written. That edit changes what a locked-test score means without
 * changing anything a reviewer would notice in a diff of counts. The per-split
 * and whole-corpus checksums are what close it, using the same
 * `checksumOf(canonicalJson(...))` idiom as lib/evaluation/registry — reused
 * rather than reinvented so two fingerprints in this repository cannot disagree
 * about what a content hash is.
 *
 * A chain ledger (lib/evaluation/registry/lockChain.ts) is deliberately *not*
 * used here. The chain defends against a maintainer rewriting a lock row in
 * place to match an edited artifact; that threat needs an append-only history
 * of supersessions, which is worth its weight once real reviewed rows exist.
 * Today the corpus ships synthetic and empty of review, so the manifest is
 * rebuilt from the corpus on every run and a single sealed checksum is the
 * honest amount of protection. `docs/data/decomposition-annotation-guide.md`
 * records this as the upgrade to make when review begins.
 *
 * No function here reads the system clock; `generatedAt` is always supplied.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Checksum, ValidationIssue, ValidationResult } from '../../evaluation/registry/contracts';
import { canonicalJson, checksumOf, sha256Hex } from '../../evaluation/registry/fingerprint';
import {
  IssueCollector,
  checksumsEqual,
  isIsoTimestamp,
  isNonEmptyString,
  isPlainObject,
  isValidChecksum,
} from '../../evaluation/registry/validationPrimitives';
import {
  DECOMPOSITION_SCHEMA_VERSION,
  type DecompositionExample,
} from '../../../src/contracts/v1/decompositionContracts';

/**
 * `locked-test`, not `test`.
 *
 * lib/evaluation/registry/contracts.ts already owns a `SplitRole` of
 * `train | valid | test` for materialised dataset artifacts. This split is an
 * in-repo corpus rather than a registered artifact, and naming the held-out
 * role differently keeps the two from being cast into each other by a
 * maintainer who assumes they mean the same thing — they do not: `test` there
 * is a role in a registry, `locked-test` here is a promise that the rows never
 * move.
 */
export type DecompositionSplit = 'train' | 'valid' | 'locked-test';

export const DECOMPOSITION_SPLITS: readonly DecompositionSplit[] = Object.freeze([
  'train',
  'valid',
  'locked-test',
]);

export const SPLIT_ASSIGNMENT_VERSION = 'decomposition-split-v1' as const;
export const SPLIT_MANIFEST_CONTRACT_VERSION = '1.0.0' as const;

/** Buckets, not percentages, but they happen to coincide at 100. */
export const SPLIT_BUCKET_COUNT = 100;

export interface SplitWeights {
  readonly train: number;
  readonly valid: number;
  readonly lockedTest: number;
}

export const DEFAULT_SPLIT_WEIGHTS: SplitWeights = Object.freeze({ train: 70, valid: 15, lockedTest: 15 });

function fail(message: string): never {
  throw new Error(`decomposition splits: ${message}`);
}

/** Code-unit ordering, never localeCompare: the manifest is a committed artifact. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function assertWeights(weights: SplitWeights): void {
  const total = weights.train + weights.valid + weights.lockedTest;
  if (
    !Number.isInteger(weights.train) ||
    !Number.isInteger(weights.valid) ||
    !Number.isInteger(weights.lockedTest) ||
    weights.train < 0 ||
    weights.valid < 0 ||
    weights.lockedTest < 0
  ) {
    fail('weights must be non-negative integers');
  }
  if (total !== SPLIT_BUCKET_COUNT) {
    fail(
      `weights must sum to ${SPLIT_BUCKET_COUNT}, found ${total}; a partial partition would leave a range of ` +
        'digests assigned to no split, and those examples would vanish from every score without anyone noticing',
    );
  }
}

/**
 * The bucket an example id falls in.
 *
 * The first 8 hex digits are 32 bits, taken as an unsigned integer — well
 * inside `Number.MAX_SAFE_INTEGER`, so the modulo is exact. Taking the whole
 * 64-hex digest through `parseInt` would silently lose precision and make the
 * bucket a function of a rounded float rather than of the digest.
 */
export function splitBucket(exampleId: string, assignmentVersion: string = SPLIT_ASSIGNMENT_VERSION): number {
  if (!isNonEmptyString(exampleId)) fail('cannot assign a split without an exampleId');
  const digest = sha256Hex(`${assignmentVersion}:${exampleId}`);
  return parseInt(digest.slice(0, 8), 16) % SPLIT_BUCKET_COUNT;
}

export function assignSplit(
  exampleId: string,
  weights: SplitWeights = DEFAULT_SPLIT_WEIGHTS,
  assignmentVersion: string = SPLIT_ASSIGNMENT_VERSION,
): DecompositionSplit {
  assertWeights(weights);
  const bucket = splitBucket(exampleId, assignmentVersion);
  if (bucket < weights.train) return 'train';
  if (bucket < weights.train + weights.valid) return 'valid';
  return 'locked-test';
}

export interface SplitAssignment {
  readonly exampleId: string;
  readonly bucket: number;
  readonly split: DecompositionSplit;
}

export interface AssignSplitsOptions {
  readonly weights?: SplitWeights;
  readonly assignmentVersion?: string;
}

/** Ordered by example id, so the output does not carry the input's ordering. */
export function assignSplits(
  examples: readonly Pick<DecompositionExample, 'exampleId'>[],
  options: AssignSplitsOptions = {},
): readonly SplitAssignment[] {
  const weights = options.weights ?? DEFAULT_SPLIT_WEIGHTS;
  const assignmentVersion = options.assignmentVersion ?? SPLIT_ASSIGNMENT_VERSION;
  assertWeights(weights);

  const ids = examples.map((example) => example.exampleId).slice().sort(byCodeUnit);
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) fail(`duplicate exampleId '${id}': one row cannot belong to two splits`);
    seen.add(id);
  }

  return Object.freeze(
    ids.map((exampleId) =>
      Object.freeze({
        exampleId,
        bucket: splitBucket(exampleId, assignmentVersion),
        split: assignSplit(exampleId, weights, assignmentVersion),
      }),
    ),
  );
}

/**
 * The rows belonging to one split, ordered by id.
 *
 * Exists so a caller never writes the filter by hand. The hand-written version
 * is one typo away from returning the whole corpus, which leaves every unit
 * test green while scoring a model on the rows it was fitted to — a failure
 * that shows up as an unusually good number, which is the kind nobody
 * investigates.
 */
export function selectSplit(
  examples: readonly DecompositionExample[],
  split: DecompositionSplit,
  options: AssignSplitsOptions = {},
): readonly DecompositionExample[] {
  if (DECOMPOSITION_SPLITS.indexOf(split) < 0) fail(`unknown split '${String(split)}'`);
  const wanted = new Set(
    assignSplits(examples, options)
      .filter((assignment) => assignment.split === split)
      .map((assignment) => assignment.exampleId),
  );
  return Object.freeze(
    examples
      .filter((example) => wanted.has(example.exampleId))
      .slice()
      .sort((a, b) => byCodeUnit(a.exampleId, b.exampleId)),
  );
}

/* ── Manifest ───────────────────────────────────────────────────── */

export interface SplitManifest {
  readonly contractVersion: typeof SPLIT_MANIFEST_CONTRACT_VERSION;
  readonly schema: typeof DECOMPOSITION_SCHEMA_VERSION;
  readonly manifestId: string;
  readonly assignmentVersion: string;
  readonly generatedAt: string;
  readonly weights: SplitWeights;
  readonly exampleCount: number;
  readonly counts: Readonly<Record<DecompositionSplit, number>>;
  readonly members: Readonly<Record<DecompositionSplit, readonly string[]>>;
  /** Content of each split, so an edit that leaves ids alone is still visible. */
  readonly splitChecksums: Readonly<Record<DecompositionSplit, Checksum>>;
  readonly corpusChecksum: Checksum;
}

/**
 * Fingerprints a set of examples by content.
 *
 * Sorted by id first, so the fingerprint is a function of the *set*: reordering
 * declarations in the corpus is not a change to the data, and would otherwise
 * force a spurious re-seal — the same reasoning as
 * `computeLockedSplitChecksum` in lib/priority/rubric/seedSetLock.ts.
 */
export function checksumOfExamples(examples: readonly DecompositionExample[]): Checksum {
  const sorted = examples.slice().sort((a, b) => byCodeUnit(a.exampleId, b.exampleId));
  return checksumOf(canonicalJson(sorted));
}

export interface BuildSplitManifestOptions {
  readonly examples: readonly DecompositionExample[];
  readonly manifestId: string;
  /** Required. The manifest is a committed file; the caller owns the clock. */
  readonly generatedAt: string;
  readonly weights?: SplitWeights;
  readonly assignmentVersion?: string;
}

export function buildSplitManifest(options: BuildSplitManifestOptions): SplitManifest {
  if (!isPlainObject(options)) fail('options must be an object');
  if (!isNonEmptyString(options.manifestId)) fail('manifestId must be a non-empty string');
  if (!isIsoTimestamp(options.generatedAt)) {
    fail('generatedAt must be an ISO-8601 timestamp; this builder reads no clock of its own');
  }

  const weights = options.weights ?? DEFAULT_SPLIT_WEIGHTS;
  const assignmentVersion = options.assignmentVersion ?? SPLIT_ASSIGNMENT_VERSION;
  const assignments = assignSplits(options.examples, { weights, assignmentVersion });
  const byId = new Map(options.examples.map((example) => [example.exampleId, example] as const));

  const members: Record<DecompositionSplit, string[]> = { train: [], valid: [], 'locked-test': [] };
  for (const assignment of assignments) members[assignment.split].push(assignment.exampleId);

  const counts: Record<DecompositionSplit, number> = { train: 0, valid: 0, 'locked-test': 0 };
  const splitChecksums: Record<DecompositionSplit, Checksum> = {
    train: checksumOf(''),
    valid: checksumOf(''),
    'locked-test': checksumOf(''),
  };
  for (const split of DECOMPOSITION_SPLITS) {
    counts[split] = members[split].length;
    splitChecksums[split] = checksumOfExamples(
      members[split].map((id) => byId.get(id) as DecompositionExample),
    );
  }

  return Object.freeze({
    contractVersion: SPLIT_MANIFEST_CONTRACT_VERSION,
    schema: DECOMPOSITION_SCHEMA_VERSION,
    manifestId: options.manifestId,
    assignmentVersion,
    generatedAt: options.generatedAt,
    weights: Object.freeze({ ...weights }),
    exampleCount: options.examples.length,
    counts: Object.freeze(counts),
    members: Object.freeze({
      train: Object.freeze(members.train),
      valid: Object.freeze(members.valid),
      'locked-test': Object.freeze(members['locked-test']),
    }),
    splitChecksums: Object.freeze(splitChecksums),
    corpusChecksum: checksumOfExamples(options.examples),
  });
}

/* ── Verification ───────────────────────────────────────────────── */

export interface VerifySplitManifestOptions {
  readonly examples: readonly DecompositionExample[];
  readonly manifest: SplitManifest;
}

/**
 * Checks that a sealed manifest still describes the committed corpus.
 *
 * Ordered so each check is only run where the previous one leaves it
 * meaningful: assignment version first (a manifest describing a different
 * partition scheme cannot be compared at all), then the manifest's internal
 * consistency, then membership, then content.
 */
export function verifySplitManifest(options: VerifySplitManifestOptions): ValidationResult {
  const collector = new IssueCollector();
  const { manifest, examples } = options;

  if (manifest.assignmentVersion !== SPLIT_ASSIGNMENT_VERSION) {
    collector.error(
      'DSM010',
      'manifest.assignmentVersion',
      `sealed under '${manifest.assignmentVersion}' but the current scheme is '${SPLIT_ASSIGNMENT_VERSION}'; ` +
        'the two describe different partitions and a match between them would be a coincidence, not a check',
    );
    return collector.result();
  }
  if (manifest.contractVersion !== SPLIT_MANIFEST_CONTRACT_VERSION) {
    collector.error(
      'DSM011',
      'manifest.contractVersion',
      `expected '${SPLIT_MANIFEST_CONTRACT_VERSION}', found ${JSON.stringify(manifest.contractVersion)}`,
    );
  }

  // Internal consistency: a row listed under two splits is a leak the corpus
  // itself cannot show, because the corpus has no splits in it.
  const placements = new Map<string, DecompositionSplit>();
  for (const split of DECOMPOSITION_SPLITS) {
    for (const exampleId of manifest.members[split]) {
      const existing = placements.get(exampleId);
      if (existing !== undefined) {
        collector.error(
          'DSM022',
          `manifest.members.${split}`,
          `'${exampleId}' is listed under both '${existing}' and '${split}'; a locked-test row that is also ` +
            'trained on makes every number computed from that split meaningless',
        );
      } else {
        placements.set(exampleId, split);
      }
    }
    if (manifest.counts[split] !== manifest.members[split].length) {
      collector.error(
        'DSM023',
        `manifest.counts.${split}`,
        `sealed count ${manifest.counts[split]} but the members list holds ${manifest.members[split].length}`,
      );
    }
  }
  if (manifest.exampleCount !== placements.size) {
    collector.error(
      'DSM024',
      'manifest.exampleCount',
      `sealed exampleCount ${manifest.exampleCount} but the splits name ${placements.size} distinct examples`,
    );
  }

  // Membership: recomputed from ids, never read back off the manifest.
  const expected = assignSplits(examples, {
    weights: manifest.weights,
    assignmentVersion: manifest.assignmentVersion,
  });
  const expectedById = new Map(expected.map((row) => [row.exampleId, row.split] as const));

  for (const row of expected) {
    const sealed = placements.get(row.exampleId);
    if (sealed === undefined) {
      collector.error(
        'DSM020',
        'manifest.members',
        `'${row.exampleId}' is in the corpus but named by no split in the manifest`,
      );
    } else if (sealed !== row.split) {
      collector.error(
        'DSM021',
        `manifest.members.${sealed}`,
        `'${row.exampleId}' is sealed under '${sealed}' but its id digests to '${row.split}'`,
      );
    }
  }
  placements.forEach((split, exampleId) => {
    if (!expectedById.has(exampleId)) {
      collector.error(
        'DSM021',
        `manifest.members.${split}`,
        `'${exampleId}' is sealed under '${split}' but no longer exists in the corpus`,
      );
    }
  });

  // Content: the only check that can see an edit which left the ids alone.
  const byId = new Map(examples.map((example) => [example.exampleId, example] as const));
  const observedCorpus = checksumOfExamples(examples);
  if (!checksumsEqual(manifest.corpusChecksum, observedCorpus)) {
    collector.error(
      'DSM030',
      'manifest.corpusChecksum',
      `corpus content changed: sealed ${manifest.corpusChecksum.value}, found ${observedCorpus.value}. ` +
        'Membership is derived from ids, so an edit that keeps an id passes every membership check; ' +
        'this is the only check that sees it',
    );
  }
  for (const split of DECOMPOSITION_SPLITS) {
    const rows = manifest.members[split]
      .map((id) => byId.get(id))
      .filter((example): example is DecompositionExample => example !== undefined);
    if (rows.length !== manifest.members[split].length) continue; // already reported as DSM021
    const observed = checksumOfExamples(rows);
    if (!checksumsEqual(manifest.splitChecksums[split], observed)) {
      collector.error(
        'DSM031',
        `manifest.splitChecksums.${split}`,
        `'${split}' content changed: sealed ${manifest.splitChecksums[split].value}, found ${observed.value}`,
      );
    }
  }

  return collector.result();
}

/* ── Reading and parsing ────────────────────────────────────────── */

/**
 * Resolved from this module rather than `process.cwd()`, so a CLI, a test and
 * an editor task all read the same file regardless of where they were launched.
 */
export const DECOMPOSITION_SPLIT_MANIFEST_PATH = fileURLToPath(
  new URL('../../../data/quality/decomposition-split-manifest.json', import.meta.url),
);

export function readSplitManifestFile(path: string = DECOMPOSITION_SPLIT_MANIFEST_PATH): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

export interface SplitManifestParseResult {
  readonly valid: boolean;
  readonly issues: readonly ValidationIssue[];
  /** Null unless every field validated. A partly-repaired manifest is not a manifest. */
  readonly manifest: SplitManifest | null;
}

export function parseSplitManifest(raw: unknown): SplitManifestParseResult {
  const collector = new IssueCollector();

  if (!isPlainObject(raw)) {
    collector.error('DSM001', 'manifest', 'split manifest must be an object');
    return { ...collector.result(), manifest: null };
  }
  if (raw.contractVersion !== SPLIT_MANIFEST_CONTRACT_VERSION) {
    collector.error(
      'DSM002',
      'manifest.contractVersion',
      `expected '${SPLIT_MANIFEST_CONTRACT_VERSION}', found ${JSON.stringify(raw.contractVersion)}`,
    );
  }
  if (raw.schema !== DECOMPOSITION_SCHEMA_VERSION) {
    collector.error(
      'DSM003',
      'manifest.schema',
      `expected '${DECOMPOSITION_SCHEMA_VERSION}', found ${JSON.stringify(raw.schema)}`,
    );
  }
  if (!isNonEmptyString(raw.manifestId)) collector.error('DSM004', 'manifest.manifestId', 'manifestId is required');
  if (!isNonEmptyString(raw.assignmentVersion)) {
    collector.error('DSM005', 'manifest.assignmentVersion', 'assignmentVersion is required');
  }
  if (!isIsoTimestamp(raw.generatedAt)) {
    collector.error('DSM006', 'manifest.generatedAt', 'generatedAt must be an ISO-8601 timestamp');
  }
  if (!isValidChecksum(raw.corpusChecksum)) {
    collector.error('DSM007', 'manifest.corpusChecksum', 'corpusChecksum must be a sha256 checksum');
  }
  if (!Number.isInteger(raw.exampleCount)) {
    collector.error('DSM008', 'manifest.exampleCount', 'exampleCount must be an integer');
  }

  const weights = raw.weights;
  if (
    !isPlainObject(weights) ||
    !Number.isInteger(weights.train) ||
    !Number.isInteger(weights.valid) ||
    !Number.isInteger(weights.lockedTest) ||
    (weights.train as number) + (weights.valid as number) + (weights.lockedTest as number) !== SPLIT_BUCKET_COUNT
  ) {
    collector.error(
      'DSM009',
      'manifest.weights',
      `weights must be three integers summing to ${SPLIT_BUCKET_COUNT}`,
    );
  }

  const members = raw.members;
  const counts = raw.counts;
  const splitChecksums = raw.splitChecksums;
  for (const split of DECOMPOSITION_SPLITS) {
    const list = isPlainObject(members) ? members[split] : undefined;
    if (!Array.isArray(list) || list.some((id) => !isNonEmptyString(id))) {
      collector.error('DSM012', `manifest.members.${split}`, 'members must be an array of non-empty strings');
    }
    if (!isPlainObject(counts) || !Number.isInteger(counts[split])) {
      collector.error('DSM013', `manifest.counts.${split}`, 'count must be an integer');
    }
    if (!isPlainObject(splitChecksums) || !isValidChecksum(splitChecksums[split])) {
      collector.error('DSM014', `manifest.splitChecksums.${split}`, 'checksum must be sha256 hex');
    }
  }

  const result = collector.result();
  return { ...result, manifest: result.valid ? (raw as unknown as SplitManifest) : null };
}

export function loadShippedSplitManifest(options?: { readonly path?: string }): SplitManifestParseResult {
  return parseSplitManifest(readSplitManifestFile(options?.path));
}
