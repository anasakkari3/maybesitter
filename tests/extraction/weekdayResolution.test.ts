/**
 * Which day "Sunday" is, and that it is a guess.
 *
 * The owner said «سجّل موعد دكتور يوم الأحد» on a first iPhone run. The app
 * resolved it to the nearest Sunday — *including today* — and showed only the
 * weekday name, so "this Sunday" and "next Sunday" looked the same and nothing
 * said the day had been assumed.
 *
 * The rule tested here is a controller ruling and is written down in
 * `src/extraction/weekdayLexicon.ts`:
 *
 *   - a bare weekday, «الأحد الجاي/القادم», "next Sunday", «יום ראשון (הבא)»
 *     resolve to the nearest upcoming Sunday that is NOT today (today+7 when
 *     today is Sunday) — in Levantine «الجاي» is "the coming one";
 *   - only an explicit following-week phrase moves one week further:
 *     «مش هالأحد، اللي بعده», «الأحد اللي بعد الجاي», "the Sunday after next",
 *     «בעוד שבוע ביום ראשון»;
 *   - «اليوم/هلأ» naming today's weekday keeps today;
 *   - every weekday-only resolution is marked as an inferred date.
 *
 * Every case runs against a fixed clock, once for each day of the week.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { extract } from '../../src/extraction/ruleBasedExtractor.ts';
import { validateExtractionResult } from '../../src/extraction/schemaValidator.ts';
import {
  daysUntilWeekday,
  readWeekdayReference,
  resolveWeekdayDate,
} from '../../src/extraction/weekdayLexicon.ts';
import type { ExtractionContext } from '../../src/extraction/extractionTypes.ts';

const TZ = 'Asia/Jerusalem';

/** 2026-09-20 is a Sunday. Index = weekday (0 = Sunday … 6 = Saturday). */
const WEEK = ['2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26'];

/** Ten in the morning, Jerusalem time, on the given local date. */
function at(date: string): ExtractionContext {
  return { now: new Date(`${date}T10:00:00+03:00`), timezone: TZ };
}

function plusDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** The Sunday the ruling expects, from a clock on weekday `today`. */
function expectedSunday(today: number, weeksLater: 0 | 1): string {
  const ahead = ((0 - today + 7) % 7) || 7;
  return plusDays(WEEK[today]!, ahead + weeksLater * 7);
}

// ── The nearest upcoming Sunday that is not today ──────────────────────

const NEAREST_SUNDAY: readonly string[] = [
  'موعد دكتور يوم الأحد',
  'سجّل موعد دكتور يوم الأحد',
  'موعد دكتور يوم الأحد الجاي',
  'موعد دكتور الأحد القادم',
  'doctor appointment on Sunday',
  'doctor appointment next Sunday',
  'תור לרופא ביום ראשון',
  'תור לרופא ביום ראשון הבא',
];

for (const phrase of NEAREST_SUNDAY) {
  for (let today = 0; today < 7; today += 1) {
    test(`rules: «${phrase}» on weekday ${today} is the nearest Sunday that is not today, and a guess`, () => {
      const result = extract(phrase, at(WEEK[today]!));
      assert.equal(result.localTimeSpec?.date, expectedSunday(today, 0));
      assert.equal(result.dateInferred, true);
    });
  }
}

test('rules: on a Sunday, a bare «الأحد» is next Sunday, never today', () => {
  const result = extract('موعد دكتور يوم الأحد', at(WEEK[0]!));
  assert.equal(result.localTimeSpec?.date, '2026-09-27');
});

// ── Only an explicit following-week phrase moves a week further ────────

const FOLLOWING_SUNDAY: readonly string[] = [
  'موعد دكتور مش هالأحد، اللي بعده',
  'موعد دكتور الأحد اللي بعد الجاي',
  'doctor appointment the Sunday after next',
  'תור לרופא בעוד שבוע ביום ראשון',
];

for (const phrase of FOLLOWING_SUNDAY) {
  for (let today = 0; today < 7; today += 1) {
    test(`rules: «${phrase}» on weekday ${today} is one week after the nearest Sunday`, () => {
      const result = extract(phrase, at(WEEK[today]!));
      assert.equal(result.localTimeSpec?.date, expectedSunday(today, 1));
      assert.equal(result.dateInferred, true);
    });
  }
}

test('rules: a following-week phrase leaves no residue in the title', () => {
  assert.equal(extract('موعد دكتور الأحد اللي بعد الجاي', at(WEEK[3]!)).title, 'موعد دكتور');
  assert.equal(extract('موعد دكتور مش هالأحد، اللي بعده', at(WEEK[3]!)).title, 'موعد دكتور');
  assert.equal(extract('dentist the Sunday after next', at(WEEK[3]!)).title, 'dentist');
});

// ── Today, when the text says today ────────────────────────────────────

test('rules: «اليوم الأحد» on a Sunday keeps today, and today is not a guess', () => {
  const result = extract('اليوم الأحد عندي دكتور', at(WEEK[0]!));
  assert.equal(result.localTimeSpec?.date, WEEK[0]);
  assert.equal(result.dateInferred, false);
});

test('rules: «هلأ» with today\'s weekday keeps today', () => {
  assert.equal(readWeekdayReference('هلأ الأحد')?.today, true);
  assert.equal(extract('هلأ الأحد عندي دكتور', at(WEEK[0]!)).localTimeSpec?.date, WEEK[0]);
});

// ── What is not a weekday resolution is not marked ─────────────────────

test('rules: tomorrow is stated, not inferred', () => {
  const result = extract('دكتور بكرا', at(WEEK[3]!));
  assert.equal(result.localTimeSpec?.date, WEEK[4]);
  assert.notEqual(result.dateInferred, true);
});

test('rules: a sentence with no day at all carries no inferred date', () => {
  assert.notEqual(extract('call the plumber', at(WEEK[3]!)).dateInferred, true);
});

// ── The pure resolver, for every weekday offset ────────────────────────

test('resolver: every (today, target) pair lands 1..7 days ahead, never 0', () => {
  for (let today = 0; today < 7; today += 1) {
    for (let target = 0; target < 7; target += 1) {
      const days = daysUntilWeekday(today, { weekday: target, weeksLater: 0, today: false });
      assert.ok(days >= 1 && days <= 7, `today=${today} target=${target} days=${days}`);
      assert.equal((today + days) % 7, target);
      assert.equal(daysUntilWeekday(today, { weekday: target, weeksLater: 1, today: false }), days + 7);
    }
  }
});

test('resolver: resolves in the user\'s zone, not UTC', () => {
  // 23:30 on Saturday in Jerusalem is 20:30 UTC Saturday; 00:30 Sunday in
  // Jerusalem is still Saturday in UTC. The day is the user's.
  const sundayJustAfterMidnight = new Date('2026-09-20T00:30:00+03:00');
  assert.equal(resolveWeekdayDate('الأحد', sundayJustAfterMidnight, TZ)?.date, '2026-09-27');
});

// ── The model path is held to the same rule ────────────────────────────

function modelSays(localTimeSpec: Record<string, unknown> | null, over: Record<string, unknown> = {}) {
  return {
    type: 'task',
    action: 'موعد دكتور',
    title: 'موعد دكتور',
    person: null,
    dueAt: null,
    remindAt: null,
    localTimeSpec,
    priority: { level: 'high', source: 'inferred', pressureAllowed: false, pressureImplied: false },
    flexibility: 'movable',
    confidence: { overall: 0.9, type: 0.9, action: 0.9, time: 0.9, priority: 0.8 },
    missingFields: [],
    ambiguityFlags: [],
    explicitReminderRequest: false,
    explicitPressureRequest: false,
    ...over,
  };
}

test('validator: a model that resolves «الأحد» to today on a Sunday is corrected to next Sunday', () => {
  const result = validateExtractionResult(
    modelSays({ date: WEEK[0], time: '10:00', timezone: TZ }),
    'موعد دكتور يوم الأحد الساعة 10 الصبح',
    at(WEEK[0]!),
  );
  assert.equal(result.localTimeSpec?.date, '2026-09-27');
  assert.equal(result.localTimeSpec?.time, '10:00');
  assert.equal(result.dateInferred, true);
});

test('validator: the instant moves with the corrected day', () => {
  const result = validateExtractionResult(
    modelSays(
      { date: WEEK[0], time: '10:00', timezone: TZ },
      { dueAt: '2026-09-20T07:00:00.000Z', remindAt: '2026-09-20T07:00:00.000Z' },
    ),
    'موعد دكتور يوم الأحد الساعة 10 الصبح',
    at(WEEK[0]!),
  );
  assert.equal(result.dueAt, '2026-09-27T07:00:00.000Z');
  assert.equal(result.remindAt, '2026-09-27T07:00:00.000Z');
});

test('validator: a day-only weekday is kept as a day and marked inferred', () => {
  const result = validateExtractionResult(modelSays(null), 'سجّل موعد دكتور يوم الأحد', at(WEEK[3]!));
  assert.equal(result.localTimeSpec?.date, '2026-09-27');
  assert.equal(result.localTimeSpec?.time, null);
  assert.equal(result.dateInferred, true);
});

test('validator: a stated calendar date is left to the model and not called a guess', () => {
  const result = validateExtractionResult(
    modelSays({ date: '2026-10-04', time: '10:00', timezone: TZ }),
    'dentist Sunday 4/10 at 10:00',
    at(WEEK[3]!),
  );
  assert.equal(result.localTimeSpec?.date, '2026-10-04');
  assert.notEqual(result.dateInferred, true);
});

test('validator: "tomorrow" beside a weekday is the model\'s call, not overruled', () => {
  const result = validateExtractionResult(
    modelSays({ date: WEEK[4], time: '09:00', timezone: TZ }),
    'tomorrow at 09:00 prepare slides for Sunday',
    at(WEEK[3]!),
  );
  assert.equal(result.localTimeSpec?.date, WEEK[4]);
  assert.notEqual(result.dateInferred, true);
});
