/**
 * Concordance scoring and corpus digest (Sprint 05, issue #22).
 *
 * The objective the whole calibration pipeline optimises. Two properties are
 * load-bearing and both are inherited from Sprint 04's agreement report rather
 * than reinvented here:
 *
 *  - `unresolved` leaves the denominator entirely. Counting an abstention as
 *    concordant would make a corpus of abstentions score 100%; counting it as
 *    discordant would punish a reviewer for following the rubric.
 *  - Coverage travels with the rate, and the rate is `null` — never 0 — when
 *    nothing was scorable. Zero is a measurement of total disagreement, and the
 *    absence of data is not that.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PRIORITY_POLICY } from '../../lib/priority/priorityPolicy.ts';
import { evaluateConcordance } from '../../lib/priority/calibration/concordance.ts';
import { computeCorpusDigest } from '../../lib/priority/calibration/corpus.ts';
import { judgmentOf, pairOf, syntheticCorpus } from './calibrationFixtures.ts';

const BASE = DEFAULT_PRIORITY_POLICY;

/* ── The rate and its coverage ───────────────────────────────────── */

test('concordance: rate counts only pairs the policy could be scored against', () => {
  const p1 = pairOf({ pairId: 'p1', left: { id: 'a1', level: 'high' }, right: { id: 'b1', level: 'normal' } });
  const p2 = pairOf({ pairId: 'p2', left: { id: 'a2', level: 'normal' }, right: { id: 'b2', level: 'high' } });
  const p3 = pairOf({ pairId: 'p3', left: { id: 'a3', level: 'high' }, right: { id: 'b3', level: 'normal' } });

  const corpus = syntheticCorpus({
    pairs: [p1, p2, p3],
    judgments: [
      judgmentOf({ pairId: 'p1', pair: p1, verdict: 'left' }),
      judgmentOf({ pairId: 'p2', pair: p2, verdict: 'left' }),
      judgmentOf({ pairId: 'p3', pair: p3, verdict: 'unresolved' }),
    ],
  });

  const result = evaluateConcordance(corpus, BASE);

  assert.equal(result.overall.scorablePairs, 2);
  assert.equal(result.overall.unscorablePairs, 1);
  assert.equal(result.overall.concordantPairs, 1);
  assert.equal(result.overall.rate, 0.5);
});

test('concordance: a corpus of only unresolved judgments yields a null rate and does not crash', () => {
  const p1 = pairOf({ pairId: 'p1', left: { id: 'a1', level: 'high' }, right: { id: 'b1', level: 'normal' } });
  const corpus = syntheticCorpus({
    pairs: [p1],
    judgments: [
      judgmentOf({ pairId: 'p1', pair: p1, verdict: 'unresolved' }),
      judgmentOf({ pairId: 'p1', pair: p1, verdict: 'unresolved', annotatorId: 'synthetic-annotator-2' }),
    ],
  });

  const result = evaluateConcordance(corpus, BASE);

  assert.equal(result.overall.rate, null);
  assert.equal(result.overall.concordantPairs, 0);
  assert.equal(result.overall.scorablePairs, 0);
  assert.equal(result.overall.unscorablePairs, 1);
});

test('concordance: an empty corpus reports null rather than a rate of zero', () => {
  const result = evaluateConcordance(syntheticCorpus({ pairs: [], judgments: [] }), BASE);

  assert.equal(result.overall.rate, null);
  assert.equal(result.overall.scorablePairs, 0);
  assert.equal(result.overall.unscorablePairs, 0);
});

test('concordance: a judged pair with no scorable counterpart is unscorable, not discordant', () => {
  const corpus = syntheticCorpus({
    pairs: [],
    judgments: [judgmentOf({ pairId: 'ghost', verdict: 'left' })],
  });

  const result = evaluateConcordance(corpus, BASE);

  assert.equal(result.overall.rate, null);
  assert.equal(result.overall.unscorablePairs, 1);
  assert.equal(result.outcomes[0].reasonCode, 'UNKNOWN_PAIR');
});

test('concordance: reviewers who disagree on a pair leave it out of the denominator', () => {
  const p1 = pairOf({ pairId: 'p1', left: { id: 'a1', level: 'high' }, right: { id: 'b1', level: 'normal' } });
  const corpus = syntheticCorpus({
    pairs: [p1],
    judgments: [
      judgmentOf({ pairId: 'p1', pair: p1, verdict: 'left' }),
      judgmentOf({ pairId: 'p1', pair: p1, verdict: 'right', annotatorId: 'synthetic-annotator-2' }),
    ],
  });

  const result = evaluateConcordance(corpus, BASE);

  assert.equal(result.overall.scorablePairs, 0);
  assert.equal(result.overall.rate, null);
  assert.equal(result.outcomes[0].reasonCode, 'CONFLICTING_VERDICTS');
});

test('concordance: a tie verdict is concordant only when the policy ranks the sides as equivalent', () => {
  const even = pairOf({ pairId: 'even', left: { id: 'a1' }, right: { id: 'b1' } });
  const uneven = pairOf({ pairId: 'uneven', left: { id: 'a2', level: 'high' }, right: { id: 'b2' } });

  const result = evaluateConcordance(
    syntheticCorpus({
      pairs: [even, uneven],
      judgments: [
        judgmentOf({ pairId: 'even', pair: even, verdict: 'tie' }),
        judgmentOf({ pairId: 'uneven', pair: uneven, verdict: 'tie' }),
      ],
    }),
    BASE,
  );

  assert.equal(result.overall.scorablePairs, 2);
  assert.equal(result.overall.concordantPairs, 1);
  const byPair = new Map(result.outcomes.map((outcome) => [outcome.pairId, outcome.status]));
  assert.equal(byPair.get('even'), 'concordant');
  assert.equal(byPair.get('uneven'), 'discordant');
});

/* ── Slices ──────────────────────────────────────────────────────── */

test('concordance: each slice carries its own rate and its own coverage', () => {
  const heavy = pairOf({
    pairId: 'h1',
    slice: 'heavy',
    left: { id: 'ha', level: 'high' },
    right: { id: 'hb', level: 'normal' },
  });
  const light = pairOf({
    pairId: 'l1',
    slice: 'light',
    left: { id: 'la', level: 'normal' },
    right: { id: 'lb', level: 'high' },
  });

  const result = evaluateConcordance(
    syntheticCorpus({
      pairs: [heavy, light],
      judgments: [
        judgmentOf({ pairId: 'h1', pair: heavy, verdict: 'left' }),
        judgmentOf({ pairId: 'l1', pair: light, verdict: 'left' }),
      ],
    }),
    BASE,
  );

  assert.deepEqual(result.bySlice.heavy, { concordantPairs: 1, scorablePairs: 1, unscorablePairs: 0, rate: 1 });
  assert.deepEqual(result.bySlice.light, { concordantPairs: 0, scorablePairs: 1, unscorablePairs: 0, rate: 0 });
});

/* ── Identity ────────────────────────────────────────────────────── */

test('concordance: a candidate identical to the baseline produces identical metrics', () => {
  const p1 = pairOf({ pairId: 'p1', left: { id: 'a1', level: 'high' }, right: { id: 'b1', snoozes: 2 } });
  const corpus = syntheticCorpus({
    pairs: [p1],
    judgments: [judgmentOf({ pairId: 'p1', pair: p1, verdict: 'left' })],
  });

  const baseline = evaluateConcordance(corpus, BASE);
  const twin = evaluateConcordance(corpus, { ...BASE, weights: { ...BASE.weights } });

  assert.deepEqual(twin.overall, baseline.overall);
  assert.deepEqual(twin.bySlice, baseline.bySlice);
  assert.deepEqual(twin.outcomes, baseline.outcomes);
});

/* ── Digest ──────────────────────────────────────────────────────── */

test('digest: the corpus digest is a function of content, not of row order', () => {
  const p1 = pairOf({ pairId: 'p1', left: { id: 'a1', level: 'high' }, right: { id: 'b1' } });
  const p2 = pairOf({ pairId: 'p2', left: { id: 'a2' }, right: { id: 'b2', level: 'high' } });
  const j1 = judgmentOf({ pairId: 'p1', pair: p1, verdict: 'left' });
  const j2 = judgmentOf({ pairId: 'p2', pair: p2, verdict: 'right' });

  const forwards = computeCorpusDigest(syntheticCorpus({ pairs: [p1, p2], judgments: [j1, j2] }));
  const backwards = computeCorpusDigest(syntheticCorpus({ pairs: [p2, p1], judgments: [j2, j1] }));

  assert.equal(forwards, backwards);
});

test('digest: changing a single verdict changes the digest', () => {
  const p1 = pairOf({ pairId: 'p1', left: { id: 'a1', level: 'high' }, right: { id: 'b1' } });
  const before = computeCorpusDigest(
    syntheticCorpus({ pairs: [p1], judgments: [judgmentOf({ pairId: 'p1', pair: p1, verdict: 'left' })] }),
  );
  const after = computeCorpusDigest(
    syntheticCorpus({ pairs: [p1], judgments: [judgmentOf({ pairId: 'p1', pair: p1, verdict: 'right' })] }),
  );

  assert.notEqual(before, after);
});

test('digest: provenance is part of the digest, so a relabelled corpus is a different corpus', () => {
  const p1 = pairOf({ pairId: 'p1', left: { id: 'a1', level: 'high' }, right: { id: 'b1' } });
  const synthetic = syntheticCorpus({ pairs: [p1], judgments: [] });
  const relabelled = { ...synthetic, provenance: 'human_reviewed' as const };

  assert.notEqual(computeCorpusDigest(synthetic), computeCorpusDigest(relabelled));
});
