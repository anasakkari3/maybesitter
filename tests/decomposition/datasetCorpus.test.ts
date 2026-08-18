/**
 * The shipped corpora, the annotation queue and ingest (Sprint 06, issue #26).
 *
 * ── The test that matters most ──────────────────────────────────────
 *
 * `the reviewed corpus ships empty` and `every shipped row is synthetic` are
 * the guards this whole track exists behind. #26's deliverable is a *reviewed*
 * dataset and no reviewer exists, so the pipeline ships real and the rows ship
 * marked. Sprint 04 shipped its judgment corpus empty and Sprint 05 kept the
 * rule for the same reason: a dataset that claims review it never had corrupts
 * every number computed from it afterwards, and does so invisibly, because a
 * score fitted to fabricated labels looks exactly like a score fitted to real
 * ones.
 *
 * Both exits are closed, as in `tests/priority/annotationCoverage.test.ts`:
 * rows that *validate* would slip past a validity check, so the row count is
 * asserted separately; rows that *do not* validate would make the count zero
 * for the wrong reason, so validity is asserted too. The raw files are read
 * directly so a future change to the loader cannot make the guard vacuous.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DECOMPOSITION_REVIEWED_CORPUS_PATH,
  DECOMPOSITION_REVIEW_LOG_PATH,
  DECOMPOSITION_SEED_CORPUS_PATH,
  buildDecompositionQueue,
  buildReviewCoverage,
  createDecompositionReview,
  createInMemoryReviewStore,
  detectReviewConflicts,
  ingestReviews,
  loadReviewedCorpus,
  loadSeedCorpus,
  loadShippedReviewLog,
  markQueueItemSkipped,
  parseExampleCorpus,
  promoteToReviewed,
  readExampleCorpusFile,
  verifyReviewedProvenance,
  type CreateReviewInput,
} from '../../lib/decomposition/evaluation/corpus.ts';
import {
  buildSplitManifest,
  loadShippedSplitManifest,
  verifySplitManifest,
} from '../../lib/decomposition/evaluation/splits.ts';
import { validateDecompositionExamples } from '../../lib/decomposition/evaluation/example.ts';
import { hasIssue } from '../../lib/evaluation/registry/validationPrimitives.ts';
import type { DecompositionExample } from '../../src/contracts/v1/decompositionContracts.ts';

const ENQUEUED_AT = '2026-08-19T08:00:00.000Z';
const REVIEWED_AT = '2026-08-19T09:00:00.000Z';
const GENERATED_AT = '2026-08-19T12:00:00.000Z';

const QUALITY_DIR = join(
  dirname(dirname(dirname(fileURLToPath(import.meta.url)))),
  'data',
  'quality',
);

const SEED = loadSeedCorpus();
const QUEUE = buildDecompositionQueue({ examples: SEED.examples, enqueuedAt: ENQUEUED_AT });

function review(overrides: Partial<CreateReviewInput> = {}) {
  return createDecompositionReview({
    exampleId: SEED.examples[0].exampleId,
    reviewerId: 'rev-a',
    verdict: 'approve',
    label: null,
    spansVerified: true,
    rationale: 'spans check out against the source text',
    reviewedAt: REVIEWED_AT,
    ...overrides,
  });
}

/* ── The honesty rule ───────────────────────────────────────────── */

test('the reviewed corpus ships empty', () => {
  const raw = readExampleCorpusFile(DECOMPOSITION_REVIEWED_CORPUS_PATH) as { examples?: unknown };
  const loaded = loadReviewedCorpus();

  // Exit one: valid rows fail the count check.
  assert.ok(Array.isArray(raw.examples), `${DECOMPOSITION_REVIEWED_CORPUS_PATH} must carry an examples array`);
  assert.equal(
    (raw.examples as unknown[]).length,
    0,
    `${DECOMPOSITION_REVIEWED_CORPUS_PATH} must ship with zero rows: it is the corpus that claims human ` +
      'review, and rows written by engineering would read as reviewer evidence while being nothing of the kind',
  );

  // Exit two: invalid rows fail the validity check, so a zero count cannot be
  // reached by shipping garbage the loader refuses to parse.
  assert.equal(loaded.valid, true, JSON.stringify(loaded.issues, null, 2));
  assert.equal(loaded.corpusEmpty, true);
  assert.equal(loaded.examples.length, 0);
});

test('the review log ships empty, so no row can claim a reviewer that does not exist', () => {
  const raw = JSON.parse(readFileSync(DECOMPOSITION_REVIEW_LOG_PATH, 'utf8')) as { reviews?: unknown };
  const loaded = loadShippedReviewLog();

  assert.ok(Array.isArray(raw.reviews));
  assert.equal((raw.reviews as unknown[]).length, 0);
  assert.equal(loaded.valid, true, JSON.stringify(loaded.issues, null, 2));
  assert.equal(loaded.corpusEmpty, true);
});

test('every row in every shipped decomposition artifact is synthetic', () => {
  const files = readdirSync(QUALITY_DIR).filter(
    (name) => name.indexOf('decomposition-') === 0 && name.endsWith('.json'),
  );
  assert.ok(files.length >= 2, `expected shipped artifacts under ${QUALITY_DIR}, found ${files.join(', ')}`);

  let inspected = 0;
  for (const name of files) {
    const parsed = JSON.parse(readFileSync(join(QUALITY_DIR, name), 'utf8')) as { examples?: unknown };
    if (!Array.isArray(parsed.examples)) continue;
    for (const row of parsed.examples as { exampleId?: string; provenance?: string }[]) {
      inspected += 1;
      assert.equal(
        row.provenance,
        'synthetic',
        `${name}: '${String(row.exampleId)}' claims provenance '${String(row.provenance)}'. Sprint 06 ships ` +
          'no reviewed rows; a row that says otherwise is a claim no reviewer backs',
      );
    }
  }
  assert.ok(inspected > 0, 'the seed corpus must actually contain rows, or this guard proves nothing');
});

test('a human_reviewed row without a reviewer record does not verify', () => {
  const forged: DecompositionExample = { ...SEED.examples[0], provenance: 'human_reviewed' };

  const unbacked = verifyReviewedProvenance({ examples: [forged], reviews: [] });
  assert.equal(unbacked.valid, false, 'a row may not claim review with no review behind it');
  assert.ok(hasIssue(unbacked, 'DXP010'), JSON.stringify(unbacked.issues, null, 2));

  const backed = verifyReviewedProvenance({
    examples: [forged],
    reviews: [review({ exampleId: forged.exampleId })],
  });
  assert.equal(backed.valid, true, JSON.stringify(backed.issues, null, 2));
});

test('the shipped corpora verify their own provenance claims', () => {
  const result = verifyReviewedProvenance({
    examples: [...SEED.examples, ...loadReviewedCorpus().examples],
    reviews: loadShippedReviewLog().reviews,
  });
  assert.equal(result.valid, true, JSON.stringify(result.issues, null, 2));
});

test('a seed-role file may not carry a reviewed row', () => {
  const raw = readExampleCorpusFile(DECOMPOSITION_SEED_CORPUS_PATH) as { examples: unknown[] };
  const smuggled = {
    ...(raw as object),
    examples: [{ ...(raw.examples[0] as object), provenance: 'human_reviewed' }],
  };
  const parsed = parseExampleCorpus(smuggled);
  assert.equal(parsed.valid, false);
  assert.ok(hasIssue(parsed, 'DXC020'), JSON.stringify(parsed.issues, null, 2));
});

test('promoteToReviewed cannot mint a reviewed row without a review', () => {
  assert.throws(
    () => promoteToReviewed(SEED.examples[0], []),
    /no review/,
    'the only constructor for a reviewed row must require the evidence that makes the claim true',
  );
  const promoted = promoteToReviewed(SEED.examples[0], [review()]);
  assert.equal(promoted.provenance, 'human_reviewed');
  assert.equal(promoted.exampleId, SEED.examples[0].exampleId);
});

/* ── The seed corpus is well formed ─────────────────────────────── */

test('the seed corpus loads and every row satisfies the shared vocabulary', () => {
  assert.equal(SEED.valid, true, JSON.stringify(SEED.issues, null, 2));
  assert.ok(SEED.examples.length >= 12, `expected a corpus worth splitting, got ${SEED.examples.length}`);

  for (const result of validateDecompositionExamples(SEED.examples)) {
    assert.equal(result.valid, true, `${result.exampleId}: ${JSON.stringify(result.violations, null, 2)}`);
  }
});

test('the seed corpus covers all three labels and more than one script', () => {
  const labels = new Set(SEED.examples.map((example) => example.label));
  assert.deepEqual(Array.from(labels).sort(), ['atomic', 'do_not_split', 'multi_step']);

  const locales = new Set(SEED.examples.map((example) => example.locale));
  assert.ok(locales.size >= 3, `expected several locales, got ${Array.from(locales).join(', ')}`);
  assert.ok(locales.has('ar') && locales.has('he'), 'the RTL cases are the ones a naive splitter breaks on');
});

/* ── The committed split manifest ───────────────────────────────── */

test('the committed split manifest still describes the committed seed corpus', () => {
  const parsed = loadShippedSplitManifest();
  assert.equal(parsed.valid, true, JSON.stringify(parsed.issues, null, 2));
  assert.notEqual(parsed.manifest, null);

  const verified = verifySplitManifest({
    examples: SEED.examples,
    manifest: parsed.manifest as NonNullable<typeof parsed.manifest>,
  });
  assert.equal(
    verified.valid,
    true,
    `the sealed manifest no longer matches data/quality/decomposition-seed-examples.json: ${JSON.stringify(
      verified.issues,
      null,
      2,
    )}`,
  );
});

test('the committed manifest is exactly what a rebuild produces', () => {
  const parsed = loadShippedSplitManifest();
  const sealed = parsed.manifest as NonNullable<typeof parsed.manifest>;
  const rebuilt = buildSplitManifest({
    examples: SEED.examples,
    manifestId: sealed.manifestId,
    generatedAt: sealed.generatedAt,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(rebuilt)), JSON.parse(JSON.stringify(sealed)));
});

/* ── Queue ──────────────────────────────────────────────────────── */

test('the queue is deterministic and reads no clock', () => {
  const again = buildDecompositionQueue({ examples: SEED.examples, enqueuedAt: ENQUEUED_AT });
  assert.deepEqual(again, QUEUE);
  assert.throws(
    () => buildDecompositionQueue({ examples: SEED.examples, enqueuedAt: 'sometime' }),
    /ISO-8601/,
  );
});

test('every seed example is enqueued, locked-test rows included', () => {
  assert.equal(QUEUE.items.length, SEED.examples.length);
  const splits = new Set(QUEUE.items.map((item) => item.split));
  assert.ok(
    splits.has('locked-test'),
    'unlike the Priority queue, nothing is withheld here: the locked split needs *labels* to be a test ' +
      'set at all, and it is edits after sealing, not review, that leak',
  );
  for (const item of QUEUE.items) {
    assert.equal(item.state, 'pending');
    assert.equal(item.enqueuedAt, ENQUEUED_AT);
    assert.match(item.itemId, /^dq_/);
  }
});

test('a skipped item cannot overwrite a decided one', () => {
  const decided = markQueueItemSkipped(QUEUE.items, QUEUE.items[0].itemId);
  assert.equal(decided[0].state, 'skipped');
  assert.throws(() => markQueueItemSkipped(QUEUE.items, 'dq_nobody'), /unknown queue item/);
});

/* ── Ingest ─────────────────────────────────────────────────────── */

test('an accepted review records who reviewed it and when', () => {
  const outcome = ingestReviews([review()], { queue: QUEUE.items });
  assert.equal(outcome.accepted.length, 1);
  assert.equal(outcome.accepted[0].reviewerId, 'rev-a');
  assert.equal(outcome.accepted[0].reviewedAt, REVIEWED_AT);
  assert.equal(outcome.rejected.length, 0);
});

test('a review without a reviewer or a timestamp cannot be constructed at all', () => {
  assert.throws(() => createDecompositionReview({ ...review(), reviewerId: '  ' } as CreateReviewInput), /reviewerId/);
  assert.throws(() => createDecompositionReview({ ...review(), reviewedAt: 'today' } as CreateReviewInput), /reviewedAt/);
});

test('a relabel must name the label it proposes, and an approval must not', () => {
  assert.throws(() => createDecompositionReview({ ...review(), verdict: 'relabel', label: null }), /relabel/);
  assert.throws(
    () => createDecompositionReview({ ...review(), verdict: 'approve', label: 'atomic' }),
    /approve/,
  );
});

test('a second decision from the same reviewer on the same example is rejected', () => {
  const outcome = ingestReviews([review(), review({ rationale: 'changed my mind' })], { queue: QUEUE.items });
  assert.equal(outcome.accepted.length, 1);
  assert.deepEqual(
    outcome.rejected.map((row) => row.code),
    ['DUPLICATE_REVIEW'],
  );
});

test('a duplicate is still a duplicate across sessions', () => {
  const first = ingestReviews([review()], { queue: QUEUE.items });
  const second = ingestReviews([review({ rationale: 'again' })], {
    queue: QUEUE.items,
    existing: first.accepted,
  });
  assert.equal(second.accepted.length, 0);
  assert.deepEqual(
    second.rejected.map((row) => row.code),
    ['DUPLICATE_REVIEW'],
  );
});

test('a review of an example nobody enqueued refers to nothing', () => {
  const outcome = ingestReviews([review({ exampleId: 'not-in-the-corpus' })], { queue: QUEUE.items });
  assert.deepEqual(
    outcome.rejected.map((row) => row.code),
    ['UNKNOWN_EXAMPLE'],
  );
});

test('a malformed row is rejected with a reason rather than dropped', () => {
  const outcome = ingestReviews([{ exampleId: 42 }], { queue: QUEUE.items });
  assert.deepEqual(
    outcome.rejected.map((row) => row.code),
    ['MALFORMED_REVIEW'],
  );
  assert.ok(outcome.issues.length > 0, 'a row that vanishes without a reason will be resubmitted unchanged');
});

/* ── Disagreement is retained, never collapsed ──────────────────── */

test('two reviewers who disagree are both kept and the disagreement is reported', () => {
  const rows = [
    review({ reviewerId: 'rev-a', verdict: 'approve', label: null }),
    review({ reviewerId: 'rev-b', verdict: 'relabel', label: 'do_not_split' }),
  ];
  const outcome = ingestReviews(rows, { queue: QUEUE.items });

  assert.equal(outcome.accepted.length, 2, 'both rows survive: a conflict is data, not an error');
  assert.equal(outcome.conflicts.length, 1);
  assert.deepEqual(outcome.conflicts[0].reviewerIds, ['rev-a', 'rev-b']);
  assert.deepEqual(outcome.conflicts[0].verdicts.slice().sort(), ['approve', 'relabel']);
});

test('an abstention is neither agreement nor disagreement', () => {
  const rows = [
    review({ reviewerId: 'rev-a', verdict: 'approve', label: null }),
    review({ reviewerId: 'rev-b', verdict: 'unresolved', label: null }),
  ];
  const outcome = ingestReviews(rows, { queue: QUEUE.items });
  assert.equal(outcome.accepted.length, 2);
  assert.equal(
    outcome.conflicts.length,
    0,
    'counting an abstention as a conflict pushes a reviewer to guess rather than abstain',
  );
  assert.equal(outcome.unresolvedCount, 1);
});

test('agreement between two reviewers is not a conflict', () => {
  const rows = [
    review({ reviewerId: 'rev-a' }),
    review({ reviewerId: 'rev-b' }),
  ];
  assert.deepEqual(detectReviewConflicts(ingestReviews(rows, { queue: QUEUE.items }).accepted), []);
});

/* ── Store ──────────────────────────────────────────────────────── */

test('the store refuses a duplicate and never rewrites a row', () => {
  const store = createInMemoryReviewStore();
  store.append(review());
  assert.throws(() => store.append(review({ rationale: 'different words' })), /already/);
  assert.equal(store.list().length, 1);
});

/* ── Coverage ───────────────────────────────────────────────────── */

test('coverage over the shipped corpora reports emptiness rather than a page of zeros', () => {
  const coverage = buildReviewCoverage({
    generatedAt: GENERATED_AT,
    items: QUEUE.items,
    reviews: loadShippedReviewLog().reviews,
  });
  assert.equal(coverage.totalItems, SEED.examples.length);
  assert.equal(coverage.reviewedItems, 0);
  assert.equal(coverage.corpusEmpty, true);
  assert.equal(coverage.status, 'CORPUS EMPTY');
  assert.equal(
    coverage.reviewedItems + coverage.pendingItems + coverage.skippedItems,
    coverage.totalItems,
    'the three buckets must partition the queue, or a fourth state could be added unnoticed',
  );
  for (const split of ['train', 'valid', 'locked-test'] as const) {
    assert.ok(split in coverage.itemsBySplit, 'every split gets a key, so a zero has a denominator beside it');
  }
});

/* ── No clock anywhere in the module ────────────────────────────── */

test('no module under lib/decomposition/evaluation reads the system clock', () => {
  const dir = join(
    dirname(dirname(dirname(fileURLToPath(import.meta.url)))),
    'lib',
    'decomposition',
    'evaluation',
  );
  const sources = readdirSync(dir).filter((name) => name.endsWith('.ts'));
  assert.ok(sources.length >= 4);

  for (const name of sources) {
    const body = readFileSync(join(dir, name), 'utf8');
    for (const forbidden of ['Date.now(', 'new Date(', 'Math.random(']) {
      assert.equal(
        body.includes(forbidden),
        false,
        `${name} uses ${forbidden}: a corpus artifact that differs between two runs over unchanged input ` +
          'cannot be reviewed as a diff, and a split that moves with the clock was never held out',
      );
    }
  }
});
