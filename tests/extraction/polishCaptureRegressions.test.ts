/**
 * The closure UAT's round-4 capture defects of 2026-09-28, and the minor items
 * the FY1/FZ1 reviews left open (lane POLISH-CAPTURE). The run was on Monday
 * 28 Sep in the morning, on a phone set to Asia/Hebron, with the Gemini path
 * consented.
 *
 *   N15 At 06:58, «أخلص التقرير قبل آخر الشهر بيومين» — two days before this
 *       month's end is Monday 28 Sep, today — was dated Thursday 29 or
 *       Friday 30 October (4 of 4): the model's next-month reading, kept
 *       because FY1 leaves any model day under an offset to the model. On the
 *       rules path the same sentence was nothing at all: «أخلص» was read as
 *       the past «خلص» ("it's over").
 *   N16 «…والخميس الساعة 6 المسا عندي عشا مع العيلة» was saved as «عندي
 *       عشا»: the model dropped «مع العيلة» from its title.
 *
 * And the review minors: «12 المسا» typed to the time question (FZ1 round 4),
 * a typed day ignored for an item that has a weekday (FY1 R2-M1), free text
 * to a question that takes none (FY1 R2-M2, which also closes FZ1 M3), the
 * confirm echo of a time cleared at confirm (FY1 R-M4), the other-day words
 * the move-back lacked (FZ1 N-M1) and «تقرير اليوم قبل آخر الشهر» read two
 * ways (FZ1 N-M3).
 *
 * The model answers for N15 and N16 are the ones Gemini actually gave
 * (`fixtures/uat-2026-09-28-round4-gemini.json`, recorded before the fix with
 * `scripts/live-capture-check.ts --only PC --record`). Rows that script a
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
import { localTimeSpecFor } from '../../src/extraction/timeLexicon.ts';
import { validateExtractionResult } from '../../src/extraction/schemaValidator.ts';

const TZ = 'Asia/Hebron';
/** Monday 28 Sep 2026, 06:58 on the phone — when N15 was typed. */
const N15_NOW = new Date('2026-09-28T03:58:00.000Z');
/** 06:50 the same morning — the smoke capture that showed N16. */
const N16_NOW = new Date('2026-09-28T03:50:00.000Z');
/** Monday 28 Sep, 10:00. */
const MON_10 = new Date('2026-09-28T07:00:00.000Z');

const N15 = 'أخلص التقرير قبل آخر الشهر بيومين';
const N16 = 'بكرا العصرية بدي أروح عالسوق، والخميس الساعة 6 المسا عندي عشا مع العيلة';

const CALLS = (JSON.parse(readFileSync(new URL('./fixtures/uat-2026-09-28-round4-gemini.json', import.meta.url), 'utf8')) as {
  calls: Array<{ case: string; payload: string | string[]; answer: unknown }>;
}).calls;

function payloadOf(prompt: string): string | string[] {
  const lines = prompt.split('\n');
  return JSON.parse(lines[lines.indexOf('BEGIN_UNTRUSTED_USER_MESSAGE') + 1]!) as string | string[];
}

/** A model that answers each payload with its recording, or an override; anything else fails. */
function recordedModel(overrides: Record<string, unknown> = {}) {
  let calls = 0;
  const provider = async (prompt: string): Promise<string> => {
    calls += 1;
    const payload = payloadOf(prompt);
    const key = typeof payload === 'string' ? payload : JSON.stringify(payload);
    if (key in overrides) return JSON.stringify(overrides[key]);
    const hit = CALLS.find((call) => JSON.stringify(call.payload) === JSON.stringify(payload));
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
    { now, timezone: TZ, scopeId: 'pc', requestedEngine: 'model' },
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

/** A model answer for a report clause — scripted, to reach an edge the recording does not. */
function reportAnswer(date: string | null, title = 'أخلص التقرير', time: string | null = null) {
  return {
    type: 'task', action: title, title, person: null,
    dueAt: date ? new Date(`${date}T${time ?? '23:59'}:00+03:00`).toISOString() : null, remindAt: null,
    localTimeSpec: date ? { date, time: time ?? '23:59', timezone: TZ } : null,
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureImplied: false },
    flexibility: 'movable', category: null, categoryConfidence: 0,
    confidence: { overall: 1, type: 1, action: 1, time: 1, priority: 1 },
    missingFields: [], ambiguityFlags: [], explicitReminderRequest: false, explicitPressureRequest: false,
  };
}

// ── N15: a counted day that is today, or has gone ────────────────────────

test('N15: the literal capture on the model path (Gemini said 29 Oct) is on today, Monday 28 Sep, the hour asked — never next month', async () => {
  const model = recordedModel();
  const { contract } = await proposeModel(N15, N15_NOW, model.provider);
  assert.equal(model.calls(), 1);
  assert.equal(contract.provenance.executedEngine, 'gemini');
  assert.equal(contract.status, 'needs_clarification');
  assert.deepEqual(contract.items.map(line), ['أخلص التقرير | 2026-09-28 - | ask_time']);
  assertAskedAhead(contract.items[0]!, N15_NOW);
  // The question names the day it is asking about: today.
  assert.equal((contract.items[0]!.clarification!.params as { date?: string }).date, '2026-09-28');
});

test('N15: the other UAT reading (Friday 30 Oct) and every other model day give way to the counted day too', async () => {
  // Scripted: the UAT saw 30 Oct as well; the rest are other days a model could give.
  for (const date of ['2026-10-30', '2026-10-28', '2026-09-30', '2026-09-29', null]) {
    const { contract } = await proposeModel(N15, N15_NOW, recordedModel({ [N15]: reportAnswer(date) }).provider);
    assert.deepEqual(contract.items.map(line), ['أخلص التقرير | 2026-09-28 - | ask_time'], String(date));
  }
});

test('N15: on the rules path the literal capture is a commitment on today, the hour asked — «أخلص» is not the past «خلص»', async () => {
  const proposal = await proposeRules(N15, N15_NOW);
  assert.equal(proposal.status, 'needs_clarification');
  assert.deepEqual(proposal.items.map(line), ['أخلص التقرير | 2026-09-28 - | ask_time']);
  assertAskedAhead(proposal.items[0]!, N15_NOW);
  // The same with «بدي», which the rules already read, and in English and Hebrew.
  for (const [text, title] of [
    ['بدي أخلص التقرير قبل آخر الشهر بيومين', 'أخلص التقرير'],
    ['submit the report two days before the end of the month', 'submit the report'],
    ['לשלם חשבון יומיים לפני סוף החודש', 'לשלם חשבון'],
  ] as const) {
    assert.deepEqual((await proposeRules(text, N15_NOW)).items.map(line), [`${title} | 2026-09-28 - | ask_time`], text);
    const { contract } = await proposeModel(text, N15_NOW, recordedModel({ [text]: reportAnswer('2026-10-29', title) }).provider);
    assert.deepEqual(contract.items.map(line), [`${title} | 2026-09-28 - | ask_time`], `model: ${text}`);
  }
  // A past narration with «خلص» is still nothing.
  for (const text of ['خلص الاجتماع', 'خلصت التقرير مبارح']) {
    assert.equal((await proposeRules(text, N15_NOW)).items.length, 0, text);
  }
});

test('N15: a counted day that has gone is asked about with no day, on both paths — never moved to next month', async () => {
  // A week before the month's end was Wednesday 23 Sep.
  const text = 'بدي أخلص التقرير قبل آخر الشهر بأسبوع';
  assert.deepEqual((await proposeRules(text, N15_NOW)).items.map(line), ['أخلص التقرير | - - | ask_time']);
  for (const date of ['2026-10-23', '2026-10-24', '2026-09-28', '2026-09-30', null]) {
    const { contract } = await proposeModel(text, N15_NOW, recordedModel({ [text]: reportAnswer(date) }).provider);
    assert.deepEqual(contract.items.map(line), ['أخلص التقرير | - - | ask_time'], `model ${date}`);
  }
});

test('N15: a stated hour on the counted day is kept on it, and a counted day still ahead is FX3\'s deadline there', async () => {
  const timed = 'بدي أخلص التقرير قبل آخر الشهر بيومين الساعة 5 المسا';
  assert.deepEqual((await proposeRules(timed, N15_NOW)).items.map(line), ['أخلص التقرير | 2026-09-28 17:00 | settled']);
  const model = await proposeModel(timed, N15_NOW, recordedModel({ [timed]: reportAnswer('2026-10-29', 'أخلص التقرير', '17:00') }).provider);
  assert.deepEqual(model.contract.items.map(line), ['أخلص التقرير | 2026-09-28 17:00 | settled']);
  // Thursday 10 Sep: the 28th is ahead, all day, settled (FZ1 round 2) — and a model next month gives way to it.
  const sep10 = new Date('2026-09-10T09:00:00.000Z');
  const ahead = 'بدي أخلص التقرير قبل آخر الشهر بيومين';
  assert.deepEqual((await proposeRules(ahead, sep10)).items.map(line), ['أخلص التقرير | 2026-09-28 - | settled']);
  const later = await proposeModel(ahead, sep10, recordedModel({ [ahead]: reportAnswer('2026-10-29') }).provider);
  assert.deepEqual(later.contract.items.map(line), ['أخلص التقرير | 2026-09-28 - | settled']);
});

// ── N16: who it is with stays in the title ───────────────────────────────

test('N16: on the model path the literal capture keeps «مع العيلة» in the dinner\'s title', async () => {
  const model = recordedModel();
  const { contract } = await proposeModel(N16, N16_NOW, model.provider);
  assert.equal(model.calls(), 1);
  assert.equal(contract.provenance.executedEngine, 'gemini');
  assert.deepEqual(contract.items.map(line), [
    'أروح عالسوق | 2026-09-29 15:00 | settled',
    'عندي عشا مع العيلة | 2026-10-01 18:00 | settled',
  ]);
});

test('N16: the rules path keeps the company too, and «غدا» said with someone is lunch, not tomorrow', async () => {
  assert.deepEqual((await proposeRules(N16, N16_NOW)).items.map((item) => item.title), ['أروح عالسوق', 'عندي عشا مع العيلة']);
  const rows: Array<[string, string]> = [
    ['عندي غدا مع أمي بكرا', 'عندي غدا مع أمي | 2026-09-29 - | ask_time'],
    ['عندي غدا مع أمي يوم الخميس', 'عندي غدا مع أمي | 2026-10-01 - | ask_time'],
    ['اجتماع مع سامي بكرا الساعة 10', 'اجتماع مع سامي | 2026-09-29 10:00 | settled'],
    ['dinner with the family on Thursday at 6pm', 'dinner with the family | 2026-10-01 18:00 | settled'],
    ['ארוחה עם המשפחה ביום חמישי ב-18:00', 'ארוחה עם המשפחה | 2026-10-01 18:00 | settled'],
  ];
  for (const [text, expected] of rows) {
    assert.deepEqual((await proposeRules(text, N16_NOW)).items.map(line), [expected], text);
  }
  // «غدا» alone is still tomorrow.
  assert.deepEqual((await proposeRules('غدا بدي أتصل بأمي', N16_NOW)).items.map(line), ['أتصل بأمي | 2026-09-29 - | ask_time']);
});

test('N16: a model title that drops the company right after it gets it back; one that kept it, or said it elsewhere, is left alone', () => {
  // Scripted model titles, each the head of the person's words.
  const rows: Array<[string, string, string]> = [
    ['بكرا عندي غدا مع أمي الساعة 2', 'عندي غدا', 'عندي غدا مع أمي'],
    ['اجتماع مع سامي بكرا الساعة 10', 'اجتماع', 'اجتماع مع سامي'],
    ['dinner with the family on Thursday at 6pm', 'dinner', 'dinner with the family'],
    ['ארוחה עם המשפחה ביום חמישי ב-18:00', 'ארוחה', 'ארוחה עם המשפחה'],
    ['والخميس الساعة 6 المسا عندي عشا مع العيلة، وبكرا بدي أروح', 'عندي عشا', 'عندي عشا مع العيلة'],
    // Kept already, or the company is not right after the title: unchanged.
    ['عندي عشا مع العيلة الخميس', 'عندي عشا مع العيلة', 'عندي عشا مع العيلة'],
    ['مع العيلة عندي عشا الخميس', 'عندي عشا', 'عندي عشا'],
    ['بدي أحكي مع أحمد بكرا', 'أحكي مع أحمد', 'أحكي مع أحمد'],
  ];
  for (const [text, title, expected] of rows) {
    const result = validateExtractionResult({ ...reportAnswer('2026-10-01', title, '18:00'), action: title }, text, { now: N16_NOW, timezone: TZ });
    assert.equal(result.title, expected, text);
  }
});

// ── «12 المسا» typed to the time question ───────────────────────────────

/** «سجّل موعد دكتور يوم الأحد» at Monday 10:00, answered by typing `freeText`. */
async function answerDoctor(freeText: string, engine: 'rules' | { reread: object } = 'rules') {
  const text = 'سجّل موعد دكتور يوم الأحد';
  if (engine !== 'rules') {
    let calls = 0;
    const store = new MemoryCaptureProposalStore();
    const persistence = new TransactionalCapturePersistenceAdapter(createEmptyDomainState());
    const contract = await proposeCapture(text, { now: MON_10, timezone: TZ, scopeId: 'pc-doc', requestedEngine: 'rules' }, { store, persistence });
    const item = contract.items[0]!;
    assert.equal(item.clarification?.questionKey, 'ask_time');
    const answer = (input: { freeText?: string; optionId?: string }) => answerClarification(
      { proposalId: contract.proposalId, itemId: item.itemId, questionId: item.clarification!.questionId, ...input },
      { now: MON_10, timezone: TZ, scopeId: 'pc-doc' },
      { store, recordEvent: () => undefined, extractor: guardedMobileExtract, llmEngine: 'gemini', llmProvider: async () => { calls += 1; return JSON.stringify(engine.reread); } },
    );
    try {
      return { line: line((await answer({ freeText })).items[0]!), calls };
    } catch (error) {
      const refused = (error as { failure?: string }).failure ?? String(error);
      return { line: `refused: ${refused}`, after: line((await answer({ optionId: 'evening' })).items[0]!), calls };
    }
  }
  const uid = 'pc-doctor';
  return withMemoryStorage(async () => {
    const proposal = await proposeMobileCapture({ text, timezone: TZ, referenceTime: MON_10.toISOString() }, { participantId: uid });
    const item = proposal.items[0]!;
    assert.equal(item.clarification?.questionKey, 'ask_time');
    assert.equal(item.resolvedDate, '2026-10-04');
    const answer = (input: { freeText?: string; optionId?: string }) => clarifyMobileCapture({
      proposalId: proposal.proposalId, itemId: item.itemId, questionId: item.clarification!.questionId, ...input,
      timezone: TZ, referenceTime: MON_10.toISOString(),
    }, { participantId: uid });
    try {
      return { line: line((await answer({ freeText })).items[0]!), calls: 0 };
    } catch (error) {
      const refused = (error as { failure?: string }).failure ?? String(error);
      // The round is kept after a refusal: a button still answers it.
      return { line: `refused: ${refused}`, after: line((await answer({ optionId: 'evening' })).items[0]!), calls: 0 };
    }
  });
}

test('«12 المسا» typed to the time question is ambiguous — not understood, and the buttons stay', async () => {
  for (const freeText of ['12 المسا', 'الساعة 12 المسا', 'ع 12 بالمسا', '١٢ المسا', '12 مساءً', '12 in the evening', 'at 12 in the evening', '12 בערב']) {
    assert.deepEqual(await answerDoctor(freeText), { line: 'refused: answer_not_understood', after: 'موعد دكتور | 2026-10-04 19:00 | settled', calls: 0 }, freeText);
  }
  // Noon said as noon, and midnight by the night's rule, still answer.
  assert.equal((await answerDoctor('12 الظهر')).line, 'موعد دكتور | 2026-10-04 12:00 | settled');
  assert.equal((await answerDoctor('12 pm')).line, 'موعد دكتور | 2026-10-04 12:00 | settled');
  assert.equal((await answerDoctor('الساعة 7 المسا')).line, 'موعد دكتور | 2026-10-04 19:00 | settled');
});

// ── A typed day moves an item that has a weekday ─────────────────────────

test('the Sunday doctor answered «بكرا المسا» / "tomorrow evening" moves to tomorrow evening — the typed day wins', async () => {
  const rows: Array<[string, string]> = [
    ['بكرا المسا', 'موعد دكتور | 2026-09-29 19:00 | settled'],
    ['tomorrow evening', 'موعد دكتور | 2026-09-29 19:00 | settled'],
    ['מחר בערב', 'موعد دكتور | 2026-09-29 19:00 | settled'],
    ['بكرا الساعة 5 المسا', 'موعد دكتور | 2026-09-29 17:00 | settled'],
    ['بعد بكرا الصبح', 'موعد دكتور | 2026-09-30 09:00 | settled'],
    ['tonight', 'موعد دكتور | 2026-09-28 20:00 | settled'],
    ['يوم الخميس الساعة 4 العصر', 'موعد دكتور | 2026-10-01 16:00 | settled'],
    // The item's own day named again, or no day: Sunday.
    ['الأحد المسا', 'موعد دكتور | 2026-10-04 19:00 | settled'],
    ['بالمسا', 'موعد دكتور | 2026-10-04 19:00 | settled'],
  ];
  for (const [freeText, expected] of rows) {
    assert.equal((await answerDoctor(freeText)).line, expected, freeText);
  }
});

test('a typed day whose hour has gone is not understood — never silently another day', async () => {
  // Monday 10:00: this morning's 09:00 has gone. Neither Sunday nor tomorrow is what was typed.
  for (const freeText of ['اليوم الصبح', 'this morning', 'היום בבוקר']) {
    const result = await answerDoctor(freeText);
    assert.deepEqual({ line: result.line, after: result.after }, { line: 'refused: answer_not_understood', after: 'موعد دكتور | 2026-10-04 19:00 | settled' }, freeText);
  }
});

test('on the model path too the typed day wins over the re-read\'s weekday', async () => {
  // Scripted re-reads of «سجّل موعد دكتور يوم الأحد» + the answer: a model
  // that keeps the sentence's Sunday, and one that reads the answer's day.
  const doctorOn = (date: string, time: string) => ({ ...reportAnswer(date, 'موعد دكتور', time), priority: { level: 'high', source: 'inferred', pressureAllowed: false, pressureImplied: false } });
  for (const reread of [doctorOn('2026-10-04', '19:00'), doctorOn('2026-09-29', '19:00')]) {
    const result = await answerDoctor('بكرا المسا', { reread });
    assert.equal(result.line, 'موعد دكتور | 2026-09-29 19:00 | settled', JSON.stringify(reread.localTimeSpec));
  }
  for (const reread of [doctorOn('2026-10-04', '17:00'), doctorOn('2026-09-29', '17:00')]) {
    assert.equal((await answerDoctor('بكرا الساعة 5 المسا', { reread })).line, 'موعد دكتور | 2026-09-29 17:00 | settled');
  }
});

// ── A question that takes no free text refuses it ────────────────────────

const BANK_AT_5 = 'بكرا الساعة 5 بدي أروح عالبنك';

async function answerAmPm(freeText: string, engine: 'rules' | 'model' = 'rules') {
  if (engine === 'model') {
    let calls = 0;
    const store = new MemoryCaptureProposalStore();
    const persistence = new TransactionalCapturePersistenceAdapter(createEmptyDomainState());
    const contract = await proposeCapture(BANK_AT_5, { now: MON_10, timezone: TZ, scopeId: 'pc-ampm', requestedEngine: 'rules' }, { store, persistence });
    const item = contract.items[0]!;
    assert.equal(item.clarification?.questionKey, 'ask_am_pm');
    assert.equal(item.clarification?.allowFreeText, false);
    const answer = (input: { freeText?: string; optionId?: string }) => answerClarification(
      { proposalId: contract.proposalId, itemId: item.itemId, questionId: item.clarification!.questionId, ...input },
      { now: MON_10, timezone: TZ, scopeId: 'pc-ampm' },
      { store, recordEvent: () => undefined, extractor: guardedMobileExtract, llmEngine: 'gemini', llmProvider: async () => { calls += 1; throw new LLMUnavailableError('provider_error'); } },
    );
    try {
      return { line: line((await answer({ freeText })).items[0]!), calls };
    } catch (error) {
      return { line: `refused: ${(error as { failure?: string }).failure ?? String(error)}`, after: line((await answer({ optionId: 'pm' })).items[0]!), calls };
    }
  }
  const uid = 'pc-ampm';
  return withMemoryStorage(async () => {
    const proposal = await proposeMobileCapture({ text: BANK_AT_5, timezone: TZ, referenceTime: MON_10.toISOString() }, { participantId: uid });
    const item = proposal.items[0]!;
    assert.equal(item.clarification?.questionKey, 'ask_am_pm');
    assert.equal(item.clarification?.allowFreeText, false);
    const answer = (input: { freeText?: string; optionId?: string }) => clarifyMobileCapture({
      proposalId: proposal.proposalId, itemId: item.itemId, questionId: item.clarification!.questionId, ...input,
      timezone: TZ, referenceTime: MON_10.toISOString(),
    }, { participantId: uid });
    try {
      return { line: line((await answer({ freeText })).items[0]!), calls: 0 };
    } catch (error) {
      return { line: `refused: ${(error as { failure?: string }).failure ?? String(error)}`, after: line((await answer({ optionId: 'pm' })).items[0]!), calls: 0 };
    }
  });
}

test('the am/pm question takes no free text: typed words are refused with free_text_not_allowed, never read as the morning', async () => {
  // FZ1 M3's rows: «بعد بكرا pm» and "I am not sure" were 05:00.
  for (const freeText of ['بعد بكرا pm', 'I am not sure', 'بعد بكرا م', 'المسا', 'pm', 'الساعة 7 المسا']) {
    for (const engine of ['rules', 'model'] as const) {
      assert.deepEqual(
        await answerAmPm(freeText, engine),
        { line: 'refused: free_text_not_allowed', after: 'أروح عالبنك | 2026-09-29 17:00 | settled', calls: 0 },
        `${engine}: ${freeText}`,
      );
    }
  }
  // A question that takes free text still reads it.
  assert.equal((await answerDoctor('الساعة 7 المسا')).line, 'موعد دكتور | 2026-10-04 19:00 | settled');
});

// ── The confirm echo of a time cleared at confirm ────────────────────────

test('a task cleared to no time at confirm echoes no time — the echo is what was stored', async () => {
  const uid = 'pc-echo';
  await withMemoryStorage(async () => {
    const text = 'لازم أشتري دوا من الصيدلية بكرا الساعة 5 المسا';
    const proposal = await proposeMobileCapture({ text, timezone: TZ, referenceTime: MON_10.toISOString() }, { participantId: uid });
    const item = proposal.items[0]!;
    assert.equal(line(item), 'أشتري دوا من الصيدلية | 2026-09-29 17:00 | settled');
    const confirmed = await confirmMobileCapture({ proposalId: proposal.proposalId, itemIds: [item.itemId], edits: [{ itemId: item.itemId, resolvedTime: null }] }, { participantId: uid });
    assert.equal(confirmed.success, true, JSON.stringify(confirmed));
    const commitment = Object.values((await getParticipantStateSnapshot(uid)).commitments)[0]!;
    assert.equal(commitment.timeSpec.dueAt ?? null, null);
    assert.equal(commitment.timeSpec.remindAt ?? null, null);
    assert.deepEqual(confirmed.persisted.map((persisted) => persisted.resolvedTime), [null]);
  });
  // A time edited to another one echoes the new one.
  await withMemoryStorage(async () => {
    const text = 'لازم أشتري دوا من الصيدلية بكرا الساعة 5 المسا';
    const proposal = await proposeMobileCapture({ text, timezone: TZ, referenceTime: MON_10.toISOString() }, { participantId: uid });
    const item = proposal.items[0]!;
    const confirmed = await confirmMobileCapture({ proposalId: proposal.proposalId, itemIds: [item.itemId], edits: [{ itemId: item.itemId, resolvedTime: '2026-09-29T16:00:00.000Z' }] }, { participantId: uid });
    assert.deepEqual(confirmed.persisted.map((persisted) => persisted.resolvedTime), ['2026-09-29T16:00:00.000Z']);
  });
});

// ── Other-day words the move-back lacked ─────────────────────────────────

test('"the next day", «آخر الليل» and «الساعة 12 بالليل» name tomorrow: the model\'s tomorrow is kept, not moved back to today', () => {
  // Monday 22:00.
  const late = new Date('2026-09-28T19:00:00.000Z');
  const at = (text: string, date: string, time: string | null) => {
    const result = validateExtractionResult({ ...reportAnswer(date, 'x', time ?? '23:59'), localTimeSpec: { date, time, timezone: TZ } }, text, { now: late, timezone: TZ });
    return `${result.localTimeSpec?.date ?? '-'} ${result.localTimeSpec?.time ?? '-'}`;
  };
  const rows: Array<[string, string | null]> = [
    ['today I sort the files and send them the next day', null],
    ['اليوم آخر الليل الساعة 1 لازم أبعت الإيميل', '01:00'],
    ['اليوم الساعة 12 بالليل لازم أبعت الإيميل', '00:00'],
    ['اليوم نص الليل لازم أبعت الإيميل', '00:00'],
    ['send the email today at midnight', '00:00'],
  ];
  for (const [text, time] of rows) assert.equal(at(text, '2026-09-29', time), `2026-09-29 ${time ?? '-'}`, text);
  // Without them the move-back still asks on today (FZ1 N10).
  assert.equal(at('اليوم الساعة 2 بالليل لازم أبعت الإيميل', '2026-09-29', '02:00'), '2026-09-28 -');
});

// ── «تقرير اليوم قبل آخر الشهر» reads the same on both engines ────────────

test('«بدي أخلص تقرير اليوم قبل آخر الشهر»: both engines put it on today and ask the hour — the month\'s end is not picked silently', async () => {
  const text = 'بدي أخلص تقرير اليوم قبل آخر الشهر';
  const rules = (await proposeRules(text, MON_10)).items.map(line);
  assert.deepEqual(rules, ['أخلص تقرير قبل آخر الشهر | 2026-09-28 - | ask_time']);
  // Scripted: no day, and the month's end, the two readings that settled 30 Sep.
  // (The title is the model's own; the day and the question are what must agree.)
  for (const date of [null, '2026-09-30']) {
    const { contract } = await proposeModel(text, MON_10, recordedModel({ [text]: reportAnswer(date, 'أخلص تقرير') }).provider);
    assert.deepEqual(contract.items.map((item) => line(item).split(' | ').slice(1).join(' | ')), ['2026-09-28 - | ask_time'], `model ${date}`);
  }
  // Tomorrow said the same way: tomorrow, on both.
  const tomorrow = 'بدي أدفع الفاتورة بكرا قبل آخر الشهر';
  assert.deepEqual((await proposeRules(tomorrow, MON_10)).items.map((item) => item.resolvedDate), ['2026-09-29']);
  const model = await proposeModel(tomorrow, MON_10, recordedModel({ [tomorrow]: reportAnswer(null, 'أدفع الفاتورة') }).provider);
  assert.deepEqual(model.contract.items.map((item) => item.resolvedDate), ['2026-09-29']);
  // No day word: FX3's deadline on the 30th, unchanged.
  const plain = 'بدي أدفع الفاتورة قبل آخر الشهر';
  const fx3 = await proposeModel(plain, MON_10, recordedModel({ [plain]: reportAnswer(null, 'أدفع الفاتورة') }).provider);
  assert.deepEqual(fx3.contract.items.map(line), ['أدفع الفاتورة | 2026-09-30 - | settled']);
});

// ── Fix round (POLISH-CAPTURE-review.md) ─────────────────────────────────

test('fix I1: «غدا مع …» is tomorrow unless the sentence names another day — standard-Arabic "tomorrow with" keeps its day', async () => {
  const tomorrow: Array<[string, string | null]> = [
    ['اجتماع غدا مع العميل الساعة 11', '11:00'],
    ['عندي اجتماع غدا مع المدير الساعة 10', '10:00'],
    ['غدا مع المدير اجتماع الساعة 10', '10:00'],
    ['أراك غدا مع الفريق الساعة 9 صباحا', '09:00'],
    ['لدي اجتماع غدا مع مديري', null],
    ['سأتصل بأمي غدا مع الصباح', '09:00'],
  ];
  for (const [text, time] of tomorrow) {
    const item = (await proposeRules(text, MON_10)).items[0];
    assert.equal(item?.resolvedDate, '2026-09-29', text);
    if (time) assert.equal(localTimeSpecFor(new Date(item!.resolvedTime!), TZ)?.time, time, text);
  }
  // Another day named: «غدا» is the lunch, and stays in the title.
  assert.deepEqual((await proposeRules('عندي غدا مع أمي بكرا', MON_10)).items.map(line), ['عندي غدا مع أمي | 2026-09-29 - | ask_time']);
  assert.deepEqual((await proposeRules('يوم الخميس عندي غدا مع أمي', MON_10)).items.map((item) => [item.title, item.resolvedDate]), [['عندي غدا مع أمي', '2026-10-01']]);
});

test('fix I2: a past «خلص» after «و»/«ف» is still past narration; the first-person «أخلص»/«بخلص» are still commitments', async () => {
  for (const text of ['وخلص الاجتماع', 'وخلصت التقرير', 'والحمدلله وخلصنا المشروع', 'فخلص الموضوع', 'وخلصت الدورة اليوم', 'خلص الاجتماع', 'الاجتماع خلص', 'اليوم خلصت الدورة']) {
    const proposal = await proposeRules(text, MON_10);
    assert.equal(proposal.status, 'no_commitment', text);
    assert.equal(proposal.items.length, 0, text);
  }
  for (const text of ['أخلص التقرير بكرا', 'بخلص الشغل بكرا الساعة 5 المسا']) {
    assert.equal((await proposeRules(text, MON_10)).items.length, 1, text);
  }
});

test('fix I3: a typed answer that negates a day, offers two, or says "the next day" is not understood — never the day it said not to use', async () => {
  for (const freeText of [
    'بكرا لا، الخميس المسا', 'not tomorrow, Thursday evening', 'الخميس بدل بكرا المسا', 'الأحد مش بكرا، المسا',
    'مش بكرا، الأحد المسا', 'بكرا أو الخميس المسا', 'tomorrow or Thursday evening', 'اليوم التاني المسا', 'לא מחר, ביום חמישי בערב',
  ]) {
    assert.deepEqual(await answerDoctor(freeText), { line: 'refused: answer_not_understood', after: 'موعد دكتور | 2026-10-04 19:00 | settled', calls: 0 }, freeText);
  }
  // A plain day, or «لا،» as its own reply before one, still answers.
  assert.equal((await answerDoctor('بكرا المسا')).line, 'موعد دكتور | 2026-09-29 19:00 | settled');
  assert.equal((await answerDoctor('لا، بكرا المسا')).line, 'موعد دكتور | 2026-09-29 19:00 | settled');
  assert.equal((await answerDoctor('الخميس المسا')).line, 'موعد دكتور | 2026-10-01 19:00 | settled');
});

test('fix M1: company is only who it is with — no dangling preposition, no «مع السلامة», "with love" or «עם זאת»', () => {
  const rows: Array<[string, string, string]> = [
    ['بكرا بدي أطلع مع صحابي عالبحر مع العيلة', 'أطلع', 'أطلع مع صحابي'],
    ['بدي أتصل بسامي مع السلامة بكرا', 'أتصل بسامي', 'أتصل بسامي'],
    ['لازم أروح عالجيم مع إني تعبان بكرا', 'أروح عالجيم', 'أروح عالجيم'],
    ['לשלוח את הדוח עם זאת מחר', 'לשלוח את הדוח', 'לשלוח את הדוח'],
    ['send the card with love tomorrow', 'send the card', 'send the card'],
    ['I am done with it, tomorrow call Sami', 'I am done', 'I am done'],
    // Still restored.
    ['والخميس الساعة 6 المسا عندي عشا مع العيلة', 'عندي عشا', 'عندي عشا مع العيلة'],
    ['meeting with John tomorrow at 5', 'meeting', 'meeting with John'],
    ['dinner with the family on Thursday at 6pm', 'dinner', 'dinner with the family'],
  ];
  for (const [text, title, expected] of rows) {
    const result = validateExtractionResult({ ...reportAnswer('2026-10-01', title, '18:00'), action: title }, text, { now: N16_NOW, timezone: TZ });
    assert.equal(result.title, expected, text);
  }
});

test('fix M2: «12:30 المسا» typed to the time question is ambiguous too', async () => {
  for (const freeText of ['12:30 المسا', 'الساعة 12:30 المسا', '12:15 in the evening']) {
    assert.equal((await answerDoctor(freeText)).line, 'refused: answer_not_understood', freeText);
  }
});

test('fix M7: «الساعة 12 المسا» in the capture itself is asked on its day, on both engines — never 12:00 or 00:00 picked', async () => {
  const rows: Array<[string, string]> = [
    ['بكرا الساعة 12 المسا بدي أتصل بأمي', 'أتصل بأمي'],
    ['call mom tomorrow at 12 in the evening', 'call mom'],
    ['מחר ב-12 בערב להתקשר לאמא', 'להתקשר לאמא'],
  ];
  for (const [text, title] of rows) {
    const rules = (await proposeRules(text, MON_10)).items;
    assert.deepEqual(rules.map((item) => line(item).split(' | ').slice(1).join(' | ')), ['2026-09-29 - | ask_time'], `rules: ${text}`);
    for (const [date, time] of [['2026-09-29', '12:00'], ['2026-09-30', '00:00']] as const) {
      const { contract } = await proposeModel(text, MON_10, recordedModel({ [text]: reportAnswer(date, title, time) }).provider);
      assert.deepEqual(contract.items.map((item) => line(item).split(' | ').slice(1).join(' | ')), [`${date} - | ask_time`], `model ${date} ${time}: ${text}`);
    }
  }
  // Noon and midnight said as such are unchanged.
  assert.equal(line((await proposeRules('بكرا الساعة 12 الضهر بدي أتصل بأمي', MON_10)).items[0]!).split(' | ')[1], '2026-09-29 12:00');
  assert.equal(line((await proposeRules('بكرا الساعة 12 بالليل بدي أتصل بأمي', MON_10)).items[0]!).split(' | ')[1], '2026-09-29 00:00');
});
