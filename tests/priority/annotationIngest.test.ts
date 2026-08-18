/**
 * Ingest tests (Sprint 05, issue #21).
 *
 * Ingest is the boundary a decision crosses to become evidence, so every way in
 * is guarded and every refusal is returned rather than dropped. The three that
 * would corrupt the calibration quietly:
 *
 *  - **Leakage into the locked split.** A pair that is fitted on and then
 *    "validated" on produces a number that measures nothing. Tested from both
 *    directions: a decision naming a locked pair is refused, and a pair that
 *    became locked after the queue was built is refused even though the queue
 *    still lists it.
 *  - **A duplicate from one reviewer.** Two rows from the same person on the
 *    same pair are not two data points; counting them twice weights that
 *    reviewer's opinion by however many times they submitted.
 *  - **A row with no auditable author or time.** Enforced against a forged input
 *    cast through `as unknown as`, not only against one the compiler can see.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ingestDecisions,
  ingestIntoStore,
  verifyBatchOrientation,
} from '../../lib/priority/annotation/decisionIngest.ts';
import { buildAnnotationQueue, exportAnnotationBatch } from '../../lib/priority/annotation/annotationQueue.ts';
import { createInMemoryDecisionStore } from '../../lib/priority/annotation/decisionStore.ts';
import { createReviewedDecision, type CreateDecisionInput } from '../../lib/priority/annotation/reviewedDecision.ts';
import { lockedSplitPairs } from '../fixtures/prioritySeedSet.ts';
import type { ReviewedDecision } from '../../src/contracts/v1/calibrationContracts.ts';

const ENQUEUED_AT = '2026-08-19T08:00:00.000Z';
const DECIDED_AT = '2026-08-19T09:00:00.000Z';

const QUEUE = buildAnnotationQueue({ enqueuedAt: ENQUEUED_AT });
const OPEN_PAIR = QUEUE.items[0].pairId;
const OTHER_PAIR = QUEUE.items[1].pairId;
const LOCKED_PAIR = lockedSplitPairs()[0].pairId;

function decision(overrides: Partial<CreateDecisionInput> = {}): ReviewedDecision {
  return createReviewedDecision({
    pairId: OPEN_PAIR,
    reviewerId: 'rev-a',
    verdict: 'left',
    rationale: 'C1 — left is overdue and right is not',
    hardConstraintFlag: false,
    decidedAt: DECIDED_AT,
    ...overrides,
  });
}

function ingest(rows: readonly unknown[], existing: readonly ReviewedDecision[] = []) {
  return ingestDecisions(rows, { queue: QUEUE.items, existing });
}

/* ── Duplicates ─────────────────────────────────────────────────── */

test('a second decision from the same reviewer on the same pair is rejected', () => {
  const first = decision();
  const second = decision({ verdict: 'right', decisionId: 'dec_second-take' });

  const result = ingest([first, second]);

  assert.deepEqual(result.accepted.map((row) => row.decisionId), [first.decisionId]);
  assert.deepEqual(result.rejected, [{ decisionId: second.decisionId, code: 'DUPLICATE_DECISION' }]);
});

test('a duplicate is caught against decisions already in the store, not only within one batch', () => {
  const stored = decision();

  const result = ingest([decision({ verdict: 'tie', decisionId: 'dec_later' })], [stored]);

  assert.equal(result.accepted.length, 0);
  assert.deepEqual(result.rejected, [{ decisionId: 'dec_later', code: 'DUPLICATE_DECISION' }]);
});

test('a second reviewer on the same pair is accepted, because that is the point', () => {
  const result = ingest([decision({ reviewerId: 'rev-a' }), decision({ reviewerId: 'rev-b', verdict: 'right' })]);

  assert.equal(result.accepted.length, 2);
  assert.deepEqual(result.rejected, []);
});

/* ── Leakage, both directions ───────────────────────────────────── */

test('a decision naming a pair in the locked evaluation split is rejected', () => {
  const leaked = decision({ pairId: LOCKED_PAIR });

  const result = ingest([leaked]);

  assert.equal(result.accepted.length, 0);
  assert.deepEqual(result.rejected, [{ decisionId: leaked.decisionId, code: 'LOCKED_SPLIT_LEAKAGE' }]);
});

test('leakage outranks unknown-pair, so the reason names the real problem', () => {
  // The queue withholds locked pairs, so a locked pair is also "not in the
  // queue". Reporting UNKNOWN_PAIR would send a maintainer to add it.
  const result = ingest([decision({ pairId: LOCKED_PAIR })]);

  assert.equal(result.rejected[0].code, 'LOCKED_SPLIT_LEAKAGE');
});

test('a pair that becomes locked after the queue was built is still refused', () => {
  // The other direction: the queue is stale and still offers the pair, but the
  // split moved underneath it. Leakage is decided against the split, not
  // against what the queue happens to hold.
  const result = ingestDecisions([decision({ pairId: OPEN_PAIR })], {
    queue: QUEUE.items,
    lockedPairIds: [OPEN_PAIR],
  });

  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0].code, 'LOCKED_SPLIT_LEAKAGE');
});

test('a pair nobody enqueued is rejected as unknown', () => {
  const stray = decision({ pairId: 'ps-invented-01' });

  const result = ingest([stray]);

  assert.deepEqual(result.rejected, [{ decisionId: stray.decisionId, code: 'UNKNOWN_PAIR' }]);
});

/* ── Provenance ─────────────────────────────────────────────────── */

test('a forged row with no reviewerId cannot bypass validation by being cast', () => {
  const forged = {
    version: 'priority-calibration-v1',
    decisionId: 'dec_forged',
    pairId: OPEN_PAIR,
    verdict: 'left',
    rationale: 'C1',
    hardConstraintFlag: false,
    decidedAt: DECIDED_AT,
  } as unknown as ReviewedDecision;

  const result = ingest([forged]);

  assert.equal(result.accepted.length, 0);
  assert.deepEqual(result.rejected, [{ decisionId: 'dec_forged', code: 'MALFORMED_DECISION' }]);
  assert.ok(result.issues.some((issue) => issue.code === 'PAD014'), 'the reason must name reviewerId');
});

test('a forged row with no decidedAt cannot bypass validation by being cast', () => {
  const forged = { ...decision(), decidedAt: undefined } as unknown as ReviewedDecision;

  const result = ingest([forged]);

  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0].code, 'MALFORMED_DECISION');
  assert.ok(result.issues.some((issue) => issue.code === 'PAD018'), 'the reason must name decidedAt');
});

test('a row whose id could name a path outside the store is malformed, not stored', () => {
  const forged = { ...decision(), decisionId: 'dec_../../etc/passwd' } as unknown as ReviewedDecision;

  const result = ingest([forged]);

  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0].code, 'MALFORMED_DECISION');
  assert.ok(result.issues.some((issue) => issue.code === 'PAD012'));
});

/* ── Nothing is dropped ─────────────────────────────────────────── */

test('every row is either accepted or rejected with a code — none is dropped silently', () => {
  const rows: unknown[] = [
    decision({ reviewerId: 'rev-a' }),
    decision({ reviewerId: 'rev-a', decisionId: 'dec_dupe' }),
    decision({ pairId: LOCKED_PAIR, reviewerId: 'rev-c' }),
    decision({ pairId: 'ps-invented-01', reviewerId: 'rev-d' }),
    'not a decision at all',
    { decisionId: 'dec_partial' },
  ];

  const result = ingest(rows);

  assert.equal(result.accepted.length + result.rejected.length, rows.length);
  assert.deepEqual(
    result.rejected.map((row) => row.code),
    ['DUPLICATE_DECISION', 'LOCKED_SPLIT_LEAKAGE', 'UNKNOWN_PAIR', 'MALFORMED_DECISION', 'MALFORMED_DECISION'],
  );
});

test('a row too malformed to carry an id is still reported, under a traceable placeholder', () => {
  const result = ingest(['not a decision at all']);

  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0].decisionId, /row 0/);
  assert.equal(result.rejected[0].code, 'MALFORMED_DECISION');
});

/* ── Conflicts ──────────────────────────────────────────────────── */

test('two reviewers who disagree produce two accepted rows and one conflict', () => {
  const first = decision({ reviewerId: 'rev-a', verdict: 'left' });
  const second = decision({ reviewerId: 'rev-b', verdict: 'right' });

  const result = ingest([first, second]);

  assert.equal(result.accepted.length, 2);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].pairId, OPEN_PAIR);
  assert.deepEqual(result.conflicts[0].decisionIds.slice().sort(), [first.decisionId, second.decisionId].sort());
  assert.deepEqual(result.conflicts[0].verdicts.slice().sort(), ['left', 'right']);
});

test('a conflict is reported across the batch and the existing store together', () => {
  const stored = decision({ reviewerId: 'rev-a', verdict: 'left' });

  const result = ingest([decision({ reviewerId: 'rev-b', verdict: 'tie' })], [stored]);

  assert.equal(result.conflicts.length, 1);
  assert.deepEqual(result.conflicts[0].verdicts.slice().sort(), ['left', 'tie']);
});

test('an abstention beside a firm verdict is counted, not converted into a conflict', () => {
  const result = ingest([
    decision({ reviewerId: 'rev-a', verdict: 'left' }),
    decision({ reviewerId: 'rev-b', verdict: 'unresolved' }),
  ]);

  assert.equal(result.accepted.length, 2);
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.unresolvedCount, 1);
  assert.deepEqual(result.abstainedPairIds, [OPEN_PAIR]);
});

/* ── Writing through to a store ─────────────────────────────────── */

test('only accepted rows reach the store', () => {
  const store = createInMemoryDecisionStore();
  const good = decision({ reviewerId: 'rev-a' });

  const result = ingestIntoStore(
    [good, decision({ pairId: LOCKED_PAIR, reviewerId: 'rev-b' }), 'garbage'],
    store,
    { queue: QUEUE.items },
  );

  assert.equal(result.accepted.length, 1);
  assert.deepEqual(store.list().map((row) => row.decisionId), [good.decisionId]);
});

test('ingesting the same file twice adds nothing the second time', () => {
  const store = createInMemoryDecisionStore();
  const rows = [decision({ reviewerId: 'rev-a' }), decision({ pairId: OTHER_PAIR, reviewerId: 'rev-a' })];

  ingestIntoStore(rows, store, { queue: QUEUE.items });
  const second = ingestIntoStore(rows, store, { queue: QUEUE.items });

  assert.equal(store.list().length, 2);
  assert.equal(second.accepted.length, 0);
  assert.deepEqual(second.rejected.map((row) => row.code), ['DUPLICATE_DECISION', 'DUPLICATE_DECISION']);
});

/* ── Orientation ────────────────────────────────────────────────── */

test('a batch whose orientation no longer matches the queue is reported', () => {
  const batch = exportAnnotationBatch(QUEUE.items, { batchId: 'b1', exportedAt: ENQUEUED_AT });
  const stale = {
    ...batch,
    items: batch.items.map((item, index) =>
      index === 0
        ? { ...item, leftCommitmentId: item.rightCommitmentId, rightCommitmentId: item.leftCommitmentId }
        : item,
    ),
  };

  assert.deepEqual(verifyBatchOrientation(batch, QUEUE.items).issues, []);

  const drifted = verifyBatchOrientation(stale, QUEUE.items);
  assert.equal(drifted.valid, false);
  assert.ok(drifted.issues.some((issue) => issue.code === 'PAI030'));
});
