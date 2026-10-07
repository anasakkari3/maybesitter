/**
 * M2b Task B, criterion 3 (Spoken corrections — condition 1, M2B-R2-004,
 * M2B-A-003) and the correction half of 3b (M2B-REV2-005): with `spoken: true`
 * the model may fix an obvious mishearing in a title and must report it; the
 * server keeps only corrections that pass the contract (single token, a
 * whole-token unique occurrence in the message, applied at a recorded token
 * position in the title, ≤ 3, server-minted unique ids) and drops the rest —
 * never the item. `rejectCorrectionIds` restores `from` at the recorded
 * position and removes only those corrections; `text` and
 * `rejectCorrectionIds` never together; after a title change a correction
 * survives only if its recorded span still holds `to`.
 *
 * The scripted model reports `corrections: [{ from, to }]` on its item — see
 * `modelCorrections` in support.ts for why that shape is this gate's
 * assumption.
 *
 * Acceptance gate written independently of the builder: every test here must
 * fail on d93a9a2b for the reason its criterion names. A "dropped" case alone
 * would pass there (nothing is ever kept), so each one is paired with a valid
 * correction in the same report that must be kept.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TOMORROW,
  assertEditInvalid,
  beginModel,
  beginRules,
  chat,
  edit,
  editOf,
  editRaw,
  end,
  itemById,
  itemWith,
  lineOf,
  modelFirstAnswer,
  modelCorrections,
  modelItem,
  show,
  type Correction,
  type Item,
} from './support.ts';

const REPLY = 'فهمت: تطلع عالسوق بكرا الساعة 5 المسا. أكّد من تحت.';
const TWO_WORDS_MESSAGE = 'لازم الطلع عالسوق وجيب خبس بكرا الساعة 5 المسا';
const TWO_WORDS_TITLE = 'اطلع عالسوق وجيب خبز';

function spokenModel(title: string, corrections: Array<[string, string]>, extra: Record<string, unknown> = {}): string {
  return beginModel(modelFirstAnswer(REPLY, 'propose', [
    modelItem(title, TOMORROW, '17:00', { kind: 'commitment', ...modelCorrections(...corrections), ...extra }),
  ]));
}

function correctionsOf(item: Item): Correction[] {
  return Array.isArray(item.corrections) ? item.corrections : [];
}

function assertWellFormed(corrections: Correction[], label: string): void {
  for (const correction of corrections) {
    assert.equal(typeof correction.id, 'string', `${label}: a correction without an id`);
    assert.ok(correction.id.length > 0, `${label}: an empty correction id`);
    assert.ok(/^\S+$/.test(correction.from) && /^\S+$/.test(correction.to), `${label}: a correction that is not one word each side: ${show(correction)}`);
  }
  assert.equal(new Set(corrections.map((correction) => correction.id)).size, corrections.length, `${label}: correction ids repeat`);
}

test('B3 corrections: a valid spoken correction is kept — one { id, from, to }, a server-minted id, the corrected word in the title', async () => {
  const uid = spokenModel('اطلع عالسوق', [['الطلع', 'اطلع']]);
  try {
    const body = await chat(uid, 'لازم الطلع عالسوق بكرا الساعة 5 المسا', { locale: 'ar', spoken: true });
    assert.equal(body.engine, 'model');
    const item = itemWith(body.proposal, 'عالسوق');
    assert.equal(item.title, 'اطلع عالسوق');
    const corrections = correctionsOf(item);
    assert.equal(corrections.length, 1, `the valid correction was not kept: ${show(item)}`);
    assert.deepEqual({ from: corrections[0]!.from, to: corrections[0]!.to }, { from: 'الطلع', to: 'اطلع' });
    assertWellFormed(corrections, 'the valid correction');
  } finally {
    end();
  }
});

const DROPPED: Array<{ label: string; message: string; bad: [string, string] }> = [
  { label: 'a substring, not a whole word of the message', message: TWO_WORDS_MESSAGE, bad: ['طلع', 'اطلع'] },
  { label: 'an empty word', message: TWO_WORDS_MESSAGE, bad: ['', 'اطلع'] },
  { label: 'two words, not one', message: TWO_WORDS_MESSAGE, bad: ['الطلع عالسوق', 'اطلع عالسوق'] },
  { label: 'a word the person said twice', message: 'لازم الطلع عالسوق وجيب خبس، وبعدها الطلع عالبيت بكرا الساعة 5 المسا', bad: ['الطلع', 'اطلع'] },
  { label: 'a correction not applied in the title', message: TWO_WORDS_MESSAGE, bad: ['الطلع', 'اروح'] },
  { label: 'a word the person never said', message: TWO_WORDS_MESSAGE, bad: ['الروح', 'اطلع'] },
];

for (const { label, message, bad } of DROPPED) {
  test(`B3 corrections: ${label} is dropped, the item and the valid correction beside it are kept`, async () => {
    const uid = spokenModel(TWO_WORDS_TITLE, [bad, ['خبس', 'خبز']]);
    try {
      const body = await chat(uid, message, { locale: 'ar', spoken: true });
      const item = itemWith(body.proposal, 'عالسوق');
      assert.equal(item.title, TWO_WORDS_TITLE, 'the item was changed or dropped with the bad correction');
      const kept = correctionsOf(item).map((correction) => [correction.from, correction.to]);
      assert.deepEqual(kept, [['خبس', 'خبز']], `not exactly the valid correction kept: ${show(item.corrections)}`);
      assertWellFormed(correctionsOf(item), label);
    } finally {
      end();
    }
  });
}

test('B3 corrections: a duplicated report is one correction with one id; more than three keep at most three', async () => {
  let uid = spokenModel(TWO_WORDS_TITLE, [['خبس', 'خبز'], ['خبس', 'خبز']]);
  try {
    const body = await chat(uid, TWO_WORDS_MESSAGE, { locale: 'ar', spoken: true });
    const corrections = correctionsOf(itemWith(body.proposal, 'عالسوق'));
    assert.equal(corrections.length, 1, `a duplicated correction is not one: ${show(corrections)}`);
    assertWellFormed(corrections, 'the duplicate');
  } finally {
    end();
  }
  uid = spokenModel('اطلع عالسوق وجيب خبز وحليب وبيض', [['الطلع', 'اطلع'], ['خبس', 'خبز'], ['حليف', 'حليب'], ['بيظ', 'بيض']]);
  try {
    const body = await chat(uid, 'لازم الطلع عالسوق وجيب خبس وحليف وبيظ بكرا الساعة 5 المسا', { locale: 'ar', spoken: true });
    const item = itemWith(body.proposal, 'عالسوق');
    const corrections = correctionsOf(item);
    assert.ok(corrections.length >= 1 && corrections.length <= 3, `four corrections gave ${corrections.length} (want 1..3): ${show(corrections)}`);
    assertWellFormed(corrections, 'four reported');
  } finally {
    end();
  }
});

test('B3 corrections: two items each carry their own corrections, with ids unique across the proposal (a model id is not reused)', async () => {
  const uid = beginModel(modelFirstAnswer('فهمت: تطلع عالسوق وتتصل بأمك بكرا. أكّد من تحت.', 'propose', [
    modelItem('اطلع عالسوق', TOMORROW, '17:00', { kind: 'commitment', corrections: [{ id: 'c1', from: 'الطلع', to: 'اطلع' }] }),
    modelItem('اتصل بأمي', TOMORROW, '21:00', { kind: 'commitment', corrections: [{ id: 'c1', from: 'اتسل', to: 'اتصل' }] }),
  ]));
  try {
    const body = await chat(uid, 'لازم الطلع عالسوق بكرا الساعة 5 المسا، ولازم اتسل بأمي بكرا الساعة 9 المسا', { locale: 'ar', spoken: true });
    const market = correctionsOf(itemWith(body.proposal, 'عالسوق'));
    const call = correctionsOf(itemWith(body.proposal, 'بأمي'));
    assert.deepEqual(market.map((correction) => [correction.from, correction.to]), [['الطلع', 'اطلع']], `the first item's correction: ${show(market)}`);
    assert.deepEqual(call.map((correction) => [correction.from, correction.to]), [['اتسل', 'اتصل']], `the second item's correction: ${show(call)}`);
    assertWellFormed([...market, ...call], 'across items');
  } finally {
    end();
  }
});

test('B3 corrections: only when spoken — kept with spoken: true, none without it or with spoken: false, none on the rules path', async () => {
  const pair: Array<[string, string]> = [['الطلع', 'اطلع']];
  const message = 'لازم الطلع عالسوق بكرا الساعة 5 المسا';
  let uid = spokenModel('اطلع عالسوق', pair);
  try {
    const body = await chat(uid, message, { locale: 'ar', spoken: true });
    assert.equal(correctionsOf(itemWith(body.proposal, 'عالسوق')).length, 1, 'the spoken correction was not kept (the control for this test)');
  } finally {
    end();
  }
  for (const spoken of [undefined, false]) {
    uid = spokenModel('اطلع عالسوق', pair);
    try {
      const body = await chat(uid, message, { locale: 'ar', ...(spoken === undefined ? {} : { spoken }) });
      assert.equal(correctionsOf(itemWith(body.proposal, 'عالسوق')).length, 0, `a typed message (spoken ${spoken}) carries corrections`);
    } finally {
      end();
    }
  }
  uid = beginRules();
  try {
    const body = await chat(uid, message, { locale: 'ar', spoken: true });
    for (const item of body.proposal?.items ?? []) assert.equal(correctionsOf(item).length, 0, 'the rules path invented a correction');
  } finally {
    end();
  }
});

test('B3 corrections: rejecting one of two restores its word at its position and keeps the other, with its id', async () => {
  const uid = spokenModel(TWO_WORDS_TITLE, [['الطلع', 'اطلع'], ['خبس', 'خبز']]);
  try {
    const first = await chat(uid, TWO_WORDS_MESSAGE, { locale: 'ar', spoken: true });
    const item = itemWith(first.proposal, 'عالسوق');
    const corrections = correctionsOf(item);
    assert.equal(corrections.length, 2, `the two corrections were not kept: ${show(item)}`);
    const go = corrections.find((correction) => correction.from === 'الطلع')!;
    const bread = corrections.find((correction) => correction.from === 'خبس')!;
    const rejected = await edit(uid, first.conversationId, editOf(first, { itemId: item.itemId }, { rejectCorrectionIds: [go.id] }));
    const after = itemById(rejected.proposal, item.itemId);
    assert.equal(after.title, 'الطلع عالسوق وجيب خبز', `the rejected word was not restored in place: ${after.title}`);
    assert.deepEqual(after.corrections, [bread], 'the other correction was not kept as it was');
    assert.ok(lineOf(rejected.proposal, item.itemId).text.includes('الطلع'), 'the understood line kept the rejected correction');
  } finally {
    end();
  }
});

for (const [label, message, title, restored] of [
  ['the first of two', 'لازم الطلع عالسوق وبعدين اطلع عالبيت بكرا الساعة 5 المسا', 'اطلع عالسوق وبعدين اطلع عالبيت', 'الطلع عالسوق وبعدين اطلع عالبيت'],
  ['the second of two', 'لازم اطلع عالسوق وبعدين الطلع عالبيت بكرا الساعة 5 المسا', 'اطلع عالسوق وبعدين اطلع عالبيت', 'اطلع عالسوق وبعدين الطلع عالبيت'],
] as const) {
  test(`B3 corrections: a rejected correction whose word occurs twice in the title is restored at its recorded position (${label})`, async () => {
    const uid = spokenModel(title, [['الطلع', 'اطلع']]);
    try {
      const first = await chat(uid, message, { locale: 'ar', spoken: true });
      const item = itemWith(first.proposal, 'عالسوق');
      const [correction] = correctionsOf(item);
      assert.ok(correction, `the correction was not kept: ${show(item)}`);
      const rejected = await edit(uid, first.conversationId, editOf(first, { itemId: item.itemId }, { rejectCorrectionIds: [correction!.id] }));
      assert.equal(itemById(rejected.proposal, item.itemId).title, restored, 'the word was restored at the wrong occurrence');
      assert.equal(correctionsOf(itemById(rejected.proposal, item.itemId)).length, 0, 'the rejected correction is still listed');
    } finally {
      end();
    }
  });
}

test('B3 corrections: text and rejectCorrectionIds in one patch → edit_invalid; an unknown correction id → edit_invalid', async () => {
  const uid = spokenModel('اطلع عالسوق', [['الطلع', 'اطلع']]);
  try {
    const first = await chat(uid, 'لازم الطلع عالسوق بكرا الساعة 5 المسا', { locale: 'ar', spoken: true });
    const item = itemWith(first.proposal, 'عالسوق');
    const [correction] = correctionsOf(item);
    assert.ok(correction, `the correction was not kept: ${show(item)}`);
    assertEditInvalid(
      await editRaw(uid, first.conversationId, editOf(first, { itemId: item.itemId }, { text: 'روح عالسوق', rejectCorrectionIds: [correction!.id] })),
      'text with rejectCorrectionIds',
    );
    assertEditInvalid(
      await editRaw(uid, first.conversationId, editOf(first, { itemId: item.itemId }, { rejectCorrectionIds: ['no-such-correction'] })),
      'an unknown correction id',
    );
  } finally {
    end();
  }
});

test('B3b corrections: after a words edit a correction survives only where its recorded span still holds its word', async () => {
  const uid = spokenModel('اطلع عالسوق', [['الطلع', 'اطلع']]);
  try {
    const first = await chat(uid, 'لازم الطلع عالسوق بكرا الساعة 5 المسا', { locale: 'ar', spoken: true });
    const item = itemWith(first.proposal, 'عالسوق');
    const [correction] = correctionsOf(item);
    assert.ok(correction, `the correction was not kept: ${show(item)}`);
    const kept = await edit(uid, first.conversationId, editOf(first, { itemId: item.itemId }, { text: 'اطلع عالسوق هلق' }));
    assert.deepEqual(itemById(kept.proposal, item.itemId).corrections, [correction], 'a words edit that left the span in place dropped the correction');
    const moved = await edit(uid, first.conversationId, editOf(kept, { itemId: item.itemId }, { text: 'بكرا اطلع عالسوق' }));
    assert.equal(correctionsOf(itemById(moved.proposal, item.itemId)).length, 0, 'a correction whose span moved survived (its word still occurs elsewhere)');
  } finally {
    end();
  }
});
