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
import {
  MAX_VIOLATIONS,
  MAX_VIOLATION_DETAIL_TOTAL,
  validateDecomposition,
} from '../../lib/decomposition/engine/validator.ts';
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

/**
 * `UNSOURCED_STEP` covers two shapes, pinned separately here so the pair cannot
 * rot into one. The shared vocabulary carries both: a step with no span at all,
 * and a step whose title its spans do not source. Both say the same thing —
 * this step's content is not traceable to what the user wrote — and #26's
 * evaluator counts them under the same code.
 */
test('UNSOURCED_STEP shape one: no span and no admission of inference', () => {
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

test('CYCLIC_DEPENDENCY: one cycle is one proposal-level defect, not one per step', () => {
  // A caller handed N rejections for one cycle cannot tell whether it has one
  // problem or N, and #26's evaluator counts the cycle once. `stepId` is null
  // because the contract reserves null for proposal-level violations and no
  // single step in a cycle is more at fault than the others.
  const a = step({ dependsOn: [{ dependsOnStepId: 's2', kind: 'temporal' }] });
  const b = { ...second, dependsOn: [{ dependsOnStepId: 's1', kind: 'temporal' as const }] };
  const violations = validateDecomposition({ sourceText: SOURCE, steps: [a, b] });

  assert.deepEqual(codes(violations), ['CYCLIC_DEPENDENCY']);
  assert.equal(violations.length, 1, 'one cycle must produce exactly one violation');
  assert.equal(violations[0].stepId, null);
  assert.match(violations[0].detail, /s1/);
  assert.match(violations[0].detail, /s2/);
});

test('a longer cycle is still one violation, and names every participant', () => {
  const third = step({
    stepId: 's3',
    title: 'invitations',
    sourceSpans: [{ start: 28, end: 39, text: 'invitations' }],
    dependsOn: [{ dependsOnStepId: 's2', kind: 'temporal' }],
  });
  const violations = validateDecomposition({
    sourceText: SOURCE,
    steps: [
      step({ dependsOn: [{ dependsOnStepId: 's3', kind: 'temporal' }] }),
      { ...second, title: 'send the', sourceSpans: [{ start: 19, end: 27, text: 'send the' }],
        dependsOn: [{ dependsOnStepId: 's1', kind: 'temporal' as const }] },
      third,
    ],
  });
  assert.deepEqual(codes(violations), ['CYCLIC_DEPENDENCY']);
  assert.equal(violations.length, 1);
  for (const stepId of ['s1', 's2', 's3']) assert.match(violations[0].detail, new RegExp(stepId));
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
    sourceSpans: [at(SOURCE, 'Book the venue'), { start: 5, end: 14, text: 'the venue' }],
  });
  assert.deepEqual(codes(validateDecomposition({ sourceText: SOURCE, steps: [doubleClaiming, second] })), [
    'SPAN_OVERLAP',
  ]);
});

test('title coverage is judged against the merged span range, so duplication is billed once', () => {
  // `[0,14)` and `[5,14)` jointly cover exactly `Book the venue`, so the title
  // *is* sourced and the only defect is the duplication. Concatenating the span
  // texts instead would read the title as `Book the venue the venue` and add a
  // second code for the same mistake — a caller handed two codes for one
  // mistake cannot tell whether it has one problem or two.
  const doubleClaiming = step({
    title: 'Book the venue',
    sourceSpans: [at(SOURCE, 'Book the venue'), { start: 5, end: 14, text: 'the venue' }],
  });
  const reported = validateDecomposition({ sourceText: SOURCE, steps: [doubleClaiming, second] });
  assert.deepEqual(codes(reported), ['SPAN_OVERLAP']);
  assert.equal(reported.length, 1, 'one defect, one violation');
});

test('merged coverage joins spans that meet, and still rejects a gap the title papers over', () => {
  // Touching ranges merge, so a title spelling the joined text is sourced.
  const touching = step({
    title: 'Book the',
    sourceSpans: [{ start: 0, end: 4, text: 'Book' }, { start: 4, end: 8, text: ' the' }],
  });
  assert.deepEqual(validateDecomposition({ sourceText: SOURCE, steps: [touching] }), []);

  // Disjoint ranges stay separate, so a title claiming the words *between* them
  // is still unsourced.
  const straddling = step({
    title: 'Book the venue and send',
    sourceSpans: [at(SOURCE, 'Book'), at(SOURCE, 'send the invitations')],
  });
  assert.deepEqual(codes(validateDecomposition({ sourceText: SOURCE, steps: [straddling] })), [
    'UNSOURCED_STEP',
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

test('UNSOURCED_STEP shape two: a title the spans do not source', () => {
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

test('a span rejected for exactness is not also charged with overlapping', () => {
  // The overlap pass ran over spans the exactness check had already rejected,
  // so a forged span collided with a real one and the same defect was billed
  // twice. A span whose text does not match what its offsets select is not a
  // claim on that range at all — there is nothing for it to overlap with.
  const forged = step({ title: 'x', sourceSpans: [{ start: 0, end: 14, text: 'WRONG TEXT!!!' }] });
  const real = step({ stepId: 's2', title: 'Book the venue' });
  assert.deepEqual(codes(validateDecomposition({ sourceText: SOURCE, steps: [forged, real] })), [
    'SPAN_MISMATCH',
  ]);
});

test('an out-of-range span is likewise not charged with overlapping', () => {
  const beyond = step({ title: 'x', sourceSpans: [{ start: 0, end: SOURCE.length + 5, text: SOURCE }] });
  const real = step({ stepId: 's2', title: 'Book the venue' });
  assert.deepEqual(codes(validateDecomposition({ sourceText: SOURCE, steps: [beyond, real] })), [
    'SPAN_OUT_OF_RANGE',
  ]);
});

test('a very deep dependency chain does not blow the stack', () => {
  // Cycle detection recursed once per edge, so a provider returning a few
  // thousand chained steps threw a RangeError straight out of the boundary —
  // past the only try/catch in the engine, which wraps the provider call and
  // not the validation of what it returned. No RejectedProposal, no audit
  // event, no fallback. #26's twin is iterative for the same reason.
  const depth = 50000;
  const chain = Array.from({ length: depth }, (_, index) => step({
    stepId: `s${index}`,
    title: 'x',
    sourceSpans: [],
    inferred: true,
    dependsOn: [{ dependsOnStepId: `s${(index + 1) % depth}`, kind: 'temporal' }],
  }));
  const violations = validateDecomposition({ sourceText: SOURCE, steps: chain });
  assert.deepEqual(codes(violations), ['CYCLIC_DEPENDENCY']);
  assert.equal(violations.length, 1);
});

test('a deep acyclic chain is not reported as a cycle', () => {
  const depth = 50000;
  const chain = Array.from({ length: depth }, (_, index) => step({
    stepId: `s${index}`,
    title: 'x',
    sourceSpans: [],
    inferred: true,
    dependsOn: index + 1 < depth ? [{ dependsOnStepId: `s${index + 1}`, kind: 'temporal' }] : [],
  }));
  assert.deepEqual(validateDecomposition({ sourceText: SOURCE, steps: chain }), []);
});

test('a provider-chosen step id cannot smuggle user text into a violation detail', () => {
  // `detail` is contractually free of raw user text, and the cycle detail names
  // the participating ids. That was justified by ids being engine-assigned,
  // which is false for a provider-supplied draft: a provider that echoes the
  // commitment as a step id put the user's sentence into every log line that
  // prints violations.
  const smuggled = 'اتصل بالدكتور سمير غدا واحجز موعد أسناني الأسبوع القادم';
  const violations = validateDecomposition({
    sourceText: SOURCE,
    steps: [
      step({ stepId: 'other', sourceSpans: [], inferred: true, title: 'x', dependsOn: [{ dependsOnStepId: smuggled, kind: 'temporal' }] }),
      step({ stepId: smuggled, sourceSpans: [], inferred: true, title: 'x', dependsOn: [{ dependsOnStepId: 'other', kind: 'temporal' }] }),
    ],
  });
  const serialized = JSON.stringify(violations.map((violation) => violation.detail));
  assert.equal(serialized.includes(smuggled), false, 'detail leaked the smuggled id');
  assert.equal(serialized.includes('سمير'), false);
  assert.match(serialized, /other/, 'a well-formed id is still named, per the cardinality ruling');
});

test('many overlapping spans are one finding per step pair, not one per span pair', () => {
  // Pairwise overlap allocated a violation object for every colliding *pair*:
  // 8,000 identical spans on one step produced 32,004,000 objects and ran the
  // process out of memory. One step double-claiming its own range is one
  // defect, which is the cardinality ruling already applied to cycles.
  const many = Array.from({ length: 4000 }, () => at(SOURCE, 'Book the venue'));
  const started = Date.now();
  const violations = validateDecomposition({ sourceText: SOURCE, steps: [step({ sourceSpans: many })] });
  const elapsed = Date.now() - started;

  assert.deepEqual(codes(violations), ['SPAN_OVERLAP']);
  assert.equal(violations.length, 1, `expected one violation, got ${violations.length}`);
  assert.ok(elapsed < 500, `took ${elapsed} ms`);
});

test('overlaps between different steps are still reported per pair of steps', () => {
  const a = step({ stepId: 'a', title: 'Book the venue' });
  const b = step({ stepId: 'b', title: 'Book the venue' });
  const c = step({ stepId: 'c', title: 'Book the venue' });
  const violations = validateDecomposition({ sourceText: SOURCE, steps: [a, b, c] });
  assert.deepEqual(codes(violations), ['SPAN_OVERLAP']);
  assert.equal(violations.length, 3, 'a-b, a-c and b-c are three distinct collisions');
});

test('a violation detail is bounded no matter how large the proposal', () => {
  // The cycle detail joined every participating id, so a 200,000-step cycle
  // produced a 1.7 MB string that then travelled with the proposal.
  const size = 20000;
  const cycle = Array.from({ length: size }, (_, index) => step({
    stepId: `s${index}`,
    title: 'x',
    sourceSpans: [],
    inferred: true,
    dependsOn: [{ dependsOnStepId: `s${(index + 1) % size}`, kind: 'temporal' }],
  }));
  const violations = validateDecomposition({ sourceText: SOURCE, steps: cycle });
  assert.deepEqual(codes(violations), ['CYCLIC_DEPENDENCY']);
  assert.ok(
    violations[0].detail.length < 500,
    `detail was ${violations[0].detail.length} characters`,
  );
  assert.match(violations[0].detail, /s0/, 'it still names participants');
  assert.match(violations[0].detail, /more/, 'and says how many it did not name');
});

test('a deep back-edge graph is checked without stalling', () => {
  const size = 40000;
  const chain = Array.from({ length: size }, (_, index) => step({
    stepId: `s${index}`,
    title: 'x',
    sourceSpans: [],
    inferred: true,
    dependsOn: [{ dependsOnStepId: index === 0 ? `s${size - 1}` : 's0', kind: 'temporal' }],
  }));
  const started = Date.now();
  validateDecomposition({ sourceText: SOURCE, steps: chain });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1500, `took ${elapsed} ms`);
});

test('a proposal of span-less steps costs nothing to check for overlap', () => {
  // Collapsing overlap to one finding per step pair introduced a regression:
  // the pair walk covered every step, so 40,000 steps that claim no source at
  // all cost a second in a loop that could never find anything. Only steps
  // holding a usable span can collide.
  const size = 40000;
  const spanless = Array.from({ length: size }, (_, index) => step({
    stepId: `s${index}`,
    title: 'x',
    sourceSpans: [],
    inferred: true,
    dependsOn: [{ dependsOnStepId: index === 0 ? `s${size - 1}` : 's0', kind: 'temporal' }],
  }));
  const started = Date.now();
  validateDecomposition({ sourceText: SOURCE, steps: spanless });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 400, `took ${elapsed} ms`);
});

/* ── The report itself is bounded (consolidation review) ─────────── */

test('a legal 200-step draft cannot turn into a megabyte of violations', () => {
  // `normaliseDraft` admits up to 200 steps, and `validateDecomposition` had no
  // step cap of its own — so a draft at that limit, every step claiming the
  // same words, produced 19,900 SPAN_OVERLAP findings carrying 1.12 MB of
  // `detail`. A violation list travels with the proposal and into audit, so an
  // unbounded report is an unbounded payload on that path.
  const many = Array.from({ length: 200 }, (_, index) => step({
    stepId: `s${index}`,
    sourceSpans: [at(SOURCE, 'Book the venue')],
  }));
  const violations = validateDecomposition({ sourceText: SOURCE, steps: many });

  assert.deepEqual(codes(violations), ['SPAN_OVERLAP']);
  assert.ok(
    violations.length <= MAX_VIOLATIONS,
    `expected at most ${MAX_VIOLATIONS} violations, got ${violations.length}`,
  );
  const detailBytes = violations.reduce((total, violation) => total + violation.detail.length, 0);
  assert.ok(
    detailBytes <= MAX_VIOLATION_DETAIL_TOTAL,
    `expected at most ${MAX_VIOLATION_DETAIL_TOTAL} characters of detail, got ${detailBytes}`,
  );
});

test('the cap does not bite on a proposal a reviewer could actually read', () => {
  // The bound must not turn an ordinary report into a truncated one. Three
  // steps colliding pairwise is three findings and stays three.
  const a = step({ stepId: 'a' });
  const b = step({ stepId: 'b' });
  const c = step({ stepId: 'c' });
  assert.equal(validateDecomposition({ sourceText: SOURCE, steps: [a, b, c] }).length, 3);
});

test('a step id that reads like a sentence is reported positionally, never quoted', () => {
  // `safeStepId` tested the character class and the length only, so any string
  // of up to 64 characters over [A-Za-z0-9_.:-] was emitted verbatim — which is
  // a sentence with the spaces replaced. `detail` is contractually free of raw
  // user text, and a violation travels into every log line that prints it.
  for (const smuggled of [
    'Tell-my-therapist-I-relapsed-on-Tuesday',
    'card_4111111111111111_cvv_123',
    'she.said.she.is.leaving.me.in.March',
  ]) {
    const violations = validateDecomposition({
      sourceText: SOURCE,
      steps: [
        step({ stepId: 'other', sourceSpans: [], inferred: true, title: 'x', dependsOn: [{ dependsOnStepId: smuggled, kind: 'temporal' }] }),
        step({ stepId: smuggled, sourceSpans: [], inferred: true, title: 'x', dependsOn: [{ dependsOnStepId: 'other', kind: 'temporal' }] }),
      ],
    });
    const serialized = JSON.stringify(violations.map((violation) => violation.detail));
    assert.equal(serialized.includes(smuggled), false, `detail leaked ${smuggled}`);
    assert.match(serialized, /other/, 'a well-formed id is still named, per the cardinality ruling');
  }
});

test('the ids an engine actually mints are still named in a detail', () => {
  // The mirror. Tightening the redaction must not turn every cycle report into
  // a list of positions: `s1`, `s2`, `step.3`, `a:b` are ids, not sentences.
  for (const id of ['s1', 's12', 'step_3', 'step.3', 'a:b', 'A-1']) {
    const violations = validateDecomposition({
      sourceText: SOURCE,
      steps: [
        step({ stepId: id, sourceSpans: [], inferred: true, title: 'x', dependsOn: [{ dependsOnStepId: 'other', kind: 'temporal' }] }),
        step({ stepId: 'other', sourceSpans: [], inferred: true, title: 'x', dependsOn: [{ dependsOnStepId: id, kind: 'temporal' }] }),
      ],
    });
    const cycle = violations.find((violation) => violation.code === 'CYCLIC_DEPENDENCY');
    assert.ok(cycle, `${id} should have produced a cycle`);
    assert.ok(cycle.detail.includes(id), `${id} is an ordinary id and must still be named`);
  }
});
