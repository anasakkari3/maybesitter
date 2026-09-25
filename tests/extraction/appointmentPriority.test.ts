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
import { answerClarification, proposeCapture, MemoryCaptureProposalStore, TransactionalCapturePersistenceAdapter } from '../../lib/services/captureBoundary/index.ts';
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
  // fix round 1: still Must with the tighter frames
  'I have my driving test on Friday at 9am',
  'going to the dentist on Sunday',
  'عند الدكتور يوم الأحد الساعة 10 الصبح',
  'عندي موعد يوم الأحد',
  'יש לי תור ביום ראשון',
  'אצל הרופא ביום ראשון בשעה 10:00',
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
  // ── Fix round 1 (I-1): precision over recall ──
  // the professional as the recipient or object
  'أرسل للدكتور الملف يوم الأحد',
  'ابعت للدكتور التقرير بكرا',
  'اشتري هدية للدكتور أحمد يوم الأحد',
  'send the file to the doctor on Sunday',
  'email the dentist on Monday at 10am',
  'called the clinic on Sunday',
  'booked the dentist for Monday',
  'rescheduled the doctor to Sunday',
  // negation and cancellation
  'ما في دكتور يوم الأحد',
  'لغيت موعد الدكتور يوم الأحد',
  'ألغيت الامتحان يوم الخميس',
  'Doctor appointment cancelled on Sunday',
  'doctor appointment canceled on Sunday',
  'cancel the dentist on Sunday',
  'no meeting on Monday at 10am',
  'התור לרופא ביום ראשון בוטל',
  // loose nouns
  'look up flight prices on Sunday',
  'play at the basketball court on Friday',
  'watch the interview on Sunday',
  'grade the exams on Sunday',
  'study for the exam on Sunday',
  'hearing back from John on Monday',
  'meeting notes due Sunday at 5pm',
  'رحلة مع الشباب يوم الجمعة',
  'موعد تسليم المشروع يوم الأحد',
  'أدرس للامتحان يوم الأحد',
  'اشوف أسعار الطيارة يوم الأحد',
  'ללמוד למבחן ביום ראשון',
  // Hebrew «בתור» is "as" or "in line", not «תור»
  'להביא עוגה בתור מתנה ביום ראשון',
  'לעמוד בתור בדואר ביום ראשון',
  // «كلم» inside «كلمة» is not a call, and a word is not an appointment
  'اكتب كلمة للحفلة يوم الأحد',
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
  // The model's day-only answer, as the prompt asks for it: a date, no hour.
  const result = validateExtractionResult(
    modelSays('normal', 'default', { date: '2026-09-27', time: null, timezone: TZ }),
    'سجّل موعد دكتور يوم الأحد',
    context,
  );
  assert.equal(result.localTimeSpec?.date, '2026-09-27');
  assert.equal(result.dateInferred, true);
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

test('validator: a malformed model date is dropped, not passed to the phone', () => {
  const result = validateExtractionResult(
    modelSays('normal', 'default', { date: 'next sunday', time: null, timezone: TZ }),
    'سجّل موعد دكتور يوم الأحد',
    context,
  );
  assert.equal(result.localTimeSpec, null);
});

test('validator: an informational answer is not raised, whatever its nouns', () => {
  const result = validateExtractionResult(
    { ...modelSays('normal', 'default', { date: '2026-09-27', time: '10:00', timezone: TZ }), type: 'informational_context' },
    'موعد دكتور يوم الأحد الساعة 10 الصبح',
    context,
  );
  assert.equal(result.priority.level, 'normal');
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

// ── Fix round 1 (I-2): answering the question recomputes the date guess ──

async function proposeOwnerSentence() {
  const store = new MemoryCaptureProposalStore();
  const contract = await proposeCapture(
    'سجّل موعد دكتور يوم الأحد',
    { now: context.now, timezone: TZ, scopeId: 'l4', requestedEngine: 'rules' },
    { store, persistence: new TransactionalCapturePersistenceAdapter(createEmptyDomainState()) },
  );
  const item = contract.items[0]!;
  return { store, contract, item, question: item.clarification! };
}

const clarifyOptions = { now: context.now, timezone: TZ, scopeId: 'l4' };

test('clarify: picking an hour on the guessed Sunday keeps the day, still a guess', async () => {
  const { store, contract, item, question } = await proposeOwnerSentence();
  const option = question.options.find((candidate) => candidate.optionId === 'morning')!;
  const next = await answerClarification(
    { proposalId: contract.proposalId, itemId: item.itemId, questionId: question.questionId, optionId: option.optionId },
    clarifyOptions,
    { store, recordEvent: () => {} },
  );
  const answered = next.items[0]!;
  assert.equal(answered.resolvedDate, '2026-09-27');
  assert.equal(answered.dateEstimated, true);
  assert.equal(answered.priorityEstimated, true);
});

test('clarify: a free-text answer that states another date replaces the day, and it is theirs', async () => {
  const { store, contract, item, question } = await proposeOwnerSentence();
  const stated = extract('موعد دكتور بكرا الساعة 10 الصبح', context);
  const next = await answerClarification(
    { proposalId: contract.proposalId, itemId: item.itemId, questionId: question.questionId, freeText: '٤/١٠ الساعة 10 الصبح' },
    clarifyOptions,
    {
      store,
      recordEvent: () => {},
      // The model read the typed date; the rules path cannot.
      extractor: async (text) => ({
        result: {
          ...stated,
          rawText: text,
          localTimeSpec: { date: '2026-10-04', time: '10:00', timezone: TZ },
          dueAt: '2026-10-04T07:00:00.000Z',
          remindAt: '2026-10-04T07:00:00.000Z',
          dateInferred: false,
        },
        engine: 'gemini',
        fallbackReason: null,
      }),
    },
  );
  const answered = next.items[0]!;
  assert.equal(answered.resolvedDate, '2026-10-04');
  assert.equal(answered.dateEstimated, false);
});

test('clarify: an answer whose reading carries no local day drops the stale day and its guess', async () => {
  const { store, contract, item, question } = await proposeOwnerSentence();
  // An instant with no wall-clock day beside it: nothing says which day the
  // card should call ours, so it says nothing rather than the old Sunday.
  const timed = extract('call the plumber', context);
  const next = await answerClarification(
    { proposalId: contract.proposalId, itemId: item.itemId, questionId: question.questionId, freeText: 'at 10' },
    clarifyOptions,
    {
      store,
      recordEvent: () => {},
      extractor: async (text) => ({
        result: { ...timed, rawText: text, localTimeSpec: null, timeEvidence: 'hhmm', dueAt: '2026-09-24T07:00:00.000Z', remindAt: '2026-09-24T07:00:00.000Z' },
        engine: 'rule-based',
        fallbackReason: null,
      }),
    },
  );
  const answered = next.items[0]!;
  assert.equal(answered.resolvedDate, undefined);
  assert.equal(answered.dateEstimated, undefined);
});
