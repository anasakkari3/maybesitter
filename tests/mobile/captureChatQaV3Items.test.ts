/**
 * QA v3 (2026-11-19), the capture chat's multi-item and stuck-chat findings,
 * replayed with a scripted model (no model is called):
 *
 *   V3-F04-01  a point the model put on the list, and its reply names, has
 *              no card: the boundary read the model's own point as "nothing"
 *              (`type` informational_context / unknown, or a low confidence)
 *              and dropped it without a word;
 *   V3-F04-05 / V3-F22-03
 *              «ما قدرت أطبّق التعديل هلّق — عدّله من الكرت تحت.» with no
 *              card under it: the same drop left the turn with nothing, and a
 *              turn that changed nothing was answered as a failed edit even
 *              when there was no card to edit — in the goal entry too;
 *   V3-F04-10  «بكرا …، وبعدها بدي أتصل بأحمد»: the second point lost the day
 *              «بعدها» ("after it") carries over from the point before it.
 *
 * Reference: Wednesday 2026-10-07 10:00 Asia/Jerusalem (the M2b harness).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TZ, at, modelFirstAnswer, modelItem, modelRefAnswer } from '../acceptance/m2b/support.ts';
import { beginModel, end, say, show, goalsOf, type Answer } from '../acceptance/m3b/support.ts';

const TOMORROW = '2026-10-08';
const EDIT_FAILED = /ما قدرت أطبّق التعديل|couldn't apply that change/;

type Card = { title: string; resolvedTime?: string | null; resolvedDate?: string };
function cards(answer: Answer): Card[] {
  return (answer.proposal?.items ?? []) as Card[];
}

function titles(answer: Answer): string[] {
  return (answer.proposal?.items ?? []).map((item) => item.title);
}

/* ── V3-F04-01: a point the reply names always has its card ─────────── */

const EXAM_TEXT = 'بكرا لازم أشتري خبز، وبعدها بدي أتصل بأحمد، والخميس عندي امتحان رياضيات الساعة 9 الصبح';
const BREAD = { ...modelItem('أشتري خبز', TOMORROW, null), source: 'بكرا لازم أشتري خبز' };
const AHMAD = { ...modelItem('أتصل بأحمد', TOMORROW, null), source: 'وبعدها بدي أتصل بأحمد' };
const EXAM_SOURCE = 'والخميس عندي امتحان رياضيات الساعة 9 الصبح';
const EXAM_REPLY = 'تمام: خبز بكرا، تتصل بأحمد، والخميس امتحان رياضيات الساعة 9 الصبح. أكّد من تحت.';

for (const [label, exam] of [
  ['informational_context', { ...modelItem('امتحان رياضيات', TOMORROW, '09:00'), type: 'informational_context', source: EXAM_SOURCE }],
  ['unknown', { ...modelItem('امتحان رياضيات', TOMORROW, '09:00'), type: 'unknown', source: EXAM_SOURCE }],
  ['a low confidence', {
    ...modelItem('امتحان رياضيات', TOMORROW, '09:00'),
    explicitReminderRequest: false,
    confidence: { overall: 0.5, type: 0.5, action: 0.5, time: 0.9, priority: 0.5 },
    source: EXAM_SOURCE,
  }],
] as const) {
  test(`V3-F04-01 the third point the model listed with ${label} keeps its card`, async () => {
    const uid = beginModel({}, modelFirstAnswer(EXAM_REPLY, 'propose', [BREAD, AHMAD, exam]));
    try {
      const answer = await say(uid, EXAM_TEXT, { locale: 'ar' });
      assert.equal(answer.engine, 'model');
      assert.ok(answer.reply.includes('امتحان'), `the reply no longer names the exam: ${answer.reply}`);
      const exams = (answer.proposal?.items ?? []).filter((item) => item.title.includes('امتحان'));
      assert.equal(exams.length, 1, `the reply names the exam but it has no card: ${show(answer.proposal)}`);
      assert.equal(exams[0]!.resolvedTime, at(TOMORROW, '09:00'), `the exam lost its hour: ${show(exams[0])}`);
      assert.equal(titles(answer).length, 3, `a point went missing: ${show(titles(answer))}`);
    } finally { end(); }
  });
}

test('V3-F04-01 the API text: the family dinner, the only timed point, keeps its card at 20:00', async () => {
  const text = 'بكرا لازم اسلم التقرير وبعدين اتصل بالبنك وبالليل عشا مع العيلة الساعة 8';
  const uid = beginModel({}, modelFirstAnswer('تمام: التقرير بكرا، البنك، وعشا مع العيلة الساعة 8 بالليل. أكّد من تحت.', 'propose', [
    { ...modelItem('اسلم التقرير', TOMORROW, null), source: 'بكرا لازم اسلم التقرير' },
    { ...modelItem('اتصل بالبنك', TOMORROW, null), source: 'وبعدين اتصل بالبنك' },
    { ...modelItem('عشا مع العيلة', TOMORROW, '20:00'), type: 'informational_context', explicitReminderRequest: false, source: 'وبالليل عشا مع العيلة الساعة 8' },
  ]));
  try {
    const answer = await say(uid, text, { locale: 'ar' });
    const dinner = (answer.proposal?.items ?? []).find((item) => item.title.includes('عشا'));
    assert.ok(dinner, `the dinner has no card: ${show(answer.proposal)}`);
    // «وبالليل» names no day of its own (no «بعدها»): its 20:00 is kept and
    // only the day is asked, with tomorrow at 20:00 one tap away.
    const tomorrowAt8 = (dinner as unknown as { clarification?: { options?: Array<{ value?: { localDate?: string; localTime?: string } }> } })
      .clarification?.options?.some((option) => option.value?.localDate === TOMORROW && option.value?.localTime === '20:00');
    assert.ok(dinner!.resolvedTime === at(TOMORROW, '20:00') || tomorrowAt8, `the dinner lost its 20:00: ${show(dinner)}`);
  } finally { end(); }
});

/* ── V3-F04-05 / V3-F22-03: never "edit it on the card below" with no card ── */

test('V3-F22-03 the goal entry: a goal the model listed as informational is a goal card, not a failed edit', async () => {
  const text = 'I want to run a 10k race by the end of March';
  const uid = beginModel({}, modelFirstAnswer('Got it: run a 10k race by the end of March. Confirm below.', 'propose', [
    { ...modelItem('Run a 10k race', null, null), type: 'informational_context', kind: 'goal', source: text },
  ]));
  try {
    const answer = await say(uid, text, { entry: 'goal', locale: 'en' });
    assert.doesNotMatch(answer.reply, EDIT_FAILED, `a failed edit with no card: ${answer.reply}`);
    const goals = goalsOf(answer);
    assert.equal(goals.length, 1, `no goal card: ${show(answer.proposal)}`);
    assert.match(goals[0]!.title, /10k/);
  } finally { end(); }
});

test('V3-F04-05 after the impossible date is asked about, the next clear commitment gets its card', async () => {
  const bank = 'عندي موعد بالبنك يوم 31 فبراير';
  const meeting = 'بكرا الساعة 5 المسا عندي اجتماع مع فريق العمل';
  const uid = beginModel({},
    modelFirstAnswer('ما في يوم 31 شباط. أي يوم قصدك؟', 'ask', [{ ...modelItem('موعد بالبنك', null, null), source: bank }]),
    modelRefAnswer('تمام، اجتماع مع فريق العمل بكرا الساعة 5 المسا. أكّد من تحت.', 'update', {
      open: [{ ref: 'i1', op: 'keep' }],
      added: [{ ...modelItem('اجتماع مع فريق العمل', TOMORROW, '17:00'), type: 'informational_context', explicitReminderRequest: false, source: meeting }],
    }));
  try {
    const first = await say(uid, bank, { locale: 'ar' });
    const second = await say(uid, meeting, { conversationId: first.conversationId, locale: 'ar' });
    assert.doesNotMatch(second.reply, EDIT_FAILED, `the chat is stuck: ${second.reply}`);
    const card = (second.proposal?.items ?? []).find((item) => item.title.includes('اجتماع'));
    assert.ok(card, `the meeting has no card: ${show(second.proposal)}`);
    assert.equal(card!.resolvedTime, at(TOMORROW, '17:00'));
  } finally { end(); }
});

test('V3-F04-05 a turn that ends with no card at all is never answered "edit it on the card below"', async () => {
  const text = 'عندي اجتماع بكرا';
  // A point with no usable title: the boundary drops it, so no card exists.
  const uid = beginModel({}, modelFirstAnswer('تمام، أكّد من تحت.', 'propose', [
    { ...modelItem('ا', TOMORROW, null), source: text },
  ]));
  try {
    const answer = await say(uid, text, { locale: 'ar' });
    assert.equal(answer.proposal, null, `expected no card: ${show(answer.proposal)}`);
    assert.doesNotMatch(answer.reply, EDIT_FAILED, `"edit it on the card below" with no card: ${answer.reply}`);
  } finally { end(); }
});

/* ── V3-F04-10: «وبعدها» keeps the day of the point before it ──────── */

test('V3-F04-10 «وبعدها بدي أتصل بأحمد» after «بكرا»: the call is tomorrow, not undated', async () => {
  const uid = beginModel({}, modelFirstAnswer('تمام: خبز بكرا وبعدها تتصل بأحمد. أي ساعة؟', 'ask', [BREAD, AHMAD]));
  try {
    const answer = await say(uid, 'بكرا لازم أشتري خبز، وبعدها بدي أتصل بأحمد', { locale: 'ar' });
    const call = cards(answer).find((item) => item.title.includes('أحمد'));
    assert.ok(call, `no card for the call: ${show(answer.proposal)}`);
    assert.equal(call!.resolvedDate, TOMORROW, `the call lost «بكرا»: ${show(call)}`);
  } finally { end(); }
});

test('V3-F04-10 "and then" in English keeps the day too', async () => {
  const uid = beginModel({}, modelFirstAnswer('Got it. What time?', 'ask', [
    { ...modelItem('Buy bread', TOMORROW, null), source: 'Tomorrow I need to buy bread' },
    { ...modelItem('Call Ahmad', TOMORROW, null), source: 'and then call Ahmad' },
  ]));
  try {
    const answer = await say(uid, 'Tomorrow I need to buy bread, and then call Ahmad', { locale: 'en' });
    const call = cards(answer).find((item) => item.title.includes('Ahmad'));
    assert.ok(call, `no card for the call: ${show(answer.proposal)}`);
    assert.equal(call!.resolvedDate, TOMORROW, `the call lost "tomorrow": ${show(call)}`);
  } finally { end(); }
});

test('V3-F04-10 the carry is only a day: no connective, no day carried; and never an hour', async () => {
  // Without «بعدها» the second point names no day of its own: still asked.
  let uid = beginModel({}, modelFirstAnswer('تمام. إيمتى؟', 'ask', [
    BREAD,
    { ...modelItem('أتصل بأحمد', TOMORROW, null), source: 'وبدي أتصل بأحمد' },
  ]));
  try {
    const answer = await say(uid, 'بكرا لازم أشتري خبز، وبدي أتصل بأحمد', { locale: 'ar' });
    const call = cards(answer).find((item) => item.title.includes('أحمد'));
    assert.ok(call, show(answer.proposal));
    assert.equal(call!.resolvedDate ?? null, null, `a day carried with no «بعدها»: ${show(call)}`);
  } finally { end(); }
  // «بعدها» carries the day of the bread, not its hour.
  uid = beginModel({}, modelFirstAnswer('تمام. أي ساعة؟', 'ask', [
    { ...modelItem('أشتري خبز', TOMORROW, '17:00'), source: 'بكرا الساعة 5 المسا لازم أشتري خبز' },
    { ...modelItem('أتصل بأحمد', TOMORROW, '17:00'), source: 'وبعدها بدي أتصل بأحمد' },
  ]));
  try {
    const answer = await say(uid, 'بكرا الساعة 5 المسا لازم أشتري خبز، وبعدها بدي أتصل بأحمد', { locale: 'ar' });
    const call = cards(answer).find((item) => item.title.includes('أحمد'));
    assert.ok(call, show(answer.proposal));
    assert.equal(call!.resolvedDate, TOMORROW, `the day was not carried: ${show(call)}`);
    assert.equal(call!.resolvedTime, null, `the bread's hour was carried: ${show(call)}`);
  } finally { end(); }
});

void TZ;
