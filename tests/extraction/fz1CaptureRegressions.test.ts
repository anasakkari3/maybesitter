/**
 * The closure UAT's round-3 capture defects of 2026-09-28, replayed (lane FZ1).
 * The run was at 03:00–04:45 on Monday 28 Sep, on a phone set to Asia/Hebron,
 * with the Gemini path consented.
 *
 *   N10 At 03:22, «اليوم الساعة 2 بالليل لازم أبعت الإيميل للمدير» — an
 *       hour that had gone an hour and twenty minutes earlier. Four runs in
 *       five it asked «أي ساعة يوم الاثنين…», and the typed answer «بعد ساعة»
 *       was applied as «بكرا · 02:00»: the passed hour rolled to tomorrow,
 *       an hour the person never gave for a day they never said. One run in
 *       five asked nothing and proposed «بكرا · 02:00» straight away: the
 *       model had moved the stated today to tomorrow. On the rules path the
 *       same sentence was proposed, settled, at 14:00 today: «بالليل» was
 *       read as the afternoon half of the clock.
 *   N6  «أحضّر تقرير آخر الشهر» and «لازم أحضّر تقرير آخر الشهر» kept their
 *       title but got no day at all. The words say this month's end, and the
 *       controller ruling is that the person's words win: Wednesday 30 Sep.
 *
 * The model answers are the ones Gemini actually gave for these clauses
 * (`fixtures/uat-2026-09-28-round3-gemini.json`, recorded before the fix with
 * `scripts/live-capture-check.ts --only FZ1 --record`). Rows that script a
 * model answer to reach an edge say so; the literal repro rows never do.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LLMUnavailableError } from '../../src/extraction/llm/llmProvider.ts';
import {
  answerClarification,
  MemoryCaptureProposalStore,
  proposeCapture,
  TransactionalCapturePersistenceAdapter,
} from '../../lib/services/captureBoundary/index.ts';
import { guardedMobileExtract } from '../../lib/services/mobile/safety.ts';
import { clarifyMobileCapture, confirmMobileCapture, proposeMobileCapture } from '../../lib/services/mobile/mobileCaptureService.ts';
import { getParticipantStateSnapshot } from '../../lib/services/mobile/participantState.ts';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { createEmptyDomainState } from '../../src/domain/stateMachine.ts';
import { localTimeSpecFor, typedHalfOfDay } from '../../src/extraction/timeLexicon.ts';
import { extractWithFallback } from '../../src/extraction/extractionService.ts';
import { validateExtractionResult } from '../../src/extraction/schemaValidator.ts';

const TZ = 'Asia/Hebron';
/** Monday 28 Sep 2026, 03:22 on the phone — when N10 was typed. */
const N10_NOW = new Date('2026-09-28T00:22:00.000Z');
/** 03:40 the same night — when N6 was typed. */
const N6_NOW = new Date('2026-09-28T00:40:00.000Z');

const N10 = 'اليوم الساعة 2 بالليل لازم أبعت الإيميل للمدير';
const N6_REPORT = 'أحضّر تقرير آخر الشهر';
const N6_MUST = 'لازم أحضّر تقرير آخر الشهر';

const CALLS = (JSON.parse(readFileSync(new URL('./fixtures/uat-2026-09-28-round3-gemini.json', import.meta.url), 'utf8')) as {
  calls: Array<{ case: string; payload: string | string[]; answer: unknown }>;
}).calls;

function payloadOf(prompt: string): string | string[] {
  const lines = prompt.split('\n');
  return JSON.parse(lines[lines.indexOf('BEGIN_UNTRUSTED_USER_MESSAGE') + 1]!) as string | string[];
}

/**
 * A model that answers each payload with its recording, or an override;
 * anything else fails. N10 was recorded twice (`run`): Gemini gave the same
 * clause two different readings.
 */
function recordedModel(overrides: Record<string, unknown> = {}, run?: string) {
  let calls = 0;
  const recorded = run ? CALLS.filter((call) => call.case.includes(run)) : CALLS;
  const provider = async (prompt: string): Promise<string> => {
    calls += 1;
    const payload = payloadOf(prompt);
    if (typeof payload === 'string' && payload in overrides) return JSON.stringify(overrides[payload]);
    const hit = recorded.find((call) => JSON.stringify(call.payload) === JSON.stringify(payload));
    if (hit) return JSON.stringify(hit.answer);
    throw new LLMUnavailableError('provider_error');
  };
  return { provider, calls: () => calls };
}

async function proposeModel(text: string, now: Date, provider: (prompt: string) => Promise<string>) {
  const store = new MemoryCaptureProposalStore();
  const persistence = new TransactionalCapturePersistenceAdapter(createEmptyDomainState());
  const contract = await proposeCapture(
    text,
    { now, timezone: TZ, scopeId: 'fz1', requestedEngine: 'model' },
    { store, persistence, extractor: guardedMobileExtract, llmProvider: provider, llmEngine: 'gemini' },
  );
  return { contract, store };
}

function withMemoryStorage<T>(run: () => Promise<T>): Promise<T> {
  setStorageForTests(createMemoryStorage());
  return run().finally(() => resetStorageForTests());
}

async function proposeRules(text: string, now: Date) {
  return withMemoryStorage(() => proposeMobileCapture({ text, timezone: TZ, referenceTime: now.toISOString() }));
}

type Item = { title: string; resolvedDate?: string; resolvedTime: string | null; needsClarification: boolean; clarification?: { questionKey?: string } | null };
const line = (item: Item) => {
  const time = item.resolvedTime ? localTimeSpecFor(new Date(item.resolvedTime), TZ)?.time : null;
  return `${item.title} | ${item.resolvedDate ?? '-'} ${time ?? '-'} | ${item.needsClarification ? item.clarification?.questionKey ?? 'edit' : 'settled'}`;
};

/** Every option offered is still ahead of `now`, and «بدون وقت محدد» is one of them. */
function assertAskedAhead(item: { clarification?: { options: Array<{ optionId: string; value: { localDate?: string; localTime?: string } }> } | null }, now: Date) {
  const options = item.clarification?.options ?? [];
  assert.ok(options.some((option) => option.optionId === 'none'), 'the "no specific time" answer is offered');
  for (const option of options) {
    if (!option.value.localDate || !option.value.localTime) continue;
    const at = Date.parse(new Date(`${option.value.localDate}T${option.value.localTime}:00+03:00`).toISOString());
    assert.ok(at > now.getTime(), `${option.optionId} ${option.value.localDate} ${option.value.localTime} is not in the past`);
  }
}

// ── N10: a passed hour «بالليل», and the answer «بعد ساعة» ─────────────────

test('FZ1 N10: on the rules path «الساعة 2 بالليل» today at 03:22 has passed and is asked about, never settled at 14:00', async () => {
  const proposal = await proposeRules(N10, N10_NOW);
  assert.equal(proposal.status, 'needs_clarification');
  assert.deepEqual(proposal.items.map(line), ['أبعت الإيميل للمدير | 2026-09-28 - | ask_time']);
  assertAskedAhead(proposal.items[0]!, N10_NOW);
});

test('FZ1 N10: on the model path the literal answer (Gemini moved today\'s 02:00 to tomorrow) is asked about, not proposed as «بكرا · 02:00»', async () => {
  const model = recordedModel({}, 'run 1');
  const { contract } = await proposeModel(N10, N10_NOW, model.provider);
  assert.equal(model.calls(), 1);
  assert.equal(contract.provenance.executedEngine, 'gemini');
  assert.equal(contract.status, 'needs_clarification');
  assert.deepEqual(contract.items.map(line), ['أبعت الإيميل للمدير | 2026-09-28 - | ask_time']);
  assertAskedAhead(contract.items[0]!, N10_NOW);
});

test('FZ1 N10: the second recorded reading (today\'s 02:00, with tomorrow\'s instant beside it) is asked about too', async () => {
  const model = recordedModel({}, 'run 2');
  const { contract } = await proposeModel(N10, N10_NOW, model.provider);
  assert.equal(model.calls(), 1);
  assert.deepEqual(contract.items.map(line), ['أبعت الإيميل للمدير | 2026-09-28 - | ask_time']);
});

/**
 * The literal N10 question on the model path, answered by typing `freeText`;
 * the re-read is Gemini's recorded answer, or `reread` when a row scripts one.
 */
async function answerN10OnModel(freeText: string, reread?: object) {
  const combined = `${N10}\n${freeText}`;
  const model = recordedModel(reread ? { [combined]: reread } : {}, 'run 2');
  const { contract, store } = await proposeModel(N10, N10_NOW, model.provider);
  const item = contract.items[0]!;
  assert.equal(item.clarification?.questionKey, 'ask_time');
  const answer = (input: { freeText?: string; optionId?: string }) => answerClarification(
    { proposalId: contract.proposalId, itemId: item.itemId, questionId: item.clarification!.questionId, ...input },
    { now: N10_NOW, timezone: TZ, scopeId: 'fz1' },
    { store, recordEvent: () => undefined, extractor: guardedMobileExtract, llmProvider: model.provider, llmEngine: 'gemini' },
  );
  let refused: string | null = null;
  let items: string[] | null = null;
  try {
    items = (await answer({ freeText })).items.map(line);
  } catch (error) {
    refused = (error as { failure?: string }).failure ?? String(error);
  }
  const after = refused ? (await answer({ optionId: 'evening' })).items.map(line) : null;
  return { refused, items, after, calls: model.calls() };
}

test('FZ1 N10: on the model path the literal «بعد ساعة» (Gemini re-read it as Tuesday 02:00) is not understood, and the buttons still answer', async () => {
  const later = await answerN10OnModel('بعد ساعة');
  assert.deepEqual(
    { refused: later.refused, items: later.items, after: later.after },
    { refused: 'answer_not_understood', items: null, after: ['أبعت الإيميل للمدير | 2026-09-28 19:00 | settled'] },
  );
});

test('FZ1 N10: a typed answer to "what time?" with no time of day and no day takes no hour from the re-read, whatever the engine reads into it', async () => {
  // Scripted re-reads: what a model could make of words that give no hour —
  // «بعد ساعة» as 04:22, «بعد شوي» as 05:00, "later" as tonight. None is an
  // hour the person typed; the question stays.
  for (const [freeText, date, time] of [['بعد ساعة', '2026-09-28', '04:22'], ['بعد شوي', '2026-09-28', '05:00'], ['later', '2026-09-28', '20:00'], ['אחר כך', '2026-09-28', '09:00'], ['هلأ', '2026-09-28', '03:30'], ['now', '2026-09-28', '03:23']] as const) {
    const result = await answerN10OnModel(freeText, modelAnswer(date, time));
    assert.deepEqual({ refused: result.refused, after: result.after }, { refused: 'answer_not_understood', after: ['أبعت الإيميل للمدير | 2026-09-28 19:00 | settled'] }, freeText);
  }
  // A typed hour, a typed part of the day or a named day still answers.
  assert.deepEqual((await answerN10OnModel('الساعة 7 المسا', modelAnswer('2026-09-28', '19:00'))).items, ['أبعت الإيميل للمدير | 2026-09-28 19:00 | settled']);
  assert.deepEqual((await answerN10OnModel('بالمسا', modelAnswer('2026-09-28', '19:00'))).items, ['أبعت الإيميل للمدير | 2026-09-28 19:00 | settled']);
  // «بكرا» alone: the person's own hour on the day they named (FY1 I4).
  assert.deepEqual((await answerN10OnModel('بكرا', modelAnswer('2026-09-29', '02:00'))).items, ['أبعت الإيميل للمدير | 2026-09-29 02:00 | settled']);
});

/** The literal N10 question on the rules path, answered by typing `freeText`. */
async function answerN10OnRules(freeText: string) {
  const uid = 'fz1-n10';
  return withMemoryStorage(async () => {
    const proposal = await proposeMobileCapture({ text: N10, timezone: TZ, referenceTime: N10_NOW.toISOString() }, { participantId: uid });
    const item = proposal.items[0]!;
    assert.equal(item.clarification?.questionKey, 'ask_time');
    const answer = (input: { freeText?: string; optionId?: string }) => clarifyMobileCapture({
      proposalId: proposal.proposalId, itemId: item.itemId, questionId: item.clarification!.questionId, ...input,
      timezone: TZ, referenceTime: N10_NOW.toISOString(),
    }, { participantId: uid });
    let refused: string | null = null;
    let items: string[] | null = null;
    try {
      items = (await answer({ freeText })).items.map(line);
    } catch (error) {
      refused = (error as { failure?: string }).failure ?? String(error);
    }
    // The round is kept after a refusal: a button still answers it.
    const after = refused ? (await answer({ optionId: 'evening' })).items.map(line) : null;
    return { refused, items, after };
  });
}

test('FZ1 N10: on the rules path «بعد ساعة» is not understood and the buttons still answer; a typed time still works', async () => {
  const later = await answerN10OnRules('بعد ساعة');
  assert.deepEqual(later, { refused: 'answer_not_understood', items: null, after: ['أبعت الإيميل للمدير | 2026-09-28 19:00 | settled'] });
  assert.deepEqual((await answerN10OnRules('الساعة 7 المسا')).items, ['أبعت الإيميل للمدير | 2026-09-28 19:00 | settled']);
  assert.deepEqual((await answerN10OnRules('بكرا الساعة 10')).items, ['أبعت الإيميل للمدير | 2026-09-29 10:00 | settled']);
  assert.deepEqual((await answerN10OnRules('بالمسا')).items, ['أبعت الإيميل للمدير | 2026-09-28 19:00 | settled']);
  assert.equal((await answerN10OnRules('الساعة 4')).refused, 'answer_not_understood');
});

test('FZ1 N10: «بالليل» and «בלילה» are the small hours from 1 to 5, the evening from 6; midnight is 00:00', async () => {
  // Sunday 27 Sep, 20:00: every reading below is still ahead.
  const evening = new Date('2026-09-27T17:00:00.000Z');
  const rows: Array<[string, string]> = [
    ['بكرا الساعة 2 بالليل بدي أبعت الإيميل', '2026-09-28 02:00'],
    ['بكرا الساعة 5 بالليل بدي أبعت الإيميل', '2026-09-28 05:00'],
    ['بكرا الساعة 11 بالليل بدي أبعت الإيميل', '2026-09-28 23:00'],
    ['بكرا الساعة 12 بالليل بدي أبعت الإيميل', '2026-09-28 00:00'],
    ['اليوم الساعة 10 بالليل بدي أبعت الإيميل', '2026-09-27 22:00'],
    ['לשלוח את המייל מחר ב-2 בלילה', '2026-09-28 02:00'],
    ['לשלוח את המייל מחר בשעה 11 בלילה', '2026-09-28 23:00'],
    // Not a night word: unchanged.
    ['بكرا الساعة 2 المسا بدي أبعت الإيميل', '2026-09-28 14:00'],
  ];
  for (const [text, expected] of rows) {
    const { result } = await extractWithFallback(text, { now: evening, timezone: TZ }, { llmProvider: async () => { throw new LLMUnavailableError('provider_none'); } });
    assert.equal(`${result.localTimeSpec?.date} ${result.localTimeSpec?.time}`, expected, text);
  }
});

// A model answer for a clause said "today", scripted to reach the edge (the
// literal N10 row above replays the real one).
function modelAnswer(date: string, time: string | null) {
  return {
    type: 'task', action: 'أبعت الإيميل', title: 'أبعت الإيميل للمدير', person: null,
    dueAt: time ? new Date(`${date}T${time}:00+03:00`).toISOString() : null, remindAt: null,
    localTimeSpec: { date, time, timezone: TZ },
    priority: { level: 'high', source: 'user_explicit', pressureAllowed: false, pressureImplied: false },
    flexibility: 'movable', category: null, categoryConfidence: 0,
    confidence: { overall: 0.9, type: 1, action: 1, time: 1, priority: 1 },
    missingFields: [], ambiguityFlags: [], explicitReminderRequest: false, explicitPressureRequest: false,
  };
}

test('FZ1 N10: a model day after the "today" the words say is not kept; the words\' day is, and "tonight" or another day named is the model\'s', () => {
  const at = (text: string, answer: object, now = N10_NOW) => {
    const result = validateExtractionResult(answer, text, { now, timezone: TZ });
    return `${result.localTimeSpec?.date ?? '-'} ${result.localTimeSpec?.time ?? '-'}`;
  };
  // The passed hour goes back to today, with no hour: the boundary asks
  // (FZ1 round 3: the move never settles).
  assert.equal(at(N10, modelAnswer('2026-09-29', '02:00')), '2026-09-28 -');
  // An hour still ahead today: today, and the hour asked — never settled.
  assert.equal(at('اليوم الساعة 5 المسا لازم أبعت الإيميل', modelAnswer('2026-09-29', '17:00')), '2026-09-28 -');
  assert.equal(at('לשלוח את המייל היום ב-5 אחר הצהריים', modelAnswer('2026-09-29', '17:00')), '2026-09-28 -');
  // Only a model day of exactly tomorrow is moved (round 3): a later one is the model's.
  assert.equal(at('send the email to my manager today at 5pm', modelAnswer('2026-10-02', '17:00')), '2026-10-02 17:00');
  // Today with no hour: the day is today.
  assert.equal(at('اليوم لازم أبعت الإيميل', modelAnswer('2026-09-29', null)), '2026-09-28 -');
  // The model's own today is untouched.
  assert.equal(at(N10, modelAnswer('2026-09-28', '02:00')), '2026-09-28 02:00');
  // "Tonight" runs past midnight: the model's 01:00 tomorrow is a reading of it.
  const late = new Date('2026-09-27T19:00:00.000Z');
  assert.equal(at('tonight at 1 send the email', modelAnswer('2026-09-28', '01:00'), late), '2026-09-28 01:00');
  assert.equal(at('الليلة الساعة 1 لازم أبعت الإيميل', modelAnswer('2026-09-28', '01:00'), late), '2026-09-28 01:00');
  // Another day named in the words is the model's to read.
  assert.equal(at('اليوم بدي أحجز موعد لبكرا الساعة 5 المسا', modelAnswer('2026-09-29', '17:00')), '2026-09-29 17:00');
  assert.equal(at('اليوم أو يوم الخميس بدي أبعت الإيميل', modelAnswer('2026-10-01', null)), '2026-10-01 -');
});

// ── N6: this month's end in the person's words ───────────────────────────

test('FZ1 N6: the literal «أحضّر تقرير آخر الشهر» on the model path (Gemini gave no day) is on Wednesday 30 Sep, the hour asked', async () => {
  for (const [text, priority] of [[N6_REPORT, 'normal'], [N6_MUST, 'high']] as const) {
    const model = recordedModel();
    const { contract } = await proposeModel(text, N6_NOW, model.provider);
    assert.equal(model.calls(), 1, text);
    assert.equal(contract.provenance.executedEngine, 'gemini', text);
    assert.deepEqual(contract.items.map(line), ['أحضّر تقرير آخر الشهر | 2026-09-30 - | ask_time'], text);
    assert.equal(contract.items[0]!.priority, priority, text);
    // The day is read from a name for the report, not said as a date: marked a guess.
    assert.equal(contract.items[0]!.dateEstimated, true, text);
    assertAskedAhead(contract.items[0]!, N6_NOW);
    assert.ok(contract.items[0]!.clarification!.options.some((option) => option.value.localDate === '2026-09-30'), text);
  }
});

test('FZ1 N6: on the rules path «أحضّر تقرير آخر الشهر» and «لازم …» are on Wednesday 30 Sep, the hour asked', async () => {
  for (const text of [N6_REPORT, N6_MUST, 'بدي أحضّر تقرير آخر الشهر']) {
    const proposal = await proposeRules(text, N6_NOW);
    assert.deepEqual(proposal.items.map(line), ['أحضّر تقرير آخر الشهر | 2026-09-30 - | ask_time'], text);
    assert.equal(proposal.items[0]!.dateEstimated, true, text);
  }
  // English and Hebrew name the report the same way.
  assert.deepEqual((await proposeRules('Prepare the end of the month report', N6_NOW)).items.map(line), ['Prepare the end of the month report | 2026-09-30 - | ask_time']);
  assert.deepEqual((await proposeRules('להכין את דוח סוף החודש', N6_NOW)).items.map(line), ['להכין את דוח סוף החודש | 2026-09-30 - | ask_time']);
});

function reportAnswer(date: string | null, title = 'أحضّر تقرير') {
  return {
    type: 'task', action: 'أحضّر', title, person: null,
    dueAt: date ? new Date(`${date}T00:00:00+03:00`).toISOString() : null, remindAt: null,
    localTimeSpec: date ? { date, time: null, timezone: TZ } : null,
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureImplied: false },
    flexibility: 'movable', category: null, categoryConfidence: 0,
    confidence: { overall: 0.8, type: 1, action: 1, time: 0.8, priority: 1 },
    missingFields: [], ambiguityFlags: ['vague_time'], explicitReminderRequest: false, explicitPressureRequest: false,
  };
}

test('FZ1 N6: a model day FY1 discards (after this month\'s end) gives way to the words\' 30 Sep too', async () => {
  const { contract } = await proposeModel(N6_REPORT, N6_NOW, recordedModel({ [N6_REPORT]: reportAnswer('2026-10-31') }).provider);
  assert.deepEqual(contract.items.map(line), ['أحضّر تقرير آخر الشهر | 2026-09-30 - | ask_time']);
});

test('FZ1 N6: FY1\'s narrowing is kept — an offset, another month, next month or a named day get no month-end day of ours', async () => {
  // Scripted: the model gave no day, so only the words could supply one.
  // (An offset *before* the month's end with a limit word — «قبل آخر الشهر
  // بأسبوع» — is FX3's deadline reading, on both paths, before and after FZ1.)
  const rows: Array<[string, string]> = [
    // An offset after the month's end with no count: no day (a counted one is
    // computed, round 2 below).
    ['بدي أدفع الفاتورة بعد آخر الشهر', 'أدفع الفاتورة'],
    ['pay the bill after the end of the month', 'pay the bill'],
    ['بدي أحضّر تقرير آخر الشهر الجاي', 'أحضّر تقرير'],
    ['Prepare the report for the end of next month', 'Prepare the report'],
    ['prepare the end of October report', 'prepare the report'],
    ['להכין את דוח סוף החודש הבא', 'להכין את הדוח'],
  ];
  for (const [text, title] of rows) {
    const { contract } = await proposeModel(text, N6_NOW, recordedModel({ [text]: reportAnswer(null, title) }).provider);
    assert.equal(contract.items[0]?.resolvedDate, undefined, text);
  }
  // Next month, or an offset after the month's end, on the rules path: no day, as before.
  for (const text of ['بدي أحضّر تقرير آخر الشهر الجاي', 'بدي أحضّر تقرير بعد آخر الشهر', 'pay the bill after the end of the month']) {
    assert.equal((await proposeRules(text, N6_NOW)).items[0]?.resolvedDate, undefined, text);
  }
  // A day or an hour the person said is theirs: the words do not move it.
  assert.deepEqual((await proposeRules('بدي أحضّر تقرير آخر الشهر بكرا الساعة 10', N6_NOW)).items.map(line), ['أحضّر تقرير آخر الشهر | 2026-09-29 10:00 | settled']);
  assert.equal((await proposeRules('بدي أحضّر تقرير آخر الشهر الساعة 10 الصبح', N6_NOW)).items[0]?.resolvedDate, '2026-09-28');
});

// ── Round 2 (coordinator): the am/pm question answered by typing ──────────

/**
 * «بكرا الساعة 5 بدي أروح عالبنك» asks «5 الصبح ولا المسا؟» (ask_am_pm). A
 * typed half of the day answers that question about *that* hour: «المسا» is
 * 17:00, not the time question's 19:00 button (at c59852fd: 19:00, «الصبح»
 * 09:00, "pm"/«م» 05:00).
 */
async function answerAmPm(text: string, freeText: string, engine: 'rules' | 'model' = 'rules') {
  const now = N10_NOW;
  if (engine === 'model') {
    // Every model call fails: a typed half needs no re-read.
    let calls = 0;
    const store = new MemoryCaptureProposalStore();
    const persistence = new TransactionalCapturePersistenceAdapter(createEmptyDomainState());
    const contract = await proposeCapture(text, { now, timezone: TZ, scopeId: 'fz1-ampm', requestedEngine: 'rules' }, { store, persistence });
    const item = contract.items[0]!;
    assert.equal(item.clarification?.questionKey, 'ask_am_pm', text);
    const updated = await answerClarification(
      { proposalId: contract.proposalId, itemId: item.itemId, questionId: item.clarification!.questionId, freeText },
      { now, timezone: TZ, scopeId: 'fz1-ampm' },
      { store, recordEvent: () => undefined, extractor: guardedMobileExtract, llmEngine: 'gemini', llmProvider: async () => { calls += 1; throw new LLMUnavailableError('provider_error'); } },
    );
    return { line: line(updated.items[0]!), calls };
  }
  const uid = 'fz1-ampm';
  return withMemoryStorage(async () => {
    const proposal = await proposeMobileCapture({ text, timezone: TZ, referenceTime: now.toISOString() }, { participantId: uid });
    const item = proposal.items[0]!;
    assert.equal(item.clarification?.questionKey, 'ask_am_pm', text);
    try {
      const updated = await clarifyMobileCapture({
        proposalId: proposal.proposalId, itemId: item.itemId, questionId: item.clarification!.questionId, freeText,
        timezone: TZ, referenceTime: now.toISOString(),
      }, { participantId: uid });
      return { line: line(updated.items[0]!), calls: 0 };
    } catch (error) {
      return { line: `refused: ${(error as { failure?: string }).failure ?? String(error)}`, calls: 0 };
    }
  });
}

const BANK_AT_5 = 'بكرا الساعة 5 بدي أروح عالبنك';

test('FZ1 round 2: a typed half of the day answers the am/pm question about the hour it asked — «المسا» is 17:00, «الصبح» 05:00', async () => {
  const rows: Array<[string, string]> = [
    ['المسا', '17:00'], ['بالمسا', '17:00'], ['مسا', '17:00'], ['العصر', '17:00'], ['بعد الظهر', '17:00'],
    ['الصبح', '05:00'], ['الصباح', '05:00'], ['بالصبح', '05:00'],
    ['pm', '17:00'], ['PM', '17:00'], ['p.m.', '17:00'], ['am', '05:00'], ['a.m.', '05:00'],
    ['م', '17:00'], ['ص', '05:00'], ['مساءً', '17:00'], ['صباحاً', '05:00'],
    ['in the evening', '17:00'], ['evening', '17:00'], ['afternoon', '17:00'], ['morning', '05:00'], ['in the morning', '05:00'],
    ['בערב', '17:00'], ['אחרי הצהריים', '17:00'], ['בבוקר', '05:00'],
    // The night's own rule (nightClockHour): 5 at night is the small hours.
    ['بالليل', '05:00'], ['בלילה', '05:00'],
  ];
  for (const [freeText, time] of rows) {
    assert.equal((await answerAmPm(BANK_AT_5, freeText)).line, `أروح عالبنك | 2026-09-29 ${time} | settled`, freeText);
  }
  // 6 at night is the evening half.
  assert.equal((await answerAmPm('بكرا الساعة 6 لازم أتصل بسامي', 'بالليل')).line, 'أتصل بسامي | 2026-09-29 18:00 | settled');
  assert.equal((await answerAmPm('بكرا الساعة 6 لازم أتصل بسامي', 'الصبح')).line, 'أتصل بسامي | 2026-09-29 06:00 | settled');
  // Minutes are kept: «5:30» answered «المسا» is 17:30.
  assert.equal((await answerAmPm('بكرا الساعة 5:30 بدي أروح عالبنك', 'المسا')).line, 'أروح عالبنك | 2026-09-29 17:30 | settled');
  // "I am busy" names no half; «ماما» and «صح» are not «م»/«ص».
  for (const text of ['I am busy', 'ماما', 'صح', 'بعد ساعة']) assert.equal(typedHalfOfDay(text), null, text);
});

test('FZ1 round 2: the typed half needs no model re-read, and a typed new hour or a day is still read as before', async () => {
  const typed = await answerAmPm(BANK_AT_5, 'المسا', 'model');
  assert.deepEqual(typed, { line: 'أروح عالبنك | 2026-09-29 17:00 | settled', calls: 0 });
  // A typed clock is a new hour, not a half of the old one.
  assert.equal((await answerAmPm(BANK_AT_5, 'الساعة 7 المسا')).line, 'أروح عالبنك | 2026-09-29 19:00 | settled');
  // A day with the half: the half applies to the asked hour on that day.
  assert.equal((await answerAmPm(BANK_AT_5, 'بعد بكرا المسا')).line, 'أروح عالبنك | 2026-09-30 17:00 | settled');
});

// ── Round 2 (coordinator): an offset on this month's end ──────────────────

/** Thursday 10 Sep 2026, 12:00 on the phone: every offset below is ahead. */
const SEP_10 = new Date('2026-09-10T09:00:00.000Z');

const OFFSET_ROWS: Array<[string, string]> = [
  // Before: a deadline on that day, all day — as «قبل آخر الشهر» is on the 30th (FX3).
  ['بدي أخلص التقرير قبل آخر الشهر بأسبوع', 'أخلص التقرير | 2026-09-23 - | settled'],
  ['لازم أدفع الفاتورة قبل آخر الشهر بيومين', 'أدفع الفاتورة | 2026-09-28 - | settled'],
  ['بدي أدفع الإيجار أسبوع قبل آخر الشهر', 'أدفع الإيجار | 2026-09-23 - | settled'],
  ['بدي أخلص التقرير قبل آخر الشهر بتلات أيام', 'أخلص التقرير | 2026-09-27 - | settled'],
  ['بدي أخلص التقرير قبل آخر الشهر بأسبوعين', 'أخلص التقرير | 2026-09-16 - | settled'],
  ['submit the report two days before the end of the month', 'submit the report | 2026-09-28 - | settled'],
  ['pay the rent a week before the end of the month', 'pay the rent | 2026-09-23 - | settled'],
  ['להגיש את הדוח שבוע לפני סוף החודש', 'להגיש את הדוח | 2026-09-23 - | settled'],
  ['לשלם חשבון יומיים לפני סוף החודש', 'לשלם חשבון | 2026-09-28 - | settled'],
  // A stated hour stays, on that day (FX3 #7).
  ['لازم أدفع الفاتورة قبل آخر الشهر بأسبوع الساعة 5 المسا', 'أدفع الفاتورة | 2026-09-23 17:00 | settled'],
  // After: the day they counted to, and the hour asked — not a limit.
  ['بدي أدفع الفاتورة بعد آخر الشهر بيومين الساعة 10 الصبح', 'أدفع الفاتورة بعد آخر الشهر بيومين | 2026-10-02 10:00 | settled'],
  ['بدي أدفع الفاتورة بعد آخر الشهر بيومين', 'أدفع الفاتورة بعد آخر الشهر بيومين | 2026-10-02 - | ask_time'],
  ['pay the bill 3 days after the end of the month', 'pay the bill 3 days after the end of the month | 2026-10-03 - | ask_time'],
  ['לשלם חשבון יומיים אחרי סוף החודש', 'לשלם חשבון יומיים אחרי סוף החודש | 2026-10-02 - | ask_time'],
];

test('FZ1 round 2: on the rules path an offset on this month\'s end is counted on the person\'s clock, never settled on the 30th', async () => {
  for (const [text, expected] of OFFSET_ROWS) {
    assert.deepEqual((await proposeRules(text, SEP_10)).items.map(line), [expected], text);
  }
  // Another month named, or an offset with no count: no day, the hour asked.
  for (const text of ['לסיים דוח עד סוף חודש אוקטובר', 'pay the bill after the end of the month', 'بدي أدفع الفاتورة بعد آخر الشهر']) {
    const items = (await proposeRules(text, SEP_10)).items;
    assert.equal(items[0]?.resolvedDate, undefined, text);
    assert.equal(items[0]?.clarification?.questionKey, 'ask_time', text);
  }
});

test('FZ1 round 2: on the model path, with no day from the model, the same offsets are counted; a model 30th under "a week before" is the words\' 23rd', async () => {
  // Scripted: the model gave the title and no day (the stated-hour row is the
  // model's to read, so it is left out).
  for (const [text, expected] of OFFSET_ROWS.filter(([, row]) => !/\d{2}:\d{2}/.test(row))) {
    const title = expected.split(' | ')[0]!;
    const { contract } = await proposeModel(text, SEP_10, recordedModel({ [text]: reportAnswer(null, title) }).provider);
    assert.deepEqual(contract.items.map(line), [expected], text);
  }
  // A model day after the month's end under a spelled count is FY1's discard; the count then settles it.
  const threeDays = 'بدي أخلص التقرير قبل آخر الشهر بتلات أيام';
  const spelled = await proposeModel(threeDays, SEP_10, recordedModel({ [threeDays]: reportAnswer('2026-10-31', 'أخلص التقرير') }).provider);
  assert.deepEqual(spelled.contract.items.map(line), ['أخلص التقرير | 2026-09-27 - | settled']);
  const weekBefore = 'بدي أخلص التقرير قبل آخر الشهر بأسبوع';
  const { contract } = await proposeModel(weekBefore, SEP_10, recordedModel({ [weekBefore]: reportAnswer('2026-09-30', 'أخلص التقرير') }).provider);
  assert.deepEqual(contract.items.map(line), ['أخلص التقرير | 2026-09-23 - | settled']);
  // Another month named, with no model day: no day of ours.
  const october = 'לסיים דוח עד סוף חודש אוקטובר';
  const none = await proposeModel(october, SEP_10, recordedModel({ [october]: reportAnswer(null, 'לסיים דוח') }).provider);
  assert.equal(none.contract.items[0]?.resolvedDate, undefined);
});

test('FZ1 round 2: a counted day that has already gone is not moved to the 30th', async () => {
  // Monday 28 Sep: a week before the month's end was the 23rd.
  const proposal = await proposeRules('بدي أخلص التقرير قبل آخر الشهر بأسبوع', N6_NOW);
  assert.notEqual(proposal.items[0]?.resolvedDate, '2026-09-30');
  assert.equal(proposal.items[0]?.needsClarification, true);
});

// ── Round 3 (review FZ1-review.md: I1, I2, I3, M2, M5a, M5b) ─────────────

/** Monday 28 Sep 2026, 09:00 on the phone. */
const MON_9 = new Date('2026-09-28T06:00:00.000Z');

function answerOn(date: string, time: string | null, title: string) {
  return { ...modelAnswer(date, time), action: title, title };
}

test('FZ1 round 3 I1: a model day the words name some other way than "today" is the model\'s — never moved to today and settled', async () => {
  const rows: Array<[string, Date, string, string | null]> = [
    // The review's rows (Mon 09:00): the model's day is right.
    ['اليوم الدكتور قلي ارجعله يوم 5 الساعة 10', MON_9, '2026-10-05', '10:00'],
    ['اليوم المدير قلي لازم أسلم التقرير آخر الشهر الساعة 12', MON_9, '2026-09-30', '12:00'],
    ['today my boss said the report is due at the end of the month at noon', MON_9, '2026-09-30', '12:00'],
    ['اليوم عرفت إنه الاجتماع أول الشهر الساعة 10', MON_9, '2026-10-01', '10:00'],
    ['היום הרופא אמר לחזור ב-5 לחודש בשעה 10', MON_9, '2026-10-05', '10:00'],
    ['بدي أتصل بسامي بس مش اليوم', MON_9, '2026-09-29', null],
    ['not today, call Sami', MON_9, '2026-09-29', null],
    ['לא היום, להתקשר לסאמי', MON_9, '2026-09-29', null],
    // The same words when that day *is* tomorrow: still the model's.
    ['اليوم المدير قلي لازم أسلم التقرير آخر الشهر الساعة 12', new Date('2026-09-29T06:00:00.000Z'), '2026-09-30', '12:00'],
    ['اليوم عرفت إنه الاجتماع أول الشهر الساعة 10', new Date('2026-09-30T06:00:00.000Z'), '2026-10-01', '10:00'],
    ['اليوم الدكتور قلي ارجعله يوم 5 الساعة 10', new Date('2026-10-04T06:00:00.000Z'), '2026-10-05', '10:00'],
    ['היום הרופא אמר לחזור ב-5 לחודש בשעה 10', new Date('2026-10-04T06:00:00.000Z'), '2026-10-05', '10:00'],
    // Friday 2 Oct: the weekend, and after the feast, are tomorrow.
    ['اليوم قررت أروح عالبحر الويكند الساعة 10', new Date('2026-10-02T06:00:00.000Z'), '2026-10-03', '10:00'],
    ['today I decided to go to the beach this weekend at 10am', new Date('2026-10-02T06:00:00.000Z'), '2026-10-03', '10:00'],
    ['اليوم بدي أحجز موعد بعد العيد الساعة 10', new Date('2026-10-02T06:00:00.000Z'), '2026-10-03', '10:00'],
  ];
  for (const [text, now, date, time] of rows) {
    const result = validateExtractionResult(answerOn(date, time, 'x'), text, { now, timezone: TZ });
    assert.equal(`${result.localTimeSpec?.date} ${result.localTimeSpec?.time ?? '-'}`, `${date} ${time ?? '-'}`, text);
  }
});

test('FZ1 round 3 I1: a moved day is always a question — an hour still ahead today is asked on today, never settled', async () => {
  const text = 'اليوم الساعة 5 المسا لازم أبعت الإيميل للمدير';
  const { contract } = await proposeModel(text, MON_9, recordedModel({ [text]: modelAnswer('2026-09-29', '17:00') }).provider);
  assert.equal(contract.status, 'needs_clarification');
  assert.deepEqual(contract.items.map(line), ['أبعت الإيميل للمدير | 2026-09-28 - | ask_time']);
  assertAskedAhead(contract.items[0]!, MON_9);
  // The literal N10 capture is still asked (its hour has passed).
  const n10 = await proposeModel(N10, N10_NOW, recordedModel({}, 'run 1').provider);
  assert.deepEqual(n10.contract.items.map(line), ['أبعت الإيميل للمدير | 2026-09-28 - | ask_time']);
});

test('FZ1 round 3 I2: «ب 3 أيام», «ب٣ أيام», «قبل ما يخلص الشهر بأسبوع» and «بخمس تيام» are counted, on both paths', async () => {
  const rows: Array<[string, string]> = [
    ['بدي أخلص التقرير قبل آخر الشهر ب 3 أيام', 'أخلص التقرير | 2026-09-27 - | settled'],
    ['بدي أخلص التقرير قبل آخر الشهر ب٣ أيام', 'أخلص التقرير | 2026-09-27 - | settled'],
    ['بدي أخلص التقرير قبل آخر الشهر بـ٣ أيام', 'أخلص التقرير | 2026-09-27 - | settled'],
    ['بدي أخلص التقرير قبل ما يخلص الشهر بأسبوع', 'أخلص التقرير | 2026-09-23 - | settled'],
    ['بدي أخلص التقرير قبل آخر الشهر بخمس تيام', 'أخلص التقرير | 2026-09-25 - | settled'],
  ];
  for (const [text, expected] of rows) {
    assert.deepEqual((await proposeRules(text, SEP_10)).items.map(line), [expected], text);
    const { contract } = await proposeModel(text, SEP_10, recordedModel({ [text]: reportAnswer(null, 'أخلص التقرير') }).provider);
    assert.deepEqual(contract.items.map(line), [expected], `model: ${text}`);
  }
});

test('FZ1 round 3 I2: an offset with no count is no day of ours — the hour is asked and the title keeps the offset', async () => {
  const rows: Array<[string, string]> = [
    ['بدي أخلص التقرير قبل آخر الشهر بأسابيع', 'بأسابيع'],
    ['بدي أخلص التقرير قبل آخر الشهر بكم يوم', 'بكم يوم'],
    ['بدي أخلص التقرير قبل آخر الشهر بشي أسبوع', 'بشي أسبوع'],
    ['بدي أخلص التقرير قبل ما يخلص الشهر بكم يوم', 'بكم يوم'],
    ['finish the report a few days before the end of the month', 'a few days'],
    ['לסיים את הדוח כמה ימים לפני סוף החודש', 'כמה ימים'],
  ];
  for (const [text, words] of rows) {
    const item = (await proposeRules(text, SEP_10)).items[0]!;
    assert.equal(item.resolvedDate, undefined, text);
    assert.equal(item.clarification?.questionKey, 'ask_time', text);
    assert.ok(item.title.includes(words), `${text}: ${item.title}`);
    const { contract } = await proposeModel(text, SEP_10, recordedModel({ [text]: reportAnswer(null, 'أخلص التقرير') }).provider);
    assert.equal(contract.items[0]?.resolvedDate, undefined, `model: ${text}`);
  }
});

test('FZ1 round 3 I3: an offset before another month\'s end is not counted on this month — no day, and the title keeps the month', async () => {
  const text = 'להגיש את הדוח שבוע לפני סוף חודש אוקטובר';
  const item = (await proposeRules(text, SEP_10)).items[0]!;
  assert.equal(item.resolvedDate, undefined);
  assert.equal(item.clarification?.questionKey, 'ask_time');
  assert.notEqual(item.title, 'להגיש את הדוח אוקטובר');
  assert.ok(item.title.includes('סוף חודש אוקטובר'), item.title);
  const { contract } = await proposeModel(text, SEP_10, recordedModel({ [text]: reportAnswer(null, 'להגיש את הדוח') }).provider);
  assert.equal(contract.items[0]?.resolvedDate, undefined);
  for (const other of ['بدي أخلص التقرير قبل آخر شهر 10 بأسبوع', 'submit the report a week before the end of October']) {
    assert.equal((await proposeRules(other, SEP_10)).items[0]?.resolvedDate, undefined, other);
  }
});

test('FZ1 round 3 M2: on the model path the month-end report with a stated hour gets no month-end day of ours', async () => {
  const text = 'أحضّر تقرير آخر الشهر الساعة 5 المسا';
  const { contract } = await proposeModel(text, N6_NOW, recordedModel({ [text]: reportAnswer(null) }).provider);
  assert.notEqual(contract.items[0]?.resolvedDate, '2026-09-30');
});

test('FZ1 round 3 M5a: a typed number with a part of the day answers the time question with that hour in that half, not the button\'s 19:00', async () => {
  for (const freeText of ['5 المسا', 'الساعة 5 المسا', '5 in the evening', '5 בערב', '٥ المسا']) {
    assert.deepEqual((await answerN10OnRules(freeText)).items, ['أبعت الإيميل للمدير | 2026-09-28 17:00 | settled'], freeText);
  }
  // No number: the button's hour, as FY1 ruled.
  assert.deepEqual((await answerN10OnRules('بالمسا')).items, ['أبعت الإيميل للمدير | 2026-09-28 19:00 | settled']);
  // A number at night follows the night's rule: «2 بالليل» for tomorrow's email is 02:00.
  const uid = 'fz1-m5a-night';
  const items = await withMemoryStorage(async () => {
    const proposal = await proposeMobileCapture({ text: 'بكرا لازم أبعت الإيميل للمدير', timezone: TZ, referenceTime: MON_9.toISOString() }, { participantId: uid });
    const item = proposal.items[0]!;
    const updated = await clarifyMobileCapture({
      proposalId: proposal.proposalId, itemId: item.itemId, questionId: item.clarification!.questionId, freeText: '2 بالليل',
      timezone: TZ, referenceTime: MON_9.toISOString(),
    }, { participantId: uid });
    return updated.items.map(line);
  });
  assert.deepEqual(items, ['أبعت الإيميل للمدير | 2026-09-29 02:00 | settled']);
});

test('FZ1 round 3 M5b: a spoken Hebrew hour at night — «מחר בשתיים בלילה» — is 02:00, and leaves the title', async () => {
  const evening = new Date('2026-09-27T17:00:00.000Z');
  for (const [text, expected] of [
    ['לשלוח את המייל מחר בשתיים בלילה', '2026-09-28 02:00'],
    ['לשלוח את המייל מחר באחת עשרה בלילה', '2026-09-28 23:00'],
    ['לשלוח את המייל מחר בחמש בבוקר', '2026-09-28 05:00'],
    ['לשלוח את המייל מחר בשש בערב', '2026-09-28 18:00'],
  ] as const) {
    const { result } = await extractWithFallback(text, { now: evening, timezone: TZ }, { llmProvider: async () => { throw new LLMUnavailableError('provider_none'); } });
    assert.equal(`${result.localTimeSpec?.date} ${result.localTimeSpec?.time}`, expected, text);
    assert.equal(result.title, 'לשלוח את המייל', text);
  }
  // A count that is not an hour keeps its word.
  const { result } = await extractWithFallback('לסיים שלוש משימות מחר בבוקר', { now: evening, timezone: TZ }, { llmProvider: async () => { throw new LLMUnavailableError('provider_none'); } });
  assert.ok(result.title?.includes('שלוש'), result.title ?? '');
});

// ── Round 3 add-on (FZ2's finding): the person's zone on an answered item ──

test('FZ1 round 3 add-on: an appointment answered «الصبح», then cleared to «بدون وقت» in the edit sheet, is stored at local midnight in the person\'s zone', async () => {
  const uid = 'fz1-dentist';
  const zone = 'Asia/Jerusalem';
  const now = new Date('2026-09-28T07:00:00.000Z'); // Mon 10:00
  await withMemoryStorage(async () => {
    const proposal = await proposeMobileCapture({ text: 'سجّل موعد أسنان يوم الجمعة', timezone: zone, referenceTime: now.toISOString() }, { participantId: uid });
    const item = proposal.items[0]!;
    assert.equal(item.clarification?.questionKey, 'ask_time');
    const answered = await clarifyMobileCapture({
      proposalId: proposal.proposalId, itemId: item.itemId, questionId: item.clarification!.questionId, optionId: 'morning',
      timezone: zone, referenceTime: now.toISOString(),
    }, { participantId: uid });
    assert.equal(answered.items[0]!.resolvedDate, '2026-10-02');
    const confirmed = await confirmMobileCapture({ proposalId: proposal.proposalId, itemIds: [item.itemId], edits: [{ itemId: item.itemId, resolvedTime: null }] }, { participantId: uid });
    assert.equal(confirmed.success, true, JSON.stringify(confirmed));
    const commitment = Object.values((await getParticipantStateSnapshot(uid)).commitments)[0]!;
    assert.deepEqual(
      { kind: commitment.timeSpec.kind, allDay: commitment.timeSpec.allDay, dueAt: commitment.timeSpec.dueAt, timezone: commitment.timeSpec.timezone },
      // Friday 2 Oct, 00:00 in Jerusalem (UTC+3).
      { kind: 'scheduled_event', allDay: true, dueAt: '2026-10-01T21:00:00.000Z', timezone: zone },
    );
  });
});

test('FZ1 round 3 add-on: any answered time keeps the person\'s zone on the stored commitment, not UTC', async () => {
  const uid = 'fz1-zone';
  const zone = 'Asia/Jerusalem';
  const now = new Date('2026-09-28T07:00:00.000Z');
  await withMemoryStorage(async () => {
    const proposal = await proposeMobileCapture({ text: 'بكرا لازم أبعت الإيميل للمدير', timezone: zone, referenceTime: now.toISOString() }, { participantId: uid });
    const item = proposal.items[0]!;
    await clarifyMobileCapture({
      proposalId: proposal.proposalId, itemId: item.itemId, questionId: item.clarification!.questionId, optionId: 'morning',
      timezone: zone, referenceTime: now.toISOString(),
    }, { participantId: uid });
    await confirmMobileCapture({ proposalId: proposal.proposalId, itemIds: [item.itemId] }, { participantId: uid });
    const commitment = Object.values((await getParticipantStateSnapshot(uid)).commitments)[0]!;
    assert.equal(commitment.timeSpec.timezone, zone);
    assert.equal(commitment.timeSpec.dueAt, '2026-09-29T06:00:00.000Z');
  });
});
