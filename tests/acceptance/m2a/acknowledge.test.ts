/**
 * M2a Task B, criterion 3 (Acknowledge first, ask the real question) —
 * condition 8 of the 2026-10-06 audit: «حابب أنزل بالوزن» is acknowledged
 * before anything is asked, and a goal or a thought is never asked for a time.
 *
 * When the turn asks anything, the reply opens with what was understood and
 * then asks the proposal's ACTUAL missing field (`missingQuestion`); a model
 * reply whose question is unrelated («فهمت الاجتماع. تمام؟») is replaced by
 * acknowledgement + `missingQuestion`. The new acknowledgement's wording is the
 * builders' — only its position and the old strings' absence are held here.
 *
 * Acceptance gate written independently of the builder: every test here must
 * fail on 0620a7b2 for the reason its criterion names.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { missingQuestion } from '../../../lib/services/captureChat/chatReply.ts';
import {
  TOMORROW,
  beginModel,
  beginRules,
  chat,
  end,
  modelAnswer,
  modelItem,
  sentences,
  type ChatBody,
} from './support.ts';

/* The old Arabic replies that must disappear (chatReply.ts at 0620a7b2). */
/** TEMPLATES.ar.ask with the goal as its title: a time question for a goal. */
const OLD_GOAL_ASK = 'إيمتى بدك «حابب أنزل بالوزن»؟ احكيلي اليوم والساعة.';
/** TEMPLATES.ar.nothing: "what do you need to do, and when?" — to a thought. */
const OLD_NOTHING = 'شو بدك تعمل وإيمتى؟ احكيلي وأنا بجهزلك ياها لتأكدها.';
/** Any time question («إيمتى», «أي ساعة», «أي يوم», «الصبح ولا المسا»). */
const TIME_QUESTION = /إيمتى|ايمتى|امتى|أي ساعة|اي ساعة|أي يوم|اي يوم|الساعة كم|قديش الساعة|الصبح ولا المسا/;

/** The reply asks the item's real missing field, after an acknowledgement — never as its opening. */
function assertAcknowledgedThenAsked(body: ChatBody): void {
  assert.ok(body.proposal, 'no proposal');
  const asking = body.proposal!.items.find((item) => item.needsClarification);
  assert.ok(asking, `nothing is asked, so this case proves nothing: ${JSON.stringify(body.proposal!.items)}`);
  // The item exactly as the route sent it: the question is the one for ITS missing field.
  const question = missingQuestion('ar', asking as unknown as Parameters<typeof missingQuestion>[1]);
  const at = body.reply.indexOf(question);
  assert.ok(at >= 0, `the reply does not ask the proposal's missing field («${question}»): ${body.reply}`);
  const opening = body.reply.slice(0, at).trim();
  assert.ok(opening.length > 0, `the reply opens with the question, not with what was understood: ${body.reply}`);
  assert.ok(!/[?؟]/.test(sentences(opening)[0] ?? ''), `the reply's first sentence is a question: ${body.reply}`);
}

test('B3 acknowledge (model path): «فهمت الاجتماع. تمام؟» — an unrelated question — is replaced by acknowledgement + the missing hour', async () => {
  const stub = 'فهمت الاجتماع. تمام؟';
  const uid = beginModel(modelAnswer(stub, 'ask', [
    modelItem('اجتماع مع سامي', TOMORROW, null, { kind: 'commitment' }),
  ]));
  try {
    const body = await chat(uid, 'عندي اجتماع مع سامي بكرا', { locale: 'ar' });
    assert.equal(body.engine, 'model');
    assert.ok(!body.reply.includes('تمام؟'), `the model's unrelated question was shown: ${body.reply}`);
    assertAcknowledgedThenAsked(body);
  } finally {
    end();
  }
});

test('B3 acknowledge (rules): a question opens with what was understood — «موعد الدكتور بكرا الساعة 4» is not answered by the bare «الصبح ولا المسا؟»', async () => {
  const uid = beginRules();
  try {
    const body = await chat(uid, 'موعد الدكتور بكرا الساعة 4', { locale: 'ar' });
    // The whole old reply was the question alone (QUESTIONS.ar.am_pm).
    assert.notEqual(body.reply, '«موعد الدكتور» الصبح ولا المسا؟', 'the old bare question is still the whole reply');
    assertAcknowledgedThenAsked(body);
  } finally {
    end();
  }
});

test('B3 acknowledge (rules): «حابب أنزل بالوزن» is acknowledged with no time question — «إيمتى بدك…» is gone', async () => {
  const uid = beginRules();
  try {
    const body = await chat(uid, 'حابب أنزل بالوزن', { locale: 'ar' });
    assert.notEqual(body.reply, OLD_GOAL_ASK, 'the old time question for a goal is still the reply');
    assert.ok(!body.reply.includes('إيمتى بدك'), `a goal was asked «إيمتى بدك…»: ${body.reply}`);
    assert.ok(!TIME_QUESTION.test(body.reply), `a goal was asked for a time: ${body.reply}`);
    assert.equal(body.proposal?.items.filter((item) => item.needsClarification).length ?? 0, 0, 'an item still asks the goal for a time');
  } finally {
    end();
  }
});

test('B3 acknowledge (rules): a consideration alone gets an acknowledgement, not «شو بدك تعمل وإيمتى؟»', async () => {
  const uid = beginRules();
  try {
    const body = await chat(uid, 'عم بفكر أسافر الصيف الجاي', { locale: 'ar' });
    assert.notEqual(body.reply, OLD_NOTHING, 'a thought got the old "what and when?" reply');
    assert.ok(!TIME_QUESTION.test(body.reply), `a consideration was asked for a time: ${body.reply}`);
  } finally {
    end();
  }
});

test('B3 acknowledge (model path): a goal statement gets no time question even when the model asks one', async () => {
  const uid = beginModel(modelAnswer('حلو! إيمتى بدك تبلّش تنزل بالوزن؟', 'ask', [
    modelItem('أنزل بالوزن', null, null, { kind: 'possible_goal' }),
  ]));
  try {
    const body = await chat(uid, 'حابب أنزل بالوزن', { locale: 'ar' });
    assert.equal(body.engine, 'model');
    assert.ok(!TIME_QUESTION.test(body.reply), `a goal was asked for a time: ${body.reply}`);
    assert.equal(body.proposal?.items.length ?? 0, 0, 'the goal is an item');
  } finally {
    end();
  }
});

test('B3 acknowledge (model path): a consideration alone gets no time question even when the model asks one', async () => {
  const uid = beginModel(modelAnswer('إيمتى بدك تسافر؟ احكيلي اليوم والساعة.', 'ask', [
    modelItem('أسافر الصيف الجاي', null, null, { kind: 'consideration' }),
  ]));
  try {
    const body = await chat(uid, 'عم بفكر أسافر الصيف الجاي', { locale: 'ar' });
    assert.equal(body.engine, 'model');
    assert.ok(!TIME_QUESTION.test(body.reply), `a consideration was asked for a time: ${body.reply}`);
    assert.equal(body.proposal?.items.length ?? 0, 0, 'the consideration is an item');
  } finally {
    end();
  }
});
