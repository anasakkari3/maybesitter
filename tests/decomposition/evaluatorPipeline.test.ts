/**
 * End to end: shipped corpus → split → metrics (Sprint 06, issue #26).
 *
 * The three modules are unit-tested separately, and separately they can each be
 * right while the seam between them is wrong — a `selectSplit` that returns the
 * whole corpus would leave every unit test green and quietly score a model on
 * its own training rows. This exercises the path a caller actually walks.
 *
 * The proposals here are built *from the expected steps*, so every number below
 * is a property of the pipeline, not of any decomposer. Sprint 06 ships no
 * measurement of model quality and this file must not be read as one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadSeedCorpus } from '../../lib/decomposition/evaluation/corpus.ts';
import { buildEvaluationReport } from '../../lib/decomposition/evaluation/metrics.ts';
import {
  DECOMPOSITION_SPLITS,
  loadShippedSplitManifest,
  selectSplit,
} from '../../lib/decomposition/evaluation/splits.ts';
import {
  DECOMPOSITION_CONTRACT_VERSION,
  DECOMPOSITION_SCHEMA_VERSION,
  type DecomposedProposal,
  type DecompositionExample,
  type DecompositionProposal,
} from '../../src/contracts/v1/decompositionContracts.ts';

const GENERATED_AT = '2026-08-19T12:00:00.000Z';
const SEED = loadSeedCorpus();

function proposalFor(example: DecompositionExample): DecompositionProposal {
  const shared = {
    version: DECOMPOSITION_CONTRACT_VERSION,
    schema: DECOMPOSITION_SCHEMA_VERSION,
    proposalId: `prop-${example.exampleId}`,
    commitmentId: example.exampleId,
    sourceText: example.sourceText,
    provenance: { requestedEngine: 'rules', executedEngine: 'rules', fallbackUsed: false },
  } as const;
  return example.expectedSteps.length >= 2
    ? { ...shared, outcome: 'decomposed', steps: example.expectedSteps as unknown as DecomposedProposal['steps'] }
    : { ...shared, outcome: 'atomic', reason: 'not_decomposable' };
}

test('selectSplit returns only the rows the manifest assigns to that split', () => {
  const sealed = loadShippedSplitManifest().manifest as NonNullable<
    ReturnType<typeof loadShippedSplitManifest>['manifest']
  >;

  let total = 0;
  for (const split of DECOMPOSITION_SPLITS) {
    const rows = selectSplit(SEED.examples, split);
    total += rows.length;
    assert.deepEqual(
      rows.map((example) => example.exampleId),
      [...sealed.members[split]],
      `selectSplit('${split}') must agree with the sealed manifest`,
    );
  }
  assert.equal(total, SEED.examples.length, 'the three selections must partition the corpus');
});

test('the locked-test split shares no row with train or valid', () => {
  const locked = new Set(selectSplit(SEED.examples, 'locked-test').map((example) => example.exampleId));
  assert.ok(locked.size > 0);
  for (const split of ['train', 'valid'] as const) {
    for (const example of selectSplit(SEED.examples, split)) {
      assert.equal(locked.has(example.exampleId), false, `${example.exampleId} is both held out and fitted on`);
    }
  }
});

test('the evaluator runs over the locked-test split and states its denominators', () => {
  const held = selectSplit(SEED.examples, 'locked-test');
  const report = buildEvaluationReport({
    examples: held,
    proposals: held.map(proposalFor),
    generatedAt: GENERATED_AT,
  });

  assert.equal(report.status, 'REPORTED');
  assert.equal(report.totalExamples, held.length);
  assert.equal(report.evaluatedExamples, held.length);
  assert.deepEqual(report.unevaluatedExampleIds, []);

  // Each score is over its own scope and says which. They are deliberately not
  // the same number: `exactExampleAgreement` covers every held-out row,
  // `clean` only the rows that produced steps.
  assert.equal(report.boundary.exactExampleAgreement.denominator, held.length);
  assert.equal(
    report.coverage.produced.denominator,
    held
      .filter((example) => example.expectedSteps.length >= 2)
      .reduce((total, example) => total + example.sourceText.length, 0),
  );

  // Reconstructed from ground truth, so these are the pipeline's ceiling.
  assert.equal(report.boundary.spanRecall.value, 1);
  assert.equal(report.faithfulness.clean.value, 1);
  assert.equal(report.faithfulness.doNotSplitRespected.value, 1);
});

test('the locked-test split cannot currently answer the boundary question', () => {
  // A known limitation, asserted rather than left implicit so it cannot drift
  // out of the guide. Per-id hashing put only one multi-step row in the
  // held-out split, so `spanRecall` there rests on three spans from a single
  // sentence and `clean` on one row — near-vacuous, whatever they read.
  //
  // The remedy is more seed rows, never ids tuned to move existing ones
  // between splits: a row whose split moves was never held out. This test is
  // expected to be UPDATED when the corpus grows, not deleted.
  const held = selectSplit(SEED.examples, 'locked-test');
  const report = buildEvaluationReport({
    examples: held,
    proposals: held.map(proposalFor),
    generatedAt: GENERATED_AT,
  });

  assert.equal(held.length, 8);
  assert.equal(held.filter((example) => example.label === 'multi_step').length, 1);

  assert.equal(report.boundary.spanRecall.denominator, 3, 'three spans, all from one sentence');
  assert.equal(report.faithfulness.clean.denominator, 1);
  assert.equal(report.faithfulness.examplesWithProducedSteps, 1);
  assert.equal(report.coverage.examplesInScope, 1);

  // What the held-out split *can* answer today: seven rows that must not split.
  assert.equal(report.faithfulness.doNotSplitRespected.denominator, 7);
});

test('a report over the whole corpus is not the same claim as one over a split', () => {
  const whole = buildEvaluationReport({
    examples: SEED.examples,
    proposals: SEED.examples.map(proposalFor),
    generatedAt: GENERATED_AT,
  });
  const held = selectSplit(SEED.examples, 'locked-test');
  const heldReport = buildEvaluationReport({
    examples: held,
    proposals: held.map(proposalFor),
    generatedAt: GENERATED_AT,
  });

  assert.equal(whole.faithfulness.clean.value, heldReport.faithfulness.clean.value);
  assert.notEqual(
    whole.faithfulness.clean.denominator,
    heldReport.faithfulness.clean.denominator,
    'the same value over two different denominators is two different claims; the denominator is what tells ' +
      'them apart, which is why it travels with the score',
  );
});
