/**
 * Arabic and Hebrew ordering — the named acceptance criterion for #27.
 *
 * The claim being tested is narrow and worth stating precisely: **spans are
 * logical, not visual.** Arabic and Hebrew render right-to-left, so the step a
 * reader sees first is the one with the *highest* offsets, and any code that
 * tried to "fix" ordering for display would produce spans that no longer index
 * their own text. So the assertions here are about storage order and exact
 * offsets, and one of them deliberately embeds bidi control characters to check
 * that a directional mark cannot shift a span off the words it claims.
 *
 * The clitic boundary gets its own assertions because it is the case a
 * whitespace splitter cannot express at all: the boundary falls *inside* a
 * token, one character in, and the conjunction character must end up in no
 * step's span — if it did, the step would begin with "and".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectSteps } from '../../lib/decomposition/engine/rulesDetector.ts';
import { proposeDecomposition } from '../../lib/decomposition/engine/index.ts';
import { DECOMPOSITION_GOLDEN, goldenById } from '../fixtures/decompositionGolden.ts';

test('steps are emitted in increasing storage order, which for RTL text is the reverse of reading order', () => {
  for (const example of DECOMPOSITION_GOLDEN) {
    const starts = detectSteps(example.sourceText).steps.map((step) => step.sourceSpans[0].start);
    const ascending = starts.slice().sort((left, right) => left - right);
    assert.deepEqual(starts, ascending, `${example.exampleId} emitted steps out of storage order`);
  }
});

test('emitted spans never overlap and never share a character', () => {
  for (const example of DECOMPOSITION_GOLDEN) {
    const steps = detectSteps(example.sourceText).steps;
    for (let index = 1; index < steps.length; index += 1) {
      assert.ok(
        steps[index - 1].sourceSpans[0].end <= steps[index].sourceSpans[0].start,
        `${example.exampleId} spans ${index - 1} and ${index} overlap`,
      );
    }
  }
});

test('Arabic: the clitic conjunction falls inside a token and lands in no step span', () => {
  const example = goldenById('ar-multi-wedding');
  const cliticIndex = example.sourceText.indexOf('واطلب');
  assert.ok(cliticIndex > 0);

  const steps = detectSteps(example.sourceText).steps;
  assert.equal(steps.length, 3);
  // The step after the clitic starts exactly one code unit past the `و`, which
  // is the boundary a word-level splitter cannot produce.
  assert.equal(steps[2].sourceSpans[0].start, cliticIndex + 1);
  for (const step of steps) {
    const span = step.sourceSpans[0];
    assert.ok(
      cliticIndex < span.start || cliticIndex >= span.end,
      'the conjunction character must not be inside any step span',
    );
    assert.equal(span.text.startsWith('و'), false, 'no step may begin with the conjunction');
  }
});

test('Hebrew: the clitic conjunction falls inside a token and lands in no step span', () => {
  const example = goldenById('he-multi-event');
  const cliticIndex = example.sourceText.indexOf('ותזמין');
  assert.ok(cliticIndex > 0);

  const steps = detectSteps(example.sourceText).steps;
  assert.equal(steps.length, 3);
  assert.equal(steps[2].sourceSpans[0].start, cliticIndex + 1);
  for (const step of steps) {
    assert.equal(step.sourceSpans[0].text.startsWith('ו'), false);
  }
});

test('Hebrew: a verb repeated in two clauses binds each step to its own clause', () => {
  const example = goldenById('he-multi-event');
  const steps = detectSteps(example.sourceText).steps;
  const first = example.sourceText.indexOf('תזמין');
  const second = example.sourceText.indexOf('תזמין', first + 1);
  assert.ok(second > first, 'test setup: the verb should occur twice');
  assert.equal(steps[0].sourceSpans[0].start, first);
  assert.equal(steps[2].sourceSpans[0].start, second);
});

test('sequencing markers themselves belong to no step', () => {
  for (const [exampleId, marker] of [
    ['ar-multi-wedding', 'ثم'],
    ['ar-en-multi-invoice', 'وبعدها'],
    ['en-multi-wedding', 'then'],
  ] as const) {
    const example = goldenById(exampleId);
    for (const step of detectSteps(example.sourceText).steps) {
      assert.equal(
        step.sourceSpans[0].text.includes(marker),
        false,
        `${exampleId}: "${marker}" leaked into a step title`,
      );
    }
  }
});

test('the RTL noun-phrase clitic is not a boundary, so the commitment stays one step', async () => {
  for (const [exampleId, phrase] of [
    ['ar-nosplit-terms', 'والأحكام'],
    ['he-nosplit-terms', 'וההגבלות'],
  ] as const) {
    const example = goldenById(exampleId);
    assert.ok(example.sourceText.includes(phrase));
    const proposal = await proposeDecomposition({
      proposalId: `p-${exampleId}`,
      commitmentId: `c-${exampleId}`,
      sourceText: example.sourceText,
    });
    assert.equal(proposal.outcome, 'atomic', `${exampleId} was split`);
    assert.equal(proposal.outcome === 'atomic' && proposal.reason, 'not_decomposable');
  }
});

test('embedded bidi control characters do not shift a span off its own text', () => {
  const marked = `‏احجز القاعة‏ ثم ‏أرسل الدعوات‏`;
  const steps = detectSteps(marked).steps;
  assert.equal(steps.length, 2);
  for (const step of steps) {
    const span = step.sourceSpans[0];
    assert.equal(marked.slice(span.start, span.end), span.text);
    assert.equal(/[‎‏]/.test(span.text), false, 'a directional mark leaked into a title');
  }
  assert.deepEqual(steps.map((step) => step.title), ['احجز القاعة', 'أرسل الدعوات']);
});

test('an RTL decomposition survives the whole engine with its offsets intact', async () => {
  const example = goldenById('ar-multi-wedding');
  const proposal = await proposeDecomposition({
    proposalId: 'p-rtl',
    commitmentId: 'c-rtl',
    sourceText: example.sourceText,
  });
  assert.equal(proposal.outcome, 'decomposed');
  if (proposal.outcome !== 'decomposed') return;
  assert.deepEqual(proposal.steps, example.expectedSteps);
  for (const step of proposal.steps) {
    for (const span of step.sourceSpans) {
      assert.equal(proposal.sourceText.slice(span.start, span.end), span.text);
    }
  }
});
