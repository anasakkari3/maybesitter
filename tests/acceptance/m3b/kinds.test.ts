/**
 * M3b Gate B: what the chat understands (PLAN-M3b acceptance 1–4, D1, D3,
 * R003, R004, R2-012, R2-014, R3-001, R3-003, R006). Gate author: Claude.
 * Rules path (no model) unless named: the deterministic half every account
 * gets. Every test must fail on 80eea528 for the reason it names.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { instantFromLocal } from '../../../src/extraction/timeLexicon.ts';
import {
  TZ,
  beginRules,
  chatRaw,
  editPoint,
  end,
  goalsOf,
  habitsOf,
  probe,
  say,
  show,
  v8KeysIn,
  type Answer,
} from './support.ts';

const TOMORROW = '2026-10-08';
const at = (date: string, time: string) => instantFromLocal(date, time, TZ)!.toISOString();

/* ── the capability probe (R004, R2-012, R2-014, R3-001) ─────────────── */

test('R004 probe: on (test env) answers 200 with goal, habit and thought', async () => {
  const uid = beginRules();
  try {
    const result = await probe(uid);
    assert.equal(result.status, 200, show(result.body));
    assert.deepEqual([...result.body.entries].sort(), ['goal', 'habit', 'thought']);
  } finally { end(); }
});

test('R2-012 probe: with memory off the goal entry is not offered', async () => {
  const uid = beginRules({ memory: false });
  try {
    const result = await probe(uid);
    assert.equal(result.status, 200, show(result.body));
    assert.deepEqual([...result.body.entries].sort(), ['habit', 'thought']);
  } finally { end(); }
});

test('R3-001 probe: off, killed, and production-with-flag all answer 404 feature_unavailable', async () => {
  for (const [label, switches] of [
    ['off', { kinds: false }],
    ['killed', { killed: true }],
    ['production + flag', { environment: 'production' }],
  ] as const) {
    const uid = beginRules(switches);
    try {
      const result = await probe(uid);
      assert.equal(result.status, 404, `${label}: ${show(result.body)}`);
      assert.equal(result.body.reason, 'feature_unavailable', label);
    } finally { end(); }
  }
});

test('R3-003 off: a chat answer carries none of the v8 fields, and an entry hint is accepted and ignored', async () => {
  const uid = beginRules({ kinds: false });
  try {
    const result = await chatRaw(uid, { message: 'بدي أمشي نص ساعة كل يوم الصبح', timezone: TZ, entry: 'habit' });
    assert.equal(result.status, 200, show(result.body));
    assert.deepEqual(Array.from(v8KeysIn(result.body)), [], `v8 keys leaked while off: ${show(result.body)}`);
  } finally { end(); }
});

test('R3-003 on: the proposal carries habits[], goals[], entry and a pointId on every point', async () => {
  const uid = beginRules();
  try {
    const answer = await say(uid, 'موعد الدكتور بكرا الساعة 4 المسا، وعم بفكر أسافر الصيف الجاي', { locale: 'ar' });
    const proposal = answer.proposal!;
    assert.ok(Array.isArray(proposal.habits) && Array.isArray(proposal.goals), `no v8 lists: ${show(proposal)}`);
    assert.equal(proposal.entry ?? null, null, 'a generic chat must say entry: null');
    for (const point of [...proposal.items, ...proposal.seeds]) assert.equal(typeof point.pointId, 'string', `no pointId on ${show(point)}`);
    for (const line of proposal.understood ?? []) assert.equal(typeof line.pointId, 'string', `no pointId on understood ${show(line)}`);
  } finally { end(); }
});

/* ── habits (acceptance 2, R003) ─────────────────────────────────────── */

test('A2 habit: «بدي أمشي نص ساعة كل يوم الصبح» is one confirmable habit with its rhythm explained, not a commitment', async () => {
  const uid = beginRules();
  try {
    const answer = await say(uid, 'بدي أمشي نص ساعة كل يوم الصبح', { locale: 'ar' });
    assert.equal(answer.proposal!.items.length, 0, `a habit became a commitment: ${show(answer.proposal!.items)}`);
    const [habit] = habitsOf(answer);
    assert.ok(habit, 'no habit');
    const perWeek = habit!.cadence?.kind === 'weekly_count' ? habit!.cadence.count : habit!.cadence?.weekdays.length;
    assert.equal(perWeek, 7, `«كل يوم» is not 7 a week: ${show(habit!.cadence)}`);
    assert.equal(habit!.durationMinutes, 30);
    assert.equal(habit!.preferredWindow, 'morning');
    assert.equal(habit!.confirmable, true);
    assert.equal(habit!.question, null);
    assert.ok(habit!.explanation && habit!.explanation.length > 0, 'no explanation before saving');
    assert.ok(answer.proposal!.understood?.some((line) => line.kind === 'habit' && line.habitItemId === habit!.habitItemId), 'understood does not name the habit');
  } finally { end(); }
});

test('A2 habit: from the habit entry, a habit with no frequency or duration asks frequency, then duration, through edits on the habit', async () => {
  const uid = beginRules();
  try {
    let answer = await say(uid, 'بدي أتعوّد أقرا', { entry: 'habit', locale: 'ar' });
    let [habit] = habitsOf(answer);
    assert.ok(habit, `the habit entry gave no habit: ${show(answer.proposal)}`);
    assert.equal(habit!.confirmable, false);
    assert.equal(habit!.explanation, null, 'an explanation was built with unknown fields');
    assert.equal(habit!.question?.field, 'frequency');

    let result = await editPoint(uid, answer, { habitItemId: habit!.habitItemId }, { cadence: { kind: 'weekly_count', count: 3 } });
    assert.equal(result.status, 200, show(result.body));
    answer = result.body as Answer;
    [habit] = habitsOf(answer);
    assert.equal(habit!.question?.field, 'duration', `frequency answered, duration not asked: ${show(habit)}`);

    result = await editPoint(uid, answer, { habitItemId: habit!.habitItemId }, { durationMinutes: 15 });
    assert.equal(result.status, 200, show(result.body));
    [habit] = habitsOf(result.body as Answer);
    assert.equal(habit!.confirmable, true);
    assert.equal(habit!.question, null);
    assert.ok(habit!.explanation, 'no explanation once complete');
  } finally { end(); }
});

test('A2 habit: a repeating appointment («كل ثلاثاء الساعة 6 عندي تدريب») stays a recurring commitment, not a habit', async () => {
  const uid = beginRules();
  try {
    const answer = await say(uid, 'كل ثلاثاء الساعة 6 المسا عندي تدريب', { locale: 'ar' });
    assert.ok(answer.proposal!.items.length >= 1, `the appointment is not a commitment: ${show(answer.proposal)}`);
    assert.deepEqual(habitsOf(answer), []);
  } finally { end(); }
});

/* ── doubt beats time (acceptance 3, D3) ─────────────────────────────── */

test('D3 doubt: a timed thought stays a consideration with its time, in ar, en and he', async () => {
  for (const [locale, message, time] of [
    ['ar', 'عم بفكر روح عالجيم بكرا الساعة 6 المسا', '18:00'],
    ['en', "I'm thinking about going to the gym tomorrow at 6pm", '18:00'],
    ['he', 'אולי אלך לחדר כושר מחר ב-18:00', '18:00'],
  ] as const) {
    const uid = beginRules();
    try {
      const answer = await say(uid, message, { locale });
      assert.equal(answer.proposal!.items.length, 0, `${locale}: a thought became a commitment: ${show(answer.proposal!.items)}`);
      const [seed] = answer.proposal!.seeds;
      assert.equal(seed?.kind, 'consideration', `${locale}: ${show(answer.proposal!.seeds)}`);
      assert.equal(seed?.suggestedTime?.at, at(TOMORROW, time), `${locale}: the time was not kept on the thought`);
    } finally { end(); }
  }
});

test('D3 doubt: «حطّها التزام» turns the timed thought into a commitment at that time, nothing saved yet', async () => {
  const uid = beginRules();
  try {
    const answer = await say(uid, 'عم بفكر روح عالجيم بكرا الساعة 6 المسا', { locale: 'ar' });
    const seed = answer.proposal!.seeds[0];
    assert.ok(seed, `the timed thought is not a seed to convert: ${show(answer.proposal)}`);
    const result = await editPoint(uid, answer, { seedItemId: seed!.seedItemId }, { kind: 'commitment' });
    assert.equal(result.status, 200, show(result.body));
    const after = (result.body as Answer).proposal!;
    assert.equal(after.seeds.length, 0);
    assert.equal(after.items.length, 1);
    assert.equal(after.items[0]!.resolvedTime, at(TOMORROW, '18:00'));
    assert.equal(after.items[0]!.pointId, seed!.pointId, 'the conversion changed the pointId (R2-011)');
  } finally { end(); }
});

test('D3 guard: commitment language without doubt, and a request form, stay commitments (B-004)', async () => {
  for (const message of ['لازم أدفع الفاتورة بكرا الساعة 5 المسا', 'ممكن تذكرني أتصل بأمي بكرا الساعة 5 المسا']) {
    const uid = beginRules();
    try {
      const answer = await say(uid, message, { locale: 'ar' });
      assert.equal(answer.proposal!.items.length, 1, `«${message}» is not one commitment: ${show(answer.proposal)}`);
      assert.equal(answer.proposal!.seeds.length, 0, `«${message}» became a seed`);
    } finally { end(); }
  }
});

/* ── goals and entries (acceptance 1, 4, D1) ─────────────────────────── */

test('A4 goal: from the goal entry «بدي أنزل بالوزن» is a goal point; from the generic entry it stays a possible_goal seed', async () => {
  let uid = beginRules();
  try {
    const answer = await say(uid, 'بدي أنزل بالوزن', { entry: 'goal', locale: 'ar' });
    const [goal] = goalsOf(answer);
    assert.ok(goal && goal.title.includes('أنزل بالوزن'), `no goal point: ${show(answer.proposal)}`);
    assert.equal(answer.proposal!.entry, 'goal');
    assert.equal(answer.proposal!.seeds.length, 0);
  } finally { end(); }
  uid = beginRules();
  try {
    const answer = await say(uid, 'بدي أنزل بالوزن', { locale: 'ar' });
    assert.deepEqual(goalsOf(answer), [], 'the generic entry made a goal point');
    assert.deepEqual(answer.proposal!.seeds.map((seed) => seed.kind), ['possible_goal']);
  } finally { end(); }
});

test('D1 entry is a hint: an appointment from the goal entry, and «لازم…» from the thought entry, are commitments', async () => {
  for (const [entry, message] of [
    ['goal', 'عندي موعد طبيب بكرا الساعة 4 المسا'],
    ['thought', 'لازم أدفع الفاتورة بكرا الساعة 5 المسا'],
  ] as const) {
    const uid = beginRules();
    try {
      const answer = await say(uid, message, { entry, locale: 'ar' });
      assert.equal(answer.proposal!.items.length, 1, `${entry}: «${message}» is not a commitment: ${show(answer.proposal)}`);
      assert.deepEqual(goalsOf(answer), [], `${entry}: became a goal`);
      assert.equal(answer.proposal!.entry, entry);
    } finally { end(); }
  }
});

test('D1 the entry is kept for the conversation: a second turn without it still answers as the first turn\'s entry', async () => {
  const uid = beginRules();
  try {
    const first = await say(uid, 'بدي أنزل بالوزن', { entry: 'goal', locale: 'ar' });
    const second = await say(uid, 'وبدي أتعلم سباحة', { conversationId: first.conversationId, locale: 'ar' });
    assert.equal(second.proposal!.entry, 'goal');
  } finally { end(); }
});

test('R007 memory off: the goal entry offers no goal point; the statement stays a possible_goal seed', async () => {
  const uid = beginRules({ memory: false });
  try {
    const answer = await say(uid, 'بدي أنزل بالوزن', { entry: 'goal', locale: 'ar' });
    assert.deepEqual(goalsOf(answer), []);
    assert.deepEqual(answer.proposal!.seeds.map((seed) => seed.kind), ['possible_goal']);
  } finally { end(); }
});

test('WIRE entry: an unknown entry value is refused 400 invalid_body', async () => {
  const uid = beginRules();
  try {
    const result = await chatRaw(uid, { message: 'بدي أمشي', timezone: TZ, entry: 'mood' });
    assert.equal(result.status, 400, show(result.body));
  } finally { end(); }
});

/* ── conversions (R006, R2-011) ──────────────────────────────────────── */

test('R006 habit → commitment keeps the title and pointId, takes no invented date, and asks for its day and time', async () => {
  const uid = beginRules();
  try {
    const answer = await say(uid, 'بدي أمشي نص ساعة كل يوم الصبح', { locale: 'ar' });
    const habit = habitsOf(answer)[0]!;
    const result = await editPoint(uid, answer, { habitItemId: habit.habitItemId }, { kind: 'commitment' });
    assert.equal(result.status, 200, show(result.body));
    const after = (result.body as Answer).proposal!;
    assert.deepEqual(after.habits, []);
    assert.equal(after.items.length, 1);
    assert.equal(after.items[0]!.resolvedTime ?? null, null, 'a date was derived from the cadence');
    assert.equal(after.items[0]!.pointId, habit.pointId);
  } finally { end(); }
});

test('R006 goal → commitment is refused 422 invalid_edit', async () => {
  const uid = beginRules();
  try {
    const answer = await say(uid, 'بدي أنزل بالوزن', { entry: 'goal', locale: 'ar' });
    const goal = goalsOf(answer)[0]!;
    const result = await editPoint(uid, answer, { goalItemId: goal.goalItemId }, { kind: 'commitment' });
    assert.equal(result.status, 422, show(result.body));
  } finally { end(); }
});

test('R006 commitment → habit asks frequency and duration (nothing guessed)', async () => {
  const uid = beginRules();
  try {
    const answer = await say(uid, 'موعد الدكتور بكرا الساعة 4 المسا', { locale: 'ar' });
    const item = answer.proposal!.items[0]!;
    const result = await editPoint(uid, answer, { itemId: item.itemId }, { kind: 'habit' });
    assert.equal(result.status, 200, show(result.body));
    const habit = habitsOf(result.body as Answer)[0]!;
    assert.equal(habit.cadence, null);
    assert.equal(habit.durationMinutes, null);
    assert.equal(habit.question?.field, 'frequency');
    assert.equal(habit.pointId, item.pointId);
  } finally { end(); }
});

/* ── review r1 of Task B: guards the build must keep (added by the gate author) ── */

test('RB-1 with kinds on, an ambiguous clock still asks AM/PM: «الساعة 4» is never guessed as 16:00 (M2 rule)', async () => {
  const uid = beginRules();
  try {
    const answer = await say(uid, 'اتصل بأمي بكرا الساعة 4', { locale: 'ar' });
    const item = answer.proposal!.items[0];
    assert.ok(item, `no commitment: ${show(answer.proposal)}`);
    assert.equal(item!.resolvedTime ?? null, null, `the half of the day was guessed: ${show(item)}`);
  } finally { end(); }
});

test('RB-2 doubt is per clause: in «موعد … الساعة 4 المسا، وعم بفكر أسافر…» the appointment stays a commitment and only the travel is a thought', async () => {
  const uid = beginRules();
  try {
    const answer = await say(uid, 'موعد الدكتور بكرا الساعة 4 المسا، وعم بفكر أسافر الصيف الجاي', { locale: 'ar' });
    assert.equal(answer.proposal!.items.length, 1, `the appointment was lost: ${show(answer.proposal)}`);
    assert.ok(answer.proposal!.items[0]!.title.includes('الدكتور'));
    const considerations = answer.proposal!.seeds.filter((seed) => seed.kind === 'consideration');
    assert.equal(considerations.length, 1, show(answer.proposal!.seeds));
    assert.ok(considerations[0]!.summary.includes('أسافر'));
    assert.ok(!considerations[0]!.summary.includes('الدكتور'), `the thought swallowed the appointment: ${considerations[0]!.summary}`);
  } finally { end(); }
});

test('RB-5 a request with «ممكن» is not doubt: «إذا ممكن حطلي موعد الدكتور بكرا الساعة 4 المسا» is one commitment', async () => {
  const uid = beginRules();
  try {
    const answer = await say(uid, 'إذا ممكن حطلي موعد الدكتور بكرا الساعة 4 المسا', { locale: 'ar' });
    assert.equal(answer.proposal!.items.length, 1, `a request became a thought: ${show(answer.proposal)}`);
    assert.equal(answer.proposal!.seeds.length, 0);
  } finally { end(); }
});

test('RB-4 the goal entry is a hint: a clear thought («عم بفكر أسافر…») from it stays a consideration, not a goal', async () => {
  const uid = beginRules();
  try {
    const answer = await say(uid, 'عم بفكر أسافر الصيف الجاي', { entry: 'goal', locale: 'ar' });
    assert.deepEqual(goalsOf(answer), [], `a thought became a goal: ${show(answer.proposal)}`);
    assert.deepEqual(answer.proposal!.seeds.map((seed) => seed.kind), ['consideration']);
  } finally { end(); }
});

test('RB-7 the habit entry is a hint: a dated appointment from it («موعد الدكتور بكرا الساعة 4 المسا») stays a commitment', async () => {
  const uid = beginRules();
  try {
    const answer = await say(uid, 'موعد الدكتور بكرا الساعة 4 المسا', { entry: 'habit', locale: 'ar' });
    assert.equal(answer.proposal!.items.length, 1, `a dated appointment became a habit: ${show(answer.proposal)}`);
    assert.deepEqual(habitsOf(answer), []);
  } finally { end(); }
});
