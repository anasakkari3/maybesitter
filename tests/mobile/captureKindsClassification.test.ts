import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCaptureKinds } from '../../lib/services/captureKinds/runtime.ts';
import { readsAsDoubt } from '../../lib/services/mobile/mobileCaptureService.ts';
import { beginRules, end, habitsOf, say } from '../acceptance/m3b/support.ts';

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
