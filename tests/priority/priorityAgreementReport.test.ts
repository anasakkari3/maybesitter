/**
 * Agreement-report tests for the Priority annotation corpus (Sprint 04, #19).
 *
 * Every judgment in this file is constructed inside the test as a *test input*.
 * That is legitimate and is not the same thing as shipping a judgment corpus:
 * these rows exist to prove the arithmetic is right, they are never loaded from
 * disk, and `tests/priority/prioritySeedSet.test.ts` separately asserts that the
 * shipped corpus has no rows at all.
 *
 * The scoring code has to be genuinely correct now, because the point of
 * shipping the ingestion wired-and-empty is that the first real annotation run
 * needs no code changes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { PairwiseJudgment, JudgmentVerdict } from '../../src/contracts/v1/priorityContracts.ts';
import {
  JUDGMENT_CORPUS_CONTRACT_VERSION,
  buildAgreementReport,
  generateAgreementMarkdown,
  loadPairwiseJudgments,
} from '../../lib/priority/rubric/agreementReport.ts';
import { MALFORMED_JUDGMENTS, PRIORITY_SEED_PAIRS } from '../fixtures/prioritySeedSet.ts';

const FIXED_GENERATED_AT = '2026-08-18T09:00:00.000Z';

function judgment(
  pairId: string,
  annotatorId: string,
  verdict: JudgmentVerdict,
  overrides: Partial<PairwiseJudgment> = {},
): PairwiseJudgment {
  return {
    pairId,
    leftCommitmentId: `${pairId}-a`,
    rightCommitmentId: `${pairId}-b`,
    verdict,
    annotatorId,
    rationale: verdict === 'unresolved' ? 'U3 — separable only by effort' : 'C1 — one side is overdue',
    judgedAt: FIXED_GENERATED_AT,
    ...overrides,
  };
}

/**
 * These tests exercise the agreement arithmetic over their own synthetic pairs,
 * so they declare their own pair universe. Without it the denominator would be
 * the shipped seed set and every figure here would be diluted by seed pairs the
 * test never intended to model.
 */
function report(judgments: readonly PairwiseJudgment[]) {
  return buildAgreementReport(judgments, {
    generatedAt: FIXED_GENERATED_AT,
    seedPairIds: Array.from(new Set(judgments.map((judgment) => judgment.pairId))),
  });
}

function corpus(judgments: readonly unknown[]): unknown {
  return { contractVersion: JUDGMENT_CORPUS_CONTRACT_VERSION, judgments };
}

/* ── Empty corpus ────────────────────────────────────────────────── */

test('a report over no judgments says the corpus is empty rather than reporting zeros', () => {
  const result = report([]);

  assert.equal(result.corpusEmpty, true);
  assert.equal(result.observedAgreement, null, 'zero agreement and no data are different claims');
  assert.equal(result.pairCount, 0);
  assert.equal(result.annotatorCount, 0);
  assert.equal(result.unresolvedCount, 0);
  assert.deepEqual(result.disagreements, []);
  assert.equal(result.status, 'CORPUS EMPTY');
  assert.equal(result.version, 'priority-v1');
  assert.equal(result.generatedAt, FIXED_GENERATED_AT);
});

test('the empty-corpus markdown states that no annotation has been collected', () => {
  const markdown = generateAgreementMarkdown(report([]));

  assert.match(markdown, /NOT HUMAN EVIDENCE/);
  assert.match(markdown, /CORPUS EMPTY/);
  assert.match(markdown, /no judgments/i);
  assert.doesNotMatch(markdown, /Observed agreement: 0/, 'an empty corpus must not render an agreement figure');
});

/* ── Observed agreement ──────────────────────────────────────────── */

test('observed agreement counts concordant annotator pairs over comparable ones', () => {
  const result = report([
    judgment('p1', 'ann-a', 'left'),
    judgment('p1', 'ann-b', 'left'),
    judgment('p2', 'ann-a', 'right'),
    judgment('p2', 'ann-b', 'right'),
    judgment('p3', 'ann-a', 'left'),
    judgment('p3', 'ann-b', 'right'),
  ]);

  assert.equal(result.corpusEmpty, false);
  assert.equal(result.pairCount, 3);
  assert.equal(result.annotatorCount, 2);
  assert.equal(result.comparableVerdictPairCount, 3);
  assert.equal(result.concordantVerdictPairCount, 2);
  assert.equal(result.observedAgreement, 0.6667);
  assert.equal(result.scorablePairCount, 3);
  assert.equal(result.unscorablePairCount, 0);
  assert.deepEqual(result.disagreements, ["p3: ann-a='left' vs ann-b='right'"]);
});

test('three annotators on one pair produce three comparisons, not one', () => {
  const result = report([
    judgment('p1', 'ann-a', 'left'),
    judgment('p1', 'ann-b', 'left'),
    judgment('p1', 'ann-c', 'right'),
  ]);

  assert.equal(result.comparableVerdictPairCount, 3);
  assert.equal(result.concordantVerdictPairCount, 1);
  assert.equal(result.observedAgreement, 0.3333);
  assert.equal(result.disagreements.length, 2);
});

test('tie agrees with tie and disagrees with a preference', () => {
  const agreeing = report([judgment('p1', 'ann-a', 'tie'), judgment('p1', 'ann-b', 'tie')]);
  assert.equal(agreeing.observedAgreement, 1);
  assert.deepEqual(agreeing.disagreements, []);

  const disagreeing = report([judgment('p2', 'ann-a', 'tie'), judgment('p2', 'ann-b', 'left')]);
  assert.equal(disagreeing.observedAgreement, 0);
  assert.deepEqual(disagreeing.disagreements, ["p2: ann-a='tie' vs ann-b='left'"]);
});

test('a pair judged by only one annotator is not scorable and does not move the number', () => {
  const result = report([
    judgment('p1', 'ann-a', 'left'),
    judgment('p1', 'ann-b', 'left'),
    judgment('p2', 'ann-a', 'right'),
  ]);

  assert.equal(result.pairCount, 2);
  assert.equal(result.scorablePairCount, 1);
  assert.equal(result.unscorablePairCount, 1);
  assert.equal(result.comparableVerdictPairCount, 1);
  assert.equal(result.observedAgreement, 1);
});

/* ── The `unresolved` rule ───────────────────────────────────────── */

test('unresolved is excluded from the denominator: neither agreement nor disagreement', () => {
  // p1 is a clean concordant pair. p2 pits a preference against an abstention.
  // If abstention counted as disagreement the answer would be 0.5; if two
  // abstentions counted as agreement the next test would read 1. Both are wrong.
  const result = report([
    judgment('p1', 'ann-a', 'left'),
    judgment('p1', 'ann-b', 'left'),
    judgment('p2', 'ann-a', 'left'),
    judgment('p2', 'ann-b', 'unresolved'),
  ]);

  assert.equal(result.observedAgreement, 1);
  assert.equal(result.comparableVerdictPairCount, 1);
  assert.equal(result.unresolvedCount, 1);
  assert.equal(result.pairCount, 2);
  assert.equal(result.scorablePairCount, 1);
  assert.equal(result.unscorablePairCount, 1, 'a pair with fewer than two resolving verdicts is not scorable');
  assert.deepEqual(result.disagreements, [], 'an abstention is not a disagreement');
});

test('two annotators who both abstain agree about nothing', () => {
  const result = report([judgment('p1', 'ann-a', 'unresolved'), judgment('p1', 'ann-b', 'unresolved')]);

  assert.equal(result.corpusEmpty, false, 'rows exist, so the corpus is not empty');
  assert.equal(result.observedAgreement, null, 'no comparable verdicts means no honest agreement figure');
  assert.equal(result.comparableVerdictPairCount, 0);
  assert.equal(result.unresolvedCount, 2);
  assert.equal(result.scorablePairCount, 0);
  assert.equal(result.unscorablePairCount, 1);
  assert.deepEqual(result.disagreements, []);
});

test('the report exposes the coverage of its own agreement figure', () => {
  const result = report([
    judgment('p1', 'ann-a', 'left'),
    judgment('p1', 'ann-b', 'left'),
    judgment('p2', 'ann-a', 'unresolved'),
    judgment('p2', 'ann-b', 'unresolved'),
    judgment('p3', 'ann-a', 'unresolved'),
    judgment('p3', 'ann-b', 'unresolved'),
  ]);

  // 100% agreement over one of three pairs is not a 100% agreement rate, and
  // the report must make that impossible to read off wrongly.
  assert.equal(result.observedAgreement, 1);
  assert.equal(result.scorablePairCount, 1);
  assert.equal(result.unscorablePairCount, 2);

  const markdown = generateAgreementMarkdown(result);
  assert.match(markdown, /1 of 3 pairs/);
  assert.match(markdown, /excluded from the denominator/i);
});

test('per-annotator abstention rates are reported, so a serial abstainer is visible', () => {
  const result = report([
    judgment('p1', 'ann-a', 'left'),
    judgment('p1', 'ann-b', 'unresolved'),
    judgment('p2', 'ann-a', 'right'),
    judgment('p2', 'ann-b', 'unresolved'),
  ]);

  const abstainer = result.perAnnotator.find((row) => row.annotatorId === 'ann-b');
  assert.equal(abstainer?.judgmentCount, 2);
  assert.equal(abstainer?.unresolvedCount, 2);
  assert.equal(abstainer?.unresolvedRate, 1);

  const decider = result.perAnnotator.find((row) => row.annotatorId === 'ann-a');
  assert.equal(decider?.unresolvedRate, 0);
});

/* ── Loader validation ──────────────────────────────────────────── */

test('a well-formed corpus loads', () => {
  const loaded = loadPairwiseJudgments(corpus([judgment('p1', 'ann-a', 'left')]));

  assert.equal(loaded.valid, true, JSON.stringify(loaded.issues, null, 2));
  assert.equal(loaded.judgments.length, 1);
  assert.equal(loaded.corpusEmpty, false);
});

test('an empty corpus loads and is reported empty', () => {
  const loaded = loadPairwiseJudgments(corpus([]));

  assert.equal(loaded.valid, true);
  assert.equal(loaded.judgments.length, 0);
  assert.equal(loaded.corpusEmpty, true);
});

test('every seeded malformed judgment is rejected, for the reason it declares', () => {
  assert.ok(MALFORMED_JUDGMENTS.length >= 6, 'a loader proven against one defect is barely proven');

  for (const malformed of MALFORMED_JUDGMENTS) {
    const loaded = loadPairwiseJudgments(corpus([malformed.row]));

    assert.equal(loaded.valid, false, `${malformed.id}: loader accepted ${malformed.defect}`);
    assert.ok(
      loaded.issues.some((issue) => issue.code === malformed.expectedIssueCode),
      `${malformed.id}: rejected, but not with ${malformed.expectedIssueCode} — raised [${loaded.issues
        .map((issue) => issue.code)
        .join(', ')}]`,
    );
    assert.equal(loaded.judgments.length, 0, `${malformed.id}: a rejected row must not reach the report`);
  }
});

test('a corpus that is not an object, or whose rows are not an array, is rejected', () => {
  assert.equal(loadPairwiseJudgments('nope').valid, false);
  assert.equal(loadPairwiseJudgments(null).valid, false);
  assert.equal(loadPairwiseJudgments({ contractVersion: JUDGMENT_CORPUS_CONTRACT_VERSION, judgments: {} }).valid, false);
});

test('a contract version the loader does not understand is rejected rather than guessed at', () => {
  const loaded = loadPairwiseJudgments({ contractVersion: 'priority-judgments-v99', judgments: [] });

  assert.equal(loaded.valid, false);
  assert.ok(loaded.issues.some((issue) => issue.code === 'PRJ002'));
});

test('the same annotator judging the same pair twice is rejected', () => {
  const loaded = loadPairwiseJudgments(corpus([judgment('p1', 'ann-a', 'left'), judgment('p1', 'ann-a', 'right')]));

  assert.equal(loaded.valid, false);
  assert.ok(loaded.issues.some((issue) => issue.code === 'PRJ020'));
});

test('when the seed set is supplied, a judgment about a pair that does not exist is rejected', () => {
  const known = PRIORITY_SEED_PAIRS[0];

  const good = loadPairwiseJudgments(
    corpus([
      judgment(known.pairId, 'ann-a', 'left', {
        leftCommitmentId: known.left.commitment.id,
        rightCommitmentId: known.right.commitment.id,
      }),
    ]),
    { seedPairs: PRIORITY_SEED_PAIRS },
  );
  assert.equal(good.valid, true, JSON.stringify(good.issues, null, 2));

  const unknownPair = loadPairwiseJudgments(corpus([judgment('ps-does-not-exist', 'ann-a', 'left')]), {
    seedPairs: PRIORITY_SEED_PAIRS,
  });
  assert.equal(unknownPair.valid, false);
  assert.ok(unknownPair.issues.some((issue) => issue.code === 'PRJ021'));

  const wrongSides = loadPairwiseJudgments(
    corpus([judgment(known.pairId, 'ann-a', 'left', { leftCommitmentId: 'c-somewhere-else' })]),
    { seedPairs: PRIORITY_SEED_PAIRS },
  );
  assert.equal(wrongSides.valid, false);
  assert.ok(wrongSides.issues.some((issue) => issue.code === 'PRJ022'));
});

/* ── Determinism ─────────────────────────────────────────────────── */

test('the report is deterministic and independent of row order', () => {
  const rows = [
    judgment('p2', 'ann-b', 'right'),
    judgment('p1', 'ann-a', 'left'),
    judgment('p2', 'ann-a', 'left'),
    judgment('p1', 'ann-b', 'left'),
  ];

  const forward = report(rows);
  const reversed = report([...rows].reverse());

  assert.deepEqual(forward, reversed);
  assert.equal(forward.observedAgreement, 0.5);
  assert.deepEqual(forward.disagreements, ["p2: ann-a='left' vs ann-b='right'"]);
});

test('a populated report renders its numbers and its disagreements', () => {
  const markdown = generateAgreementMarkdown(
    report([
      judgment('p1', 'ann-a', 'left'),
      judgment('p1', 'ann-b', 'right'),
      judgment('p2', 'ann-a', 'tie'),
      judgment('p2', 'ann-b', 'tie'),
    ]),
  );

  assert.match(markdown, /Observed agreement/);
  assert.match(markdown, /50\.0%/);
  assert.match(markdown, /ann-a='left' vs ann-b='right'/);
  assert.match(markdown, /NOT HUMAN EVIDENCE/);
});

test('agreement over a handful of the seed set reports the pairs nobody judged', () => {
  // The scenario a code review reproduced: two annotators agree on two pairs
  // and the report rendered "100.0% over 2 of 2", hiding the rest of the seed
  // set. A rate over 2 of 25 is not a high agreement rate; it is a rubric
  // almost nobody applied.
  const judged = PRIORITY_SEED_PAIRS.slice(0, 2);
  const judgments = judged.flatMap((pair) => [
    judgment(pair.pairId, 'ann-1', 'left'),
    judgment(pair.pairId, 'ann-2', 'left'),
  ]);

  const built = buildAgreementReport(judgments, { generatedAt: FIXED_GENERATED_AT });

  assert.equal(built.observedAgreement, 1, 'they did agree on what they judged');
  assert.equal(built.scorablePairCount, 2);
  assert.equal(built.pairCount, PRIORITY_SEED_PAIRS.length, 'the denominator is the seed set');
  assert.equal(built.unjudgedPairCount, PRIORITY_SEED_PAIRS.length - 2);

  const markdown = generateAgreementMarkdown(built);
  assert.match(markdown, /unjudged/, 'the rendering must surface the unjudged pairs beside the rate');
});
