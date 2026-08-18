/**
 * Boundary, coverage and semantic-faithfulness metrics (Sprint 06, issue #26).
 *
 * ── Every score is asserted together with its denominator ───────────
 *
 * A faithfulness of 1.0 over 3 of the 11 golden examples is a different claim
 * from a faithfulness of 1.0 over all 11, and the two are indistinguishable
 * once the number is copied into a summary. This repository already enforces
 * that convention for its other coverage figures
 * (`lib/priority/rubric/seedSetCoverage.ts`, `queueCoverage.ts`), so the tests
 * here assert the denominator on every score rather than the value alone.
 *
 * ── The scores are exercised against the golden set ─────────────────
 *
 * `DECOMPOSITION_GOLDEN` is the shared ground truth #27's validator is measured
 * against too. Running the metrics over it is how "the evaluator is usable
 * against the golden set" stops being an assertion in a design document.
 *
 * Nothing here says anything about model quality: the proposals are constructed
 * by the test. The corpus exists to prove the pipeline runs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FAITHFULNESS_VIOLATION_CODES,
  buildEvaluationReport,
  pairProposals,
} from '../../lib/decomposition/evaluation/metrics.ts';
import {
  DECOMPOSITION_CONTRACT_VERSION,
  DECOMPOSITION_SCHEMA_VERSION,
  type DecomposedProposal,
  type DecompositionExample,
  type DecompositionProposal,
  type DecompositionStepProposal,
} from '../../src/contracts/v1/decompositionContracts.ts';
import { DECOMPOSITION_GOLDEN, goldenById, goldenByLabel, span } from '../fixtures/decompositionGolden.ts';

const GENERATED_AT = '2026-08-19T12:00:00.000Z';

function base(example: DecompositionExample) {
  return {
    version: DECOMPOSITION_CONTRACT_VERSION,
    schema: DECOMPOSITION_SCHEMA_VERSION,
    proposalId: `prop-${example.exampleId}`,
    // The harness keys proposals to examples by commitmentId; see `pairProposals`.
    commitmentId: example.exampleId,
    sourceText: example.sourceText,
    provenance: { requestedEngine: 'rules', executedEngine: 'rules', fallbackUsed: false },
  } as const;
}

function atomic(example: DecompositionExample): DecompositionProposal {
  return { ...base(example), outcome: 'atomic', reason: 'not_decomposable' };
}

function decomposed(
  example: DecompositionExample,
  steps: readonly DecompositionStepProposal[] = example.expectedSteps,
): DecompositionProposal {
  if (steps.length < 2) throw new Error(`cannot build a decomposed proposal from ${steps.length} step(s)`);
  return {
    ...base(example),
    outcome: 'decomposed',
    steps: steps as unknown as DecomposedProposal['steps'],
  };
}

/**
 * The proposal a perfect decomposer would produce for each golden row: the
 * expected steps where there are any, an honest atomic refusal where there are
 * not.
 */
function perfect(examples: readonly DecompositionExample[] = DECOMPOSITION_GOLDEN): DecompositionProposal[] {
  return examples.map((example) =>
    example.expectedSteps.length >= 2 ? decomposed(example) : atomic(example),
  );
}

function report(
  examples: readonly DecompositionExample[],
  proposals: readonly DecompositionProposal[],
) {
  return buildEvaluationReport({ examples, proposals, generatedAt: GENERATED_AT });
}

/* ── Pairing ────────────────────────────────────────────────────── */

test('an example with no proposal is named, never dropped from the denominator silently', () => {
  const subset = perfect().slice(0, 5);
  const paired = pairProposals(DECOMPOSITION_GOLDEN, subset);

  assert.equal(paired.cases.length, 5);
  assert.equal(paired.unevaluatedExampleIds.length, DECOMPOSITION_GOLDEN.length - 5);
  assert.ok(paired.unevaluatedExampleIds.includes('en-nosplit-terms'));

  const built = report(DECOMPOSITION_GOLDEN, subset);
  assert.equal(built.totalExamples, DECOMPOSITION_GOLDEN.length);
  assert.equal(built.evaluatedExamples, 5);
  assert.equal(
    built.faithfulness.clean.denominator,
    5,
    'a score over 5 of 11 examples must state 5, not 11, as its denominator',
  );
});

test('a proposal naming no example is reported rather than scored', () => {
  const orphan = atomic({ ...goldenById('en-atomic-dentist'), exampleId: 'ghost' });
  const paired = pairProposals(DECOMPOSITION_GOLDEN, [...perfect(), orphan]);
  assert.deepEqual(paired.unmatchedProposalIds, ['prop-ghost']);
  assert.equal(paired.cases.length, DECOMPOSITION_GOLDEN.length);
});

test('an empty corpus reports that it is empty instead of rendering zeros', () => {
  const built = report([], []);
  assert.equal(built.corpusEmpty, true);
  assert.equal(built.status, 'CORPUS EMPTY');
  assert.equal(built.boundary.spanRecall.value, null, 'a ratio over nothing is not zero, it is undefined');
  assert.equal(built.boundary.spanRecall.denominator, 0);
});

/* ── Boundary ───────────────────────────────────────────────────── */

test('a perfect decomposer scores boundary 1.0 over every golden span', () => {
  const built = report(DECOMPOSITION_GOLDEN, perfect());

  assert.equal(built.boundary.spanRecall.value, 1);
  assert.equal(built.boundary.spanPrecision.value, 1);
  assert.equal(built.boundary.exactExampleAgreement.value, 1);
  assert.equal(built.boundary.exactExampleAgreement.denominator, DECOMPOSITION_GOLDEN.length);
  assert.equal(
    built.boundary.spanRecall.denominator,
    DECOMPOSITION_GOLDEN.reduce((total, example) => total + example.expectedSteps.length, 0),
    'each golden step carries exactly one span, so the span denominator is the step count',
  );
});

test('a boundary off by one code unit is not a match', () => {
  const wedding = goldenById('en-multi-wedding');
  const shifted = wedding.expectedSteps.map((step, index) =>
    index === 0
      ? {
          ...step,
          sourceSpans: [
            {
              start: step.sourceSpans[0].start,
              end: step.sourceSpans[0].end - 1,
              text: wedding.sourceText.slice(step.sourceSpans[0].start, step.sourceSpans[0].end - 1),
            },
          ],
        }
      : step,
  );
  const built = report([wedding], [decomposed(wedding, shifted)]);

  assert.equal(built.boundary.spanRecall.numerator, 2);
  assert.equal(built.boundary.spanRecall.denominator, 3);
  assert.equal(built.boundary.exactExampleAgreement.value, 0);
});

test('spans invented over a do-not-split row are counted against precision', () => {
  const terms = goldenById('en-nosplit-terms');
  const overSplit = decomposed(terms, [
    {
      stepId: 's1',
      title: 'Review the terms',
      sourceSpans: [span(terms.sourceText, 'Review the terms')],
      inferred: false,
      dependsOn: [],
      statedTiming: null,
      statedOwner: null,
    },
    {
      stepId: 's2',
      title: 'conditions before Friday',
      sourceSpans: [span(terms.sourceText, 'conditions before Friday')],
      inferred: false,
      dependsOn: [],
      statedTiming: null,
      statedOwner: null,
    },
  ]);
  const built = report([terms], [overSplit]);

  assert.equal(built.boundary.spanPrecision.numerator, 0);
  assert.equal(built.boundary.spanPrecision.denominator, 2);
  assert.equal(built.boundary.spanPrecision.value, 0);
  // Recall has no expected spans to be measured over; that is undefined, not perfect.
  assert.equal(built.boundary.spanRecall.denominator, 0);
  assert.equal(built.boundary.spanRecall.value, null);
});

/* ── Coverage ───────────────────────────────────────────────────── */

test('coverage states how much source text the produced steps account for, and over how many rows', () => {
  const built = report(DECOMPOSITION_GOLDEN, perfect());
  const decomposedRows = DECOMPOSITION_GOLDEN.filter((example) => example.expectedSteps.length >= 2);
  const sourceCodeUnits = decomposedRows.reduce((total, example) => total + example.sourceText.length, 0);

  assert.equal(built.coverage.examplesInScope, decomposedRows.length);
  assert.equal(built.coverage.produced.denominator, sourceCodeUnits);
  assert.ok(
    (built.coverage.produced.value ?? 0) > 0.5 && (built.coverage.produced.value ?? 0) < 1,
    `golden spans exclude connectives and punctuation, so coverage must be neither 0 nor 1; got ${
      built.coverage.produced.value
    }`,
  );
  // The reference the produced figure is only readable against.
  assert.equal(built.coverage.expected.value, built.coverage.produced.value);
});

test('overlapping produced spans are counted once, not twice', () => {
  const wedding = goldenById('en-multi-wedding');
  const first = wedding.expectedSteps[0];
  const doubled = decomposed(wedding, [
    first,
    { ...first, stepId: 'duplicate-of-s1' },
    wedding.expectedSteps[1],
  ]);
  const built = report([wedding], [doubled]);

  const union = first.sourceSpans[0].end - first.sourceSpans[0].start +
    (wedding.expectedSteps[1].sourceSpans[0].end - wedding.expectedSteps[1].sourceSpans[0].start);
  assert.equal(
    built.coverage.produced.numerator,
    union,
    'coverage is a union over code units; double-counting a repeated span would let a decomposer ' +
      'reach 100% by emitting the same step twice',
  );
});

test('a refusal to decompose contributes no coverage and is excluded from its denominator', () => {
  const wedding = goldenById('en-multi-wedding');
  const built = report([wedding], [atomic(wedding)]);
  assert.equal(built.coverage.examplesInScope, 0);
  assert.equal(built.coverage.produced.denominator, 0);
  assert.equal(built.coverage.produced.value, null);
  assert.equal(built.evaluatedExamples, 1, 'the example was still evaluated; only coverage has nothing to say');
});

/* ── Semantic faithfulness ──────────────────────────────────────── */

test('a perfect decomposer is fully faithful over the golden set', () => {
  const built = report(DECOMPOSITION_GOLDEN, perfect());
  assert.equal(built.faithfulness.clean.value, 1);
  assert.equal(built.faithfulness.clean.denominator, DECOMPOSITION_GOLDEN.length);
  assert.equal(built.faithfulness.doNotSplitRespected.value, 1);
  assert.equal(
    built.faithfulness.doNotSplitRespected.denominator,
    goldenByLabel('do_not_split').length + goldenByLabel('atomic').length,
  );
  for (const code of FAITHFULNESS_VIOLATION_CODES) {
    assert.equal(built.faithfulness.violationCounts[code], 0, `${code} should not fire on the golden set`);
  }
});

test('the violation histogram names every faithfulness code, including the ones at zero', () => {
  const built = report(DECOMPOSITION_GOLDEN, perfect());
  assert.deepEqual(Object.keys(built.faithfulness.violationCounts).sort(), [...FAITHFULNESS_VIOLATION_CODES].sort());
});

test('an invented date and an invented owner are each counted', () => {
  const wedding = goldenById('en-multi-wedding');
  const invented = wedding.expectedSteps.map((step, index) =>
    index === 0 ? { ...step, statedTiming: '2026-08-21', statedOwner: 'Sarah' } : step,
  );
  const built = report([wedding], [decomposed(wedding, invented)]);

  assert.equal(built.faithfulness.violationCounts.INVENTED_TIMING, 1);
  assert.equal(built.faithfulness.violationCounts.INVENTED_OWNER, 1);
  assert.equal(built.faithfulness.clean.numerator, 0);
  assert.equal(built.faithfulness.clean.denominator, 1);
  assert.deepEqual(built.faithfulness.offendingExampleIds, ['en-multi-wedding']);
});

test('splitting a do-not-split row is counted against faithfulness and against the do-not-split score', () => {
  const terms = goldenById('ar-nosplit-terms');
  const split = decomposed(terms, [
    {
      stepId: 's1',
      title: 'راجع الشروط',
      sourceSpans: [span(terms.sourceText, 'راجع الشروط')],
      inferred: false,
      dependsOn: [],
      statedTiming: null,
      statedOwner: null,
    },
    {
      stepId: 's2',
      title: 'الأحكام قبل الجمعة',
      sourceSpans: [span(terms.sourceText, 'الأحكام قبل الجمعة')],
      inferred: false,
      dependsOn: [],
      statedTiming: null,
      statedOwner: null,
    },
  ]);
  const built = report([terms], [split]);

  assert.equal(built.faithfulness.violationCounts.SPLIT_ATOMIC, 1);
  assert.equal(built.faithfulness.doNotSplitRespected.numerator, 0);
  assert.equal(built.faithfulness.doNotSplitRespected.denominator, 1);
  assert.equal(built.faithfulness.doNotSplitRespected.value, 0);
});

test('refusing to split a genuinely multi-step row is a boundary miss, not an invention', () => {
  // Under-splitting withholds a claim; it does not make one up. Charging it to
  // faithfulness would make "said nothing" and "invented a date" the same
  // finding, and a decomposer that refuses everything would then look exactly
  // as dishonest as one that fabricates.
  const wedding = goldenById('en-multi-wedding');
  const built = report([wedding], [atomic(wedding)]);

  assert.equal(built.faithfulness.clean.value, 1);
  assert.equal(built.faithfulness.violationCounts.SPLIT_ATOMIC, 0);
  assert.equal(built.boundary.spanRecall.value, 0);
  assert.equal(built.boundary.spanRecall.denominator, 3);
});

test('a forged span is caught by faithfulness even though its offsets are a perfect boundary match', () => {
  const wedding = goldenById('en-multi-wedding');
  const forged = wedding.expectedSteps.map((step, index) =>
    index === 0
      ? { ...step, sourceSpans: [{ ...step.sourceSpans[0], text: 'Cancel the venue' }] }
      : step,
  );
  const built = report([wedding], [decomposed(wedding, forged)]);

  assert.equal(built.boundary.spanRecall.value, 1, 'the cut is in the right place');
  assert.equal(built.faithfulness.violationCounts.SPAN_MISMATCH, 1, 'but the text it claims is not what is there');
  assert.equal(built.faithfulness.clean.value, 0);
});

/* ── Determinism ────────────────────────────────────────────────── */

test('two runs over the same inputs produce the same report', () => {
  assert.deepEqual(
    report(DECOMPOSITION_GOLDEN, perfect()),
    report(DECOMPOSITION_GOLDEN, perfect()),
  );
});

test('the report reads no clock of its own', () => {
  assert.throws(
    () => buildEvaluationReport({ examples: [], proposals: [], generatedAt: 'whenever' }),
    /ISO-8601/,
  );
});
