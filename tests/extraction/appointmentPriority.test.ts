/**
 * A fixed appointment is a Must, and the product says it guessed so.
 *
 * The owner said «سجّل موعد دكتور يوم الأحد» and the review card read «يُفضّل»
 * (should). Nothing in the rules path, the prompt or the validator knew that a
 * doctor on a named day is not optional: `inferPriority` returned `normal`
 * unless an urgency word appeared, and `normal` renders as Should.
 *
 * The rule: an appointment-type commitment — doctor, dentist, clinic,
 * hospital, exam, interview, flight, court — with a fixed day or time defaults
 * to `high`, source `inferred`. A meeting counts only with a clock time. It is
 * still a guess, so `priorityEstimated` stays true and the «حزرناها» chip
 * shows. Plain tasks, and arranging an appointment ("call the dentist", «احجز
 * موعد»), are not raised.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { extract } from '../../src/extraction/ruleBasedExtractor.ts';
import { validateExtractionResult } from '../../src/extraction/schemaValidator.ts';
import { buildPrompt } from '../../src/extraction/ollamaExtractor.ts';
import { proposeCapture, MemoryCaptureProposalStore, TransactionalCapturePersistenceAdapter } from '../../lib/services/captureBoundary/index.ts';
import { createEmptyDomainState } from '../../src/domain/stateMachine.ts';
import type { ExtractionContext } from '../../src/extraction/extractionTypes.ts';

const TZ = 'Asia/Jerusalem';
// A Wednesday.
const context: ExtractionContext = { now: new Date('2026-09-23T10:00:00+03:00'), timezone: TZ };

const RAISED: readonly string[] = [
  // ar — Levantine and MSA
  'سجّل موعد دكتور يوم الأحد',
  'عندي دكتور بكرا الساعة 4 العصر',
  'موعد عند طبيب الأسنان الخميس',
  'بروح عالعيادة يوم السبت الصبح',
  'مستشفى بكرا الساعة 9 الصبح',
  'امتحان رياضيات الأحد',
  'مقابلة شغل الاثنين الساعة 11 الصبح',
  'طيارتي الجمعة الساعة 6 المسا',
  'جلسة بالمحكمة الثلاثاء',
  'اجتماع مع المدير بكرا الساعة 10 الصبح',
  // he
  'תור לרופא ביום ראשון',
  'רופא שיניים מחר בשעה 16:00',
  'מבחן בחשבון ביום חמישי',
  'ראיון עבודה ביום שני בבוקר',
  'טיסה לאילת ביום שישי',
  'פגישה עם המנהל מחר בשעה 10:00',
  // en
  'doctor appointment on Sunday',
  'dentist tomorrow at 4pm',
  'clinic on Thursday morning',
  'job interview Monday at 11am',
  'flight to Rome on Friday at 6pm',
  'court hearing on Tuesday',
  'meeting with Rami tomorrow at 10:00',
];

const NOT_RAISED: readonly string[] = [
  // plain tasks, with a day
  'اشتري خبز يوم الأحد',
  'buy milk on Sunday',
  'לקנות חלב ביום ראשון',
  // an appointment word with no fixed day or time
  'موعد دكتور',
  'dentist appointment',
  // a meeting with only a day is not a fixed time
  'meeting with Rami on Sunday',
  // arranging an appointment is a task, not the appointment
  'call the dentist tomorrow',
  'book a doctor appointment on Sunday',
  'احجز موعد دكتور يوم الأحد',
  'اتصل بالعيادة بكرا',
  'לקבוע תור לרופא ביום ראשון',
];

for (const phrase of RAISED) {
  test(`rules: «${phrase}» is a Must, marked as a guess`, () => {
    const result = extract(phrase, context);
    assert.equal(result.priority.level, 'high', `level for «${phrase}»`);
    assert.equal(result.priority.source, 'inferred', `source for «${phrase}»`);
  });
}

for (const phrase of NOT_RAISED) {
  test(`rules: «${phrase}» is not raised`, () => {
    assert.equal(extract(phrase, context).priority.level, 'normal', `level for «${phrase}»`);
  });
}

test('rules: a hedge still wins over an appointment', () => {
  assert.equal(extract('maybe dentist on Sunday', context).priority.level, 'low');
  assert.equal(extract('يمكن دكتور يوم الأحد', context).priority.level, 'low');
});

test('rules: a stated urgency stays the user\'s, not a guess', () => {
  const result = extract('urgent doctor appointment on Sunday', context);
  assert.equal(result.priority.level, 'high');
  assert.equal(result.priority.source, 'user_explicit');
});

// ── The prompt contract ────────────────────────────────────────────────

test('prompt: tells the model an appointment with a fixed day is high, inferred', () => {
  const prompt = buildPrompt('سجّل موعد دكتور يوم الأحد', context);
  // The rule itself, not only an example of it: a few-shot line alone is a
  // pattern the model may or may not generalise.
  assert.match(prompt, /An appointment with a fixed day or time[^\n]*is high with source inferred/);
  assert.match(prompt, /Calling, booking or cancelling one is an ordinary task/);
  // And one worked example, in Arabic, of the owner's own case.
  assert.match(prompt, /دكتور[^\n]*"priority":\{"level":"high","source":"inferred"\}/);
  // The weekday rule the validator enforces is stated to the model too.
  assert.match(prompt, /nearest upcoming one that is not today/);
});

function modelSays(level: string, source: string, localTimeSpec: Record<string, unknown> | null) {
  return {
    type: 'task',
    action: 'موعد دكتور',
    title: 'موعد دكتور',
    person: null,
    dueAt: null,
    remindAt: null,
    localTimeSpec,
    priority: { level, source, pressureAllowed: false, pressureImplied: false },
    flexibility: 'movable',
    confidence: { overall: 0.9, type: 0.9, action: 0.9, time: 0.9, priority: 0.8 },
    missingFields: [],
    ambiguityFlags: [],
    explicitReminderRequest: false,
    explicitPressureRequest: false,
  };
}

test('validator: keeps a model\'s high/inferred for an appointment', () => {
  const result = validateExtractionResult(modelSays('high', 'inferred', null), 'سجّل موعد دكتور يوم الأحد', context);
  assert.equal(result.priority.level, 'high');
  assert.equal(result.priority.source, 'inferred');
});

test('validator: raises a model\'s default normal for a fixed appointment, as a guess', () => {
  const result = validateExtractionResult(modelSays('normal', 'default', null), 'سجّل موعد دكتور يوم الأحد', context);
  assert.equal(result.priority.level, 'high');
  assert.equal(result.priority.source, 'inferred');
});

test('validator: does not overrule a low or an explicit normal', () => {
  assert.equal(validateExtractionResult(modelSays('low', 'inferred', null), 'يمكن دكتور يوم الأحد', context).priority.level, 'low');
  assert.equal(
    validateExtractionResult(modelSays('normal', 'user_explicit', null), 'doctor on Sunday, not important', context).priority.level,
    'normal',
  );
});

test('validator: does not raise a plain task', () => {
  const result = validateExtractionResult(
    { ...modelSays('normal', 'default', null), action: 'buy milk', title: 'Buy milk' },
    'buy milk on Sunday',
    context,
  );
  assert.equal(result.priority.level, 'normal');
});

// ── End to end: the owner's sentence, as the review card receives it ───

test('proposal: «سجّل موعد دكتور يوم الأحد» arrives as high, estimated, on an estimated Sunday', async () => {
  const contract = await proposeCapture(
    'سجّل موعد دكتور يوم الأحد',
    { now: context.now, timezone: TZ, scopeId: 'l4', requestedEngine: 'rules' },
    { store: new MemoryCaptureProposalStore(), persistence: new TransactionalCapturePersistenceAdapter(createEmptyDomainState()) },
  );
  const item = contract.items[0];
  assert.ok(item, 'no item proposed');
  assert.equal(item.priority, 'high');
  assert.equal(item.priorityEstimated, true);
  assert.equal(item.resolvedDate, '2026-09-27');
  assert.equal(item.dateEstimated, true);
  // No hour was said: the one question is about the hour, and names the day.
  assert.equal(item.clarification?.questionKey, 'ask_time');
  assert.equal(item.clarification?.params.date, '2026-09-27');
});

test('proposal: a day the user stated is not marked as a guess', async () => {
  const contract = await proposeCapture(
    'dentist tomorrow at 4pm',
    { now: context.now, timezone: TZ, scopeId: 'l4', requestedEngine: 'rules' },
    { store: new MemoryCaptureProposalStore(), persistence: new TransactionalCapturePersistenceAdapter(createEmptyDomainState()) },
  );
  assert.equal(contract.items[0]?.resolvedDate, '2026-09-24');
  assert.equal(contract.items[0]?.dateEstimated, false);
});

// ── A share carries the same two fields, or it loses the item ──────────

test('share allowlist: an item carrying the day and its guess flag survives, both fields intact', async () => {
  const { applyShareActionAllowlist } = await import('../../lib/services/share/shareAllowlist.ts');
  const contract = await proposeCapture(
    'سجّل موعد دكتور يوم الأحد',
    { now: context.now, timezone: TZ, scopeId: 'l4', requestedEngine: 'rules' },
    { store: new MemoryCaptureProposalStore(), persistence: new TransactionalCapturePersistenceAdapter(createEmptyDomainState()) },
  );
  const { proposal, drops } = applyShareActionAllowlist<typeof contract>(contract);
  assert.deepEqual(drops, []);
  assert.equal(proposal.items[0]?.resolvedDate, '2026-09-27');
  assert.equal(proposal.items[0]?.dateEstimated, true);
});

test('share allowlist: a malformed day is stripped and reported, not passed to the phone', async () => {
  const { applyShareActionAllowlist } = await import('../../lib/services/share/shareAllowlist.ts');
  const { proposal, drops } = applyShareActionAllowlist<{ items: Array<Record<string, unknown>> }>({
    version: 'v1',
    proposalId: 'p1',
    status: 'proposed',
    items: [{ itemId: 'i1', title: 'Dentist', resolvedTime: null, needsClarification: true, resolvedDate: 'next sunday', dateEstimated: 'yes' }],
  });
  assert.equal(proposal.items[0]?.resolvedDate, undefined);
  assert.equal(proposal.items[0]?.dateEstimated, undefined);
  assert.ok(drops.some((drop) => drop.field === 'resolvedDate'));
});
