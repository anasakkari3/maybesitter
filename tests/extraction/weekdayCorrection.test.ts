/**
 * A model date that is not on the weekday the words name is corrected (QA
 * audit NA2.3; owner decision 2026-11-17, option (a)).
 *
 * On Thursday 12 November Gemini dated «السبت الجاي» a Sunday, «الإثنين
 * الجاي» a Tuesday, «الخميس الجاي» a Friday and «ביום ראשון הבא» a Monday
 * (capture list eval, lane B3) — each a day the person never named. The
 * validator now puts such a date on the day the rules read from the words
 * (`resolveWeekdayDate`), at the same hour. Only then: a model date already
 * on the named weekday — "next Sunday" read as the Sunday after, for one — is
 * left alone (L4), and so is a text that names no weekday, several, a
 * recurrence, or another statement of its date.
 *
 * Synthetic text only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateExtractionResult } from '../../src/extraction/schemaValidator.ts';
import { instantFromLocal } from '../../src/extraction/timeLexicon.ts';
import { createEmptyDomainState } from '../../src/domain/stateMachine.ts';
import { MemoryCaptureProposalStore, proposeCapture } from '../../lib/services/captureBoundary/index.ts';

const TZ = 'Asia/Jerusalem';
/** Thursday 12 November 2026, 08:00 in Jerusalem. */
const NOW = new Date('2026-11-12T06:00:00.000Z');
const context = { now: NOW, timezone: TZ };

const at = (date: string, time: string) => instantFromLocal(date, time, TZ)!.toISOString();

/** The model's object for one clause: a task on `date`, at `time` when given. */
const model = (title: string, date: string, time: string | null) => ({
  type: 'task', action: title, title, person: null,
  dueAt: time ? at(date, time) : null, remindAt: null,
  localTimeSpec: { date, time, timezone: TZ },
  priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureImplied: false },
  flexibility: 'movable', category: null, categoryConfidence: 0,
  confidence: { overall: 0.9, type: 1, action: 0.9, time: 0.9, priority: 1 },
  missingFields: time ? [] : ['time'], ambiguityFlags: [], explicitReminderRequest: false, explicitPressureRequest: false,
});

for (const [label, text, title, modelDate, time, expected] of [
  ['ar «السبت الجاي» read as Sunday', 'السبت الجاي لازم أنظف السيارة', 'أنظف السيارة', '2026-11-15', null, '2026-11-14'],
  ['ar «الإثنين الجاي» read as Tuesday', 'الإثنين الجاي الساعة 9 الصبح امتحان السواقة', 'امتحان السواقة', '2026-11-17', '09:00', '2026-11-16'],
  ['ar «الخميس الجاي» on a Thursday, read as Friday', 'الخميس الجاي الساعة 8 المسا عزومة عند خالتي', 'عزومة عند خالتي', '2026-11-20', '20:00', '2026-11-19'],
  ['he «ביום ראשון הבא» read as Monday', 'ביום ראשון הבא ב-10:00 תור לרופא', 'תור לרופא', '2026-11-23', '10:00', '2026-11-15'],
  ['en "next Monday" read as Tuesday', 'next Monday at 9am driving test', 'driving test', '2026-11-17', '09:00', '2026-11-16'],
] as const) {
  test(`NA2.3 (${label}): moved to the named weekday, at the same hour`, () => {
    const result = validateExtractionResult(model(title, modelDate, time), text, context);
    assert.equal(result.localTimeSpec?.date, expected);
    assert.equal(result.localTimeSpec?.time ?? null, time);
    assert.equal(result.dueAt, time ? at(expected, time) : result.dueAt);
    assert.equal(result.weekdayCorrected, true);
  });
}

test('NA2.3: «السبت الجاي» said the day before is tomorrow, as on the rules path', () => {
  // Friday 13 November: the nearest Saturday that is not today is tomorrow.
  // («الجمعة الجاي» is not used here: «الجمعة» is also "the week", and the
  // lexicon reads «الجمعة الجاي» as next week, a date of its own.)
  const friday = { now: new Date('2026-11-13T06:00:00.000Z'), timezone: TZ };
  const result = validateExtractionResult(model('أتصل بخالي', '2026-11-15', null), 'السبت الجاي لازم أتصل بخالي', friday);
  assert.equal(result.localTimeSpec?.date, '2026-11-14');
  assert.equal(result.weekdayCorrected, true);
});

for (const [label, text, modelDate, time] of [
  ['the model date is already on the named weekday ("next Sunday" as the Sunday after)', 'next Sunday at 10am dentist appointment', '2026-11-22', '10:00'],
  ['no weekday in the words', 'tomorrow at 5pm call mom', '2026-11-14', '17:00'],
  ['two weekdays in the words', 'Sunday school report due Monday', '2026-11-17', null],
  ['a recurrence', 'every Saturday at 10am gym', '2026-11-15', '10:00'],
  ['a relative day beside the weekday', 'بكرا يوم السبت لازم أتصل', '2026-11-15', null],
  ['a calendar date beside the weekday', 'Saturday 21 November at 10am dentist', '2026-11-21', '10:00'],
  ['«الاثنين» may be "the two"', 'اشتري الاثنين الساعة 5 المسا', '2026-11-12', '17:00'],
] as const) {
  test(`NA2.3: untouched when ${label}`, () => {
    const result = validateExtractionResult(model('item', modelDate, time), text, context);
    assert.equal(result.localTimeSpec?.date, modelDate);
    assert.notEqual(result.weekdayCorrected, true);
  });
}

test('NA2.3: the correction is logged content-free, with no words of the capture', async () => {
  const lines: string[] = [];
  const info = console.info;
  console.info = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    const text = 'السبت الجاي لازم أنظف السيارة';
    const proposal = await proposeCapture(
      text,
      { now: NOW, timezone: TZ, scopeId: 'na23-weekday', requestedEngine: 'model' },
      {
        store: new MemoryCaptureProposalStore(),
        llmProvider: async () => JSON.stringify(model('أنظف السيارة', '2026-11-15', null)),
        llmEngine: 'gemini',
        persistence: { snapshot: async () => createEmptyDomainState(), persistAtomically: async () => ({ state: createEmptyDomainState() }) },
      } as never,
    );
    assert.equal(proposal.items[0]!.resolvedDate, '2026-11-14');
    const logged = lines.filter((line) => line.includes('capture_weekday_corrected'));
    assert.equal(logged.length, 1);
    assert.deepEqual(JSON.parse(logged[0]!), { event: 'capture_weekday_corrected' });
    assert.ok(!logged[0]!.includes('السيارة') && !logged[0]!.includes('السبت'));
  } finally {
    console.info = info;
  }
});
