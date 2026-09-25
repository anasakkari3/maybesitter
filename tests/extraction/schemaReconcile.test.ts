/**
 * The time is decided here, not by the model (UC-2.2, #162).
 *
 * Every test in this file is about one promise: a user never receives a time
 * they did not give. The interesting cases are the ones where the model is
 * confident and wrong, because those are the ones a prompt cannot fix.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileLocalTimeSpec, validateExtractionResult } from '../../src/extraction/schemaValidator.ts';
import { extract } from '../../src/extraction/ruleBasedExtractor.ts';
import { decideExtractionDisposition } from '../../src/extraction/extractionPolicy.ts';
import { forbidsResolvedTime, timeOfDayEvidence } from '../../src/extraction/timeLexicon.ts';
import type { ExtractionContext } from '../../src/extraction/extractionTypes.ts';

const berlin: ExtractionContext = { now: new Date('2026-09-13T08:00:00.000Z'), timezone: 'Europe/Berlin' };
const utc: ExtractionContext = { now: new Date('2026-09-13T08:00:00.000Z'), timezone: 'UTC' };

/** A complete, schema-valid model answer, with the time left to the caller. */
function modelAnswer(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'task',
    action: 'call the clinic',
    title: 'Call the clinic',
    person: null,
    dueAt: null,
    remindAt: null,
    localTimeSpec: null,
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureImplied: false },
    flexibility: 'movable',
    confidence: { overall: 0.95, type: 0.95, action: 0.95, time: 0.95, priority: 0.8 },
    missingFields: [],
    ambiguityFlags: [],
    explicitReminderRequest: true,
    explicitPressureRequest: false,
    ...over,
  };
}

test('reconcile: a model instant three hours off its own localTimeSpec is corrected to the spec', () => {
  // The model read "tomorrow at 09:00" correctly and then did the timezone
  // arithmetic wrong — the single most common way a hosted model mis-times a
  // capture, and it is silent because both halves look plausible.
  const result = validateExtractionResult(
    modelAnswer({
      // 09:00 in Europe/Berlin on 2026-09-14 is 07:00Z. The model said 10:00Z.
      dueAt: '2026-09-14T10:00:00.000Z',
      remindAt: '2026-09-14T10:00:00.000Z',
      localTimeSpec: { date: '2026-09-14', time: '09:00', timezone: 'Europe/Berlin' },
    }),
    'call the clinic tomorrow at 09:00',
    berlin,
  );

  assert.equal(result.dueAt, '2026-09-14T07:00:00.000Z', 'the wall clock has to win over the model arithmetic');
  assert.equal(result.remindAt, '2026-09-14T07:00:00.000Z');
  assert.equal(result.localTimeSpec?.time, '09:00');
  // Three hours is an offset mistake, not a disagreement about the day.
  assert.ok(!result.ambiguityFlags.includes('contradictory_time'));
});

test('reconcile: past twelve hours apart, the disagreement is reported as well as corrected', () => {
  const result = validateExtractionResult(
    modelAnswer({
      dueAt: '2026-09-15T22:00:00.000Z',
      remindAt: '2026-09-15T22:00:00.000Z',
      localTimeSpec: { date: '2026-09-14', time: '09:00', timezone: 'Europe/Berlin' },
    }),
    'call the clinic tomorrow at 09:00',
    berlin,
  );

  assert.equal(result.dueAt, '2026-09-14T07:00:00.000Z');
  assert.ok(result.ambiguityFlags.includes('contradictory_time'));
});

test('reconcile: the zone is the device’s, never the one the model named', () => {
  // A model that names a timezone is guessing at one. Honouring the guess would
  // move the instant by however far the guess was wrong.
  const result = validateExtractionResult(
    modelAnswer({
      dueAt: '2026-09-14T09:00:00.000Z',
      remindAt: '2026-09-14T09:00:00.000Z',
      localTimeSpec: { date: '2026-09-14', time: '09:00', timezone: 'Pacific/Auckland' },
    }),
    'call the clinic tomorrow at 09:00',
    berlin,
  );

  assert.equal(result.localTimeSpec?.timezone, 'Europe/Berlin');
  assert.equal(result.dueAt, '2026-09-14T07:00:00.000Z', 'resolved against the device zone');
});

test('no invented time: "call mom" plus a model-invented remindAt yields null and vague_time', () => {
  const result = validateExtractionResult(
    modelAnswer({
      action: 'call mom',
      title: 'Call mom',
      dueAt: '2026-09-13T17:00:00.000Z',
      remindAt: '2026-09-13T17:00:00.000Z',
      localTimeSpec: { date: '2026-09-13', time: '19:00', timezone: 'Europe/Berlin' },
    }),
    'call mom',
    berlin,
  );

  assert.equal(result.remindAt, null);
  assert.equal(result.dueAt, null);
  assert.ok(result.ambiguityFlags.includes('vague_time'));
  assert.equal(result.timeEvidence, 'none');
  // And it must not be reported as a confident reading of the time.
  assert.ok(result.confidence.time <= 0.1, `time confidence was ${result.confidence.time}`);
});

test('no invented time: a day with no hour keeps the day and drops the hour', () => {
  const result = validateExtractionResult(
    modelAnswer({
      dueAt: '2026-09-14T16:00:00.000Z',
      remindAt: '2026-09-14T16:00:00.000Z',
      localTimeSpec: { date: '2026-09-14', time: '18:00', timezone: 'Europe/Berlin' },
    }),
    'call the clinic tomorrow',
    berlin,
  );

  assert.equal(result.remindAt, null, 'no hour was stated, so there is no instant');
  assert.equal(result.timeEvidence, 'day_only');
  assert.ok(result.ambiguityFlags.includes('vague_time'));
  // The day is what makes "what time on Monday?" possible instead of "when?".
  assert.equal(result.localTimeSpec?.date, '2026-09-14');
  assert.equal(result.localTimeSpec?.time, null);
});

test('no invented time: אתקשר לדוד מחר בשמונה is vague, and vague deliberately', () => {
  // "Tomorrow at eight" — but which eight. The Hebrew carries no meridiem and
  // no part-of-day word, and this must hold because a rule fired, not because
  // nothing in the codebase could read Hebrew.
  const text = 'אתקשר לדוד מחר בשמונה';
  assert.equal(timeOfDayEvidence(text), 'day_only', 'bare spoken hour is not time-of-day evidence');

  const result = validateExtractionResult(
    modelAnswer({
      action: 'להתקשר לדוד',
      title: 'להתקשר לדוד',
      dueAt: '2026-09-14T06:00:00.000Z',
      remindAt: '2026-09-14T06:00:00.000Z',
      localTimeSpec: { date: '2026-09-14', time: '08:00', timezone: 'Europe/Berlin' },
    }),
    text,
    berlin,
  );

  assert.equal(result.remindAt, null);
  assert.ok(result.ambiguityFlags.includes('vague_time'));
});

test('a clock time the user marked is kept, even with no AM/PM', () => {
  // «الساعة 5» is the user's number. It survives — and the frozen gate case
  // depends on it surviving — but it is named `clock_marker`, because which
  // five is ours to guess.
  const result = extract('ذكرني بكرة الساعة 5 أحكي مع أحمد', {
    now: new Date('2026-07-27T10:00:00+03:00'),
    timezone: 'Asia/Jerusalem',
  });

  assert.equal(result.remindAt, '2026-07-28T02:00:00.000Z', '05:00 Asia/Jerusalem');
  assert.equal(result.timeEvidence, 'clock_marker');
  // A guessed meridiem is a twelve-hour error; it does not auto-confirm.
  assert.equal(decideExtractionDisposition(result), 'pending_confirmation');
});

test('a part of day is evidence: the period is the user’s even though the hour is ours', () => {
  const morning = extract('بكرة الصبح لازم أروح عالشغل', {
    now: new Date('2026-07-27T10:00:00+03:00'),
    timezone: 'Asia/Jerusalem',
  });
  assert.equal(morning.timeEvidence, 'daypart');
  assert.equal(morning.remindAt, '2026-07-28T06:00:00.000Z', '09:00 Asia/Jerusalem');

  // Hebrew evening must be readable by the guard, or the reconciler would strip
  // a perfectly good time out of every Hebrew evening reminder.
  assert.equal(timeOfDayEvidence('מחר בערב צריך לשלם'), 'daypart');
  assert.equal(forbidsResolvedTime('מחר בערב צריך לשלם'), false);
});

test('no_action_verb survives the validator instead of being silently dropped', () => {
  const result = validateExtractionResult(
    modelAnswer({ ambiguityFlags: ['no_action_verb'], dueAt: null, remindAt: null, localTimeSpec: null }),
    'the pharmacy on the corner',
    utc,
  );
  assert.ok(result.ambiguityFlags.includes('no_action_verb'));
});

test('reconcileLocalTimeSpec is pure and decides from the text alone', () => {
  // Called directly: no model, no schema, just the rule.
  const kept = reconcileLocalTimeSpec(
    { dueAt: '2026-09-14T07:00:00.000Z', remindAt: null, localTimeSpec: { date: '2026-09-14', time: '09:00', timezone: 'Europe/Berlin' } },
    'tomorrow at 9am',
    berlin,
  );
  assert.equal(kept.dueAt, '2026-09-14T07:00:00.000Z');
  assert.deepEqual(kept.flags, []);

  const stripped = reconcileLocalTimeSpec(
    { dueAt: '2026-09-14T07:00:00.000Z', remindAt: null, localTimeSpec: null },
    'buy milk',
    berlin,
  );
  assert.equal(stripped.dueAt, null);
  assert.deepEqual(stripped.flags, ['vague_time']);
});

test('the whole evidence ladder, in one table', () => {
  const rows: Array<[string, string]> = [
    ['Team meeting tomorrow from 14:00 to 15:00', 'hhmm'],
    ['Remind me to call Ahmad tomorrow at 7 PM.', 'ampm'],
    ['ذكرني أتصل بأحمد بكرة الساعة ٧ مساءً', 'ampm'],
    ['بكرة الصبح لازم أروح عالشغل', 'daypart'],
    ['מחר בערב צריך לשלם את החשבון', 'daypart'],
    ['Call the clinic tomorrow at 9', 'clock_marker'],
    ['ذكرني بكرة الساعة 5 أحكي مع أحمد', 'clock_marker'],
    ['Remind me tomorrow to call mom', 'day_only'],
    ['עندي محاضرة يوم الأحد الجاي', 'day_only'],
    ['call mom', 'none'],
    ['Buy milk.', 'none'],
  ];
  for (const [text, expected] of rows) {
    assert.equal(timeOfDayEvidence(text), expected, text);
  }
});

test('reconcile: negated requests in all three languages force negated_request flag and cap confidence (#401)', () => {
  const modelOutput = (title: string) => ({
    type: 'task',
    action: title,
    title,
    person: null,
    dueAt: null,
    remindAt: null,
    localTimeSpec: null,
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureImplied: false },
    flexibility: 'movable',
    confidence: { overall: 0.95, type: 0.95, action: 0.95, time: 0.95, priority: 0.8 },
    missingFields: [],
    ambiguityFlags: [],
    explicitReminderRequest: false,
    explicitPressureRequest: false,
  });

  for (const text of [
    "don't remind me about gym",
    'لا تذكرني بالجيم بعد اليوم',
    'لا تذكريني بالجيم بعد اليوم',
    'ما بدي تذكير بهالموضوع',
    'אל תזכיר לי יותר על החדר כושר',
    'אל תזכירי לי יותר על החדר כושר',
    'תזכיר לי not to worry about it',
  ]) {
    const res = validateExtractionResult(modelOutput(text), text, berlin);
    assert.ok(res.ambiguityFlags.includes('negated_request'), `${text} missing negated_request flag`);
    assert.ok(res.confidence.overall <= 0.55, `${text} confidence not capped: ${res.confidence.overall}`);
  }

  const cleanAr = validateExtractionResult(modelOutput('ذكرني بالجيم بكرا'), 'ذكرني بالجيم بكرا', berlin);
  assert.ok(!cleanAr.ambiguityFlags.includes('negated_request'));
  assert.equal(cleanAr.confidence.overall, 0.95);

  const cleanHe = validateExtractionResult(modelOutput('תזכיר לי מחר על החדר כושר'), 'תזכיר לי מחר על החדר כושר', berlin);
  assert.ok(!cleanHe.ambiguityFlags.includes('negated_request'));
  assert.equal(cleanHe.confidence.overall, 0.95);
});

