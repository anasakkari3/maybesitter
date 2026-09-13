/**
 * The one question the product asks, and the ones it must never ask
 * (UC-2.5, #165).
 *
 * The builder is pure, so "no past options" and "one question, chosen by what is
 * most missing" are arithmetic rather than something to be observed on a screen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClarification } from '../../lib/services/captureBoundary/clarificationBuilder.ts';
import { instantFromLocal } from '../../src/extraction/timeLexicon.ts';
import type { ExtractionResult } from '../../src/extraction/extractionTypes.ts';

const TZ = 'Asia/Jerusalem';
const context = (iso: string) => ({ now: new Date(iso), timezone: TZ });

function result(over: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    type: 'task',
    action: 'call the clinic',
    title: 'Call the clinic',
    person: null,
    dueAt: null,
    remindAt: null,
    localTimeSpec: null,
    timeEvidence: 'none',
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureImplied: false },
    flexibility: 'movable',
    confidence: { overall: 0.7, type: 0.7, action: 0.8, time: 0.1, priority: 0.8 },
    missingFields: [],
    ambiguityFlags: [],
    explicitReminderRequest: true,
    explicitPressureRequest: false,
    rawText: 'call the clinic',
    parserVersion: 'test',
    ...over,
  };
}

test('nothing is asked when the item has an action and a time it can trust', () => {
  const question = buildClarification(result({
    timeEvidence: 'ampm',
    localTimeSpec: { date: '2026-09-15', time: '19:00', timezone: TZ },
    remindAt: '2026-09-15T16:00:00.000Z',
  }), context('2026-09-14T10:00:00+03:00'));

  assert.equal(question, null);
});

test('no action outranks everything else', () => {
  // There is nothing to be reminded *to do*; a question about the time would be
  // decoration on an empty commitment.
  const question = buildClarification(result({
    action: null,
    title: null,
    ambiguityFlags: ['vague_action'],
    timeEvidence: 'clock_marker',
    localTimeSpec: { date: '2026-09-15', time: '08:00', timezone: TZ },
  }), context('2026-09-14T10:00:00+03:00'));

  assert.equal(question?.questionKey, 'ask_action');
  assert.equal(question?.field, 'action');
  // No options: the product cannot guess what somebody meant to do, and a list
  // of guesses would be worse than an empty field.
  assert.deepEqual(question?.options, []);
  assert.equal(question?.allowFreeText, true);
});

test('a bare hour is asked as am or pm, with both on the same day', () => {
  const question = buildClarification(result({
    timeEvidence: 'clock_marker',
    localTimeSpec: { date: '2026-09-15', time: '08:00', timezone: TZ },
  }), context('2026-09-14T10:00:00+03:00'));

  assert.equal(question?.questionKey, 'ask_am_pm');
  assert.equal(question?.params.hour, '8');
  assert.deepEqual(question?.options.map(o => o.optionId), ['am', 'pm']);
  assert.deepEqual(question?.options.map(o => o.value.localTime), ['08:00', '20:00']);
  assert.deepEqual(question?.options.map(o => o.value.localDate), ['2026-09-15', '2026-09-15']);
  // No free text: the user has two answers and typing a third would be a worse
  // way to give one of them.
  assert.equal(question?.allowFreeText, false);
});

test('an am option already past is not offered', () => {
  // Asked at 14:00 about "8" today: eight in the morning has gone.
  const question = buildClarification(result({
    timeEvidence: 'clock_marker',
    localTimeSpec: { date: '2026-09-14', time: '08:00', timezone: TZ },
  }), context('2026-09-14T14:00:00+03:00'));

  assert.equal(question?.questionKey, 'ask_am_pm');
  assert.deepEqual(question?.options.map(o => o.optionId), ['pm']);
});

test('a bare hour whose day has entirely gone is not asked as am or pm', () => {
  // Both options are in the past, so the day is wrong and am/pm is the wrong
  // question to ask about it.
  const question = buildClarification(result({
    timeEvidence: 'clock_marker',
    localTimeSpec: { date: '2026-09-10', time: '08:00', timezone: TZ },
  }), context('2026-09-14T10:00:00+03:00'));

  assert.notEqual(question?.questionKey, 'ask_am_pm');
});

test('a day with no hour is asked as a time, with a no-time answer always available', () => {
  const question = buildClarification(result({
    timeEvidence: 'day_only',
    localTimeSpec: { date: '2026-09-15', time: null, timezone: TZ },
    ambiguityFlags: ['vague_time'],
  }), context('2026-09-14T10:00:00+03:00'));

  assert.equal(question?.questionKey, 'ask_time');
  assert.deepEqual(question?.options.map(o => o.optionId), ['morning', 'afternoon', 'evening', 'none']);
  assert.deepEqual(question?.options.map(o => o.value.localTime), ['09:00', '14:00', '19:00', undefined]);
  // A commitment without an hour is a legitimate thing to want; forcing one
  // would be the product insisting on an answer the user does not have.
  assert.deepEqual(question?.options.at(-1)?.value, {});
});

test('the parts of today that have gone are not offered', () => {
  // Asked at 16:00 with no date: morning and afternoon have gone today, so they
  // are offered on tomorrow; evening is still ahead today.
  const question = buildClarification(result({ timeEvidence: 'none' }), context('2026-09-14T16:00:00+03:00'));

  assert.equal(question?.questionKey, 'ask_time');
  const byId = Object.fromEntries(question!.options.map(o => [o.optionId, o.value]));
  assert.equal(byId.evening?.localDate, '2026-09-14', 'this evening is still ahead');
  assert.equal(byId.morning?.localDate, '2026-09-15', 'this morning has gone');
  assert.equal(byId.afternoon?.localDate, '2026-09-15', 'this afternoon has gone');
});

test('every option the builder ever returns is in the future', () => {
  // The property that matters most: offering a past option invites a tap that
  // the save then refuses, which reads as the product breaking rather than as
  // the product having asked a bad question.
  const hours = ['00:30', '05:00', '08:00', '11:59', '13:00', '16:00', '20:00', '23:45'];
  const evidences: ExtractionResult['timeEvidence'][] = ['none', 'day_only', 'clock_marker', 'daypart', 'ampm', 'hhmm'];
  const dates = ['2026-09-13', '2026-09-14', '2026-09-15', null];

  for (const at of hours) {
    const ctx = context(`2026-09-14T${at}:00+03:00`);
    for (const evidence of evidences) {
      for (const date of dates) {
        for (const time of [null, '08:00', '19:00']) {
          const question = buildClarification(result({
            timeEvidence: evidence,
            localTimeSpec: date ? { date, time, timezone: TZ } : null,
          }), ctx);
          for (const candidate of question?.options ?? []) {
            const { localDate, localTime } = candidate.value;
            if (!localDate || !localTime) continue;
            const instant = instantFromLocal(localDate, localTime, TZ);
            assert.ok(
              instant && instant.getTime() > ctx.now.getTime(),
              `offered ${localDate} ${localTime} at ${ctx.now.toISOString()} (${evidence})`,
            );
          }
        }
      }
    }
  }
});

test('the question never carries a sentence, only keys and parameters', () => {
  // The whole reason the server does not phrase these.
  const questions = [
    buildClarification(result({ action: null, ambiguityFlags: ['vague_action'] }), context('2026-09-14T10:00:00+03:00')),
    buildClarification(result({ timeEvidence: 'clock_marker', localTimeSpec: { date: '2026-09-15', time: '08:00', timezone: TZ } }), context('2026-09-14T10:00:00+03:00')),
    buildClarification(result({ timeEvidence: 'day_only', localTimeSpec: { date: '2026-09-15', time: null, timezone: TZ } }), context('2026-09-14T10:00:00+03:00')),
  ];

  const KEYS = ['ask_time', 'ask_action', 'ask_am_pm', 'ask_day'];
  for (const question of questions) {
    assert.ok(question, 'expected a question');
    assert.ok(KEYS.includes(question!.questionKey), question!.questionKey);
    // A label is a key, not a sentence: no spaces, no punctuation.
    for (const candidate of question!.options) {
      assert.match(candidate.labelKey, /^[a-zA-Z][a-zA-Z0-9_]*$/, candidate.labelKey);
    }
    // And the whole object carries nothing sentence-shaped except the user's own
    // title, which they wrote themselves.
    const serialized = JSON.stringify({ ...question, params: { ...question!.params, title: '' } });
    assert.ok(!/[.!?]/.test(serialized), `question carries prose: ${serialized}`);
  }
});

test('each question gets its own id, so an answer cannot be replayed onto another', () => {
  const a = buildClarification(result({ timeEvidence: 'none' }), context('2026-09-14T10:00:00+03:00'));
  const b = buildClarification(result({ timeEvidence: 'none' }), context('2026-09-14T10:00:00+03:00'));
  assert.notEqual(a?.questionId, b?.questionId);
  assert.match(a!.questionId, /^[0-9a-f-]{36}$/);
});
