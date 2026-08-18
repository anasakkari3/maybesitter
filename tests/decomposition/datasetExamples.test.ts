/**
 * Example validation (Sprint 06, issue #26).
 *
 * The evaluator's half of the shared violation vocabulary. #27's validator
 * rejects proposals carrying these codes; this module counts them to score a
 * dataset, and the two must reach the same verdict about the same data — which
 * is only testable if each side is pinned to concrete inputs rather than to its
 * own idea of what a violation looks like.
 *
 * Two properties are asserted here that are easy to lose later:
 *
 *  - `SPAN_MISMATCH` is decided by actually slicing the source text. A
 *    validator that trusts `span.text` would pass every forged span, which is
 *    the one failure the whole provenance design exists to prevent.
 *  - No violation `detail` carries raw user text. The audit policy
 *    (`rawInputInAudit: false`) is a property of every message this module
 *    emits, so it is asserted over the whole corpus of messages rather than
 *    spot-checked on one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateDecompositionExample,
  validateProposedSteps,
} from '../../lib/decomposition/evaluation/example.ts';
import type {
  DecompositionExample,
  DecompositionStepProposal,
  DecompositionViolationCode,
} from '../../src/contracts/v1/decompositionContracts.ts';
import { DECOMPOSITION_GOLDEN, span } from '../fixtures/decompositionGolden.ts';

const SOURCE = 'Book the venue by Friday, then send the invitations to Omar.';

function step(overrides: Partial<DecompositionStepProposal> & { stepId: string }): DecompositionStepProposal {
  return {
    title: overrides.stepId,
    sourceSpans: [],
    inferred: true,
    dependsOn: [],
    statedTiming: null,
    statedOwner: null,
    ...overrides,
  };
}

function sourced(stepId: string, snippet: string, extra: Partial<DecompositionStepProposal> = {}) {
  return step({
    stepId,
    title: snippet,
    sourceSpans: [span(SOURCE, snippet)],
    inferred: false,
    ...extra,
  });
}

function example(overrides: Partial<DecompositionExample> = {}): DecompositionExample {
  return {
    exampleId: 'ex-under-test',
    locale: 'en',
    sourceText: SOURCE,
    label: 'multi_step',
    provenance: 'synthetic',
    expectedSteps: [],
    note: 'constructed by the test',
    ...overrides,
  };
}

/**
 * Violation codes for one constructed example.
 *
 * A benign inferred step is appended to `multi_step` cases so a single-step
 * probe does not also trip the cardinality rule. That rule has its own test
 * below; letting it fire in every other assertion would make each of them
 * report two codes and hide which one the case was written for.
 */
function codes(steps: readonly DecompositionStepProposal[], overrides: Partial<DecompositionExample> = {}) {
  const label = overrides.label ?? 'multi_step';
  const padded =
    label === 'multi_step' && steps.length < 2
      ? [...steps, step({ stepId: 'filler', title: 'Pay the deposit' })]
      : steps;
  return validateDecompositionExample(example({ ...overrides, expectedSteps: padded })).violations.map(
    (violation) => violation.code,
  );
}

/* ── The golden set is clean ────────────────────────────────────── */

test('every golden example validates without a violation', () => {
  for (const golden of DECOMPOSITION_GOLDEN) {
    const result = validateDecompositionExample(golden);
    assert.equal(
      result.valid,
      true,
      `${golden.exampleId}: ${JSON.stringify(result.violations, null, 2)}`,
    );
  }
});

/* ── Spans ──────────────────────────────────────────────────────── */

test('SPAN_MISMATCH is decided by slicing the source, not by trusting span.text', () => {
  const forged = step({
    stepId: 's1',
    title: 'Book the venue',
    sourceSpans: [{ start: 0, end: 14, text: 'Cancel the venue' }],
    inferred: false,
  });
  assert.deepEqual(codes([forged, sourced('s2', 'send the invitations')]), ['SPAN_MISMATCH']);
});

test('SPAN_OUT_OF_RANGE covers a span past the end, a negative start and an empty range', () => {
  const past = step({
    stepId: 's1',
    title: 'x',
    sourceSpans: [{ start: SOURCE.length - 2, end: SOURCE.length + 40, text: 'x' }],
    inferred: false,
  });
  const negative = step({
    stepId: 's2',
    title: 'y',
    sourceSpans: [{ start: -1, end: 4, text: 'y' }],
    inferred: false,
  });
  const empty = step({ stepId: 's3', title: 'z', sourceSpans: [{ start: 5, end: 5, text: '' }], inferred: false });

  assert.deepEqual(codes([past, negative, empty]), [
    'SPAN_OUT_OF_RANGE',
    'SPAN_OUT_OF_RANGE',
    'SPAN_OUT_OF_RANGE',
  ]);
});

test('an out-of-range span is not also reported as a mismatch', () => {
  // slice() clamps, so an unchecked mismatch test would fire a second, misleading
  // code on the same span and send a maintainer looking for the wrong defect.
  const beyond = step({
    stepId: 's1',
    title: 'x',
    sourceSpans: [{ start: 0, end: SOURCE.length + 10, text: SOURCE }],
    inferred: false,
  });
  assert.deepEqual(codes([beyond]), ['SPAN_OUT_OF_RANGE']);
});

test('SPAN_OVERLAP fires when two steps claim the same source text', () => {
  const wide = sourced('s1', 'Book the venue by Friday');
  const inside = sourced('s2', 'by Friday');
  assert.deepEqual(codes([wide, inside]), ['SPAN_OVERLAP']);
});

test('adjacent spans do not overlap: the range is half-open', () => {
  const left = step({ stepId: 's1', title: 'Book', sourceSpans: [span(SOURCE, 'Book')], inferred: false });
  const right = step({
    stepId: 's2',
    title: ' the venue',
    sourceSpans: [{ start: 4, end: 14, text: SOURCE.slice(4, 14) }],
    inferred: false,
  });
  assert.deepEqual(codes([left, right]), []);
});

/* ── Invention ──────────────────────────────────────────────────── */

test('INVENTED_TIMING fires for a timing the source never states', () => {
  const invented = sourced('s1', 'Book the venue', { statedTiming: '2026-08-21' });
  assert.deepEqual(codes([invented]), ['INVENTED_TIMING']);
});

test('a timing quoted verbatim from the source is not an invention', () => {
  const verbatim = sourced('s1', 'Book the venue', { statedTiming: 'by Friday' });
  assert.deepEqual(codes([verbatim]), []);
});

test('INVENTED_OWNER fires for an owner the source never names', () => {
  const invented = sourced('s1', 'Book the venue', { statedOwner: 'Sarah' });
  assert.deepEqual(codes([invented]), ['INVENTED_OWNER']);
  assert.deepEqual(codes([sourced('s2', 'send the invitations', { statedOwner: 'Omar' })]), []);
});

/* ── Sourcing ───────────────────────────────────────────────────── */

test('INFERRED_WITH_SPAN fires when a step both admits inference and cites text', () => {
  const contradictory = step({
    stepId: 's1',
    title: 'Book the venue',
    sourceSpans: [span(SOURCE, 'Book the venue')],
    inferred: true,
  });
  assert.deepEqual(codes([contradictory]), ['INFERRED_WITH_SPAN']);
});

test('UNSOURCED_STEP fires for a step with no span that does not admit inference', () => {
  const unsourced = step({ stepId: 's1', title: 'Pay the deposit', inferred: false });
  assert.deepEqual(codes([unsourced]), ['UNSOURCED_STEP']);
});

test('an honestly inferred step with no span is not a violation', () => {
  assert.deepEqual(codes([step({ stepId: 's1', title: 'Pay the deposit', inferred: true })]), []);
});

/* ── Step shape ─────────────────────────────────────────────────── */

test('EMPTY_STEP fires for a blank or whitespace-only title', () => {
  assert.deepEqual(codes([step({ stepId: 's1', title: '   ' })]), ['EMPTY_STEP']);
});

test('CONJUNCTION_ONLY fires for a split artefact in each supported script', () => {
  for (const connective of ['and', 'then', 'And,', 'ثم', 'و', 'وبعدها', 'ואז', 'ו']) {
    assert.deepEqual(
      codes([step({ stepId: 's1', title: connective })]),
      ['CONJUNCTION_ONLY'],
      `expected CONJUNCTION_ONLY for ${JSON.stringify(connective)}`,
    );
  }
});

test('a real step whose title merely contains a connective is not a split artefact', () => {
  assert.deepEqual(codes([step({ stepId: 's1', title: 'Review the terms and conditions' })]), []);
});

test('DUPLICATE_STEP_ID fires once for the second step sharing an id', () => {
  assert.deepEqual(codes([step({ stepId: 's1', title: 'a' }), step({ stepId: 's1', title: 'b' })]), [
    'DUPLICATE_STEP_ID',
  ]);
});

/* ── Dependencies ───────────────────────────────────────────────── */

test('SELF_DEPENDENCY, UNKNOWN_DEPENDENCY and CYCLIC_DEPENDENCY are each reported', () => {
  const selfEdge = step({
    stepId: 's1',
    title: 'a',
    dependsOn: [{ dependsOnStepId: 's1', kind: 'temporal' }],
  });
  assert.deepEqual(codes([selfEdge]), ['SELF_DEPENDENCY']);

  const dangling = step({
    stepId: 's1',
    title: 'a',
    dependsOn: [{ dependsOnStepId: 'nobody', kind: 'temporal' }],
  });
  assert.deepEqual(codes([dangling]), ['UNKNOWN_DEPENDENCY']);

  const cycleA = step({ stepId: 's1', title: 'a', dependsOn: [{ dependsOnStepId: 's2', kind: 'temporal' }] });
  const cycleB = step({ stepId: 's2', title: 'b', dependsOn: [{ dependsOnStepId: 's1', kind: 'temporal' }] });
  assert.deepEqual(codes([cycleA, cycleB]), ['CYCLIC_DEPENDENCY']);
});

/* ── Do-not-split ───────────────────────────────────────────────── */

test('SPLIT_ATOMIC fires when a do-not-split or atomic example carries steps', () => {
  for (const label of ['do_not_split', 'atomic'] as const) {
    const violations = codes([sourced('s1', 'Book the venue'), sourced('s2', 'send the invitations')], {
      label,
    });
    assert.ok(
      violations.includes('SPLIT_ATOMIC'),
      `${label} with steps must report SPLIT_ATOMIC, got ${violations.join(', ')}`,
    );
  }
});

/* ── Audit policy ───────────────────────────────────────────────── */

test('no violation detail repeats raw source text', () => {
  const leaky = [
    step({
      stepId: 's1',
      title: 'Book the venue',
      sourceSpans: [{ start: 0, end: 14, text: 'Cancel the venue' }],
      inferred: false,
    }),
    sourced('s2', 'send the invitations', { statedOwner: 'Sarah', statedTiming: 'tomorrow' }),
    step({ stepId: 's3', title: 'Book the venue', inferred: false }),
  ];
  const result = validateDecompositionExample(example({ expectedSteps: leaky }));
  assert.ok(result.violations.length >= 3);

  for (const violation of result.violations) {
    for (const secret of ['Book the venue', 'send the invitations', 'Sarah', 'tomorrow', 'Cancel the venue']) {
      assert.ok(
        !violation.detail.includes(secret),
        `${violation.code} leaked ${JSON.stringify(secret)} into an audit-visible detail: ${violation.detail}`,
      );
    }
  }
});

test('every violation is attributed to a step id or explicitly to the proposal', () => {
  const result = validateDecompositionExample(
    example({
      label: 'do_not_split',
      expectedSteps: [sourced('s1', 'Book the venue'), step({ stepId: 's2', title: '  ' })],
    }),
  );
  const byCode = new Map(result.violations.map((violation) => [violation.code, violation.stepId] as const));
  assert.equal(byCode.get('EMPTY_STEP'), 's2', 'a step-level finding names its step');
  assert.equal(byCode.get('SPLIT_ATOMIC'), null, 'SPLIT_ATOMIC is a finding about the example, not a step');
});

/* ── The shape #27 checks proposals with ───────────────────────── */

test('validateProposedSteps applies the same rules without an example wrapper', () => {
  const produced: readonly DecompositionStepProposal[] = [
    sourced('s1', 'Book the venue'),
    step({ stepId: 's2', title: 'and' }),
  ];
  const observed: readonly DecompositionViolationCode[] = validateProposedSteps(
    SOURCE,
    produced,
    'multi_step',
  ).map((violation) => violation.code);
  assert.deepEqual(observed, ['CONJUNCTION_ONLY']);
});

/* ── M3: overlap is about the example, not about a pair of steps ── */

test('SPAN_OVERLAP fires when one step claims the same source text twice', () => {
  // "Source segments are exact and non-overlapping" is unqualified. A step
  // double-claiming its own text is a duplicated segment, and coveredCodeUnits
  // unions the duplication away so no metric would ever notice it.
  const doubled = step({
    stepId: 's1',
    title: 'Book the venue by Friday',
    sourceSpans: [span(SOURCE, 'Book the venue by Friday'), span(SOURCE, 'by Friday')],
    inferred: false,
  });
  assert.deepEqual(codes([doubled]), ['SPAN_OVERLAP']);
});

test('one step may still cite two disjoint spans', () => {
  // The reason sourceSpans is a list at all: a step stated across discontinuous
  // parts of one sentence. Widening the overlap check must not break this.
  const discontinuous = step({
    stepId: 's1',
    title: 'Book the venue … to Omar',
    sourceSpans: [span(SOURCE, 'Book the venue'), span(SOURCE, 'to Omar')],
    inferred: false,
  });
  assert.deepEqual(codes([discontinuous]), []);
});

/* ── H3: SPLIT_ATOMIC is the over-split direction only ──────────── */

test('SPLIT_ATOMIC does not fire for a multi_step example carrying too few steps', () => {
  // The contract text is "a commitment marked do-not-split was split anyway",
  // and #27 cannot reach the other direction: DecomposedProposal.steps is typed
  // [Step, Step, ...Step[]], so a sub-two-step decomposition is unrepresentable.
  // Emitting a shared code #27 can never emit would make the cross-track
  // comparison disagree over data neither side considers broken. The underlying
  // defect is still caught, as a corpus issue — see datasetCorpus.test.ts.
  const result = validateDecompositionExample(
    example({ label: 'multi_step', expectedSteps: [sourced('s1', 'Book the venue')] }),
  );
  assert.deepEqual(result.violations.map((violation) => violation.code), []);
  assert.equal(result.valid, false, 'still invalid — as a corpus defect');
  assert.deepEqual(
    result.corpusIssues.map((issue) => issue.code),
    ['DXC031'],
  );
});

test('an empty proposal produces no violation at all', () => {
  // The metrics module relied on a guard clause to stop the old under-split
  // direction from firing here. With SPLIT_ATOMIC narrowed, the guard is gone
  // and this is what makes its removal safe.
  assert.deepEqual(validateProposedSteps(SOURCE, [], 'multi_step'), []);
  assert.deepEqual(validateProposedSteps(SOURCE, [], 'do_not_split'), []);
});

/* ── L3: an empty string is not a claim ─────────────────────────── */

test('an empty statedTiming or statedOwner is refused rather than silently passing', () => {
  // indexOf('') is 0, so an empty string "occurs verbatim" in every source text
  // and slips through the invention check. It is neither a real claim nor null.
  assert.deepEqual(codes([sourced('s1', 'Book the venue', { statedTiming: '' })]), ['INVENTED_TIMING']);
  assert.deepEqual(codes([sourced('s1', 'Book the venue', { statedOwner: '' })]), ['INVENTED_OWNER']);
  assert.deepEqual(codes([sourced('s1', 'Book the venue', { statedOwner: '   ' })]), ['INVENTED_OWNER']);
});
