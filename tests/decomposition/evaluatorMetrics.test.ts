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

import { validateDecompositionExample } from '../../lib/decomposition/evaluation/example.ts';
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
    built.boundary.exactExampleAgreement.denominator,
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
  // Pinned to the exact figure, not to a range. `expected === produced` was the
  // assertion here before, and it is tautological for a perfect decomposer:
  // both sides derive from the same spans, so it holds however either is
  // computed and would not have caught a wrong denominator.
  assert.equal(built.coverage.produced.numerator, 158);
  assert.equal(built.coverage.produced.denominator, 213);
  assert.equal(built.coverage.produced.value, 158 / 213);
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
  const withSteps = DECOMPOSITION_GOLDEN.filter((example) => example.expectedSteps.length >= 2).length;
  assert.equal(built.faithfulness.clean.value, 1);
  assert.equal(
    built.faithfulness.clean.denominator,
    withSteps,
    'faithfulness is over the rows that actually produced something to be unfaithful with',
  );
  assert.equal(built.faithfulness.examplesWithProducedSteps, withSteps);
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

  assert.equal(
    built.faithfulness.clean.value,
    null,
    'a refusal is not inspected for faithfulness, so it must not sit in the numerator either',
  );
  assert.equal(built.faithfulness.clean.denominator, 0);
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

/* ── M1: a refusal is not a clean bill of health ────────────────── */

test('a decomposer that refuses everything does not score a perfect faithfulness', () => {
  // The headline defect: a proposal with no steps produces no violations, so it
  // landed in the numerator while the denominator stayed at every evaluated
  // row. The safest possible failure scored identically to a flawless run.
  const built = report(
    DECOMPOSITION_GOLDEN,
    DECOMPOSITION_GOLDEN.map((example) => atomic(example)),
  );

  assert.equal(built.faithfulness.clean.value, null, 'refusing everything is a measurement of nothing');
  assert.equal(built.faithfulness.clean.numerator, 0);
  assert.equal(built.faithfulness.clean.denominator, 0);
  assert.equal(built.faithfulness.examplesWithProducedSteps, 0);
  assert.equal(built.evaluatedExamples, DECOMPOSITION_GOLDEN.length, 'the rows were still evaluated');
  assert.equal(built.boundary.spanRecall.value, 0, 'and the miss shows up where it belongs');
});

test('the faithfulness denominator counts only rows that produced steps', () => {
  const wedding = goldenById('en-multi-wedding');
  const dentist = goldenById('en-atomic-dentist');
  const built = report([wedding, dentist], [decomposed(wedding), atomic(dentist)]);

  assert.equal(built.evaluatedExamples, 2);
  assert.equal(built.faithfulness.clean.denominator, 1);
  assert.equal(built.faithfulness.examplesWithProducedSteps, 1);
  assert.match(built.faithfulness.clean.denominatorOf, /produced/);
});

/* ── M2: the ground-truth figure is not a ceiling ───────────────── */

test('coverage.groundTruth is scoped to rows that have expected spans', () => {
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

  // The old `expected` was computed over the decomposed rows and read 0.0000
  // here while `produced` read 0.8696 — so the "ceiling" was beneath the figure
  // it supposedly bounded, and an over-splitter (the failure the do-not-split
  // weighting exists to catch) produced the highest coverage in the report.
  assert.ok((built.coverage.produced.value ?? 0) > 0.8);
  assert.equal(built.coverage.groundTruth.value, null, 'this row has no expected spans to cover anything with');
  assert.equal(built.coverage.groundTruth.denominator, 0);
  assert.notEqual(built.coverage.groundTruth.metric, 'coverage.expected');
});

test('coverage.groundTruth states its own scope, which is not the produced scope', () => {
  const built = report(DECOMPOSITION_GOLDEN, perfect());
  assert.equal(built.coverage.produced.denominator, 213);
  assert.equal(built.coverage.groundTruth.denominator, 213);
  assert.match(built.coverage.groundTruth.denominatorOf, /expected/);
  assert.notEqual(
    built.coverage.produced.denominatorOf,
    built.coverage.groundTruth.denominatorOf,
    'two figures over two scopes must not present themselves as one comparison',
  );
});

/* ── perExample rows ────────────────────────────────────────────── */

test('perExample carries the per-row arithmetic, pinned', () => {
  const wedding = goldenById('en-multi-wedding');
  const built = report([wedding], [decomposed(wedding)]);
  assert.equal(built.coverage.perExample.length, 1);

  const row = built.coverage.perExample[0];
  assert.equal(row.exampleId, 'en-multi-wedding');
  assert.equal(row.coveredCodeUnits, 48);
  assert.equal(row.sourceCodeUnits, 71);
  assert.equal(row.ratio, 48 / 71);
});

test('a per-row ratio over an empty source is null, not zero', () => {
  // "A ratio over zero is null, never 0" is stated three sections up in the
  // module; this field contradicted it.
  const empty: DecompositionExample = {
    exampleId: 'empty-source',
    locale: 'en',
    sourceText: '',
    label: 'multi_step',
    provenance: 'synthetic',
    expectedSteps: [],
    note: 'constructed by the test',
  };
  const steps = [
    { stepId: 's1', title: 'a', sourceSpans: [], inferred: true, dependsOn: [], statedTiming: null, statedOwner: null },
    { stepId: 's2', title: 'b', sourceSpans: [], inferred: true, dependsOn: [], statedTiming: null, statedOwner: null },
  ];
  const built = report([empty], [decomposed(empty, steps)]);
  assert.equal(built.coverage.perExample[0].ratio, null);
});

/* ── Multiset semantics ─────────────────────────────────────────── */

test('a span emitted three times is one match and three produced spans', () => {
  // Set semantics would collapse the duplicates and forgive them. The stated
  // rationale for using a multiset had no test holding it in place.
  const wedding = goldenById('en-multi-wedding');
  const first = wedding.expectedSteps[0];
  const spammed = decomposed(wedding, [
    first,
    { ...first, stepId: 'copy-a' },
    { ...first, stepId: 'copy-b' },
    wedding.expectedSteps[1],
  ]);
  const built = report([wedding], [spammed]);

  assert.equal(built.boundary.spanRecall.numerator, 2, 'two distinct expected spans were found');
  assert.equal(built.boundary.spanRecall.denominator, 3);
  assert.equal(built.boundary.spanPrecision.numerator, 2, 'the two extra copies are not extra credit');
  assert.equal(built.boundary.spanPrecision.denominator, 4);
});

test('a repeated expected span is matched as many times as it appears', () => {
  // This pins the `Math.min` in `intersectionSize` rather than plain set
  // membership. The ground truth here is deliberately malformed — two steps
  // claiming identical text, which `validateDecompositionExample` rejects as
  // SPAN_OVERLAP and the corpus loader refuses. `buildEvaluationReport` does
  // not validate what it is handed, so the arithmetic still has to be right on
  // input a caller can construct; set semantics would silently score 1 of 2.
  const wedding = goldenById('en-multi-wedding');
  const shared = wedding.expectedSteps[0];
  const twins: DecompositionExample = {
    ...wedding,
    exampleId: 'malformed-twin-spans',
    expectedSteps: [shared, { ...shared, stepId: 'twin' }],
  };
  assert.equal(
    validateDecompositionExample(twins).violations.some((violation) => violation.code === 'SPAN_OVERLAP'),
    true,
    'the validator rejects this shape; the metric still has to count it correctly',
  );

  const built = report([twins], [decomposed(twins, twins.expectedSteps)]);
  assert.equal(built.boundary.spanRecall.numerator, 2);
  assert.equal(built.boundary.spanRecall.denominator, 2);
  assert.equal(built.boundary.spanRecall.value, 1);
});
