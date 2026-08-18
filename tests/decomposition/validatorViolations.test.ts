/**
 * One test per `DecompositionViolationCode`, each asserting the validator emits
 * *exactly* that code and nothing else.
 *
 * "Exactly" is the point. Several of these conditions overlap by construction —
 * a span reaching past the end of the text also fails the slice round-trip, and
 * a step depending on itself is also a cycle — so a validator that reported
 * every technically-true code would give a reviewer a pile of findings for one
 * defect and no way to tell which one to fix. Asserting the exact code set is
 * what pins the precedence rules; asserting "includes" would let them drift.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  DecompositionStepProposal,
  DecompositionViolation,
  DecompositionViolationCode,
  SourceSpan,
} from '../../src/contracts/v1/decompositionContracts.ts';
import { validateDecomposition } from '../../lib/decomposition/engine/validator.ts';
import { DECOMPOSITION_GOLDEN } from '../fixtures/decompositionGolden.ts';

const SOURCE = 'Book the venue and send the invitations.';

function at(source: string, snippet: string): SourceSpan {
  const start = source.indexOf(snippet);
  assert.ok(start >= 0, `test setup: ${snippet} not in source`);
  return { start, end: start + snippet.length, text: snippet };
}

function step(overrides: Partial<DecompositionStepProposal> = {}): DecompositionStepProposal {
  return {
    stepId: 's1',
    title: 'Book the venue',
    sourceSpans: [at(SOURCE, 'Book the venue')],
    inferred: false,
    dependsOn: [],
    statedTiming: null,
    statedOwner: null,
    ...overrides,
  };
}

const second = step({
  stepId: 's2',
  title: 'send the invitations',
  sourceSpans: [at(SOURCE, 'send the invitations')],
});

function codes(violations: readonly DecompositionViolation[]): DecompositionViolationCode[] {
  return Array.from(new Set(violations.map((violation) => violation.code))).sort();
}

test('a well-formed two-step decomposition produces no violations', () => {
  assert.deepEqual(validateDecomposition({ sourceText: SOURCE, steps: [step(), second] }), []);
});

test('EMPTY_STEP: a whitespace-only title', () => {
  const violations = validateDecomposition({ sourceText: SOURCE, steps: [step({ title: '   ' }), second] });
  assert.deepEqual(codes(violations), ['EMPTY_STEP']);
});

test('CONJUNCTION_ONLY: a title that is only a connective, in each script', () => {
  for (const [source, connective] of [
    ['Book the venue and send the invitations.', 'and'],
    ['احجز القاعة ثم أرسل الدعوات.', 'ثم'],
    ['תזמין את האולם ואז תשלח הזמנות.', 'ואז'],
  ] as const) {
    const only = step({ title: connective, sourceSpans: [at(source, connective)] });
    const other = step({ stepId: 's2', title: source.slice(0, 5), sourceSpans: [at(source, source.slice(0, 5))] });
    assert.deepEqual(codes(validateDecomposition({ sourceText: source, steps: [only, other] })), [
      'CONJUNCTION_ONLY',
    ]);
  }
});

test('SPAN_MISMATCH: offsets in range but selecting different text', () => {
  const lying = step({ sourceSpans: [{ start: 0, end: 14, text: 'Book the cake!' }] });
  assert.deepEqual(codes(validateDecomposition({ sourceText: SOURCE, steps: [lying, second] })), [
    'SPAN_MISMATCH',
  ]);
});

test('SPAN_OUT_OF_RANGE takes precedence over the mismatch it also causes', () => {
  const beyond = step({ sourceSpans: [{ start: 0, end: SOURCE.length + 5, text: SOURCE }] });
  assert.deepEqual(codes(validateDecomposition({ sourceText: SOURCE, steps: [beyond, second] })), [
    'SPAN_OUT_OF_RANGE',
  ]);
});

test('SPAN_OVERLAP: two steps claiming the same source text', () => {
  const overlapping = step({
    stepId: 's2',
    title: 'the venue and send',
    sourceSpans: [at(SOURCE, 'the venue and send')],
  });
  assert.deepEqual(codes(validateDecomposition({ sourceText: SOURCE, steps: [step(), overlapping] })), [
    'SPAN_OVERLAP',
  ]);
});

test('SPAN_OVERLAP is not raised for adjacent half-open spans', () => {
  const left = step({ title: 'Book', sourceSpans: [{ start: 0, end: 4, text: 'Book' }] });
  const right = step({ stepId: 's2', title: 'the', sourceSpans: [{ start: 4, end: 8, text: ' the' }] });
  assert.deepEqual(validateDecomposition({ sourceText: SOURCE, steps: [left, right] }), []);
});

test('INVENTED_TIMING: a stated time that is not in the source text', () => {
  const invented = step({ statedTiming: 'next Tuesday' });
  assert.deepEqual(codes(validateDecomposition({ sourceText: SOURCE, steps: [invented, second] })), [
    'INVENTED_TIMING',
  ]);
});

test('INVENTED_OWNER: a stated owner that is not in the source text', () => {
  const invented = step({ statedOwner: 'Dana' });
  assert.deepEqual(codes(validateDecomposition({ sourceText: SOURCE, steps: [invented, second] })), [
    'INVENTED_OWNER',
  ]);
});

test('INFERRED_WITH_SPAN: claims inference while citing source text', () => {
  const contradictory = step({ inferred: true });
  assert.deepEqual(codes(validateDecomposition({ sourceText: SOURCE, steps: [contradictory, second] })), [
    'INFERRED_WITH_SPAN',
  ]);
});

test('UNSOURCED_STEP: no span and no admission of inference', () => {
  const unsourced = step({ sourceSpans: [] });
  assert.deepEqual(codes(validateDecomposition({ sourceText: SOURCE, steps: [unsourced, second] })), [
    'UNSOURCED_STEP',
  ]);
});

test('an inferred step with no span is legal', () => {
  const inferred = step({ stepId: 's3', title: 'Confirm the booking', sourceSpans: [], inferred: true });
  assert.deepEqual(validateDecomposition({ sourceText: SOURCE, steps: [step(), second, inferred] }), []);
});

test('DUPLICATE_STEP_ID: two steps sharing an id', () => {
  const clone = step({ title: 'send the invitations', sourceSpans: [at(SOURCE, 'send the invitations')] });
  assert.deepEqual(codes(validateDecomposition({ sourceText: SOURCE, steps: [step(), clone] })), [
    'DUPLICATE_STEP_ID',
  ]);
});

test('UNKNOWN_DEPENDENCY: an edge pointing at no step in this proposal', () => {
  const dangling = step({ dependsOn: [{ dependsOnStepId: 'sX', kind: 'temporal' }] });
  assert.deepEqual(codes(validateDecomposition({ sourceText: SOURCE, steps: [dangling, second] })), [
    'UNKNOWN_DEPENDENCY',
  ]);
});

test('SELF_DEPENDENCY takes precedence over the cycle it also forms', () => {
  const loop = step({ dependsOn: [{ dependsOnStepId: 's1', kind: 'temporal' }] });
  assert.deepEqual(codes(validateDecomposition({ sourceText: SOURCE, steps: [loop, second] })), [
    'SELF_DEPENDENCY',
  ]);
});

test('CYCLIC_DEPENDENCY: a two-step cycle', () => {
  const a = step({ dependsOn: [{ dependsOnStepId: 's2', kind: 'temporal' }] });
  const b = { ...second, dependsOn: [{ dependsOnStepId: 's1', kind: 'temporal' as const }] };
  assert.deepEqual(codes(validateDecomposition({ sourceText: SOURCE, steps: [a, b] })), [
    'CYCLIC_DEPENDENCY',
  ]);
});

test('SPLIT_ATOMIC: a commitment declared do-not-split was split anyway', () => {
  const violations = validateDecomposition({
    sourceText: SOURCE,
    steps: [step(), second],
    declaredAtomic: true,
  });
  assert.deepEqual(codes(violations), ['SPLIT_ATOMIC']);
});

test('violation details never carry raw user text', () => {
  const source = 'راجع الشروط والأحكام قبل الجمعة.';
  const violations = validateDecomposition({
    sourceText: source,
    steps: [
      step({ title: '   ', sourceSpans: [], statedTiming: 'يوم الاثنين', statedOwner: 'عمر' }),
      { ...second, sourceSpans: [{ start: 0, end: 400, text: source }] },
    ],
  });
  assert.ok(violations.length > 0);
  const serialized = JSON.stringify(violations);
  for (const secret of [source, 'يوم الاثنين', 'عمر', 'send the invitations']) {
    assert.equal(serialized.includes(secret), false, `violation detail leaked ${secret}`);
  }
});

test('every golden expected-step set validates clean against its own source', () => {
  for (const example of DECOMPOSITION_GOLDEN) {
    if (example.expectedSteps.length === 0) continue;
    assert.deepEqual(
      validateDecomposition({ sourceText: example.sourceText, steps: example.expectedSteps }),
      [],
      `${example.exampleId} should be a valid decomposition`,
    );
  }
});

/* ── Contract rulings issued at review time ──────────────────────── */

test('SPAN_OVERLAP covers two spans belonging to the same step', () => {
  // A step double-claiming its own words is exactly as wrong as two steps
  // colliding: the acceptance criterion "source segments are exact and
  // non-overlapping" is unqualified, and #26's evaluator counts it the same way.
  const doubleClaiming = step({
    title: 'Book the venue the venue',
    sourceSpans: [at(SOURCE, 'Book the venue'), { start: 5, end: 14, text: 'the venue' }],
  });
  assert.deepEqual(codes(validateDecomposition({ sourceText: SOURCE, steps: [doubleClaiming, second] })), [
    'SPAN_OVERLAP',
  ]);
});

test('SPAN_OUT_OF_RANGE covers a degenerate empty range, not only an out-of-bounds one', () => {
  // `slice(5, 5) === ''` matches a `text` of `''`, so SPAN_MISMATCH would pass
  // this trivially. A span that claims nothing is malformed, not exact.
  const degenerate = step({ sourceSpans: [{ start: 5, end: 5, text: '' }] });
  assert.deepEqual(codes(validateDecomposition({ sourceText: SOURCE, steps: [degenerate, second] })), [
    'SPAN_OUT_OF_RANGE',
  ]);
});

test('an empty statedTiming or statedOwner is a claim about nothing, not an absent claim', () => {
  // `sourceText.includes('')` is true, so a naive verbatim check passes an
  // empty string silently. Absence is spelled `null`; '' is neither.
  for (const [field, code] of [
    ['statedTiming', 'INVENTED_TIMING'],
    ['statedOwner', 'INVENTED_OWNER'],
  ] as const) {
    for (const blank of ['', '   ']) {
      assert.deepEqual(
        codes(validateDecomposition({ sourceText: SOURCE, steps: [step({ [field]: blank }), second] })),
        [code],
        `${field}=${JSON.stringify(blank)} should be rejected`,
      );
    }
  }
});

/* ── Title provenance (Blocker 3) ────────────────────────────────── */

test('UNSOURCED_STEP: a title the spans do not source', () => {
  // The invention channel the validator used to leave open: a provider can cite
  // real spans and put anything at all in the title, and the title is the field
  // the user reads and the adapter persists. Provenance is only checkable if
  // the words the step claims are the words the spans select.
  const fabricated = step({ title: 'Wire $9,000 to account 12345' });
  assert.deepEqual(codes(validateDecomposition({ sourceText: SOURCE, steps: [fabricated, second] })), [
    'UNSOURCED_STEP',
  ]);
});

test('a title assembled from several spans is sourced', () => {
  const multiSpan = step({
    title: 'Book the venue send the invitations',
    sourceSpans: [at(SOURCE, 'Book the venue'), at(SOURCE, 'send the invitations')],
  });
  assert.deepEqual(validateDecomposition({ sourceText: SOURCE, steps: [multiSpan] }), []);
});

test('title provenance tolerates whitespace differences but not added words', () => {
  const respaced = step({ title: '  Book   the venue  ' });
  assert.deepEqual(validateDecomposition({ sourceText: SOURCE, steps: [respaced, second] }), []);

  const padded = step({ title: 'Book the venue urgently' });
  assert.deepEqual(codes(validateDecomposition({ sourceText: SOURCE, steps: [padded, second] })), [
    'UNSOURCED_STEP',
  ]);
});

test('a broken span is reported once, not also as an unsourced title', () => {
  // Precedence: when the span itself is unusable the title cannot be checked
  // against it, and reporting both would give two findings for one defect.
  for (const spans of [
    [{ start: 0, end: 14, text: 'Book the cake!' }],
    [{ start: 0, end: SOURCE.length + 5, text: SOURCE }],
  ]) {
    const broken = step({ title: 'Something else entirely', sourceSpans: spans });
    const reported = codes(validateDecomposition({ sourceText: SOURCE, steps: [broken, second] }));
    assert.equal(reported.length, 1, `expected one code, got ${reported.join()}`);
    assert.equal(reported[0].startsWith('SPAN_'), true);
  }
});

test('an inferred step is exempt from title provenance, because it admits having none', () => {
  const inferred = step({ stepId: 's3', title: 'Confirm the booking', sourceSpans: [], inferred: true });
  assert.deepEqual(validateDecomposition({ sourceText: SOURCE, steps: [step(), second, inferred] }), []);
});

test('no golden expected step is reported unsourced once title provenance is checked', () => {
  for (const example of DECOMPOSITION_GOLDEN) {
    const reported = codes(
      validateDecomposition({ sourceText: example.sourceText, steps: example.expectedSteps }),
    );
    assert.equal(
      reported.includes('UNSOURCED_STEP'),
      false,
      `${example.exampleId} titles should be sourced by their own spans`,
    );
  }
});
