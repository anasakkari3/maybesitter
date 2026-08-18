/**
 * The single-use locked-split gate (Sprint 05, issue #22).
 *
 * The gate exists to answer one question once: does the policy hold up on data
 * it was never fitted to? Three ways of getting that wrong are guarded here,
 * and each of them fails by producing a *reassuring* answer rather than an
 * error.
 *
 *  - **A vacuous pass.** A gate that reports "passed" over zero judgments is
 *    worse than no gate at all: it manufactures confidence out of an absence of
 *    data. The corpus ships empty today, so this is the state the gate is
 *    actually in, not a hypothetical.
 *  - **A second look.** Once a locked split has been measured against, it is no
 *    longer held out. Re-running until the number comes out right is fitting to
 *    the test set one attempt at a time.
 *  - **A free retry.** A *failed* gate consumes the split exactly as a passing
 *    one does. If failure were free, "run it again after a tweak" would be the
 *    obvious next move, and that is the same leak wearing a different face.
 *
 * A refusal, by contrast, does **not** consume the split: nothing was measured,
 * so nothing was spent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PRIORITY_POLICY } from '../../lib/priority/priorityPolicy.ts';
import { runLockedGate } from '../../lib/priority/calibration/lockedGate.ts';
import { runCalibration } from '../../lib/priority/calibration/calibrate.ts';
import { judgmentOf, pairOf, syntheticCorpus } from './calibrationFixtures.ts';

const BASE = DEFAULT_PRIORITY_POLICY;
const SPLIT = 'priority-locked-split-v1';

/** Both pairs are ordered the way the shipped weights order them. */
function agreeingCorpus() {
  const p1 = pairOf({ pairId: 'lk1', left: { id: 'lk1-a', level: 'high' }, right: { id: 'lk1-b' } });
  const p2 = pairOf({ pairId: 'lk2', left: { id: 'lk2-a', level: 'high' }, right: { id: 'lk2-b' } });
  return syntheticCorpus({
    pairs: [p1, p2],
    judgments: [
      judgmentOf({ pairId: 'lk1', pair: p1, verdict: 'left' }),
      judgmentOf({ pairId: 'lk2', pair: p2, verdict: 'left' }),
    ],
  });
}

/** Both pairs are ordered against the shipped weights. */
function disagreeingCorpus() {
  const p1 = pairOf({ pairId: 'lk1', left: { id: 'lk1-a', level: 'high' }, right: { id: 'lk1-b' } });
  const p2 = pairOf({ pairId: 'lk2', left: { id: 'lk2-a', level: 'high' }, right: { id: 'lk2-b' } });
  return syntheticCorpus({
    pairs: [p1, p2],
    judgments: [
      judgmentOf({ pairId: 'lk1', pair: p1, verdict: 'right' }),
      judgmentOf({ pairId: 'lk2', pair: p2, verdict: 'right' }),
    ],
  });
}

/* ── Refusals ────────────────────────────────────────────────────── */

test('gate: an empty corpus is refused, never passed', () => {
  const run = runLockedGate({
    splitId: SPLIT,
    corpus: syntheticCorpus({ pairs: [], judgments: [] }),
    policy: BASE,
    minimumConcordance: 0.8,
    usedSplitIds: [],
  });

  assert.equal(run.result.outcome, 'refused_empty_corpus');
  assert.equal(run.result.metric, null);
  assert.match(run.result.reason, /no judgments/i);
});

test('gate: a refusal does not consume the split', () => {
  const run = runLockedGate({
    splitId: SPLIT,
    corpus: syntheticCorpus({ pairs: [], judgments: [] }),
    policy: BASE,
    minimumConcordance: 0.8,
    usedSplitIds: [],
  });

  assert.deepEqual(run.usedSplitIds, []);
});

test('gate: a corpus of nothing but abstentions is refused, with its coverage stated', () => {
  const p1 = pairOf({ pairId: 'lk1', left: { id: 'lk1-a', level: 'high' }, right: { id: 'lk1-b' } });
  const run = runLockedGate({
    splitId: SPLIT,
    corpus: syntheticCorpus({
      pairs: [p1],
      judgments: [judgmentOf({ pairId: 'lk1', pair: p1, verdict: 'unresolved' })],
    }),
    policy: BASE,
    minimumConcordance: 0.8,
    usedSplitIds: [],
  });

  assert.equal(run.result.outcome, 'refused_empty_corpus');
  // Rows existed, so the gate can say what it looked at — but nothing was
  // scorable, so there is no rate and therefore nothing to pass.
  assert.notEqual(run.result.metric, null);
  assert.equal(run.result.metric?.rate, null);
  assert.equal(run.result.metric?.unscorablePairs, 1);
  assert.deepEqual(run.usedSplitIds, []);
});

/* ── Single use ──────────────────────────────────────────────────── */

test('gate: a passing run consumes the split', () => {
  const run = runLockedGate({
    splitId: SPLIT,
    corpus: agreeingCorpus(),
    policy: BASE,
    minimumConcordance: 0.8,
    usedSplitIds: [],
  });

  assert.equal(run.result.outcome, 'passed');
  assert.equal(run.result.metric?.rate, 1);
  assert.deepEqual(run.usedSplitIds, [SPLIT]);
});

test('gate: a failing run consumes the split too, so failure buys no retry', () => {
  const run = runLockedGate({
    splitId: SPLIT,
    corpus: disagreeingCorpus(),
    policy: BASE,
    minimumConcordance: 0.8,
    usedSplitIds: [],
  });

  assert.equal(run.result.outcome, 'failed');
  assert.equal(run.result.metric?.rate, 0);
  assert.deepEqual(run.usedSplitIds, [SPLIT]);
});

test('gate: a second use of the same locked split is refused', () => {
  const first = runLockedGate({
    splitId: SPLIT,
    corpus: agreeingCorpus(),
    policy: BASE,
    minimumConcordance: 0.8,
    usedSplitIds: [],
  });
  const second = runLockedGate({
    splitId: SPLIT,
    corpus: agreeingCorpus(),
    policy: BASE,
    minimumConcordance: 0.8,
    usedSplitIds: first.usedSplitIds,
  });

  assert.equal(second.result.outcome, 'refused_already_used');
  assert.equal(second.result.metric, null);
  assert.deepEqual(second.usedSplitIds, [SPLIT], 'a refused re-use must not append a second entry');
});

test('gate: re-use is detected before emptiness, so a re-run cannot hide behind an empty corpus', () => {
  const run = runLockedGate({
    splitId: SPLIT,
    corpus: syntheticCorpus({ pairs: [], judgments: [] }),
    policy: BASE,
    minimumConcordance: 0.8,
    usedSplitIds: [SPLIT],
  });

  assert.equal(run.result.outcome, 'refused_already_used');
});

test('gate: a different split is not blocked by a used one', () => {
  const run = runLockedGate({
    splitId: 'priority-locked-split-v2',
    corpus: agreeingCorpus(),
    policy: BASE,
    minimumConcordance: 0.8,
    usedSplitIds: [SPLIT],
  });

  assert.equal(run.result.outcome, 'passed');
  assert.deepEqual(run.usedSplitIds, [SPLIT, 'priority-locked-split-v2']);
});

/* ── The threshold ───────────────────────────────────────────────── */

test('gate: the threshold is inclusive and must be a rate', () => {
  const half = pairOf({ pairId: 'lk1', left: { id: 'lk1-a', level: 'high' }, right: { id: 'lk1-b' } });
  const other = pairOf({ pairId: 'lk2', left: { id: 'lk2-a', level: 'high' }, right: { id: 'lk2-b' } });
  const corpus = syntheticCorpus({
    pairs: [half, other],
    judgments: [
      judgmentOf({ pairId: 'lk1', pair: half, verdict: 'left' }),
      judgmentOf({ pairId: 'lk2', pair: other, verdict: 'right' }),
    ],
  });

  const atThreshold = runLockedGate({ splitId: SPLIT, corpus, policy: BASE, minimumConcordance: 0.5, usedSplitIds: [] });
  assert.equal(atThreshold.result.outcome, 'passed');

  const aboveThreshold = runLockedGate({ splitId: SPLIT, corpus, policy: BASE, minimumConcordance: 0.51, usedSplitIds: [] });
  assert.equal(aboveThreshold.result.outcome, 'failed');

  assert.throws(
    () => runLockedGate({ splitId: SPLIT, corpus, policy: BASE, minimumConcordance: 1.5, usedSplitIds: [] }),
    TypeError,
  );
});

test('gate: the reason always states the coverage the outcome rests on', () => {
  const run = runLockedGate({
    splitId: SPLIT,
    corpus: agreeingCorpus(),
    policy: BASE,
    minimumConcordance: 0.8,
    usedSplitIds: [],
  });

  assert.match(run.result.reason, /2 of 2/);
});

/* ── The manifest records the use ────────────────────────────────── */

test('gate: a calibration run that consumed the locked split says so in its manifest', () => {
  const corpus = agreeingCorpus();
  const withoutGate = runCalibration({
    corpus,
    basePolicy: BASE,
    generatedAt: '2026-08-19T00:00:00.000Z',
    searchSeed: 3,
  });
  const withGate = runCalibration({
    corpus,
    basePolicy: BASE,
    generatedAt: '2026-08-19T00:00:00.000Z',
    searchSeed: 3,
    lockedSplitUsed: true,
  });

  assert.equal(withoutGate.manifest.lockedSplitUsed, false);
  assert.equal(withGate.manifest.lockedSplitUsed, true);
});
