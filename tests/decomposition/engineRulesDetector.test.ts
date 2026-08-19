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
    'תקנה כרטיסים ותסדר מלון.',
  ]) {
    assert.equal(detectSteps(text).steps.length, 2, `failed to split: ${text}`);
  }
});

/**
 * Negative probes aimed at the detector's weakest assumption, not its strongest.
 *
 * The first version of this detector decided "an action starts here" from the
 * first *letter* — Arabic `ا أ إ آ ت ي ن س`, Hebrew `ת י א נ ל`. Those letters
 * open a large share of ordinary indefinite nouns (`سلطة`, `نسخة`, `תפריט`,
 * `תזכורת`) and Hebrew `ל` is the preposition "to" at least as often as an
 * infinitive prefix, so the rule fired on conjoined *objects* and invented a
 * step. The golden `do_not_split` rows did not catch it: each happens to put a
 * definite article after the clitic or leave a single-token recipient, and a
 * surname (`ולדני כהן`) dissolves both mitigations.
 *
 * These sentences are all one action with a conjoined object or recipient. They
 * exist to fail if positive verb evidence is ever weakened back into a prefix
 * guess.
 */
const CONJOINED_OBJECTS: readonly string[] = [
  'جهز العشاء وسلطة خضراء.',
  'أرسل التقرير ونسخة للمدير.',
  'اتصل بسارة وأحمد الغامدي.',
  'اشتر خبزا وحليبا طازجا.',
  'احجز تذكرتين وغرفة فندق.',
  'راجع العقد وملاحظات المحامي.',
  'أرسل الدعوة ورسالة تذكير.',
  'תשלח מתנה לשרה ולדני כהן.',
  'תזמין שולחן ותפריט מיוחד.',
  'תשלח מייל ותזכורת קצרה.',
  'תקנה לחם וחלב טרי.',
  'תבדוק את החוזה ואת הנספחים.',
  'תזמין כיסא ושולחן קטן.',
  'תארגן פגישה ושיחת המשך.',
  'أرسل الفاتورة وصورة عنها.',
  'اتصل بالمكتب ورقم الطوارئ.',
  'תזמין פיצה ושתייה קרה.',
  'תשלח הודעה לדני ולרונית לוי.',
  'Buy bread and butter for the weekend.',
  'Send the contract and a cover letter.',
];

test('a conjoined object or recipient is never a step boundary, in Arabic or Hebrew', () => {
  const split = CONJOINED_OBJECTS
    .map((text) => ({ text, steps: detectSteps(text).steps }))
    .filter((row) => row.steps.length > 0);
  assert.deepEqual(
    split.map((row) => `${row.text} -> ${row.steps.map((step) => step.title).join(' | ')}`),
    [],
    'these are one action each; a split here invents an errand the user never described',
  );
});

test('an explicit sequencing marker is never overruled by a short tail', () => {
  // A minimum-phrase rule guards against conjoined objects, but a sequencing
  // marker is the strongest evidence the detector has. Discarding the whole
  // split because the second clause is one word told the caller the commitment
  // was one action, which is a different and false claim.
  for (const [text, expected] of [
    ['أرسل الرسالة ثم اتصل.', ['أرسل الرسالة', 'اتصل']],
    ['תשלח את המייל ואז תתקשר.', ['תשלח את המייל', 'תתקשר']],
    ['Email the client, then call.', ['Email the client', 'call']],
  ] as const) {
    assert.deepEqual(detectSteps(text).steps.map((step) => step.title), expected, text);
  }
});

test('a short tail after a mere conjunction drops that boundary and keeps the rest', () => {
  // Rejecting the offending boundary, not the whole split: the `ثم` boundary
  // survives while the trailing one-word conjunct is folded back in.
  const detected = detectSteps('احجز القاعة ثم أرسل الدعوات وعمر.');
  assert.deepEqual(detected.steps.map((step) => step.title), ['احجز القاعة', 'أرسل الدعوات وعمر']);
});

test('an Arabic verb carrying an attached object pronoun is still a verb', () => {
  // Arabic suffixes the object pronoun onto the verb: `ارسله` is `ارسل` + `ه`.
  // A lexicon matched on the surface form alone misses every transitive
  // instruction phrased that way, which is most of them.
  for (const [text, expected] of [
    ['اكتب التقرير وبعدها ارسله للمدير.', ['اكتب التقرير', 'ارسله للمدير']],
    ['اكتب الرسالة وارسلها للعميل.', ['اكتب الرسالة', 'ارسلها للعميل']],
  ] as const) {
    assert.deepEqual(detectSteps(text).steps.map((step) => step.title), expected, text);
  }

  // `جهز العرض واطبعه.` deliberately does *not* split: the pronoun is
  // recognised, but the clause it opens is one token beside a mere conjunction,
  // which the minimum-clause rule folds back. Under-split by design — the same
  // rule is what keeps `وعمر` and `ולעומר` from becoming errands.
  assert.deepEqual(detectSteps('جهز العرض واطبعه.').steps, []);
});

test('stripping an object pronoun cannot turn a noun into a boundary', () => {
  // The stripping only ever *adds* a lexicon match, so the guard that matters
  // is that no conjoined object gains one.
  for (const text of CONJOINED_OBJECTS) {
    assert.deepEqual(detectSteps(text).steps, [], text);
  }
});

test('many short clauses do not make the detector quadratic', () => {
  // Pass 2 used to drop one undersized boundary per iteration and re-cut the
  // whole source each time, so a comma-separated list of one-word clauses cost
  // O(n^2): 100 KB blocked the event loop for 36 seconds, all of it spent
  // proving there was nothing to split. Decomposition runs rules-first by
  // default, so this needed no model and no hostile provider — one request
  // stalled the process.
  //
  // The bound is generous on purpose: the point is the growth curve, not a
  // millisecond target. The old code needed ~36,000 ms here.
  const text = `buy${', buy'.repeat(20000)}`;
  const started = Date.now();
  const detected = detectSteps(text);
  const elapsed = Date.now() - started;

  assert.deepEqual(detected.steps, [], 'one-word clauses are conjoined objects, not steps');
  assert.ok(elapsed < 2000, `detectSteps took ${elapsed} ms on ${text.length} characters`);
});

test('dropping one boundary still lets a neighbouring boundary survive', () => {
  // The one-at-a-time re-cut existed for a reason: folding a short clause into
  // its neighbour can make the *next* boundary legal, and a single pass that
  // dropped every undersized boundary at once would lose that split. The sweep
  // that replaced it has to keep the same answer.
  assert.deepEqual(
    detectSteps('احجز القاعة ثم أرسل الدعوات وعمر.').steps.map((step) => step.title),
    ['احجز القاعة', 'أرسل الدعوات وعمر'],
  );
  assert.deepEqual(
    detectSteps('Email the client, then call.').steps.map((step) => step.title),
    ['Email the client', 'call'],
  );
});

test('markers that never merge do not make the detector quadratic either', () => {
  // The previous fix linearised pass 2 but left pass 1: when no marker is
  // accepted the cursor never advances, so the "is there content before this
  // marker?" scan re-walked the whole prefix for every marker — visible only
  // when that prefix is entirely trimmable. `TRIMMABLE` includes `.` while
  // `PUNCTUATION_BOUNDARY` does not, so `,.` pairs never merge and every comma
  // rescans everything. 10 KB (the boundary's own cap) cost 195 ms.
  //
  // Fixing the case and not the class is what let this survive, so the check is
  // now derived from the token index, which cannot rescan by construction.
  for (const [length, budget] of [[10000, 400], [100000, 1500]] as const) {
    const text = ',.'.repeat(length / 2);
    const started = Date.now();
    const detected = detectSteps(text);
    const elapsed = Date.now() - started;
    assert.deepEqual(detected.steps, []);
    assert.ok(elapsed < budget, `${text.length} characters took ${elapsed} ms`);
  }
});

test('a prefix of pure punctuation still does not hide real content', () => {
  // The token-index check has to agree with the character scan it replaced:
  // content before a marker still blocks the marker from opening step one.
  assert.deepEqual(
    detectSteps('...Book the venue, then send the invitations.').steps.map((step) => step.title),
    ['Book the venue', 'send the invitations'],
  );
  assert.deepEqual(detectSteps(', then send the invitations.').steps, []);
});
