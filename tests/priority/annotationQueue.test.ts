/**
 * Annotation queue tests (Sprint 05, issue #21).
 *
 * The queue is what a reviewer is handed. Two of its properties are load-bearing
 * rather than cosmetic:
 *
 *  1. **A locked-split pair is never enqueued.** This is the first of the two
 *     leakage directions. If a reviewer is shown a locked pair at all, the
 *     resulting judgment can be fitted against and then "validated" on the same
 *     pair, and the held-out split stops being held out. The ingest check in
 *     annotationIngest.test.ts is the second direction; neither alone is enough,
 *     because a queue that never offers the pair still has to refuse a decision
 *     that arrives by another route, and an ingest check alone would leave the
 *     reviewer's time wasted on pairs whose answers must be discarded.
 *  2. **Nothing here reads a clock.** `enqueuedAt` is supplied. A queue whose
 *     contents change with the hour cannot be exported, reviewed and re-imported
 *     as the same batch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyDecisionsToQueue,
  buildAnnotationQueue,
  defaultSliceOf,
  exportAnnotationBatch,
  markQueueItemSkipped,
  parseAnnotationBatch,
  queueItemIdFor,
} from '../../lib/priority/annotation/annotationQueue.ts';
import { createReviewedDecision } from '../../lib/priority/annotation/reviewedDecision.ts';
import { PRIORITY_SEED_PAIRS, lockedSplitPairs } from '../fixtures/prioritySeedSet.ts';
import { CALIBRATION_SCHEMA_VERSION } from '../../src/contracts/v1/calibrationContracts.ts';
import { hasIssue } from '../../lib/evaluation/registry/validationPrimitives.ts';

const ENQUEUED_AT = '2026-08-19T08:00:00.000Z';

function build() {
  return buildAnnotationQueue({ enqueuedAt: ENQUEUED_AT });
}

/* ── Leakage, direction one: the queue never offers a locked pair ──── */

test('the queue enqueues every calibration pair and withholds the locked evaluation split', () => {
  const lockedIds = lockedSplitPairs().map((pair) => pair.pairId);
  assert.ok(lockedIds.length > 0, 'the seed set must hold a locked split for this test to mean anything');

  const built = build();

  assert.equal(built.items.length, PRIORITY_SEED_PAIRS.length - lockedIds.length);
  assert.deepEqual(built.withheldLockedPairIds.slice().sort(), lockedIds.slice().sort());
  for (const item of built.items) {
    assert.equal(
      lockedIds.includes(item.pairId),
      false,
      `${item.pairId} belongs to the locked split and must never be handed to a reviewer`,
    );
  }
});

test('a queue built from only locked pairs is empty rather than quietly enqueuing them', () => {
  const built = buildAnnotationQueue({ enqueuedAt: ENQUEUED_AT, pairs: lockedSplitPairs() });

  assert.equal(built.items.length, 0);
  assert.equal(built.withheldLockedPairIds.length, lockedSplitPairs().length);
});

/* ── Shape ──────────────────────────────────────────────────────── */

test('queue items carry the orientation the seed pair declares', () => {
  for (const item of build().items) {
    const pair = PRIORITY_SEED_PAIRS.find((candidate) => candidate.pairId === item.pairId);
    assert.ok(pair, `no seed pair named ${item.pairId}`);
    assert.equal(item.version, CALIBRATION_SCHEMA_VERSION);
    assert.equal(item.leftCommitmentId, pair.left.commitment.id);
    assert.equal(item.rightCommitmentId, pair.right.commitment.id);
    assert.equal(item.state, 'pending');
    assert.equal(item.enqueuedAt, ENQUEUED_AT);
    assert.equal(item.slice, defaultSliceOf(pair));
  }
});

test('building the queue twice over unchanged input produces identical items', () => {
  assert.equal(JSON.stringify(build().items), JSON.stringify(build().items));
});

test('the slice label is overridable, so a consumer may group by language alone', () => {
  const built = buildAnnotationQueue({
    enqueuedAt: ENQUEUED_AT,
    sliceOf: (pair) => pair.language,
  });

  assert.deepEqual(
    Array.from(new Set(built.items.map((item) => item.slice))).sort(),
    ['ar', 'en', 'he', 'mixed'],
  );
});

test('a queue item id cannot be minted for a pair id that would escape a directory', () => {
  assert.throws(() => queueItemIdFor('../../etc/passwd'), /queue item id/);
  assert.throws(() => queueItemIdFor(''), /queue item id/);
  assert.equal(queueItemIdFor('ps-ar-light-01'), 'aq_ps-ar-light-01');
});

/* ── State ──────────────────────────────────────────────────────── */

function decisionOn(pairId: string, reviewerId: string) {
  const pair = PRIORITY_SEED_PAIRS.find((candidate) => candidate.pairId === pairId);
  assert.ok(pair);
  return createReviewedDecision({
    pairId,
    reviewerId,
    verdict: 'left',
    rationale: 'C1 — left is overdue and right is not',
    hardConstraintFlag: false,
    decidedAt: '2026-08-19T09:00:00.000Z',
  });
}

test('applying decisions marks exactly the items that were decided', () => {
  const built = build();
  const target = built.items[0];

  const applied = applyDecisionsToQueue(built.items, [decisionOn(target.pairId, 'rev-a')]);

  assert.equal(applied.filter((item) => item.state === 'decided').length, 1);
  assert.equal(applied.find((item) => item.itemId === target.itemId)?.state, 'decided');
  assert.equal(applied.filter((item) => item.state === 'pending').length, built.items.length - 1);
});

test('a decided item cannot be turned back into a skip', () => {
  const built = build();
  const target = built.items[0];
  const applied = applyDecisionsToQueue(built.items, [decisionOn(target.pairId, 'rev-a')]);

  assert.throws(() => markQueueItemSkipped(applied, target.itemId), /decided/);
});

test('skipping a pending item changes only that item', () => {
  const built = build();
  const skipped = markQueueItemSkipped(built.items, built.items[1].itemId);

  assert.equal(skipped[1].state, 'skipped');
  assert.equal(skipped.filter((item) => item.state === 'skipped').length, 1);
  assert.throws(() => markQueueItemSkipped(built.items, 'aq_no-such-pair'), /unknown queue item/);
});

/* ── Batches ────────────────────────────────────────────────────── */

test('exported batches partition the pending queue without overlap or loss', () => {
  const built = build();
  const first = exportAnnotationBatch(built.items, { batchId: 'b1', exportedAt: ENQUEUED_AT, limit: 7 });
  const second = exportAnnotationBatch(built.items, {
    batchId: 'b2',
    exportedAt: ENQUEUED_AT,
    limit: 7,
    offset: 7,
  });
  const third = exportAnnotationBatch(built.items, {
    batchId: 'b3',
    exportedAt: ENQUEUED_AT,
    limit: 7,
    offset: 14,
  });

  const ids = [...first.items, ...second.items, ...third.items].map((item) => item.itemId);
  assert.equal(new Set(ids).size, ids.length, 'no item may appear in two batches');
  assert.deepEqual(ids.slice().sort(), built.items.map((item) => item.itemId).slice().sort());
});

test('a batch excludes items that are already decided', () => {
  const built = build();
  const applied = applyDecisionsToQueue(built.items, [decisionOn(built.items[0].pairId, 'rev-a')]);

  const batch = exportAnnotationBatch(applied, { batchId: 'b1', exportedAt: ENQUEUED_AT });

  assert.equal(batch.items.length, built.items.length - 1);
  assert.equal(batch.items.some((item) => item.itemId === built.items[0].itemId), false);
});

test('a batch round-trips through parse unchanged', () => {
  const batch = exportAnnotationBatch(build().items, { batchId: 'b1', exportedAt: ENQUEUED_AT });
  const parsed = parseAnnotationBatch(JSON.parse(JSON.stringify(batch)) as unknown);

  assert.equal(parsed.valid, true, JSON.stringify(parsed.issues, null, 2));
  assert.deepEqual(parsed.batch, batch);
});

test('a batch carrying a malformed item is rejected rather than repaired', () => {
  const batch = exportAnnotationBatch(build().items, { batchId: 'b1', exportedAt: ENQUEUED_AT });
  const tampered = JSON.parse(JSON.stringify(batch)) as { items: Record<string, unknown>[] };
  tampered.items[0].state = 'maybe';
  tampered.items[1].enqueuedAt = 'last tuesday';
  tampered.items[2].rightCommitmentId = tampered.items[2].leftCommitmentId;

  const parsed = parseAnnotationBatch(tampered);

  assert.equal(parsed.valid, false);
  assert.equal(parsed.batch, null);
  assert.ok(hasIssue(parsed, 'PAQ015'), 'state outside the vocabulary');
  assert.ok(hasIssue(parsed, 'PAQ017'), 'enqueuedAt must be ISO-8601');
  assert.ok(hasIssue(parsed, 'PAQ014'), 'a pair cannot compare a commitment with itself');
});

test('the queue builder reads no clock: the same instant in produces the same instant out', () => {
  const other = buildAnnotationQueue({ enqueuedAt: '2001-01-01T00:00:00.000Z' });

  assert.equal(other.items[0].enqueuedAt, '2001-01-01T00:00:00.000Z');
  assert.throws(() => buildAnnotationQueue({ enqueuedAt: 'now' }), /enqueuedAt/);
});
