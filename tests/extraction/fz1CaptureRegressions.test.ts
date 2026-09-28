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
import { clarifyMobileCapture, proposeMobileCapture } from '../../lib/services/mobile/mobileCaptureService.ts';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { createEmptyDomainState } from '../../src/domain/stateMachine.ts';
import { localTimeSpecFor } from '../../src/extraction/timeLexicon.ts';
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
  for (const [freeText, date, time] of [['بعد ساعة', '2026-09-28', '04:22'], ['بعد شوي', '2026-09-28', '05:00'], ['later', '2026-09-28', '20:00'], ['אחר כך', '2026-09-28', '09:00']] as const) {
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
  // The passed hour goes back to today — the guarded extractor then refuses it
  // as past and the boundary asks, as for any passed hour.
  assert.equal(at(N10, modelAnswer('2026-09-29', '02:00')), '2026-09-28 02:00');
  // An hour still ahead today stays today.
  assert.equal(at('اليوم الساعة 5 المسا لازم أبعت الإيميل', modelAnswer('2026-09-29', '17:00')), '2026-09-28 17:00');
  assert.equal(at('send the email to my manager today at 5pm', modelAnswer('2026-10-02', '17:00')), '2026-09-28 17:00');
  assert.equal(at('לשלוח את המייל היום ב-5 אחר הצהריים', modelAnswer('2026-09-29', '17:00')), '2026-09-28 17:00');
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
    ['بدي أدفع الفاتورة بعد آخر الشهر بيومين', 'أدفع الفاتورة'],
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
  // Next month on the rules path: no day, as before.
  assert.equal((await proposeRules('بدي أحضّر تقرير آخر الشهر الجاي', N6_NOW)).items[0]?.resolvedDate, undefined);
  // A day or an hour the person said is theirs: the words do not move it.
  assert.deepEqual((await proposeRules('بدي أحضّر تقرير آخر الشهر بكرا الساعة 10', N6_NOW)).items.map(line), ['أحضّر تقرير آخر الشهر | 2026-09-29 10:00 | settled']);
  assert.equal((await proposeRules('بدي أحضّر تقرير آخر الشهر الساعة 10 الصبح', N6_NOW)).items[0]?.resolvedDate, '2026-09-28');
});
