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
    title: 'Book the venue to Omar',
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

/* ── UNSOURCED_STEP, shape two: a title no span supports ────────── */

test('UNSOURCED_STEP fires for a title its own spans do not source', () => {
  // The cross-track divergence case: the span round-trips perfectly and the
  // title is something else entirely. Every other provenance check passes.
  const mismatched = step({
    stepId: 's1',
    title: 'and',
    sourceSpans: [span(SOURCE, 'Book the venue')],
    inferred: false,
  });
  assert.deepEqual(codes([mismatched]), ['CONJUNCTION_ONLY', 'UNSOURCED_STEP']);
});

test('a fabricated title alongside a valid span is unsourced', () => {
  // The attack this closes on #27's side: a hostile model provider returns
  // spans that check out and titles that were never in the text. The span
  // round-tripped; the title it purported to source did not.
  for (const fabricated of ['Wire $9,000 to account 12345', 'Delete all backups']) {
    const forged = step({
      stepId: 's1',
      title: fabricated,
      sourceSpans: [span(SOURCE, 'Book the venue')],
      inferred: false,
    });
    assert.deepEqual(codes([forged]), ['UNSOURCED_STEP'], `did not catch ${JSON.stringify(fabricated)}`);
  }
});

test('the two UNSOURCED_STEP shapes are both reachable and both distinct', () => {
  // Pinned separately so the distinction cannot rot into one check. The code
  // covers a step with no span that does not admit to being inferred, and a
  // step whose spans do not source its title. They are different defects
  // wearing one name, and only the first was implemented here before.
  const noSpanAtAll = step({ stepId: 's1', title: 'Pay the deposit', inferred: false });
  assert.deepEqual(codes([noSpanAtAll]), ['UNSOURCED_STEP']);

  const titleNotSourced = step({
    stepId: 's1',
    title: 'Pay the deposit',
    sourceSpans: [span(SOURCE, 'Book the venue')],
    inferred: false,
  });
  assert.deepEqual(codes([titleNotSourced]), ['UNSOURCED_STEP']);

  // Distinct details, so a maintainer can tell which shape they have.
  const detailOf = (steps: readonly DecompositionStepProposal[]) =>
    validateDecompositionExample(
      example({ expectedSteps: [...steps, step({ stepId: 'filler', title: 'Pay the deposit' })] }),
    ).violations[0].detail;
  assert.notEqual(detailOf([noSpanAtAll]), detailOf([titleNotSourced]));
});

test('a title exactly equal to its span text is sourced', () => {
  assert.deepEqual(codes([sourced('s1', 'Book the venue')]), []);
});

test('a title assembled from two disjoint spans is sourced', () => {
  const assembled = step({
    stepId: 's1',
    title: 'Book the venue to Omar',
    sourceSpans: [span(SOURCE, 'Book the venue'), span(SOURCE, 'to Omar')],
    inferred: false,
  });
  assert.deepEqual(codes([assembled]), []);
});

test('overlapping spans still source the title they cover', () => {
  // Coverage is a union, so a step whose spans overlap has covered exactly the
  // merged range. The duplication is SPAN_OVERLAP's finding; charging the same
  // step a second code for it would report one defect twice.
  const overlapping = step({
    stepId: 's1',
    title: 'Book the venue by Friday',
    sourceSpans: [span(SOURCE, 'Book the venue by Friday'), span(SOURCE, 'by Friday')],
    inferred: false,
  });
  assert.deepEqual(codes([overlapping]), ['SPAN_OVERLAP']);
});

test('an inferred step is not held to its (absent) spans', () => {
  assert.deepEqual(codes([step({ stepId: 's1', title: 'Pay the deposit', inferred: true })]), []);
});

test('a step whose span is unusable is not also reported as unsourced', () => {
  // The span failed exactness or range, so its text cannot be trusted to decide
  // anything about the title. Reporting both sends a maintainer looking for a
  // title problem when the defect is an offset — the same reason an
  // out-of-range span is not also a mismatch.
  const forgedSpan = step({
    stepId: 's1',
    title: 'Book the venue',
    sourceSpans: [{ start: 0, end: 14, text: 'Cancel the venue' }],
    inferred: false,
  });
  assert.deepEqual(codes([forgedSpan]), ['SPAN_MISMATCH']);

  const outOfRange = step({
    stepId: 's1',
    title: 'Book the venue',
    sourceSpans: [{ start: 0, end: SOURCE.length + 10, text: SOURCE }],
    inferred: false,
  });
  assert.deepEqual(codes([outOfRange]), ['SPAN_OUT_OF_RANGE']);
});

test('whitespace between spans and around a title does not decide provenance', () => {
  const padded = step({
    stepId: 's1',
    title: '  Book the venue   to Omar  ',
    sourceSpans: [span(SOURCE, 'Book the venue'), span(SOURCE, 'to Omar')],
    inferred: false,
  });
  assert.deepEqual(codes([padded]), []);
});

test('a blank title beside a valid span is EMPTY_STEP alone, not also unsourced', () => {
  // A blank title is EMPTY_STEP; asking whether nothing is sourced is not a
  // meaningful question, and two codes for one defect sends a maintainer
  // looking for a provenance problem where the step simply has no title.
  //
  // This also preserves the cross-track agreement the merge-owned test already
  // measured on the EMPTY_STEP fixture: #26 and #27 both report EMPTY_STEP
  // alone there today, and widening UNSOURCED_STEP must not silently change
  // that. If #27's title check does fire on a blank title, this is the test
  // that will surface the disagreement rather than letting it merge.
  const blankButSpanned = step({
    stepId: 's1',
    title: '   ',
    sourceSpans: [span(SOURCE, 'Book the venue')],
    inferred: false,
  });
  assert.deepEqual(codes([blankButSpanned]), ['EMPTY_STEP']);
});

/* ── The audit clause covers step ids, not just source text ─────── */

const HOSTILE_ID = 'Tell my therapist I relapsed on Tuesday, account 4111-1111-1111-1111';

test('no violation detail interpolates a raw step id', () => {
  // The contract says `detail` never contains raw user text and this module
  // repeats the claim for itself; both were false. A stepId is caller-supplied,
  // so on the engine-facing path this function documents — proposals from a
  // model — it is exactly as untrusted as the source text.
  //
  // Five codes leaked it, one more than the review found: SPAN_OVERLAP
  // interpolates *two* ids.
  const hostile = (overrides: Partial<DecompositionStepProposal> = {}) =>
    step({ stepId: HOSTILE_ID, ...overrides });

  const cases: readonly (readonly DecompositionStepProposal[])[] = [
    [hostile({ title: '   ' }), step({ stepId: 'z', title: 'Pay the deposit' })],
    [hostile({ title: 'Pay the deposit', inferred: false }), step({ stepId: 'z', title: 'Pay the deposit' })],
    [
      step({ stepId: 'a', title: 'a', dependsOn: [{ dependsOnStepId: HOSTILE_ID, kind: 'temporal' }] }),
      step({ stepId: 'z', title: 'Pay the deposit' }),
    ],
    [hostile({ title: 'a' }), hostile({ title: 'b' })],
    [
      hostile({ title: 'Book the venue by Friday', inferred: false, sourceSpans: [span(SOURCE, 'Book the venue by Friday')] }),
      step({ stepId: 'other', title: 'by Friday', inferred: false, sourceSpans: [span(SOURCE, 'by Friday')] }),
    ],
    // SPAN_OVERLAP has two branches and they build their message separately.
    // The case above is the cross-step one; this is the self-overlap one, which
    // a first mutation pass showed was leaking unexercised.
    [
      hostile({
        title: 'Book the venue by Friday',
        inferred: false,
        sourceSpans: [span(SOURCE, 'Book the venue by Friday'), span(SOURCE, 'by Friday')],
      }),
      step({ stepId: 'z', title: 'Pay the deposit' }),
    ],
  ];

  let seen = 0;
  for (const steps of cases) {
    const violations = validateProposedSteps(SOURCE, steps, 'multi_step');
    assert.ok(violations.length > 0, 'each case must actually produce a violation');
    for (const violation of violations) {
      seen += 1;
      assert.equal(
        violation.detail.includes('4111') || violation.detail.includes('therapist'),
        false,
        `${violation.code} leaked a raw step id into an audit-visible detail: ${violation.detail}`,
      );
    }
  }
  assert.ok(seen >= 6, `expected to exercise at least six violations, saw ${seen}`);
});

test('the stepId field still carries the real id, because the contract says it does', () => {
  // Only `detail` is under the audit clause. `stepId` is typed to carry the id
  // a violation is attributed to, and a consumer needs it to find the step.
  const violations = validateProposedSteps(
    SOURCE,
    [step({ stepId: HOSTILE_ID, title: '   ' }), step({ stepId: 'z', title: 'Pay the deposit' })],
    'multi_step',
  );
  assert.equal(violations[0].code, 'EMPTY_STEP');
  assert.equal(violations[0].stepId, HOSTILE_ID);
});

test('a benign step id stays readable in the detail', () => {
  // Redacting every id would make the messages useless for the ordinary case,
  // which is every id this repository actually uses.
  const violations = validateProposedSteps(
    SOURCE,
    [step({ stepId: 's1', title: '   ' }), step({ stepId: 's2', title: 'Pay the deposit' })],
    'multi_step',
  );
  assert.ok(violations[0].detail.includes("'s1'"), violations[0].detail);
});

/* ── M2: SPLIT_ATOMIC means split, and one step is not a split ──── */

test('SPLIT_ATOMIC does not fire for a single step', () => {
  // The contract's wording is "a commitment marked do-not-split was *split*
  // anyway". One step is not a split, and #27 fires only above one — so on this
  // case #26 was the side that was wrong.
  const one = [sourced('s1', 'Book the venue')];
  for (const label of ['atomic', 'do_not_split'] as const) {
    assert.deepEqual(
      validateProposedSteps(SOURCE, one, label).map((violation) => violation.code),
      [],
      `${label} with one step must not report SPLIT_ATOMIC`,
    );
  }
});

test('SPLIT_ATOMIC still fires above one step', () => {
  const two = [sourced('s1', 'Book the venue'), sourced('s2', 'send the invitations')];
  for (const label of ['atomic', 'do_not_split'] as const) {
    assert.deepEqual(validateProposedSteps(SOURCE, two, label).map((violation) => violation.code), [
      'SPLIT_ATOMIC',
    ]);
  }
});

test('a single step on an unsplittable row is still caught, as a corpus defect', () => {
  // Aligning the shared code must not silently drop the finding: the contract
  // says expectedSteps is empty for atomic and do_not_split, so one step there
  // is bad ground truth. It moves to this module's namespace for the same
  // reason the under-split direction did — #27 cannot represent it, so a shared
  // code would diverge again.
  const result = validateDecompositionExample(
    example({ label: 'do_not_split', expectedSteps: [sourced('s1', 'Book the venue')] }),
  );
  assert.deepEqual(result.violations.map((violation) => violation.code), []);
  assert.equal(result.valid, false);
  assert.deepEqual(result.corpusIssues.map((issue) => issue.code), ['DXC032']);
});
