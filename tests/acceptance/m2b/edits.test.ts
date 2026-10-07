/**
 * M2b Task B, criterion 2 (Deterministic edits keeping ids — M2-A-R2-001,
 * M2B-R2-006, M2B-REV-003/004, v4 M2B-A-R3-002): the atomic patch `kind`,
 * `text`, `time: { at, timeZone }` applied with no model call on both engines
 * to the conversation's current stored proposal; ids and order kept; a kind
 * change moves the point between items and seeds keeping its id and its place
 * in `understood`; an explicit commitment is never demoted by intent markers;
 * a seed made a commitment with no time asks the time; a ranged item keeps its
 * length; words pass the plain-text rule; the normalization matrix holds; the
 * existing confirm saves the edited version; one human-readable user turn and
 * an acknowledgement are recorded.
 *
 * Acceptance gate written independently of the builder: every test here must
 * fail on d93a9a2b for the reason its criterion names — there an edit is
 * refused as a missing message.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CALL_AND_TRAVEL,
  DOCTOR,
  LATER,
  PAST_INSTANT,
  RANGE_AND_TRAVEL,
  SEED_KINDS,
  TOMORROW,
  TZ,
  assertEditInvalid,
  assertOneTurnPair,
  assertUnderstoodValid,
  at,
  beginModel,
  beginRules,
  chat,
  confirmRaw,
  edit,
  editOf,
  editRaw,
  end,
  itemById,
  itemWith,
  lineOf,
  modelFirstAnswer,
  modelCalls,
  modelItem,
  revisionOf,
  savedCommitments,
  seedById,
  seedWith,
  show,
  takeModelDown,
  understoodIds,
  type Answer,
} from './support.ts';

const time = (instant: string | null, timeZone: string = TZ) => ({ time: { at: instant, timeZone } });

async function confirmItems(uid: string, answer: Answer, itemIds: string[]): Promise<void> {
  const result = await confirmRaw(uid, { proposalId: answer.proposal!.proposalId, itemIds, revision: revisionOf(answer.proposal) });
  assert.equal(result.status, 200, `confirm answered ${result.status}: ${show(result.body)}`);
}

/* ── kind ─────────────────────────────────────────────────────────── */

for (const kind of SEED_KINDS) {
  test(`B2 edit (rules): kind commitment→${kind} keeps the id as the seed's id and its place in understood; ${kind}→commitment brings it back as an item asking the time`, async () => {
    const uid = beginRules();
    try {
      const first = await chat(uid, CALL_AND_TRAVEL, { locale: 'ar' });
      const call = itemWith(first.proposal, 'اتصل بأمي');
      const travel = seedWith(first.proposal, 'أسافر');
      const order = understoodIds(first.proposal);
      assert.deepEqual(order, [call.itemId, travel.seedItemId]);

      const asSeed = await edit(uid, first.conversationId, editOf(first, { itemId: call.itemId }, { kind }));
      assertOneTurnPair(first, asSeed, `commitment→${kind}`);
      assert.equal(asSeed.proposal!.proposalId, first.proposal!.proposalId, 'the edit minted a new proposal');
      assert.equal(asSeed.proposal!.items.some((item) => item.itemId === call.itemId), false, `the item is still an item after kind ${kind}`);
      const seed = seedById(asSeed.proposal, call.itemId);
      assert.equal(seed.kind, kind);
      assert.ok(seed.summary.includes('اتصل بأمي'), `the seed is not in the item's words: ${seed.summary}`);
      assert.equal(seedById(asSeed.proposal, travel.seedItemId).kind, 'consideration', 'the untouched seed changed');
      assert.deepEqual(understoodIds(asSeed.proposal, `after →${kind}`), order, 'the point lost its place in understood');

      const back = await edit(uid, first.conversationId, editOf(asSeed, { seedItemId: call.itemId }, { kind: 'commitment' }));
      const item = itemById(back.proposal, call.itemId);
      assert.ok(item.title.includes('اتصل بأمي'), `the item is not in the seed's words: ${item.title}`);
      assert.equal(back.proposal!.seeds.some((candidate) => candidate.seedItemId === call.itemId), false, 'the seed is still a seed');
      assert.equal(item.resolvedTime, null, 'a seed made a commitment got a time nobody gave in the patch');
      assert.equal(item.needsClarification, true, 'a seed made a commitment with no time does not ask the time');
      assert.ok(item.clarification, 'a seed made a commitment with no time carries no time question');
      assert.deepEqual(understoodIds(back.proposal, `after ${kind}→commitment`), order, 'the point lost its place in understood');
    } finally {
      end();
    }
  });
}

test('B2 edit (rules): kind consideration→commitment keeps the id, asks the time, and «عم بفكر» does not demote it again', async () => {
  const uid = beginRules();
  try {
    const first = await chat(uid, CALL_AND_TRAVEL, { locale: 'ar' });
    const call = itemWith(first.proposal, 'اتصل بأمي');
    const travel = seedWith(first.proposal, 'أسافر');
    const promoted = await edit(uid, first.conversationId, editOf(first, { seedItemId: travel.seedItemId }, { kind: 'commitment' }));
    assert.equal(promoted.proposal!.seeds.length, 0, `the consideration is still a seed: ${show(promoted.proposal!.seeds)}`);
    const item = itemById(promoted.proposal, travel.seedItemId);
    assert.ok(item.title.includes('أسافر'), `the new item is not in the seed's words: ${item.title}`);
    assert.equal(item.needsClarification, true, 'the new commitment with no time does not ask the time');
    assert.ok(item.clarification, 'the new commitment carries no time question');
    assert.equal(itemById(promoted.proposal, call.itemId).resolvedTime, call.resolvedTime, 'the untouched item moved');
    assert.deepEqual(understoodIds(promoted.proposal), [call.itemId, travel.seedItemId], 'the point lost its place in understood');
    assert.equal(lineOf(promoted.proposal, travel.seedItemId).kind, 'commitment');
  } finally {
    end();
  }
});

test('B2 edit (rules): kind consideration→idea keeps the seed id; only the kind moves, in the seed and its understood line', async () => {
  const uid = beginRules();
  try {
    const first = await chat(uid, CALL_AND_TRAVEL, { locale: 'ar' });
    const travel = seedWith(first.proposal, 'أسافر');
    const edited = await edit(uid, first.conversationId, editOf(first, { seedItemId: travel.seedItemId }, { kind: 'idea' }));
    const seed = seedById(edited.proposal, travel.seedItemId);
    assert.equal(seed.kind, 'idea');
    assert.equal(seed.summary, travel.summary, 'the words changed with the kind');
    assert.equal(lineOf(edited.proposal, travel.seedItemId).kind, 'idea', 'the understood line kept the old kind');
    assert.equal(edited.proposal!.items.length, 1);
  } finally {
    end();
  }
});

test('B2 edit (model path): edits are applied with no model call, and still with the model down (cap reached)', async () => {
  const uid = beginModel(modelFirstAnswer('فهمت: تتصل بأمك بكرا الساعة 5 المسا، وبتفكر تسافر الصيف الجاي. أكّد من تحت.', 'propose', [
    modelItem('اتصل بأمي', TOMORROW, '17:00', { kind: 'commitment' }),
    modelItem('أسافر الصيف الجاي', null, null, { kind: 'consideration' }),
  ]));
  try {
    const first = await chat(uid, CALL_AND_TRAVEL, { locale: 'ar' });
    assert.equal(first.engine, 'model');
    const calls = modelCalls();
    const call = itemWith(first.proposal, 'اتصل بأمي');
    const travel = seedWith(first.proposal, 'أسافر');
    const one = await edit(uid, first.conversationId, editOf(first, { itemId: call.itemId }, { text: 'اتصل بأختي', ...time(at(LATER, '18:00')) }));
    assert.equal(modelCalls(), calls, 'a structured edit called the model');
    assert.equal(itemById(one.proposal, call.itemId).resolvedTime, at(LATER, '18:00'));
    takeModelDown();
    const two = await edit(uid, first.conversationId, editOf(one, { seedItemId: travel.seedItemId }, { kind: 'idea' }));
    assert.equal(modelCalls(), calls, 'a structured edit called the model');
    assert.equal(seedById(two.proposal, travel.seedItemId).kind, 'idea');
    assert.equal(itemById(two.proposal, call.itemId).title, 'اتصل بأختي', 'the second edit lost the first');
  } finally {
    end();
  }
});

/* ── target by id ─────────────────────────────────────────────────── */

test('B2 edit (model path): two items with the same title — each edit lands on the item its id names, the other is untouched', async () => {
  const uid = beginModel(modelFirstAnswer('فهمت: مرتين تتصل بأمك بكرا. أكّد من تحت.', 'propose', [
    modelItem('اتصل بأمي', TOMORROW, '17:00', { kind: 'commitment' }),
    modelItem('اتصل بأمي', TOMORROW, '21:00', { kind: 'commitment' }),
  ]));
  try {
    const first = await chat(uid, 'لازم اتصل بأمي بكرا الساعة 5 المسا، ولازم اتصل بأمي بكرا الساعة 9 المسا', { locale: 'ar' });
    const [early, late] = first.proposal!.items;
    assert.ok(early && late && early.title === late.title, `not two items with one title: ${show(first.proposal!.items)}`);
    const order = understoodIds(first.proposal);
    const moved = await edit(uid, first.conversationId, editOf(first, { itemId: late.itemId }, time(at(LATER, '20:00'))));
    assert.equal(itemById(moved.proposal, late.itemId).resolvedTime, at(LATER, '20:00'), 'the named item did not move');
    assert.equal(itemById(moved.proposal, early.itemId).resolvedTime, early.resolvedTime, 'the other item with the same title moved');
    const renamed = await edit(uid, first.conversationId, editOf(moved, { itemId: early.itemId }, { text: 'اتصل بأمي الصبح' }));
    assert.equal(itemById(renamed.proposal, early.itemId).title, 'اتصل بأمي الصبح');
    assert.equal(itemById(renamed.proposal, late.itemId).title, 'اتصل بأمي', 'the other item with the same title was renamed');
    assert.deepEqual(understoodIds(renamed.proposal), order, 'the edits reordered understood');
  } finally {
    end();
  }
});

/* ── words ────────────────────────────────────────────────────────── */

test('B2 edit (rules): words on an item change its title and its understood line; words on a seed change its summary and line', async () => {
  const uid = beginRules();
  try {
    const first = await chat(uid, CALL_AND_TRAVEL, { locale: 'ar' });
    const call = itemWith(first.proposal, 'اتصل بأمي');
    const travel = seedWith(first.proposal, 'أسافر');
    const one = await edit(uid, first.conversationId, editOf(first, { itemId: call.itemId }, { text: 'اتصل بأختي' }));
    assertOneTurnPair(first, one, 'the words edit');
    const item = itemById(one.proposal, call.itemId);
    assert.equal(item.title, 'اتصل بأختي');
    assert.equal(item.resolvedTime, call.resolvedTime, 'a words edit moved the time');
    const line = lineOf(one.proposal, call.itemId).text;
    assert.ok(line.includes('بأختي') && !line.includes('بأمي'), `the understood line kept the old words: ${line}`);
    const two = await edit(uid, first.conversationId, editOf(one, { seedItemId: travel.seedItemId }, { text: 'أسافر عالبحر' }));
    assert.equal(seedById(two.proposal, travel.seedItemId).summary, 'أسافر عالبحر');
    assert.ok(lineOf(two.proposal, travel.seedItemId).text.includes('عالبحر'), 'the seed\'s understood line kept the old words');
    assertUnderstoodValid(two.proposal);
  } finally {
    end();
  }
});

test('B2 edit (rules): words breaking the plain-text rule — a link, a control character, a saved-claim, 121 characters, blank — → edit_invalid, nothing changes', async () => {
  const uid = beginRules();
  try {
    const first = await chat(uid, CALL_AND_TRAVEL, { locale: 'ar' });
    const call = itemWith(first.proposal, 'اتصل بأمي');
    const bad: Array<[string, string]> = [
      ['a link', 'افتح https://example.com/x'],
      ['a bare domain', 'روح على evil.com'],
      ['a control character', 'اتصل\u0007 بأمي'],
      ['a newline', 'اتصل\nبأمي'],
      ['a saved-claim', 'حفظت الموعد'],
      ['121 characters', 'ا'.repeat(121)],
      ['blank', '   '],
    ];
    for (const [label, text] of bad) {
      assertEditInvalid(await editRaw(uid, first.conversationId, editOf(first, { itemId: call.itemId }, { text })), label);
    }
    // 120 characters is within the rule, and the proposal is still at the revision the person saw.
    const ok = await edit(uid, first.conversationId, editOf(first, { itemId: call.itemId }, { text: 'ب'.repeat(120) }));
    assert.equal(ok.proposal!.revision, 1, 'a refused words edit wrote a revision');
  } finally {
    end();
  }
});

/* ── time ─────────────────────────────────────────────────────────── */

test('B2 edit (rules): moving a ranged item keeps its length, and the confirm stores the moved start and end', async () => {
  const uid = beginRules();
  try {
    const first = await chat(uid, RANGE_AND_TRAVEL, { locale: 'ar' });
    const meeting = itemWith(first.proposal, 'اجتماع');
    assert.equal(meeting.endTime, at(TOMORROW, '20:00'), 'the base range is not 16:00–20:00');
    const moved = await edit(uid, first.conversationId, editOf(first, { itemId: meeting.itemId }, time(at(LATER, '10:00'))));
    const item = itemById(moved.proposal, meeting.itemId);
    assert.equal(item.resolvedTime, at(LATER, '10:00'));
    assert.equal(item.endTime, at(LATER, '14:00'), `the range did not keep its four hours: ${item.endTime}`);
    assert.equal(item.resolvedDate, LATER, 'resolvedDate was not recomputed');
    assert.equal(item.needsClarification, false);
    await confirmItems(uid, moved, [meeting.itemId]);
    const saved = await savedCommitments(uid);
    assert.equal(saved.length, 1);
    assert.equal(saved[0]!.timeSpec.dueAt, at(LATER, '10:00'), 'the confirm saved the old start');
    assert.equal(saved[0]!.timeSpec.endAt, at(LATER, '14:00'), 'the confirm saved the old end');
  } finally {
    end();
  }
});

test('B2 edit (rules): clearing a ranged item\'s time drops the time and the range; setting a time again brings no stale range back', async () => {
  const uid = beginRules();
  try {
    const first = await chat(uid, RANGE_AND_TRAVEL, { locale: 'ar' });
    const meeting = itemWith(first.proposal, 'اجتماع');
    const cleared = await edit(uid, first.conversationId, editOf(first, { itemId: meeting.itemId }, time(null)));
    const none = itemById(cleared.proposal, meeting.itemId);
    assert.equal(none.resolvedTime, null, 'the time was not cleared');
    assert.equal(none.endTime, undefined, 'the range survived the cleared time');
    assert.notEqual(cleared.proposal!.status, 'needs_clarification', 'a cleared time left the proposal asking');
    const again = await edit(uid, first.conversationId, editOf(cleared, { itemId: meeting.itemId }, time(at(LATER, '09:00'))));
    const set = itemById(again.proposal, meeting.itemId);
    assert.equal(set.resolvedTime, at(LATER, '09:00'));
    assert.equal(set.endTime, undefined, 'a cleared range came back with the new time');
  } finally {
    end();
  }
});

test('B2 edit (rules): time on a seed with no kind change → edit_invalid; kind commitment + time in one patch → a timed item, saved by the confirm in the seed\'s words', async () => {
  const uid = beginRules();
  try {
    const first = await chat(uid, CALL_AND_TRAVEL, { locale: 'ar' });
    const travel = seedWith(first.proposal, 'أسافر');
    assertEditInvalid(
      await editRaw(uid, first.conversationId, editOf(first, { seedItemId: travel.seedItemId }, time(at(LATER, '12:00')))),
      'a time on a seed',
    );
    const promoted = await edit(uid, first.conversationId, editOf(first, { seedItemId: travel.seedItemId }, { kind: 'commitment', ...time(at(LATER, '12:00')) }));
    const item = itemById(promoted.proposal, travel.seedItemId);
    assert.equal(item.resolvedTime, at(LATER, '12:00'), 'the time in the same patch was not applied');
    assert.equal(item.needsClarification, false, 'a commitment given its time still asks');
    assert.equal(item.clarification ?? null, null, 'a stale time question was left on the item');
    await confirmItems(uid, promoted, [travel.seedItemId]);
    const saved = await savedCommitments(uid);
    assert.equal(saved.length, 1, `not one saved commitment: ${show(saved)}`);
    assert.ok(saved[0]!.title.includes('أسافر'), `the saved commitment is not in the seed's words: ${saved[0]!.title}`);
    assert.equal(saved[0]!.timeSpec.dueAt, at(LATER, '12:00'));
  } finally {
    end();
  }
});

test('B2 edit (rules): a past instant, a non-instant, a date with no time, an impossible date or an unknown zone → edit_invalid, nothing changes', async () => {
  const uid = beginRules();
  try {
    const first = await chat(uid, CALL_AND_TRAVEL, { locale: 'ar' });
    const call = itemWith(first.proposal, 'اتصل بأمي');
    const bad: Array<[string, { at: string | null; timeZone: string }]> = [
      ['a past instant', { at: PAST_INSTANT, timeZone: TZ }],
      ['words, not an instant', { at: 'tomorrow at 5', timeZone: TZ }],
      ['a date with no time', { at: LATER, timeZone: TZ }],
      ['an impossible date', { at: '2030-02-30T10:00:00.000Z', timeZone: TZ }],
      ['an unknown zone', { at: at(LATER, '18:00'), timeZone: 'Mars/Olympus' }],
    ];
    for (const [label, value] of bad) {
      assertEditInvalid(await editRaw(uid, first.conversationId, editOf(first, { itemId: call.itemId }, { time: value })), label);
    }
    const ok = await edit(uid, first.conversationId, editOf(first, { itemId: call.itemId }, time(at(LATER, '18:00'))));
    assert.equal(ok.proposal!.revision, 1, 'a refused time edit wrote a revision');
  } finally {
    end();
  }
});

test('B2 edit (rules): setting the time of an item asking «الصبح ولا المسا» clears the question and recomputes the status', async () => {
  const uid = beginRules();
  try {
    const first = await chat(uid, DOCTOR, { locale: 'ar' });
    assert.equal(first.proposal!.status, 'needs_clarification');
    const doctor = itemWith(first.proposal, 'الدكتور');
    assert.ok(doctor.needsClarification && doctor.clarification, 'the doctor item does not ask');
    const set = await edit(uid, first.conversationId, editOf(first, { itemId: doctor.itemId }, time(at(LATER, '16:00'))));
    const item = itemById(set.proposal, doctor.itemId);
    assert.equal(item.resolvedTime, at(LATER, '16:00'));
    assert.equal(item.resolvedDate, LATER);
    assert.equal(item.needsClarification, false, 'the item still asks after its time was set');
    assert.equal(item.clarification ?? null, null, 'a stale question was left on the item');
    assert.equal(set.proposal!.status, 'proposed', 'the proposal status was not recomputed');
    assert.ok(!/الصبح ولا المسا/.test(set.reply), `the acknowledgement still asks morning or evening: ${set.reply}`);
  } finally {
    end();
  }
});

test('B2 edit (rules): clearing the time of an item asking «الصبح ولا المسا» leaves no stale question', async () => {
  const uid = beginRules();
  try {
    const first = await chat(uid, DOCTOR, { locale: 'ar' });
    const doctor = itemWith(first.proposal, 'الدكتور');
    const oldQuestion = doctor.clarification!.questionId;
    const cleared = await edit(uid, first.conversationId, editOf(first, { itemId: doctor.itemId }, time(null)));
    const item = itemById(cleared.proposal, doctor.itemId);
    assert.equal(item.resolvedTime, null);
    assert.notEqual(item.clarification?.questionId, oldQuestion, 'the old «الصبح ولا المسا» question is still on the item');
    assert.equal(item.needsClarification, false, 'an item the person said has no time still asks');
    assert.notEqual(cleared.proposal!.status, 'needs_clarification', 'the proposal status was not recomputed');
  } finally {
    end();
  }
});

test('B2 edit (rules): a combined words + time patch is applied together; one invalid field applies nothing', async () => {
  const uid = beginRules();
  try {
    const first = await chat(uid, CALL_AND_TRAVEL, { locale: 'ar' });
    const call = itemWith(first.proposal, 'اتصل بأمي');
    assertEditInvalid(
      await editRaw(uid, first.conversationId, editOf(first, { itemId: call.itemId }, { text: 'اتصل بأختي', time: { at: PAST_INSTANT, timeZone: TZ } })),
      'words with a past time',
    );
    const both = await edit(uid, first.conversationId, editOf(first, { itemId: call.itemId }, { text: 'اتصل بأختي', ...time(at(LATER, '19:30')) }));
    const item = itemById(both.proposal, call.itemId);
    assert.equal(item.title, 'اتصل بأختي', 'the words were not applied (or the refused patch half-applied)');
    assert.equal(item.resolvedTime, at(LATER, '19:30'));
    assert.equal(both.proposal!.revision, 1, 'the refused patch wrote a revision');
    assertOneTurnPair(first, both, 'the combined patch');
  } finally {
    end();
  }
});

test('B2 edit (rules): the confirm after a words + time edit saves the edited title and time', async () => {
  const uid = beginRules();
  try {
    const first = await chat(uid, CALL_AND_TRAVEL, { locale: 'ar' });
    const call = itemWith(first.proposal, 'اتصل بأمي');
    const edited = await edit(uid, first.conversationId, editOf(first, { itemId: call.itemId }, { text: 'اتصل بأختي', ...time(at(LATER, '19:30')) }));
    await confirmItems(uid, edited, [call.itemId]);
    const saved = await savedCommitments(uid);
    assert.deepEqual(saved.map((commitment) => [commitment.title, commitment.timeSpec.dueAt]), [['اتصل بأختي', at(LATER, '19:30')]]);
  } finally {
    end();
  }
});

test('B2 edit (rules): a time patch recomputes the item\'s clashes — onto a saved commitment it clashes, moved away it does not', async () => {
  // Everything in this test lives in January 2030 so the person's saved day is
  // inside the schedule the chat reads (from the request's reference time).
  const reference = '2030-01-09T08:00:00.000Z';
  const uid = beginRules();
  try {
    const saved = await chat(uid, 'لازم اتصل بأمي بكرا الساعة 5 المسا', { locale: 'ar', referenceTime: reference });
    const call = itemWith(saved.proposal, 'اتصل بأمي');
    assert.equal(call.resolvedTime, at(LATER, '17:00'));
    await confirmItems(uid, saved, [call.itemId]);

    const first = await chat(uid, 'لازم اشتري خبز', { locale: 'ar', referenceTime: reference });
    const bread = itemWith(first.proposal, 'خبز');
    const onto = await edit(uid, first.conversationId, editOf(first, { itemId: bread.itemId }, time(at(LATER, '17:00'))), { referenceTime: reference });
    assert.ok((itemById(onto.proposal, bread.itemId).conflicts ?? []).length > 0, 'a time onto a saved commitment shows no clash');
    const away = await edit(uid, first.conversationId, editOf(onto, { itemId: bread.itemId }, time(at(LATER, '21:00'))), { referenceTime: reference });
    assert.equal((itemById(away.proposal, bread.itemId).conflicts ?? []).length, 0, 'a stale clash stayed after the time moved away');
  } finally {
    end();
  }
});
