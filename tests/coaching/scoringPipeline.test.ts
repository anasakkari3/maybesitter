/**
 * The scoring pipeline: the report's shape, the human slot, and the locked half
 * (Sprint 09, issue #37).
 *
 * ── The tests that matter most ──────────────────────────────────────
 *
 *   1. `no human scores yet is distinguishable from human scores were all zero`.
 *      Asserted from both directions: the `not_collected` variant is walked
 *      recursively and proved to carry **no number at all**, and an all-zero
 *      review set is shown to reach `collected` with real denominators. A
 *      `humanScore: number` defaulting to 0 would satisfy neither.
 *
 *   2. `the faithfulness section is unmoved by tone`. Two corpora that differ
 *      only in the *prose* of their faithfulness-violated rows produce a
 *      byte-identical faithfulness section. That is the acceptance criterion
 *      measured rather than inspected, and it is what would still fail if a
 *      nullable tone field were reintroduced upstream.
 *
 *   3. `the locked half refuses a second look`. Adopted from
 *      `lib/priority/calibration/lockedGate.ts` with its two refusals, including
 *      the one that matters most: a report over zero rows emits the same words a
 *      real one emits and certifies nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { Instant } from '../../src/contracts/v1/recommendationContracts.ts';
import {
  ADVERSARIAL_CATEGORIES,
  LOCK_ASSIGNMENT_VERSION,
  buildRow,
  defaultCorpus,
  lockStateFor,
  partitionByLock,
  type CoachingEvaluationRow,
  type LockedRowSet,
  type TuningRowSet,
} from '../../lib/coaching/evaluation/evaluationSet.ts';
import {
  FAITHFULNESS_DIMENSIONS,
  RUBRIC_DIMENSIONS,
  TONE_BANDS,
  TONE_DIMENSIONS,
} from '../../lib/coaching/evaluation/rubric.ts';
import {
  humanScoringSlot,
  mergeHumanScores,
  runLockedEvaluation,
  scoreRow,
  scoreTuningSet,
  type CoachingMetric,
  type CoachingScoreReport,
  type HumanRowScore,
} from '../../lib/coaching/evaluation/scoring.ts';

const GENERATED_AT = '2026-08-20T09:00:00Z' as Instant;

const CORPUS = defaultCorpus();
const PARTITION = partitionByLock(CORPUS);
const REPORT = scoreTuningSet(PARTITION.tuning, GENERATED_AT);

function sorted(values: readonly string[]): string[] {
  return values.slice().sort();
}

/** Every number reachable from a value, with the path that reached it. */
function numbersUnder(value: unknown, path: string, found: string[]): string[] {
  if (typeof value === 'number') found.push(path);
  else if (Array.isArray(value)) value.forEach((item, index) => numbersUnder(item, `${path}[${index}]`, found));
  else if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      numbersUnder((value as Record<string, unknown>)[key], `${path}.${key}`, found);
    }
  }
  return found;
}

/** Every key name reachable from a value. */
function keysUnder(value: unknown, found: string[]): string[] {
  if (Array.isArray(value)) value.forEach((item) => keysUnder(item, found));
  else if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      found.push(key);
      keysUnder((value as Record<string, unknown>)[key], found);
    }
  }
  return found;
}

/* ── Never vacuous ───────────────────────────────────────────────── */

test('the report covers a non-empty half, so no assertion below passes by finding nothing', () => {
  assert.ok(REPORT.rowCount > 0);
  assert.equal(REPORT.rowCount, PARTITION.tuning.rows.length);
  assert.equal(REPORT.half, 'tuning');
});

/* ── The report says what it is ──────────────────────────────────── */

test('the report carries the corpus provenance and review status, both single-valued', () => {
  assert.equal(REPORT.provenance, 'synthetic');
  assert.equal(REPORT.reviewStatus, 'not_reviewed');
});

test('the report is pinned to the rubric, the corpus and an instant the caller supplied', () => {
  assert.equal(typeof REPORT.rubricVersion, 'string');
  assert.equal(typeof REPORT.evaluationSetVersion, 'string');
  assert.equal(REPORT.generatedAt, GENERATED_AT);
  assert.equal(REPORT.corpusDigest.length, 64);
  assert.deepEqual(REPORT.guardFindings, []);
});

test('an unusable generatedAt is reported rather than silently accepted', () => {
  // `2026-11-23T00:00:00` denotes a different instant on every host, so a report
  // stamped with one cannot be placed in time. Reported, not thrown.
  const bad = scoreTuningSet(PARTITION.tuning, '2026-11-23T00:00:00' as Instant);
  assert.deepEqual(bad.guardFindings.map((finding) => finding.code), ['GENERATED_AT_NOT_AN_INSTANT']);
});

/* ── No composite score anywhere ─────────────────────────────────── */

test('no field in the report combines a tone figure with a faithfulness figure', () => {
  const keys = keysUnder(REPORT, []);
  for (const forbidden of ['overall', 'composite', 'combined', 'totalScore', 'weighted', 'aggregate']) {
    assert.equal(keys.includes(forbidden), false, `the report grew a ${forbidden} field`);
  }
  // The tone section's denominator is the rows that reached the tone gate, and
  // the faithfulness section's is the rows that reached the rubric at all.
  // Different denominators are what makes the two impossible to average.
  assert.notEqual(REPORT.tone.scoredRows, REPORT.faithfulness.gateHeld.denominator);
});

test('the faithfulness section is unmoved by prose that would fail every tone dimension', () => {
  // The acceptance criterion as a measurement. The two corpora differ only in
  // the wording of rows whose faithfulness already failed.
  //
  // `persistence_claim` rows are excluded and that exclusion is the interesting
  // part: it is the one dimension whose evidence *is* the prose, so rewriting
  // their sentences removes the defect rather than dressing it differently. A
  // test that rewrote them would be measuring its own edit. Every other
  // faithfulness dimension is decided against the recommendation, and none of
  // them moves.
  const worded = PARTITION.tuning.rows.map((row) => {
    const verdict = scoreRow(row, 0).verdict;
    if (verdict.gate !== 'faithfulness_violated') return row;
    if (verdict.faithfulness.outcomeByDimension.persistence_claim === 'violated') return row;
    const first = row.input.output.sentences[0];
    return {
      ...row,
      input: {
        ...row.input,
        output: {
          ...row.input.output,
          sentences: [
            { ...first, text: 'You failed, you have no choice, figure it out.' },
            ...row.input.output.sentences.slice(1),
          ],
        },
      },
    } as CoachingEvaluationRow;
  });
  const other = scoreTuningSet({ kind: 'tuning', rows: worded }, GENERATED_AT);
  assert.deepEqual(other.faithfulness, REPORT.faithfulness);
  assert.deepEqual(other.tone, REPORT.tone);
});

test('a row that lied is counted as withheld from tone scoring, not as a tone failure', () => {
  // The difference is the whole point: 0 tone failures over 100 rows and 0 tone
  // failures over 40 rows with 60 withheld are different claims, and only the
  // second one is true here.
  assert.ok(REPORT.tone.withheldForFaithfulness > 0);
  assert.equal(
    REPORT.tone.scoredRows + REPORT.tone.withheldForFaithfulness + REPORT.tone.withheldAsInadmissible,
    REPORT.rowCount,
  );
  for (const dimension of TONE_DIMENSIONS) {
    assert.equal(REPORT.tone.byDimension[dimension].passRate.denominator, REPORT.tone.scoredRows);
  }
});

/* ── Metrics carry their denominators ────────────────────────────── */

test('every metric states what its denominator counts', () => {
  const metrics = [
    REPORT.admissible,
    REPORT.faithfulness.gateHeld,
    REPORT.expectation.gateMatched,
    REPORT.expectation.attackDetected,
    ...FAITHFULNESS_DIMENSIONS.map((dimension) => REPORT.faithfulness.byDimension[dimension]),
    ...TONE_DIMENSIONS.map((dimension) => REPORT.tone.byDimension[dimension].passRate),
  ];
  for (const item of metrics as readonly CoachingMetric[]) {
    assert.ok(item.describes.length > 0, `${item.metric} carries a number with no denominator description`);
    assert.ok(item.denominator >= 0);
    assert.ok(item.numerator <= item.denominator, `${item.metric} numerator exceeds its denominator`);
    if (item.denominator === 0) assert.equal(item.value, null, `${item.metric} rendered an empty denominator as a value`);
    else assert.equal(item.value, item.numerator / item.denominator);
  }
});

test('a ratio over zero is null, never zero', () => {
  // Zero is a measurement — "nothing was faithful". An empty denominator is the
  // absence of one, and rendering the second as the first presents no data as a
  // bad result.
  const empty = scoreTuningSet({ kind: 'tuning', rows: [] }, GENERATED_AT);
  assert.equal(empty.admissible.value, null);
  assert.equal(empty.admissible.denominator, 0);
  assert.equal(empty.faithfulness.gateHeld.value, null);
  for (const dimension of TONE_DIMENSIONS) assert.equal(empty.tone.byDimension[dimension].passRate.value, null);
  assert.deepEqual(sorted(empty.expectation.absentCategories), sorted(ADVERSARIAL_CATEGORIES));
});

test('every tone band count is present, so a band that stops being produced is visible', () => {
  for (const dimension of TONE_DIMENSIONS) {
    const summary = REPORT.tone.byDimension[dimension];
    assert.deepEqual(sorted(Object.keys(summary.bandCounts)), sorted(TONE_BANDS));
    const total = TONE_BANDS.reduce((sum, band) => sum + summary.bandCounts[band], 0);
    assert.equal(total, REPORT.tone.scoredRows);
  }
});

/* ── The corpus still does what it says ──────────────────────────── */

test('every row lands in the gate its category declares, and every planted defect is found', () => {
  // The figure a regression would move first. If the scorer stops detecting a
  // category, this drops while every other number in the report improves.
  assert.equal(REPORT.expectation.gateMatched.value, 1);
  assert.equal(REPORT.expectation.attackDetected.value, 1);
  assert.deepEqual(REPORT.expectation.mismatches, []);
  assert.ok(REPORT.expectation.attackDetected.denominator > 0);
});

test('no category is absent from the tuning half', () => {
  assert.deepEqual(REPORT.expectation.absentCategories, []);
});

test('out-of-scope defects are counted rather than dropped', () => {
  const codes = REPORT.outOfScope.map((entry) => entry.code);
  assert.deepEqual(codes, ['IDENTIFIER_IN_PROSE']);
  assert.ok((REPORT.outOfScope[0]?.count ?? 0) > 0);
});

test('finding counts come back in code-point order', () => {
  const codes = REPORT.faithfulness.findingCounts.map((entry) => entry.code);
  assert.deepEqual(codes, codes.slice().sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)));
  assert.ok(codes.length > 0);
});

test('the report is deterministic for one corpus and one instant', () => {
  assert.deepEqual(scoreTuningSet(PARTITION.tuning, GENERATED_AT), REPORT);
});

/* ── The tuning guard ────────────────────────────────────────────── */

test('a locked row presented for tuning is reported beside the numbers, not thrown', () => {
  const lockedRow = CORPUS.find((row) => lockStateFor(row.rowId) === 'locked');
  assert.ok(lockedRow !== undefined);
  if (lockedRow === undefined) return;
  const contaminated: TuningRowSet = { kind: 'tuning', rows: [...PARTITION.tuning.rows, lockedRow] };
  const report = scoreTuningSet(contaminated, GENERATED_AT);
  assert.deepEqual(
    report.guardFindings.map((finding) => finding.code),
    ['LOCKED_ROW_IN_TUNING_SET'],
  );
  // The report still exists: a refusal to report would hide the contamination
  // rather than name it. What must not happen is a clean-looking report.
  assert.equal(report.rowCount, PARTITION.tuning.rows.length + 1);
  for (const finding of report.guardFindings) {
    assert.equal(finding.detail.includes(lockedRow.rowId), false, 'a guard detail leaked a row id');
  }
});

/* ── The locked half ─────────────────────────────────────────────── */

test('the locked half is measured once and refuses a second look', () => {
  const first = runLockedEvaluation({
    lockId: LOCK_ASSIGNMENT_VERSION,
    set: PARTITION.locked,
    generatedAt: GENERATED_AT,
    usedLockIds: [],
  });
  assert.equal(first.outcome, 'measured');
  assert.ok(first.report !== null);
  assert.equal(first.report?.half, 'locked');
  assert.deepEqual(first.usedLockIds, [LOCK_ASSIGNMENT_VERSION]);

  const second = runLockedEvaluation({
    lockId: LOCK_ASSIGNMENT_VERSION,
    set: PARTITION.locked,
    generatedAt: GENERATED_AT,
    usedLockIds: first.usedLockIds,
  });
  assert.equal(second.outcome, 'refused_already_used');
  assert.equal(second.report, null, 'a refusal must not carry a report of a measurement that did not happen');
  assert.deepEqual(second.usedLockIds, first.usedLockIds, 'a refusal must not consume the id');
});

test('the locked half refuses an empty corpus rather than reporting a pass over zero rows', () => {
  // A gate that reports over zero rows emits the same words a real one emits,
  // appears in the same field, and certifies nothing.
  const empty: LockedRowSet = { kind: 'locked', rows: [] };
  const run = runLockedEvaluation({ lockId: 'lock-empty', set: empty, generatedAt: GENERATED_AT, usedLockIds: [] });
  assert.equal(run.outcome, 'refused_empty_corpus');
  assert.equal(run.report, null);
  assert.deepEqual(run.usedLockIds, []);
});

test('an unnamed locked half cannot be measured', () => {
  const run = runLockedEvaluation({ lockId: '', set: PARTITION.locked, generatedAt: GENERATED_AT, usedLockIds: [] });
  assert.equal(run.outcome, 'refused_already_used');
  assert.equal(run.report, null);
});

/* ── The human slot ──────────────────────────────────────────────── */

test('a fresh report carries an empty human slot with no number anywhere in it', () => {
  // The required distinction, from the side that has no data. Not "the numbers
  // are zero" — there are no numbers, so nothing can be read as a measurement.
  assert.equal(REPORT.human.status, 'not_collected');
  assert.deepEqual(numbersUnder(REPORT.human, 'human', []), []);
});

test('the human slot names the questions a reviewer is asked, read off the rubric', () => {
  const slot = humanScoringSlot();
  assert.deepEqual(sorted(Object.keys(slot.questions)), sorted(RUBRIC_DIMENSIONS));
  assert.deepEqual(sorted(slot.scale), sorted(TONE_BANDS));
  assert.deepEqual(sorted(slot.dimensions), sorted(RUBRIC_DIMENSIONS));
  assert.equal(slot.status, 'awaiting_first_review');
  assert.equal(slot.mergeEntryPoint, 'mergeHumanScores');
  assert.ok(slot.note.includes('proxy'));
});

test('merging an empty review set leaves the slot empty rather than filling it with zeros', () => {
  const merged = mergeHumanScores(REPORT, { collectedAt: GENERATED_AT, scores: [] });
  assert.equal(merged.human.status, 'not_collected');
  assert.deepEqual(numbersUnder(merged.human, 'human', []), []);
});

test('a review set that is all failures reaches collected, with real denominators', () => {
  // The other side of the distinction. "Human scores were all zero" is a
  // measurement: it reaches a different variant, and it carries the denominator
  // that says how much was measured.
  const scoredRow = REPORT.rows.find((row) => row.verdict.gate === 'scored');
  assert.ok(scoredRow !== undefined);
  if (scoredRow === undefined) return;
  const scores: HumanRowScore[] = RUBRIC_DIMENSIONS.map((dimension) => ({
    rowId: scoredRow.rowId,
    reviewerId: 'reviewer-1',
    dimension,
    verdict: 'fail',
  }));
  const merged = mergeHumanScores(REPORT, { collectedAt: GENERATED_AT, scores });
  assert.equal(merged.human.status, 'collected');
  if (merged.human.status !== 'collected') return;
  assert.equal(merged.human.reviewerCount, 1);
  assert.equal(merged.human.rowsReviewed, 1);
  for (const dimension of RUBRIC_DIMENSIONS) {
    const item: CoachingMetric = merged.human.byDimension[dimension];
    assert.equal(item.numerator, 0, `${dimension} recorded a pass that was not given`);
    assert.equal(item.denominator, 1, `${dimension} lost its denominator`);
    assert.equal(item.value, 0);
  }
  // And the two states are distinguishable by more than the numbers: the empty
  // one has no `byDimension` key at all.
  assert.equal(Object.prototype.hasOwnProperty.call(REPORT.human, 'byDimension'), false);
});

test('agreement with the automated gate is computed for tone dimensions only', () => {
  // The faithfulness gate is not a proxy for a human judgement — it is the
  // judgement — so a disagreement there is a defect in one side rather than a
  // calibration figure.
  const scoredRow = REPORT.rows.find((row) => row.verdict.gate === 'scored');
  assert.ok(scoredRow !== undefined);
  if (scoredRow === undefined) return;
  const scores: HumanRowScore[] = RUBRIC_DIMENSIONS.map((dimension) => ({
    rowId: scoredRow.rowId,
    reviewerId: 'reviewer-1',
    dimension,
    verdict: 'pass',
  }));
  const merged = mergeHumanScores(REPORT, { collectedAt: GENERATED_AT, scores });
  assert.equal(merged.human.status, 'collected');
  if (merged.human.status !== 'collected') return;
  assert.deepEqual(sorted(Object.keys(merged.human.agreementWithAutomated)), sorted(TONE_DIMENSIONS));
  for (const dimension of TONE_DIMENSIONS) {
    assert.equal(merged.human.agreementWithAutomated[dimension].denominator, 1);
  }
});

test('a human score naming a row the report does not hold contributes to no agreement figure', () => {
  const scores: HumanRowScore[] = [
    { rowId: 'no-such-row', reviewerId: 'reviewer-1', dimension: 'calmness', verdict: 'pass' },
  ];
  const merged = mergeHumanScores(REPORT, { collectedAt: GENERATED_AT, scores });
  assert.equal(merged.human.status, 'collected');
  if (merged.human.status !== 'collected') return;
  // It still counts toward the dimension's own denominator — a reviewer's answer
  // was recorded — but it agrees with nothing, because there is nothing to
  // compare it to.
  assert.equal(merged.human.byDimension.calmness.denominator, 1);
  assert.equal(merged.human.agreementWithAutomated.calmness.denominator, 0);
  assert.equal(merged.human.agreementWithAutomated.calmness.value, null);
});

test('a human score on a row whose faithfulness failed reaches no tone agreement figure', () => {
  // There is no automated tone band for such a row, by construction. The merge
  // must not invent one.
  const violated = REPORT.rows.find((row) => row.verdict.gate === 'faithfulness_violated');
  assert.ok(violated !== undefined);
  if (violated === undefined) return;
  const merged = mergeHumanScores(REPORT, {
    collectedAt: GENERATED_AT,
    scores: [{ rowId: violated.rowId, reviewerId: 'reviewer-1', dimension: 'calmness', verdict: 'pass' }],
  });
  assert.equal(merged.human.status, 'collected');
  if (merged.human.status !== 'collected') return;
  assert.equal(merged.human.agreementWithAutomated.calmness.denominator, 0);
});

test('merging human scores never promotes the corpus to reviewed', () => {
  // A report about rows is not a property of the rows. Promotion needs a review
  // log naming each row, its reviewer and a time, and that machinery is not part
  // of this pass.
  const merged = mergeHumanScores(REPORT, {
    collectedAt: GENERATED_AT,
    scores: [{ rowId: REPORT.rows[0].rowId, reviewerId: 'reviewer-1', dimension: 'calmness', verdict: 'pass' }],
  });
  assert.equal(merged.reviewStatus, 'not_reviewed');
  assert.equal(merged.provenance, 'synthetic');
});

test('an unknown rubric dimension in a review set is ignored rather than crashing the merge', () => {
  const merged = mergeHumanScores(REPORT, {
    collectedAt: GENERATED_AT,
    scores: [
      { rowId: REPORT.rows[0].rowId, reviewerId: 'r', dimension: 'vibes' as never, verdict: 'pass' },
      { rowId: REPORT.rows[0].rowId, reviewerId: 'r', dimension: 'calmness', verdict: 'pass' },
    ],
  });
  assert.equal(merged.human.status, 'collected');
  if (merged.human.status !== 'collected') return;
  assert.equal(merged.human.byDimension.calmness.denominator, 1);
});

/* ── Row scoring ─────────────────────────────────────────────────── */

test('a row score names its row by index as well as by id', () => {
  const row = buildRow('probe/score', 'sole_survivor_reason', 'he', 'clean_control', 'authored');
  const score = scoreRow(row, 7);
  assert.equal(score.rowIndex, 7);
  assert.equal(score.rowId, row.rowId);
  assert.equal(score.locale, 'he');
  assert.equal(score.gateMatchedExpectation, true);
  assert.equal(score.attackedDimensionDetected, null, 'a clean control attacks nothing');
});

test('the scorer reports rather than throws for a set it was handed as null', () => {
  const report = scoreTuningSet(null as unknown as TuningRowSet, GENERATED_AT);
  assert.equal(report.rowCount, 0);
  assert.equal(report.admissible.value, null);
  const run = runLockedEvaluation({
    lockId: 'x',
    set: null as unknown as LockedRowSet,
    generatedAt: GENERATED_AT,
    usedLockIds: [],
  });
  assert.equal(run.outcome, 'refused_empty_corpus');
});

test('the report type carries a row score for every row, so nothing is summarised away', () => {
  assert.equal(REPORT.rows.length, REPORT.rowCount);
  const reported: CoachingScoreReport = REPORT;
  assert.equal(reported.rows[0].verdict.gate.length > 0, true);
});
