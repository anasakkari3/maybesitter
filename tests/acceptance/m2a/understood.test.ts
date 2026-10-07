/**
 * M2a Task B, criterion 2 (Understood) and 4a's locale half — conditions 5
 * and 6 of the 2026-10-06 audit: say what was understood before the cards,
 * one grouped understanding for five points, in the order they were said.
 *
 * Contract v3: `proposal.understood[]` names every item and every seed exactly
 * once, a seed point carries its seed's kind, the order is the order of
 * speech, each `text` ≤ 160, plain, no link, no saved-claim. It is built after
 * shaping and after every clarification, and the stored order is
 * authoritative across later clarifications.
 *
 * Acceptance gate written independently of the builder: every test here must
 * fail on 0620a7b2 for the reason its criterion names.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TOMORROW,
  assertUnderstoodValid,
  beginModel,
  beginRules,
  chat,
  clarify,
  end,
  lineLanguage,
  modelAnswer,
  modelItem,
  understoodKeywords,
} from './support.ts';

/** Five points, interleaved kinds, comma-joined the way people talk. */
const FIVE = 'لازم اتصل بأمي بكرا الساعة 5 المسا، وعم بفكر أسافر الصيف الجاي، وبدي أدفع فاتورة الكهربا يوم الخميس الساعة 10 الصبح، وحابب أنزل بالوزن، ومستني رد من المدير على الإجازة';
/** One keyword per point, in the order said. */
const FIVE_ORDER = ['أمي', 'أسافر', 'فاتورة', 'الوزن', 'المدير'];

test('B2 understood (rules): five interleaved points give one grouped understanding — five lines, every item and seed once, in the order said', async () => {
  const uid = beginRules();
  try {
    const body = await chat(uid, FIVE, { locale: 'ar' });
    assert.ok(body.proposal, 'no proposal');
    assertUnderstoodValid(body.proposal, 'five points');
    assert.equal(body.proposal!.understood!.length, 5, 'not one understood line per point');
    assert.deepEqual(understoodKeywords(body.proposal!, FIVE_ORDER), FIVE_ORDER, 'understood is not in the order said');
    assert.deepEqual(
      body.proposal!.understood!.map((point) => point.kind),
      ['commitment', 'consideration', 'commitment', 'possible_goal', 'waiting_for'],
    );
  } finally {
    end();
  }
});

test('B2 understood (model path): the model\'s shuffled list is put back in the order said, through item→seed conversion', async () => {
  // The model answers in its own order; speech order is tracked through
  // extraction, fan-out, dedup and the item→seed conversion.
  const uid = beginModel(modelAnswer(
    'فهمت خمس أشياء. أكّد من تحت.',
    'propose',
    [
      modelItem('أدفع فاتورة الكهربا', TOMORROW, '10:00', { kind: 'commitment' }),
      modelItem('رد من المدير على الإجازة', null, null, { kind: 'waiting_for' }),
      modelItem('اتصل بأمي', TOMORROW, '17:00', { kind: 'commitment' }),
      modelItem('أنزل بالوزن', null, null, { kind: 'possible_goal' }),
      modelItem('أسافر الصيف الجاي', null, null, { kind: 'consideration' }),
    ],
  ));
  try {
    const body = await chat(uid, FIVE, { locale: 'ar' });
    assert.equal(body.engine, 'model');
    assert.ok(body.proposal, 'no proposal');
    assertUnderstoodValid(body.proposal, 'model five points');
    assert.equal(body.proposal!.understood!.length, 5);
    assert.deepEqual(understoodKeywords(body.proposal!, FIVE_ORDER), FIVE_ORDER, 'understood follows the model, not the person');
  } finally {
    end();
  }
});

test('B2 understood (rules): a single commitment carries a one-line understanding', async () => {
  const uid = beginRules();
  try {
    const body = await chat(uid, 'لازم اتصل بأمي بكرا الساعة 5 المسا', { locale: 'ar' });
    assert.ok(body.proposal && body.proposal.items.length === 1, `not one item: ${JSON.stringify(body.proposal)}`);
    const points = assertUnderstoodValid(body.proposal, 'one commitment');
    assert.equal(points.length, 1);
    assert.equal(points[0]!.kind, 'commitment');
    assert.equal(lineLanguage(points[0]!.text), 'ar', `the line is not in Arabic: ${points[0]!.text}`);
  } finally {
    end();
  }
});

test('B2 understood (rules): validation holds on adversarial words — a link, an overlong clause, a saved-claim', async () => {
  const long = `لازم أكتب تقرير طويل كتير عن ${'المشروع والميزانية والخطة والفريق '.repeat(8)}بكرا الساعة 5 المسا`;
  const messages = [
    'لازم اقرأ المقال على www.example.com بكرا الساعة 5 المسا',
    long,
    'لازم ضفتها وحفظت الملف بكرا الساعة 5 المسا',
    'Call mom tomorrow at 5pm, I saved it already',
  ];
  for (const message of messages) {
    const uid = beginRules();
    try {
      const body = await chat(uid, message);
      // Validated before sending: ≤160, no link, no saved-claim, every item once.
      assertUnderstoodValid(body.proposal, `«${message.slice(0, 40)}…»`);
    } finally {
      end();
    }
  }
});

test('B2 understood (model path): a model title carrying a link or a saved-claim never reaches an understood line', async () => {
  const uid = beginModel(modelAnswer(
    'Call mom tomorrow at 5pm. Confirm below.',
    'propose',
    [modelItem('Call mom — I have added it to your calendar, see www.example.com', TOMORROW, '17:00', { kind: 'commitment' })],
  ));
  try {
    const body = await chat(uid, 'Call mom tomorrow at 5pm', { locale: 'en' });
    assert.equal(body.engine, 'model');
    const points = assertUnderstoodValid(body.proposal, 'adversarial model title');
    for (const point of points) assert.equal(lineLanguage(point.text), 'en', `an English proposal got a line in another language: ${point.text}`);
  } finally {
    end();
  }
});

test('B2 understood (rules): the stored order is authoritative after a clarification — same lines, same order, every item once', async () => {
  const uid = beginRules();
  try {
    const first = await chat(uid, 'موعد الدكتور بكرا الساعة 4، وعم بفكر أسافر الصيف الجاي، ولازم اتصل بأمي بكرا الساعة 5 المسا', { locale: 'ar' });
    assert.ok(first.proposal, 'no proposal');
    const order = ['الدكتور', 'أسافر', 'أمي'];
    assert.deepEqual(understoodKeywords(first.proposal!, order), order, 'the first turn is not in the order said');
    const asking = first.proposal!.items.find((item) => item.needsClarification && item.clarification);
    assert.ok(asking, 'the doctor\'s 4 o\'clock asks nothing');
    const answered = await clarify(uid, first.proposal!, asking!, { optionId: 'pm' });
    assertUnderstoodValid(answered, 'after the clarification');
    assert.deepEqual(understoodKeywords(answered, order), order, 'a clarification reordered understood');
    assert.deepEqual(
      answered.understood!.map((point) => (point.kind === 'commitment' ? point.itemId : point.seedItemId)),
      first.proposal!.understood!.map((point) => (point.kind === 'commitment' ? point.itemId : point.seedItemId)),
      'the clarification changed which things understood names',
    );
  } finally {
    end();
  }
});

test('B2 understood (model path): proposalStore persists understood — an off-topic next turn reads back the same lines', async () => {
  const uid = beginModel(
    modelAnswer('فهمت: تتصل بأمك بكرا الساعة 5 المسا، وبتفكر تسافر. أكّد من تحت.', 'propose', [
      modelItem('اتصل بأمي', TOMORROW, '17:00', { kind: 'commitment' }),
      modelItem('أسافر الصيف الجاي', null, null, { kind: 'consideration' }),
    ]),
    modelAnswer('العفو! في إشي تاني؟', 'chat', [
      modelItem('اتصل بأمي', TOMORROW, '17:00', { kind: 'commitment' }),
    ]),
  );
  try {
    const first = await chat(uid, 'لازم اتصل بأمي بكرا الساعة 5 المسا، وعم بفكر أسافر الصيف الجاي', { locale: 'ar' });
    assertUnderstoodValid(first.proposal, 'first turn');
    const second = await chat(uid, 'شكرا', { conversationId: first.conversationId, locale: 'ar' });
    assert.ok(second.proposal, 'the stored proposal was lost');
    assert.equal(second.proposal!.proposalId, first.proposal!.proposalId);
    assert.deepEqual(second.proposal!.understood, first.proposal!.understood, 'the stored proposal came back without its understood lines');
  } finally {
    end();
  }
});

test('B4a understood (rules): the proposal\'s language survives a clarification — an English proposal stays English after the card\'s answer', async () => {
  // The clarify route carries no locale; the resolved response locale is
  // persisted with the proposal and passed to the clarification finalizer.
  const uid = beginRules();
  try {
    const first = await chat(uid, 'Dentist appointment tomorrow at 4', { locale: 'en' });
    const before = assertUnderstoodValid(first.proposal, 'English proposal');
    for (const point of before) assert.equal(lineLanguage(point.text), 'en', `an English proposal got: ${point.text}`);
    const asking = first.proposal!.items.find((item) => item.needsClarification && item.clarification)!;
    const answered = await clarify(uid, first.proposal!, asking, { optionId: 'pm' });
    const after = assertUnderstoodValid(answered, 'after the clarification');
    for (const point of after) assert.equal(lineLanguage(point.text), 'en', `the clarification switched the language: ${point.text}`);
  } finally {
    end();
  }
});

test('B4a understood (model path): an Arabic message with the app in English — the clarification keeps the proposal\'s language', async () => {
  const uid = beginModel(modelAnswer('Dentist tomorrow at 4. Morning or evening?', 'ask', [
    modelItem('Dentist appointment', TOMORROW, null, { kind: 'commitment', missingFields: ['time'] }),
  ]));
  try {
    const first = await chat(uid, 'موعد الدكتور بكرا الساعة 4', { locale: 'en' });
    const before = assertUnderstoodValid(first.proposal, 'cross-language proposal');
    const languages = before.map((point) => lineLanguage(point.text));
    const asking = first.proposal!.items.find((item) => item.needsClarification && item.clarification);
    assert.ok(asking, `nothing asks: ${JSON.stringify(first.proposal!.items)}`);
    const answered = await clarify(uid, first.proposal!, asking!, { optionId: 'pm' });
    const after = assertUnderstoodValid(answered, 'after the clarification');
    assert.deepEqual(after.map((point) => lineLanguage(point.text)), languages, 'the clarification changed the understood language');
  } finally {
    end();
  }
});

test.todo('B2 understood (model path): a model-written understood text that fails validation (URL, "I saved", wrong time, overlong, wrong language) is replaced per point by deterministic server text — needs the builders\' model field name for the line, which the plan does not fix');
test.todo('B2 understood: Firestore emulator round trip of `understood` and the persisted locale, and a legacy stored proposal (no source ordinals) answered with no `understood` — emulator suite, not this in-process gate');
