/**
 * Coverage report and shipped-corpus tests (Sprint 05, issue #21).
 *
 * ── The test that matters most ──────────────────────────────────────
 *
 * `the shipped decision store holds zero decisions` is the guard this whole
 * track exists behind. Sprint 04 shipped its judgment corpus empty because
 * Sprint 05 fitting the product's ranking to fabricated preferences was the
 * specific harm being avoided, and #22 calibrates against exactly this data.
 * Plausible-looking reviewer decisions here would not be untidy — they would
 * feed invented human preferences into the tuning of what a user sees, and the
 * resulting weights would be indistinguishable from weights fitted to real ones.
 *
 * Both exits are closed. Rows that *validate* would slip past a validity check,
 * so the row count is asserted separately; rows that *do not* validate would
 * make the count zero for the wrong reason, so validity is asserted too. Neither
 * assertion alone is enough, and the raw file is read directly so a future
 * change to the loader cannot make the guard vacuous.
 *
 * ── corpusEmpty is reported, not implied ────────────────────────────
 *
 * A report over no decisions must say so rather than rendering zeros. Sprint 04
 * made the same call for `AgreementReport.corpusEmpty`: presenting the absence
 * of data as a measurement is not a smaller error than fabricating rows, it is
 * the same error wearing a number.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildQueueCoverageReport,
  generateQueueCoverageMarkdown,
} from '../../lib/priority/annotation/queueCoverage.ts';
import {
  DECISION_CORPUS_PATH,
  loadShippedDecisionCorpus,
  parseDecisionCorpus,
  readDecisionCorpusFile,
} from '../../lib/priority/annotation/decisionCorpus.ts';
import { buildAnnotationQueue, markQueueItemSkipped } from '../../lib/priority/annotation/annotationQueue.ts';
import { createInMemoryDecisionStore } from '../../lib/priority/annotation/decisionStore.ts';
import { createReviewedDecision, type CreateDecisionInput } from '../../lib/priority/annotation/reviewedDecision.ts';
import { CALIBRATION_SCHEMA_VERSION } from '../../src/contracts/v1/calibrationContracts.ts';
import { RUBRIC_VERSION } from '../fixtures/prioritySeedSet.ts';
import { hasIssue } from '../../lib/evaluation/registry/validationPrimitives.ts';

const GENERATED_AT = '2026-08-19T10:00:00.000Z';
const QUEUE = buildAnnotationQueue({ enqueuedAt: '2026-08-19T08:00:00.000Z' });

function decision(overrides: Partial<CreateDecisionInput> = {}) {
  return createReviewedDecision({
    pairId: QUEUE.items[0].pairId,
    reviewerId: 'rev-a',
    verdict: 'left',
    rationale: 'C1 — left is overdue and right is not',
    hardConstraintFlag: false,
    decidedAt: '2026-08-19T09:00:00.000Z',
    ...overrides,
  });
}

/* ── The shipped corpus is empty ────────────────────────────────── */

test('the shipped decision store holds zero decisions', () => {
  const raw = readDecisionCorpusFile() as { decisions?: unknown };
  const loaded = loadShippedDecisionCorpus();

  // Exit one: valid rows fail the count check.
  assert.ok(Array.isArray(raw.decisions), `${DECISION_CORPUS_PATH} must carry a decisions array`);
  assert.equal(
    (raw.decisions as unknown[]).length,
    0,
    `${DECISION_CORPUS_PATH} must ship with zero rows: #22 fits ranking weights against this file, ` +
      'and rows written by engineering would read as reviewer evidence while being nothing of the kind',
  );
  assert.equal(loaded.decisions.length, 0);

  // Exit two: invalid rows fail the validity check, so a zero count cannot be
  // reached by shipping garbage the loader refuses to parse.
  assert.equal(loaded.valid, true, JSON.stringify(loaded.issues, null, 2));
  assert.equal(loaded.corpusEmpty, true);
});

test('the shipped corpus declares what kind of evidence it is for', () => {
  const loaded = loadShippedDecisionCorpus();

  assert.equal(loaded.provenance, 'human_reviewed');
  assert.equal(loaded.rubricVersion, RUBRIC_VERSION);
  assert.equal(loaded.contractVersion, CALIBRATION_SCHEMA_VERSION);
});

test('the coverage report over the shipped store reports corpusEmpty', () => {
  const report = buildQueueCoverageReport({
    generatedAt: GENERATED_AT,
    items: QUEUE.items,
    decisions: loadShippedDecisionCorpus().decisions,
  });

  assert.equal(report.corpusEmpty, true);
  assert.equal(report.decidedItems, 0);
  assert.equal(report.reviewerCount, 0);
  assert.equal(report.conflictCount, 0);
  assert.equal(report.pendingItems, QUEUE.items.length);
  assert.equal(report.status, 'CORPUS EMPTY');
  assert.match(generateQueueCoverageMarkdown(report), /no reviewer decision has been recorded/i);
});

/* ── Parsing ────────────────────────────────────────────────────── */

test('a corpus row missing reviewer provenance is rejected rather than loaded', () => {
  const parsed = parseDecisionCorpus({
    contractVersion: CALIBRATION_SCHEMA_VERSION,
    provenance: 'human_reviewed',
    rubricVersion: RUBRIC_VERSION,
    decisions: [{ ...decision(), reviewerId: '   ' }],
  });

  assert.equal(parsed.valid, false);
  assert.equal(parsed.decisions.length, 0);
  assert.ok(hasIssue(parsed, 'PAD014'));
});

test('a corpus that does not declare its provenance is rejected', () => {
  const parsed = parseDecisionCorpus({
    contractVersion: CALIBRATION_SCHEMA_VERSION,
    rubricVersion: RUBRIC_VERSION,
    decisions: [],
  });

  assert.equal(parsed.valid, false);
  assert.ok(hasIssue(parsed, 'PDC003'));
});

test('a corpus holding two decisions from one reviewer on one pair is rejected', () => {
  const parsed = parseDecisionCorpus({
    contractVersion: CALIBRATION_SCHEMA_VERSION,
    provenance: 'human_reviewed',
    rubricVersion: RUBRIC_VERSION,
    decisions: [decision(), { ...decision({ verdict: 'right' }), decisionId: 'dec_second' }],
  });

  assert.equal(parsed.valid, false);
  assert.ok(hasIssue(parsed, 'PDC020'));
});

test('a corpus that is not an object at all is reported, not thrown', () => {
  const parsed = parseDecisionCorpus('nonsense');

  assert.equal(parsed.valid, false);
  assert.equal(parsed.corpusEmpty, true);
  assert.ok(hasIssue(parsed, 'PDC001'));
});

test('a corpus round-trips through export and parse with its non-Latin text intact', () => {
  const arabic = 'المعيار C1 — الطرف الأيسر متأخر عن موعده';
  const hebrew = 'קריטריון C4 — נדחה שלוש פעמים';
  const store = createInMemoryDecisionStore();
  store.append({
    pairId: QUEUE.items[0].pairId,
    reviewerId: 'rev-ar',
    verdict: 'left',
    rationale: arabic,
    hardConstraintFlag: true,
    decidedAt: '2026-08-19T09:00:00.000Z',
  });
  store.append({
    pairId: QUEUE.items[1].pairId,
    reviewerId: 'rev-he',
    verdict: 'right',
    rationale: hebrew,
    hardConstraintFlag: false,
    decidedAt: '2026-08-19T09:05:00.000Z',
  });

  const exported = store.export({
    exportedAt: GENERATED_AT,
    provenance: 'human_reviewed',
    rubricVersion: RUBRIC_VERSION,
  });
  const parsed = parseDecisionCorpus(JSON.parse(JSON.stringify(exported)) as unknown);

  assert.equal(parsed.valid, true, JSON.stringify(parsed.issues, null, 2));
  assert.deepEqual(parsed.decisions.map((row) => row.rationale).sort(), [arabic, hebrew].sort());
  assert.equal(
    Buffer.from(JSON.stringify(parsed.decisions), 'utf8').equals(
      Buffer.from(JSON.stringify(exported.decisions), 'utf8'),
    ),
    true,
    'the corpus must survive a JSON round-trip as the same bytes',
  );
});

/* ── Counting ───────────────────────────────────────────────────── */

test('the report counts decided, pending and skipped items separately', () => {
  const withSkip = markQueueItemSkipped(QUEUE.items, QUEUE.items[5].itemId);
  const decisions = [decision({ reviewerId: 'rev-a' }), decision({ reviewerId: 'rev-b', verdict: 'right' })];

  const report = buildQueueCoverageReport({ generatedAt: GENERATED_AT, items: withSkip, decisions });

  assert.equal(report.totalItems, QUEUE.items.length);
  assert.equal(report.decidedItems, 1, 'one pair carries decisions, however many reviewers judged it');
  assert.equal(report.skippedItems, 1);
  assert.equal(report.pendingItems, QUEUE.items.length - 2);
  assert.equal(
    report.decidedItems + report.pendingItems + report.skippedItems,
    report.totalItems,
    'every item must be accounted for in exactly one bucket',
  );
  assert.equal(report.decisionCount, 2);
  assert.equal(report.reviewerCount, 2);
  assert.equal(report.conflictCount, 1);
  assert.equal(report.corpusEmpty, false);
  assert.equal(report.status, 'REPORTED');
});

test('bySlice names every slice in the queue, including the ones nobody judged', () => {
  const report = buildQueueCoverageReport({
    generatedAt: GENERATED_AT,
    items: QUEUE.items,
    decisions: [decision()],
  });

  const slices = Array.from(new Set(QUEUE.items.map((item) => item.slice))).sort();
  assert.deepEqual(Object.keys(report.bySlice).sort(), slices);
  assert.deepEqual(Object.keys(report.itemsBySlice).sort(), slices);
  assert.equal(report.bySlice[QUEUE.items[0].slice], 1);
  assert.equal(
    Object.values(report.bySlice).reduce((sum, count) => sum + count, 0),
    report.decidedItems,
    'a slice with no decisions must appear at zero rather than be omitted',
  );
});

test('an abstention counts as a decided item but not as a conflict', () => {
  const report = buildQueueCoverageReport({
    generatedAt: GENERATED_AT,
    items: QUEUE.items,
    decisions: [decision({ reviewerId: 'rev-a', verdict: 'left' }), decision({ reviewerId: 'rev-b', verdict: 'unresolved' })],
  });

  assert.equal(report.decidedItems, 1);
  assert.equal(report.unresolvedCount, 1);
  assert.equal(report.conflictCount, 0);
});

/* ── Determinism ────────────────────────────────────────────────── */

test('the report builder takes its clock as a parameter and uses it verbatim', () => {
  const report = buildQueueCoverageReport({ generatedAt: GENERATED_AT, items: QUEUE.items, decisions: [] });

  assert.equal(report.generatedAt, GENERATED_AT);
  assert.equal(report.version, CALIBRATION_SCHEMA_VERSION);
  assert.throws(
    () => buildQueueCoverageReport({ generatedAt: 'now', items: QUEUE.items, decisions: [] }),
    /generatedAt/,
  );
});

test('two runs over unchanged input produce a byte-identical report', () => {
  const first = buildQueueCoverageReport({ generatedAt: GENERATED_AT, items: QUEUE.items, decisions: [decision()] });
  const second = buildQueueCoverageReport({ generatedAt: GENERATED_AT, items: QUEUE.items, decisions: [decision()] });

  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(generateQueueCoverageMarkdown(first), generateQueueCoverageMarkdown(second));
});

test('the markdown states the withheld locked split rather than leaving it implicit', () => {
  const report = buildQueueCoverageReport({
    generatedAt: GENERATED_AT,
    items: QUEUE.items,
    decisions: [],
    withheldLockedPairIds: QUEUE.withheldLockedPairIds,
  });

  assert.deepEqual(report.withheldLockedPairIds, QUEUE.withheldLockedPairIds);
  assert.match(generateQueueCoverageMarkdown(report), /locked evaluation split/i);
});
