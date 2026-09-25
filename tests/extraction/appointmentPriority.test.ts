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
import { stripCaptureCommand } from '../../src/extraction/captureCommand.ts';
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
  // fix round 2: the owner's own ways of saying they are going
  'رايح للدكتور يوم الأحد',
  'رايحة للدكتور بكرا الساعة 10 الصبح',
  'بروح عالدكتور يوم الأحد',
  'بروح عند الدكتور بكرا',
  'عندي دكتور يوم الأحد',
  'عندي موعد عند الدكتور يوم الأحد',
  'عندي موعد الطبيب يوم الخميس',
  'عندي موعد طبيب الأسنان بكرا',
  'موعدي مع الدكتور يوم الأحد',
  'יש לי תור לרופא ביום ראשון',
  'הולך לרופא ביום ראשון',
  'הולכת לרופאת שיניים מחר בבוקר',
  'going to the doctor on Sunday',
  "doctor's appointment on Sunday",
  'dentist appointment tomorrow at 9am',
  "don't forget the dentist on Sunday",
  'do not forget the doctor tomorrow at 10am',
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
  // fix round 2: an attend word does not rescue contacting or a negation
  'رايح أبعت للدكتور الملف يوم الأحد',
  'بروح أتصل بالدكتور بكرا',
  "don't call the dentist on Sunday",
  "don't forget to email the doctor on Sunday",
  'going to cancel the dentist on Sunday',
  'הולך לשלוח לרופא את הטופס ביום ראשון',
  // «للدكتور» alone is still a recipient
  'ورقة للدكتور يوم الأحد',
  // a recipient beside an appointment word: an errand for it, not the visit
  'card for the dentist appointment on Sunday',
  // attending, but to contact or deliver: still excluded
  'going to the doctor to send the forms on Sunday',
  'رايح للدكتور ابعت الملف يوم الأحد',
  // a loose noun around an attend word
  'رايح اشوف أسعار الطيارة يوم الأحد',
  // ── Fix round 3 (N-2): an errand or a non-appointment target ──
  "going to the doctor's website on Sunday",
  "going to the doctor's office to pick up the prescription on Sunday",
  'heading to the clinic to drop off the forms on Sunday',
  'go to the hospital parking lot to pick up Sam on Sunday',
  'go to the dentist to get the x-rays on Monday at 10am',
  'check the clinic portal on Sunday',
  'عندي دكتور بالعيلة يوم الأحد',
  'عندي دكتور صاحب يوم الأحد',
  'عندي دكتور قريب يوم الأحد',
  'عندي دكتور بالجيرة يوم الأحد',
  'رايح أجيب الدوا من عند الدكتور يوم الأحد',
  'بدي أجيب الدوا من عند الدكتور يوم الأحد',
  'آخد الورقة من عند الدكتور بكرا',
  'رايح للدكتور أحمد عالعشا يوم الأحد',
  'رايح للدكتور آخد النتيجة يوم الأحد',
  'بروح عالدكتور أوصّل أمي يوم الأحد',
  'رايح أجيب دوا من الصيدلية يوم الأحد',
  'بروح عالعيادة أجيب الأوراق يوم الأحد',
  'הולך לרופא להביא לו עוגה ביום ראשון',
  'הולכת למרפאה לקחת את הטפסים ביום ראשון',
  'הולך לבית חולים לאסוף את אבא ביום ראשון',
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

// ── Fix round 2: the capture command is not part of the title ──────────

const TITLES: ReadonlyArray<[string, string]> = [
  ['سجّل موعد دكتور يوم الأحد', 'موعد دكتور'],
  ['سجل موعد دكتور يوم الأحد', 'موعد دكتور'],
  ['ذكّرني موعد دكتور يوم الأحد', 'موعد دكتور'],
  ['سجّل لي موعد دكتور يوم الأحد', 'موعد دكتور'],
  ['حطلي موعد دكتور يوم الأحد', 'موعد دكتور'],
  ['اكتبلي: موعد دكتور يوم الأحد', 'موعد دكتور'],
  ['سجّل تذكير بالفاتورة يوم الأحد', 'تذكير بالفاتورة'],
  ['سجّل ملاحظة عن الاجتماع يوم الأحد', 'ملاحظة عن الاجتماع'],
  ['ذكّرني إني أتصل بأمي يوم الأحد', 'أتصل بأمي'],
  ['سجّل عندي امتحان يوم الأحد', 'عندي امتحان'],
  ['سجّل امتحان رياضيات يوم الأحد', 'امتحان رياضيات'],
  ['سجل مقابلة شغل يوم الأحد', 'مقابلة شغل'],
  ['note: dentist on Sunday', 'dentist'],
  ['add: dentist on Sunday', 'dentist'],
  ['remind me about the dentist on Sunday', 'the dentist'],
  ['remind me of the dentist on Sunday', 'the dentist'],
  ['תרשום לי תור לרופא ביום ראשון', 'תור לרופא'],
  ['תרשום לי: תור לרופא ביום ראשון', 'תור לרופא'],
  ['תרשום לי שיש תור לרופא ביום ראשון', 'יש תור לרופא'],
  ['תזכיר לי תור לרופא ביום ראשון', 'תור לרופא'],
];

for (const [text, title] of TITLES) {
  test(`rules title: «${text}» → «${title}»`, () => {
    assert.equal(extract(text, context).title, title);
  });
}

/** The verb *is* the task: signing up, writing, putting, adding something. */
const VERB_IS_THE_TASK: ReadonlyArray<[string, string]> = [
  // Fix round 3 (N-1): only a commitment after the verb lets it go.
  ['سجّل الأولاد بالمدرسة يوم الأحد', 'سجّل الأولاد بالمدرسة'],
  ['سجل ابني بالنادي يوم الأحد', 'سجل ابني بالنادي'],
  ['سجّل حلقة البودكاست يوم الأحد', 'سجّل حلقة البودكاست'],
  ['سجل فيديو للعيد يوم الأحد', 'سجل فيديو للعيد'],
  ['سجّل المصاريف يوم الأحد', 'سجّل المصاريف'],
  ['سجّل الدخول عالبنك يوم الأحد', 'سجّل الدخول عالبنك'],
  ['سجّل اسم البنت بالروضة يوم الأحد', 'سجّل اسم البنت بالروضة'],
  ['سجلي البنت بالروضة يوم الأحد', 'سجلي البنت بالروضة'],
  ['ذكّرني ليش يوم الأحد', 'ذكّرني ليش'],
  ['ذكرني ليش يوم الأحد', 'ذكرني ليش'],
  ['حطلي الغسيل بالغسالة يوم الأحد', 'حطلي الغسيل بالغسالة'],
  ['اكتب لي رسالة لأمي يوم الأحد', 'اكتب لي رسالة لأمي'],
  ['תרשום לי את הילד לחוג ביום ראשון', 'תרשום לי את הילד לחוג'],
  ['תזכיר לי את הילד לחוג ביום ראשון', 'תזכיר לי את הילד לחוג'],
  // Fix round 4 (C-2): a noun that starts with ש is not the subordinator.
  // («חשוב» at the end is read as the importance, so the rules row uses another noun.)
  ['תרשום לי שיעור פסנתר ביום ראשון', 'תרשום לי שיעור פסנתר'],
  ['תרשום לי שיחה עם דני ביום ראשון', 'תרשום לי שיחה עם דני'],
  ['תרשום לי שולחן חדש ביום ראשון', 'תרשום לי שולחן חדש'],
  ['תרשום לי שמלה לחתונה ביום ראשון', 'תרשום לי שמלה לחתונה'],
  ['תזכיר לי שיעורי בית ביום ראשון', 'שיעורי בית'],
  ['תרשום לי שכירות הדירה ביום ראשון', 'תרשום לי שכירות הדירה'],
  ['سجّل بالنادي يوم الأحد', 'سجّل بالنادي'],
  ['سجل في دورة السباحة يوم الأحد', 'سجل في دورة السباحة'],
  ['اكتب التقرير يوم الأحد', 'اكتب التقرير'],
  ['حط الغسيل يوم الأحد', 'حط الغسيل'],
  ['ضيف جاي يوم الأحد', 'ضيف جاي'],
  ['add milk to the list on Sunday', 'add milk to the list'],
  ['note the meter reading on Sunday', 'note the meter reading'],
  ['לרשום את הילד לחוג ביום ראשון', 'לרשום את הילד לחוג'],
];

for (const [text, title] of VERB_IS_THE_TASK) {
  test(`rules title: «${text}» keeps its verb`, () => {
    assert.equal(extract(text, context).title, title);
  });
}

test('rules title: a command with nothing after it is left alone', () => {
  assert.equal(extract('سجّل يوم الأحد', context).title, 'سجّل');
  // Stripping "note:" here would leave an empty title.
  assert.equal(extract('اكتب: يوم الأحد', context).title, 'اكتب:');
  assert.equal(extract('note: on Sunday', context).title, 'note:');
});

test('validator title: the model\'s «سجّل موعد دكتور» loses the command, the gym sign-up keeps it', () => {
  const said = validateExtractionResult(
    { ...modelSays('high', 'inferred', null), title: 'سجّل موعد دكتور', action: 'سجّل موعد دكتور' },
    'سجّل موعد دكتور يوم الأحد',
    context,
  );
  assert.equal(said.title, 'موعد دكتور');
  assert.equal(said.action, 'موعد دكتور');
  const gym = validateExtractionResult(
    { ...modelSays('normal', 'default', null), title: 'سجّل بالنادي', action: 'سجّل بالنادي' },
    'سجّل بالنادي يوم الأحد',
    context,
  );
  assert.equal(gym.title, 'سجّل بالنادي');
});

const MODEL_TITLES_KEPT: readonly string[] = [
  'سجّل الأولاد بالمدرسة',
  'سجّل حلقة البودكاست',
  'سجّل المصاريف',
  'ذكّرني ليش',
  'حطلي الغسيل بالغسالة',
  'اكتب لي رسالة لأمي',
  'תרשום לי את הילד לחוג',
  'add milk to the list',
  'note the meter reading',
];

for (const title of MODEL_TITLES_KEPT) {
  test(`validator title: the model's «${title}» is not rewritten`, () => {
    const result = validateExtractionResult(
      { ...modelSays('normal', 'default', null), title, action: title },
      `${title} يوم الأحد`,
      context,
    );
    assert.equal(result.title, title);
    assert.equal(result.action, title);
  });
}

test('no Hebrew title starts with the object marker «את»', () => {
  for (const text of ['תרשום לי את הילד לחוג ביום ראשון', 'תזכיר לי את הילד לחוג ביום ראשון', 'תרשום לי: את הילד ביום ראשון']) {
    assert.doesNotMatch(extract(text, context).title ?? '', /^את\s/, text);
  }
});

// ── Fix round 4 (C-2): «ש» comes off only as a subordinator ────────────

const HE_S_NOUNS: readonly string[] = [
  'תרשום לי שיעור חשוב',
  'תרשום לי שיחה עם דני',
  'תרשום לי שולחן חדש',
  'תרשום לי שמלה לחתונה',
  'תזכיר לי שיעורי בית',
  'תרשום לי שכירות הדירה',
];

for (const title of HE_S_NOUNS) {
  test(`command strip: «${title}» is not cut into a non-word`, () => {
    assert.equal(stripCaptureCommand(title), title);
    // The rules path keeps the ש-word whole too: never «יעור», «ולחן».
    const noun = title.split(' ')[2]!;
    assert.ok((extract(`${title} ביום ראשון`, context).title ?? '').split(' ').includes(noun), noun);
    const model = validateExtractionResult(
      { ...modelSays('normal', 'default', null), title, action: title },
      `${title} ביום ראשון`,
      context,
    );
    assert.equal(model.title, title);
  });
}

const HE_CLAUSES: ReadonlyArray<[string, string]> = [
  ['תרשום לי: שיעור חשוב', 'שיעור חשוב'],
  ['תרשום לי שיש תור לרופא', 'יש תור לרופא'],
  ['תזכיר לי שאני צריך להתקשר לדני', 'אני צריך להתקשר לדני'],
  ['תזכיר לי שמחר יש מבחן', 'מחר יש מבחן'],
  ['תרשום לי שצריך לשלם ארנונה', 'צריך לשלם ארנונה'],
];

for (const [title, rest] of HE_CLAUSES) {
  test(`command strip: «${title}» → «${rest}»`, () => {
    assert.equal(stripCaptureCommand(title), rest);
  });
}
