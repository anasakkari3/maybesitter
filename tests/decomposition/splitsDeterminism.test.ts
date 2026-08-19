/**
 * Deterministic, checksum-protected splits (Sprint 06, issue #26).
 *
 * The properties asserted here are the ones that make a held-out split mean
 * anything at all:
 *
 *  - **Assignment is a function of the example id.** Not of iteration order,
 *    not of a clock, not of unseeded randomness. Anything else and the
 *    "locked" test set is a different set of rows each time it is computed,
 *    which is not a held-out set, it is a sample.
 *  - **Adding an example never moves an existing one.** A quantile-style split
 *    over a sorted digest would give exact proportions and would also re-point
 *    the locked set every time the corpus grows — the failure that quietly
 *    turns a test row into a training row.
 *  - **A mutated corpus is detectable.** Editing a row's text without touching
 *    its id leaves membership identical, so membership alone cannot catch it.
 *    The checksums are what close that hole.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DECOMPOSITION_SPLITS,
  DEFAULT_SPLIT_WEIGHTS,
  SPLIT_ASSIGNMENT_VERSION,
  assignSplit,
  assignSplits,
  buildSplitManifest,
  parseSplitManifest,
  splitBucket,
  verifySplitManifest,
  type DecompositionSplit,
} from '../../lib/decomposition/evaluation/splits.ts';
import { canonicalJson } from '../../lib/evaluation/registry/fingerprint.ts';
import { errorsOf, hasIssue } from '../../lib/evaluation/registry/validationPrimitives.ts';
import type { DecompositionExample } from '../../src/contracts/v1/decompositionContracts.ts';
import { DECOMPOSITION_GOLDEN } from '../fixtures/decompositionGolden.ts';

const GENERATED_AT = '2026-08-19T12:00:00.000Z';

function synthetic(exampleId: string, sourceText = `source text for ${exampleId}`): DecompositionExample {
  return {
    exampleId,
    locale: 'en',
    sourceText,
    label: 'atomic',
    provenance: 'synthetic',
    expectedSteps: [],
    note: 'constructed by the test',
  };
}

const CORPUS: readonly DecompositionExample[] = Object.freeze([
  ...DECOMPOSITION_GOLDEN,
  ...Array.from({ length: 40 }, (_unused, index) => synthetic(`synthetic-${index}`)),
]);

function manifest(examples: readonly DecompositionExample[] = CORPUS) {
  return buildSplitManifest({ examples, manifestId: 'dsplit-001', generatedAt: GENERATED_AT });
}

/* ── Determinism ────────────────────────────────────────────────── */

test('assignment is a pure function of the example id', () => {
  for (const example of CORPUS) {
    assert.equal(assignSplit(example.exampleId), assignSplit(example.exampleId));
    assert.equal(splitBucket(example.exampleId), splitBucket(example.exampleId));
  }
});

test('two builds over the same corpus are byte-identical', () => {
  assert.equal(canonicalJson(manifest()), canonicalJson(manifest()));
});

test('shuffling the corpus does not change the manifest', () => {
  // Reversed rather than randomly shuffled: a random order would make a failure
  // here unreproducible, which is the opposite of what this test is about.
  const reversed = CORPUS.slice().reverse();
  assert.equal(canonicalJson(manifest(reversed)), canonicalJson(manifest()));
});

test('assignment does not depend on which other examples exist', () => {
  const full = new Map(assignSplits(CORPUS).map((row) => [row.exampleId, row.split] as const));
  const half = assignSplits(CORPUS.slice(0, 12));
  for (const row of half) {
    assert.equal(
      row.split,
      full.get(row.exampleId),
      `${row.exampleId} moved between splits when the corpus shrank; a locked-test row that ` +
        'moves as the corpus grows was never held out',
    );
  }
});

/* ── Leak-freedom ───────────────────────────────────────────────── */

test('every example lands in exactly one split', () => {
  const built = manifest();
  const seen = new Map<string, DecompositionSplit>();
  for (const split of DECOMPOSITION_SPLITS) {
    for (const exampleId of built.members[split]) {
      assert.equal(seen.has(exampleId), false, `${exampleId} appears in more than one split`);
      seen.set(exampleId, split);
    }
  }
  assert.equal(seen.size, CORPUS.length);
});

test('no locked-test example also appears in train or valid', () => {
  const built = manifest();
  const locked = new Set(built.members['locked-test']);
  assert.ok(locked.size > 0, 'the corpus under test must actually populate the locked split');
  for (const exampleId of [...built.members.train, ...built.members.valid]) {
    assert.equal(locked.has(exampleId), false, `${exampleId} is both locked-test and fitted-on`);
  }
});

test('all three splits are populated by a corpus of this size', () => {
  const built = manifest();
  for (const split of DECOMPOSITION_SPLITS) {
    assert.ok(built.counts[split] > 0, `${split} is empty; a split nobody can measure is not a split`);
  }
  assert.equal(
    built.counts.train + built.counts.valid + built.counts['locked-test'],
    CORPUS.length,
    'the three counts must partition the corpus',
  );
});

/* ── Weights ────────────────────────────────────────────────────── */

test('weights must sum to the bucket count', () => {
  assert.equal(
    DEFAULT_SPLIT_WEIGHTS.train + DEFAULT_SPLIT_WEIGHTS.valid + DEFAULT_SPLIT_WEIGHTS.lockedTest,
    100,
  );
  assert.throws(
    () => assignSplit('anything', { train: 50, valid: 20, lockedTest: 20 }),
    /sum to 100/,
    'weights that do not partition the bucket space would silently drop a range of digests',
  );
});

test('a bucket is always inside the bucket space', () => {
  for (let index = 0; index < 500; index += 1) {
    const bucket = splitBucket(`probe-${index}`);
    assert.ok(Number.isInteger(bucket) && bucket >= 0 && bucket < 100, `bucket ${bucket} is out of range`);
  }
});

/* ── Checksum protection ────────────────────────────────────────── */

test('the manifest verifies against the corpus it was built from', () => {
  const result = verifySplitManifest({ examples: CORPUS, manifest: manifest() });
  assert.equal(result.valid, true, JSON.stringify(result.issues, null, 2));
});

test('editing an example without changing its id is caught by the checksum', () => {
  const built = manifest();
  const mutated = CORPUS.map((example) =>
    example.exampleId === 'synthetic-0' ? { ...example, sourceText: 'quietly rewritten' } : example,
  );

  // Membership is untouched — the id did not change — so only the content
  // checksums can see this. That is the entire reason they exist.
  const rebuilt = buildSplitManifest({ examples: mutated, manifestId: 'dsplit-001', generatedAt: GENERATED_AT });
  assert.deepEqual(rebuilt.members, built.members);

  const result = verifySplitManifest({ examples: mutated, manifest: built });
  assert.equal(result.valid, false, 'a mutated corpus must not verify against a sealed manifest');
  assert.ok(hasIssue(result, 'DSM030'), JSON.stringify(result.issues, null, 2));
});

test('adding or removing an example is caught as a membership change', () => {
  const built = manifest();
  const shortened = CORPUS.slice(0, CORPUS.length - 1);
  const result = verifySplitManifest({ examples: shortened, manifest: built });
  assert.equal(result.valid, false);
  assert.ok(
    errorsOf(result).some((issue) => issue.code === 'DSM020' || issue.code === 'DSM021'),
    JSON.stringify(result.issues, null, 2),
  );
});

test('a manifest sealed under a different assignment version does not silently verify', () => {
  const built = { ...manifest(), assignmentVersion: 'decomposition-split-v0' };
  const result = verifySplitManifest({ examples: CORPUS, manifest: built });
  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'DSM010'), JSON.stringify(result.issues, null, 2));
  assert.equal(SPLIT_ASSIGNMENT_VERSION, 'decomposition-split-v1');
});

test('a hand-edited members list is caught even when the counts still add up', () => {
  // Distinct from the leak test below: this moves a row between splits, which
  // the recomputed assignment catches (DSM021); that one lists a row twice,
  // which only the manifest's own consistency pass can see (DSM022).

  const built = manifest();
  const swapped = {
    ...built,
    members: {
      ...built.members,
      train: [...built.members.train.slice(1), built.members['locked-test'][0]],
      'locked-test': [...built.members['locked-test'].slice(1), built.members.train[0]].sort(),
    },
  };
  const result = verifySplitManifest({ examples: CORPUS, manifest: swapped });
  assert.equal(result.valid, false, 'moving a row between splits by hand must not verify');
});

/* ── Parsing ────────────────────────────────────────────────────── */

test('a manifest that has been outside this process is parsed before it is trusted', () => {
  const roundTripped = JSON.parse(JSON.stringify(manifest())) as unknown;
  const parsed = parseSplitManifest(roundTripped);
  assert.equal(parsed.valid, true, JSON.stringify(parsed.issues, null, 2));
  assert.notEqual(parsed.manifest, null);

  const broken = parseSplitManifest({ ...(roundTripped as object), corpusChecksum: 'not-a-checksum' });
  assert.equal(broken.valid, false);
  assert.equal(broken.manifest, null, 'a partly-valid manifest is not a manifest');
});

/* ── Weight boundaries ──────────────────────────────────────────── */

test('the bucket boundaries fall exactly where the weights say', () => {
  // No seed id happens to hash to bucket 70, so a `<` / `<=` slip at that edge
  // survived the whole suite. Probed ids are used to reach each boundary.
  const boundaries: Record<number, string> = {};
  for (let index = 0; index < 20000 && Object.keys(boundaries).length < 4; index += 1) {
    const candidate = `probe-${index}`;
    const bucket = splitBucket(candidate);
    if ([69, 70, 84, 85].indexOf(bucket) >= 0 && boundaries[bucket] === undefined) {
      boundaries[bucket] = candidate;
    }
  }
  assert.deepEqual(Object.keys(boundaries).map(Number).sort((a, b) => a - b), [69, 70, 84, 85]);

  assert.equal(assignSplit(boundaries[69]), 'train', 'bucket 69 is the last train bucket');
  assert.equal(assignSplit(boundaries[70]), 'valid', 'bucket 70 is the first valid bucket');
  assert.equal(assignSplit(boundaries[84]), 'valid', 'bucket 84 is the last valid bucket');
  assert.equal(assignSplit(boundaries[85]), 'locked-test', 'bucket 85 is the first locked-test bucket');
});

/* ── Tampered manifests ─────────────────────────────────────────── */

test('an id listed under two splits at once is caught as a leak', () => {
  // The manifest is the only place this is visible: the corpus has no splits in
  // it, so a recomputed assignment cannot see a row duplicated across two lists.
  const built = manifest();
  const leaked = {
    ...built,
    members: { ...built.members, train: [...built.members.train, built.members['locked-test'][0]] },
  };
  const result = verifySplitManifest({ examples: CORPUS, manifest: leaked });
  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'DSM022'), JSON.stringify(result.issues, null, 2));
});

test('a manifest sealed under different weights does not verify', () => {
  // Weights decide the partition just as much as the hash does. A manifest
  // sealed with {100, 0, 0} has an empty locked-test split and used to verify
  // clean, which is a corpus with no hold-out at all describing itself as split.
  const skewed = buildSplitManifest({
    examples: CORPUS,
    manifestId: 'dsplit-001',
    generatedAt: GENERATED_AT,
    weights: { train: 100, valid: 0, lockedTest: 0 },
  });
  assert.equal(skewed.counts['locked-test'], 0);

  const result = verifySplitManifest({ examples: CORPUS, manifest: skewed });
  assert.equal(result.valid, false, 'a re-weighted split needs a new assignment version, not a quiet reseal');
  assert.ok(hasIssue(result, 'DSM025'), JSON.stringify(result.issues, null, 2));
});
