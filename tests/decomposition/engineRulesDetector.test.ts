/**
 * The rules detector, judged against the shared golden set.
 *
 * These assertions compare whole step lists with `deepEqual` rather than
 * spot-checking titles, because the parts most likely to be quietly wrong are
 * the ones a title check cannot see: the offsets, the timing lifted out of the
 * span, and the dependency edges. A `deepEqual` against ground truth written by
 * someone else is the only version of this test that can fail for a reason the
 * detector's author did not anticipate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectSteps } from '../../lib/decomposition/engine/rulesDetector.ts';
import { validateDecomposition } from '../../lib/decomposition/engine/validator.ts';
import { DECOMPOSITION_GOLDEN, goldenById, goldenByLabel } from '../fixtures/decompositionGolden.ts';

test('English: sequencing marker splits and orders, plain conjunction splits without ordering', () => {
  const example = goldenById('en-multi-wedding');
  const detected = detectSteps(example.sourceText);
  assert.deepEqual(detected.steps, example.expectedSteps);
});

test('Arabic: the prefixed clitic "و" is a boundary with no whitespace to split on', () => {
  const example = goldenById('ar-multi-wedding');
  const detected = detectSteps(example.sourceText);
  assert.deepEqual(detected.steps, example.expectedSteps);
});

test('Hebrew: comma and the prefixed clitic "ו" both bound steps, and a repeated verb binds to its own clause', () => {
  const example = goldenById('he-multi-event');
  const detected = detectSteps(example.sourceText);
  assert.deepEqual(detected.steps, example.expectedSteps);
});

test('Mixed script: a step spans both scripts and its stated timing stays verbatim', () => {
  const example = goldenById('ar-en-multi-invoice');
  const detected = detectSteps(example.sourceText);
  assert.deepEqual(detected.steps, example.expectedSteps);
});

test('atomic commitments produce no steps at all, not a one-step split', () => {
  for (const example of goldenByLabel('atomic')) {
    const detected = detectSteps(example.sourceText);
    assert.deepEqual(detected.steps, [], `${example.exampleId} must not split`);
  }
});

test('do-not-split commitments survive the clitic handling that makes the multi-step rows splittable', () => {
  for (const example of goldenByLabel('do_not_split')) {
    const detected = detectSteps(example.sourceText);
    assert.deepEqual(detected.steps, [], `${example.exampleId} must not split`);
  }
});

test('every emitted span round-trips against its own source text, in every script', () => {
  for (const example of DECOMPOSITION_GOLDEN) {
    for (const step of detectSteps(example.sourceText).steps) {
      assert.ok(step.sourceSpans.length > 0, `${example.exampleId}/${step.stepId} cited no source`);
      for (const span of step.sourceSpans) {
        assert.equal(
          example.sourceText.slice(span.start, span.end),
          span.text,
          `${example.exampleId}/${step.stepId} span does not round-trip`,
        );
      }
    }
  }
});

test('detector output passes its own validator on every golden row', () => {
  for (const example of DECOMPOSITION_GOLDEN) {
    const detected = detectSteps(example.sourceText);
    assert.deepEqual(
      validateDecomposition({ sourceText: example.sourceText, steps: detected.steps }),
      [],
      `${example.exampleId} produced an invalid decomposition`,
    );
  }
});

test('the detector never invents an owner, because no rule can tell an owner from a recipient', () => {
  for (const example of DECOMPOSITION_GOLDEN) {
    for (const step of detectSteps(example.sourceText).steps) {
      assert.equal(step.statedOwner, null, `${example.exampleId}/${step.stepId} invented an owner`);
    }
  }
});

test('a bare clitic boundary is scored below an explicit sequencing marker', () => {
  const clitic = detectSteps('احجز القاعة واطلب الكعكة.');
  const sequenced = detectSteps('احجز القاعة ثم اطلب الكعكة.');
  assert.equal(clitic.steps.length, 2);
  assert.equal(sequenced.steps.length, 2);
  assert.ok(
    clitic.confidence < sequenced.confidence,
    `clitic ${clitic.confidence} should score below sequencing marker ${sequenced.confidence}`,
  );
});

test('confidence is zero when nothing split, so a caller cannot read a refusal as a confident single step', () => {
  const detected = detectSteps('Call the dentist.');
  assert.deepEqual(detected.steps, []);
  assert.equal(detected.confidence, 0);
});

test('blank input produces no steps rather than a step made of whitespace', () => {
  for (const blank of ['', '   ', '\n\t']) {
    assert.deepEqual(detectSteps(blank).steps, []);
  }
});

/**
 * Held-out cases: sentences deliberately absent from the golden set.
 *
 * The golden rows can only prove the detector handles the traps someone already
 * thought of. These probe the same *shapes* with different words, which is the
 * only way to tell a rule from a memorised fixture.
 */
test('a conjoined final word is a second object, not a second step, in every script', () => {
  for (const [text, why] of [
    ['Buy bread and butter.', 'English noun conjunction'],
    ['اتصل بسارة وعمر.', 'Arabic clitic before a proper noun'],
    // The Hebrew trap: `ל` is both the infinitive prefix and the preposition
    // "to", so `ולעומר` ("and to Omar") has the exact surface shape of a
    // conjoined infinitive verb. Nothing in the morphology separates them.
    ['תשלח מכתב לשרה ולעומר.', 'Hebrew clitic before a preposition + proper noun'],
  ] as const) {
    assert.deepEqual(detectSteps(text).steps, [], `over-split: ${why}`);
  }
});

test('unseen sentences with the same shape as the golden rows still split', () => {
  for (const text of [
    'Buy the tickets then book the hotel.',
    'نظف البيت واغسل الصحون.',
    'تقنה כרטיסים ותסדר מלון.'.replace('تقنה', 'תקנה'),
  ]) {
    assert.equal(detectSteps(text).steps.length, 2, `failed to split: ${text}`);
  }
});
