import test from 'node:test';
import assert from 'node:assert/strict';
import { decideEscalation } from '../../src/extraction/escalationGate.ts';
import type { ExtractionResult } from '../../src/extraction/extractionTypes.ts';

function baseResult(over: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    type: 'task',
    action: 'call',
    title: 'call Ahmad',
    person: null,
    dueAt: '2026-08-22T15:00:00.000Z',
    remindAt: '2026-08-22T14:00:00.000Z',
    localTimeSpec: { date: '2026-08-22', time: '17:00', timezone: 'Asia/Jerusalem' },
    timeEvidence: 'hhmm',
    priority: { level: 'normal', source: 'inferred', pressureAllowed: true, pressureImplied: false },
    flexibility: 'movable',
    category: null,
    categoryConfidence: 0,
    confidence: { overall: 0.9, type: 0.9, action: 0.9, time: 0.9, priority: 0.8 },
    missingFields: [],
    ambiguityFlags: [],
    explicitReminderRequest: false,
    explicitPressureRequest: false,
    rawText: 'call Ahmad tomorrow at 3pm',
    parserVersion: 'test-v1',
    ...over,
  };
}

test('a confident single commitment does not escalate', () => {
  assert.equal(decideEscalation(baseResult(), 'call Ahmad tomorrow at 3pm').escalate, false);
});

test('multiple_commitments always escalates — splitting is what we cannot get wrong', () => {
  const d = decideEscalation(
    baseResult({ ambiguityFlags: ['multiple_commitments'] }),
    'work at five then gym at seven',
  );
  assert.equal(d.escalate, true);
  assert.ok(d.reasons.includes('multiple_commitments'));
});

test('low time confidence escalates', () => {
  const d = decideEscalation(
    baseResult({ confidence: { overall: 0.9, type: 0.9, action: 0.9, time: 0.4, priority: 0.8 } }),
    'sometime after work',
  );
  assert.equal(d.escalate, true);
  assert.ok(d.reasons.includes('low_time_confidence'));
});

test('low overall confidence escalates', () => {
  const d = decideEscalation(
    baseResult({ confidence: { overall: 0.5, type: 0.5, action: 0.5, time: 0.9, priority: 0.8 } }),
    'whatever that thing was',
  );
  assert.ok(d.reasons.includes('low_overall_confidence'));
});

test('an unresolved Arabic pronoun escalates even at high confidence', () => {
  const d = decideEscalation(baseResult(), 'بعد ما أخلص شغل بمرّ عليها');
  assert.equal(d.escalate, true);
  assert.ok(d.reasons.includes('unresolved_reference'));
});

test('all firing reasons are reported, not just the first', () => {
  const d = decideEscalation(
    baseResult({
      ambiguityFlags: ['multiple_commitments'],
      confidence: { overall: 0.4, type: 0.4, action: 0.4, time: 0.3, priority: 0.8 },
    }),
    'بمرّ عليها بعدين',
  );
  assert.ok(d.reasons.length >= 3, `expected several reasons, got ${d.reasons.join(',')}`);
});

test("the plan's own construct-state fixture escalates", () => {
  // evaluation-data/dialect-suite.jsonl ar-3. The definite article is absent in
  // the construct state, which the first pattern required -- so the one sentence
  // the plan chose to illustrate an unresolvable reference sailed through.
  const decision = decideEscalation(
    baseResult(),
    'نفس موعد الأسبوع الماضي بس أبكر شوي',
  );
  assert.deepEqual(decision.reasons, ['unresolved_reference']);
});

test('a Hebrew comparison to an earlier commitment escalates', () => {
  assert.deepEqual(
    decideEscalation(baseResult(), 'אותה שעה מחר בבוקר').reasons,
    ['unresolved_reference'],
  );
});

test('an Arabic reference to somebody’s place escalates', () => {
  assert.deepEqual(
    decideEscalation(baseResult(), 'لازم أروح عندها بكرا').reasons,
    ['unresolved_reference'],
  );
});

test('a resolved Arabic sentence does not escalate on a substring', () => {
  // JS \b is ASCII-only, so it does nothing in Arabic: عنده matched inside
  // عندهم, and معه inside الجامعه. Fully resolved sentences escalated.
  for (const sentence of [
    'بكرة عندي محاضرة بالجامعه الساعة عشرة',
    'عندهم عزيمة بكرة الساعة سبعة',
    'اجتماع مع أحمد الساعة تسعة',
  ]) {
    assert.deepEqual(decideEscalation(baseResult(), sentence).reasons, [], sentence);
  }
});

test('an ordinary English pronoun is not an unresolved reference', () => {
  // A pronoun in object position changes no extracted field -- not the title,
  // the time, the split or the priority -- and the arbiter has no history to
  // resolve it with either. Escalating bought nothing and fired on most
  // English captures, against a design whose premise is that only doubtful
  // captures cost anything.
  for (const sentence of [
    'remind me there is a dentist appointment tomorrow at 3pm',
    'pick up the kids from her school at 2pm',
    'lunch with Sarah there at noon',
    'meet him at the clinic at 9',
  ]) {
    assert.deepEqual(decideEscalation(baseResult(), sentence).reasons, [], sentence);
  }
});

test('an English comparison to an earlier commitment still escalates', () => {
  // The signal that survives: a reference the model cannot resolve without
  // history, which is the case the plan chose to illustrate.
  assert.deepEqual(
    decideEscalation(baseResult(), 'book it same time as last week').reasons,
    ['unresolved_reference'],
  );
});
