/**
 * Hard-constraint preservation as a filter (Sprint 05, issue #22).
 *
 * This is the criterion the sprint turns on, so the central case is
 * constructed deliberately rather than hoped for: a candidate policy that
 * **improves aggregate concordance** and **inverts a constrained pair** at the
 * same time. A weighted penalty would let that candidate through as long as its
 * aggregate gain outweighed the penalty; a filter cannot, at any weight.
 *
 * Two kinds of constraint are checked, and they fail differently:
 *
 *  - **Declared** — a reviewer asserted (`ReviewedDecision.hardConstraintFlag`)
 *    that a pair's ordering was forced. Reachable by weights, and the case the
 *    admissibility test below is built on.
 *  - **Structural** — one side is a user-pinned high-importance commitment.
 *    `rankPriorities` puts pinned items in their own ordering tier, so no weight
 *    can invert one. The check is kept anyway, as a net under a future change to
 *    the ranker, and the test asserts the tier actually holds across the whole
 *    sweep rather than assuming it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PRIORITY_POLICY } from '../../lib/priority/priorityPolicy.ts';
import { checkConstraints } from '../../lib/priority/calibration/constraints.ts';
import { evaluateConcordance } from '../../lib/priority/calibration/concordance.ts';
import { canonicalSweepGrid } from '../../lib/priority/calibration/sweep.ts';
import { runCalibration } from '../../lib/priority/calibration/calibrate.ts';
import { hardConstraintsFromDecisions } from '../../lib/priority/calibration/corpus.ts';
import { CALIBRATION_SCHEMA_VERSION } from '../../src/contracts/v1/calibrationContracts.ts';
import { judgmentOf, pairOf, syntheticCorpus, CAL_CLOCK } from './calibrationFixtures.ts';

const BASE = DEFAULT_PRIORITY_POLICY;
const GENERATED_AT = '2026-08-19T00:00:00.000Z';

/**
 * Three pairs of identical shape — a high-importance commitment against a
 * once-snoozed normal one — and one of them carries a reviewer's hard-constraint
 * flag pointing at the high-importance side.
 *
 * Because the shape is identical, *every* weight move that fixes the two
 * unconstrained pairs also inverts the constrained one. The improvement is real
 * (1/3 -> 2/3) and it is exactly what must not be purchasable.
 */
function constrainedCorpus() {
  const pinned = pairOf({
    pairId: 'cx',
    slice: 'constrained',
    left: { id: 'cx-a', level: 'high' },
    right: { id: 'cx-b', snoozes: 1 },
  });
  const free1 = pairOf({ pairId: 'cp1', slice: 'free', left: { id: 'cp1-a', snoozes: 1 }, right: { id: 'cp1-b', level: 'high' } });
  const free2 = pairOf({ pairId: 'cp2', slice: 'free', left: { id: 'cp2-a', snoozes: 1 }, right: { id: 'cp2-b', level: 'high' } });

  return syntheticCorpus({
    pairs: [pinned, free1, free2],
    judgments: [
      judgmentOf({ pairId: 'cx', pair: pinned, verdict: 'left' }),
      judgmentOf({ pairId: 'cp1', pair: free1, verdict: 'left' }),
      judgmentOf({ pairId: 'cp2', pair: free2, verdict: 'left' }),
    ],
    hardConstraints: hardConstraintsFromDecisions(
      [
        {
          version: CALIBRATION_SCHEMA_VERSION,
          decisionId: 'dec-cx-1',
          pairId: 'cx',
          reviewerId: 'synthetic-reviewer-1',
          verdict: 'left',
          rationale: 'synthetic pipeline proof; the ordering was stated as forced',
          hardConstraintFlag: true,
          decidedAt: CAL_CLOCK,
        },
      ],
      [pinned, free1, free2],
    ),
  });
}

/* ── The filter ──────────────────────────────────────────────────── */

test('constraints: a reviewer hard-constraint flag becomes a declaration naming the pinned commitment', () => {
  const corpus = constrainedCorpus();
  assert.deepEqual(corpus.hardConstraints, [
    { pairId: 'cx', pinnedCommitmentId: 'cx-a', declaredBy: 'dec-cx-1' },
  ]);
});

test('constraints: the baseline satisfies the declared constraint', () => {
  const check = checkConstraints(constrainedCorpus(), BASE);
  assert.deepEqual(check.violations, []);
  assert.equal(check.declaredConstraintPairs, 1);
});

test('constraints: a candidate that improves the aggregate while inverting a constraint is rejected', () => {
  const corpus = constrainedCorpus();
  const baselineRate = evaluateConcordance(corpus, BASE).overall.rate;
  assert.equal(baselineRate, 0.3333);

  const inverting = canonicalSweepGrid(BASE).filter((policy) => {
    const rate = evaluateConcordance(corpus, policy).overall.rate;
    return rate !== null && rate > baselineRate!;
  });

  // The case has to exist, or the test proves nothing.
  assert.ok(inverting.length > 0, 'expected at least one candidate to improve the aggregate');

  for (const policy of inverting) {
    const check = checkConstraints(corpus, policy);
    assert.equal(check.violations.length, 1, `${policy.version} should violate the declared constraint`);
    assert.deepEqual(check.violations[0], {
      pairId: 'cx',
      pinnedCommitmentId: 'cx-a',
      outrankedByCommitmentId: 'cx-b',
    });
  }
});

test('constraints: the improving candidate is admissible:false and is never selected as best', () => {
  const corpus = constrainedCorpus();
  const report = runCalibration({ corpus, basePolicy: BASE, generatedAt: GENERATED_AT, searchSeed: 11 });

  const improving = report.candidates.filter(
    (candidate) => candidate.overall.rate !== null && candidate.overall.rate > report.baseline.overall.rate!,
  );
  assert.ok(improving.length > 0);
  for (const candidate of improving) {
    assert.equal(candidate.admissible, false);
    assert.ok(candidate.constraintViolations.length > 0);
  }

  // A penalty term would have let the best of these through. A filter cannot.
  assert.equal(report.best, null);
  assert.equal(report.status, 'NO ADMISSIBLE IMPROVEMENT');
  assert.equal(report.rejectedForConstraintCount, improving.length);
});

test('constraints: admissible is false exactly when a violation is present', () => {
  const report = runCalibration({
    corpus: constrainedCorpus(),
    basePolicy: BASE,
    generatedAt: GENERATED_AT,
    searchSeed: 11,
  });

  for (const candidate of [report.baseline, ...report.candidates]) {
    assert.equal(candidate.admissible, candidate.constraintViolations.length === 0, candidate.policy.version);
  }
});

/* ── The structural pin ──────────────────────────────────────────── */

test('constraints: a user-pinned commitment outranks an unpinned one under every candidate on the grid', () => {
  const pinned = pairOf({
    pairId: 'sp1',
    // The pinned side is worth *less* on points, so only the tier can put it first.
    left: { id: 'sp1-pinned', level: 'high', source: 'user_explicit' },
    right: { id: 'sp1-loud', snoozes: 3 },
  });
  const corpus = syntheticCorpus({ pairs: [pinned], judgments: [] });

  const baseCheck = checkConstraints(corpus, BASE);
  assert.equal(baseCheck.structuralPinPairs, 1, 'the structural pin must actually be detected');
  assert.deepEqual(baseCheck.violations, []);

  for (const policy of canonicalSweepGrid(BASE)) {
    assert.deepEqual(checkConstraints(corpus, policy).violations, [], policy.version);
  }
});

test('constraints: a pair with no pin and no declaration is not treated as constrained', () => {
  const plain = pairOf({ pairId: 'np1', left: { id: 'np1-a' }, right: { id: 'np1-b', level: 'high' } });
  const check = checkConstraints(syntheticCorpus({ pairs: [plain], judgments: [] }), BASE);

  assert.equal(check.structuralPinPairs, 0);
  assert.equal(check.declaredConstraintPairs, 0);
  assert.deepEqual(check.violations, []);
});

test('constraints: both sides user-pinned is not a pin of one over the other', () => {
  const both = pairOf({
    pairId: 'bp1',
    left: { id: 'bp1-a', level: 'high', source: 'user_explicit' },
    right: { id: 'bp1-b', level: 'high', source: 'user_explicit', snoozes: 2 },
  });
  const check = checkConstraints(syntheticCorpus({ pairs: [both], judgments: [] }), BASE);

  assert.equal(check.structuralPinPairs, 0);
  assert.deepEqual(check.violations, []);
});
