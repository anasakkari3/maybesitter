import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCaptureKinds } from '../../lib/services/captureKinds/runtime.ts';
import { readsAsDoubt } from '../../lib/services/mobile/mobileCaptureService.ts';
import { beginRules, editPoint, end, habitsOf, say, show, type Answer } from '../acceptance/m3b/support.ts';

test('capture-kind doubt markers distinguish first-person uncertainty from requests in ar/en/he', () => {
  for (const [text, expected] of [
    ['إذا ممكن حطلي موعد الدكتور بكرا', false],
    ['ممكن تذكرني أتصل بأمي', false],
    ['ممكن أروح بكرا؟', true],
    ["maybe I'll go tomorrow", true],
    ['could you remind me tomorrow', false],
    ['אולי אלך מחר', true],
    ['אפשר להזכיר לי מחר', false],
  ] as const) {
    assert.equal(readsAsDoubt(text), expected, text);
  }
});

test('capture kinds is enabled only by a strict flag in an allowed non-production environment', () => {
  for (const environment of ['local', 'test', 'staging']) {
    assert.equal(resolveCaptureKinds({ MAYBESITTER_ENV: environment, MAYBESITTER_FEATURE_CAPTURE_KINDS: 'true' }), true, environment);
  }
  for (const environment of ['production', 'preview', 'development']) {
    assert.equal(resolveCaptureKinds({ MAYBESITTER_ENV: environment, MAYBESITTER_FEATURE_CAPTURE_KINDS: 'true' }), false, environment);
  }
  assert.equal(resolveCaptureKinds({ MAYBESITTER_ENV: 'test', MAYBESITTER_FEATURE_CAPTURE_KINDS: 'TRUE' }), false);
  assert.equal(resolveCaptureKinds({
    MAYBESITTER_ENV: 'test',
    MAYBESITTER_FEATURE_CAPTURE_KINDS: 'true',
    MAYBESITTER_KILL_SWITCH_CAPTURE_KINDS: 'true',
  }), false);
});

test('habit classification and fields come from the habit item source segment', async () => {
  const uid = beginRules();
  try {
    const answer = await say(uid, 'بدي أمشي كل يوم الصبح، وموعد الدكتور بكرا الساعة 4 المسا', { locale: 'ar' });
    const [habit] = habitsOf(answer);
    assert.ok(habit, 'the walking clause did not become a habit');
    assert.ok(habit.title.includes('أمشي'), habit.title);
    assert.deepEqual(habit.cadence, { kind: 'weekly_count', count: 7 });
    assert.equal(habit.preferredWindow, 'morning');
    assert.equal(answer.proposal?.items.length, 1);
    assert.ok(answer.proposal?.items[0]?.title.includes('الدكتور'));
  } finally {
    end();
  }
});

test('habit entry keeps a dated appointment as a commitment', async () => {
  const uid = beginRules();
  try {
    const answer = await say(uid, 'موعد الدكتور بكرا الساعة 4 المسا', { entry: 'habit', locale: 'ar' });
    assert.equal(answer.proposal?.items.length, 1);
    assert.deepEqual(habitsOf(answer), []);
  } finally {
    end();
  }
});

test('habit entry tilts an undecided item into a habit that asks frequency', async () => {
  const uid = beginRules();
  try {
    const answer = await say(uid, 'بدي أقرا', { entry: 'habit', locale: 'ar' });
    const [habit] = habitsOf(answer);
    assert.ok(habit, 'the undecided item did not become a habit');
    assert.equal(answer.proposal?.items.length, 0);
    assert.equal(habit.question?.field, 'frequency');
  } finally {
    end();
  }
});

test('habit entry keeps recurring training as a commitment', async () => {
  const uid = beginRules();
  try {
    const answer = await say(uid, 'كل ثلاثاء الساعة 6 المسا عندي تدريب', { entry: 'habit', locale: 'ar' });
    assert.equal(answer.proposal?.items.length, 1);
    assert.deepEqual(habitsOf(answer), []);
  } finally {
    end();
  }
});

// QA v3, V3-F23-05: «بدي أقرأ 20 دقيقة كل يوم الساعة 10 بالليل» lost both the
// twenty minutes (only 15/30/45/60 were read, so it asked «قديش بتاخد كل مرة؟»
// without 20 among the answers) and the hour (only a bare part of the day was
// read, so «الساعة 10 بالليل» saved «الأوقات المفضّلة: مش محدد»).
for (const [text, locale] of [
  ['بدي أقرأ 20 دقيقة كل يوم الساعة 10 بالليل', 'ar'],
  ['I want to read 20 minutes every day at 10pm', 'en'],
] as const) {
  test(`V3-F23-05 a habit said with its minutes and its hour keeps both: ${text}`, async () => {
    const uid = beginRules();
    try {
      const [habit] = habitsOf(await say(uid, text, { entry: 'habit', locale }));
      assert.ok(habit, 'no habit proposed');
      assert.equal(habit.durationMinutes, 20, 'the minutes the person said were dropped');
      assert.equal(habit.question, null, 'it asked how long after being told');
      assert.equal(habit.confirmable, true);
      assert.deepEqual(habit.preferredWindow, { start: '22:00', end: '22:20' }, 'the hour the person said was dropped');
    } finally {
      end();
    }
  });
}

test('V3-F23-05 an hour without its half of the day is not guessed into a habit window', async () => {
  const uid = beginRules();
  try {
    const [habit] = habitsOf(await say(uid, 'بدي أقرأ 20 دقيقة كل يوم الساعة 10', { entry: 'habit', locale: 'ar' }));
    assert.ok(habit, 'no habit proposed');
    assert.equal(habit.durationMinutes, 20);
    assert.equal(habit.preferredWindow, null, '«الساعة 10» could be morning or night; it must not become one');
  } finally {
    end();
  }
});

test('V3-F23-05 an hour said before its minutes keeps a window as long as the minutes answered later', async () => {
  const uid = beginRules();
  try {
    const answer = await say(uid, 'بدي أقرأ كل يوم الساعة 10 بالليل', { entry: 'habit', locale: 'ar' });
    const [habit] = habitsOf(answer);
    assert.ok(habit, 'no habit proposed');
    assert.equal(habit.question?.field, 'duration');
    assert.deepEqual(habit.preferredWindow, { start: '22:00', end: '23:00' });
    const result = await editPoint(uid, answer, { habitItemId: habit.habitItemId }, { durationMinutes: 90 });
    assert.equal(result.status, 200, show(result.body));
    const [edited] = habitsOf(result.body as Answer);
    assert.equal(edited!.durationMinutes, 90);
    assert.deepEqual(edited!.preferredWindow, { start: '22:00', end: '23:30' }, 'a session outgrew the window it is preferred in');
  } finally {
    end();
  }
});
