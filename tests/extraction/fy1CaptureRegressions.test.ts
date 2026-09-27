/**
 * The closure UAT's round-2 capture defects of 2026-09-27, replayed (lane FY1).
 *
 *   N1  At 18:08, «اليوم الساعة 3 العصر كان عندي اجتماع…، واليوم لازم أرتب
 *       الغرفة، وبكرا الساعة 5 بدي أروح عالبنك» failed whole — «ما زبطت» —
 *       and every item in it was lost. On the model path the model rightly
 *       read the meeting clause as nothing; the boundary's rules recovery then
 *       re-read it (a commitment noun and a time), the guarded extractor threw
 *       `PastCommitmentTimeError` for its 15:00, and nothing caught it, so the
 *       capture came back `rejected` and the route answered 400. Alone,
 *       «اليوم الساعة 3 العصر لازم أبعت الإيميل للمدير» was refused by design.
 *   N4  The doctor's appointment answered «بدون وقت محدد» was stored with no
 *       day at all (`unscheduled`), shown as «لحد الأحد», and planned today.
 *   N6  «أحضّر تقرير آخر الشهر» on the model path: the title lost «آخر الشهر»
 *       and the model's 31 October was kept and asked about.
 *
 * The model answers are the ones Gemini actually gave for these clauses
 * (`fixtures/uat-2026-09-27-round2-gemini.json`, recorded before the fix with
 * `scripts/live-capture-check.ts --only FY1 --record`); the fake provider
 * answers a payload with its recording and fails on anything else. The model
 * path is `proposeCapture` with `guardedMobileExtract`, which is what
 * `proposeMobileCapture` gives it for a consented account; the rules path is
 * `proposeMobileCapture` itself.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LLMUnavailableError } from '../../src/extraction/llm/llmProvider.ts';
import {
  answerClarification,
  confirmCapture,
  MemoryCaptureProposalStore,
  proposeCapture,
  TransactionalCapturePersistenceAdapter,
} from '../../lib/services/captureBoundary/index.ts';
import { guardedMobileExtract } from '../../lib/services/mobile/safety.ts';
import { clarifyMobileCapture, confirmMobileCapture, proposeMobileCapture } from '../../lib/services/mobile/mobileCaptureService.ts';
import { getParticipantStateSnapshot } from '../../lib/services/mobile/participantState.ts';
import { buildDailyPlanInput } from '../../lib/services/dailyPlan/buildDailyPlan.ts';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { createEmptyDomainState, type Command, type Commitment } from '../../src/domain/stateMachine.ts';
import { localTimeSpecFor } from '../../src/extraction/timeLexicon.ts';
import { extractWithFallback } from '../../src/extraction/extractionService.ts';

const TZ = 'Asia/Jerusalem';
/** Sunday 27 Sep 2026, 18:08 in Jerusalem — when N1 was typed. */
const N1_NOW = new Date('2026-09-27T15:08:00.000Z');
/** 18:05 the same evening — when N6 was typed. */
const N6_NOW = new Date('2026-09-27T15:05:00.000Z');

const N1_THREE = 'اليوم الساعة 3 العصر كان عندي اجتماع مع سامي، واليوم لازم أرتب الغرفة، وبكرا الساعة 5 بدي أروح عالبنك';
const N1_ALONE = 'اليوم الساعة 3 العصر لازم أبعت الإيميل للمدير';
const N1_PAST_EVENT = 'اليوم الساعة 3 العصر كان عندي اجتماع مع سامي';
const N6_REPORT = 'أحضّر تقرير آخر الشهر';
const DOCTOR = 'سجّل موعد دكتور يوم الأحد';

/** No model: the rules read the clause, and nothing reaches a local one. */
const NO_MODEL = async (): Promise<string> => { throw new LLMUnavailableError('provider_none'); };

const CALLS = (JSON.parse(readFileSync(new URL('./fixtures/uat-2026-09-27-round2-gemini.json', import.meta.url), 'utf8')) as {
  calls: Array<{ payload: string | string[]; answer: unknown }>;
}).calls;

function payloadOf(prompt: string): string | string[] {
  const lines = prompt.split('\n');
  return JSON.parse(lines[lines.indexOf('BEGIN_UNTRUSTED_USER_MESSAGE') + 1]!) as string | string[];
}

/**
 * A model that answers each payload — one clause, or a batch — with the
 * recording for exactly that payload, or with an override for a clause.
 */
function recordedModel(overrides: Record<string, unknown> = {}) {
  let calls = 0;
  const provider = async (prompt: string): Promise<string> => {
    calls += 1;
    const payload = payloadOf(prompt);
    if (typeof payload === 'string' && payload in overrides) return JSON.stringify(overrides[payload]);
    if (Array.isArray(payload) && payload.some((clause) => clause in overrides)) {
      return JSON.stringify({ items: payload.map((clause, clauseIndex) => {
        const answer = overrides[clause];
        if (answer === undefined) throw new LLMUnavailableError('provider_error');
        return { clauseIndex, ...(answer as object) };
      }) });
    }
    const hit = CALLS.find((call) => JSON.stringify(call.payload) === JSON.stringify(payload));
    if (hit) return JSON.stringify(hit.answer);
    // A batch that was never sent as such — after the fix the past meeting
    // no longer reaches the model, so the room and the bank share a call of
    // two — is answered clause by clause from each one's own recording.
    if (Array.isArray(payload)) {
      return JSON.stringify({ items: payload.map((clause, clauseIndex) => {
        const single = CALLS.find((call) => call.payload === clause);
        if (!single) throw new LLMUnavailableError('provider_error');
        return { clauseIndex, ...(single.answer as object) };
      }) });
    }
    throw new LLMUnavailableError('provider_error');
  };
  return { provider, calls: () => calls };
}

async function proposeModel(text: string, now: Date, provider: (prompt: string) => Promise<string>) {
  const store = new MemoryCaptureProposalStore();
  const persistence = new TransactionalCapturePersistenceAdapter(createEmptyDomainState());
  const contract = await proposeCapture(
    text,
    { now, timezone: TZ, scopeId: 'fy1', requestedEngine: 'model' },
    { store, persistence, extractor: guardedMobileExtract, llmProvider: provider, llmEngine: 'gemini' },
  );
  return { contract, store, persistence };
}

async function proposeRules(text: string, now: Date) {
  return proposeMobileCapture({ text, timezone: TZ, referenceTime: now.toISOString() });
}

function withMemoryStorage<T>(run: () => Promise<T>): Promise<T> {
  setStorageForTests(createMemoryStorage());
  return run().finally(() => resetStorageForTests());
}

type Item = { title: string; resolvedDate?: string; resolvedTime: string | null; needsClarification: boolean; clarification?: { questionKey?: string } | null };
const line = (item: Item) => {
  const time = item.resolvedTime ? localTimeSpecFor(new Date(item.resolvedTime), TZ)?.time : null;
  return `${item.title} | ${item.resolvedDate ?? '-'} ${time ?? '-'} | ${item.needsClarification ? item.clarification?.questionKey ?? 'edit' : 'settled'}`;
};

/** Every option offered is still ahead of `now`: nothing unanswerable is asked. */
function assertAskedAhead(item: { clarification?: { options: Array<{ optionId: string; value: { localDate?: string; localTime?: string } }> } | null }, now: Date) {
  const options = item.clarification?.options ?? [];
  assert.ok(options.some((option) => option.optionId === 'none'), 'the "no specific time" answer is offered');
  for (const option of options) {
    if (!option.value.localDate || !option.value.localTime) continue;
    const at = Date.parse(new Date(`${option.value.localDate}T${option.value.localTime}:00+03:00`).toISOString());
    assert.ok(at > now.getTime(), `${option.optionId} ${option.value.localDate} ${option.value.localTime} is not in the past`);
  }
}

// ── N1: a clause timed earlier today never sinks the capture ─────────────

test('FY1 N1: the literal three-clause capture on the model path keeps the room and the bank, and says nothing about the past meeting', async () => {
  const model = recordedModel();
  const { contract } = await proposeModel(N1_THREE, N1_NOW, model.provider);
  assert.notEqual(contract.status, 'rejected');
  assert.equal(contract.provenance.executedEngine, 'gemini');
  assert.deepEqual(contract.items.map(line), [
    'أرتب الغرفة | - - | ask_time',
    // The past meeting's «الساعة 3» is not a time the proposal lost, so the
    // bank keeps the 17:00 the person said.
    'أروح عالبنك | 2026-09-28 17:00 | settled',
  ]);
  assert.equal(contract.status, 'proposed');
});

test('FY1 N1: the literal three-clause capture on the rules path proposes nothing for the past meeting', async () => {
  const proposal = await withMemoryStorage(() => proposeRules(N1_THREE, N1_NOW));
  assert.equal(proposal.status, 'needs_clarification');
  assert.deepEqual(proposal.items.map(line), [
    'أرتب الغرفة | 2026-09-27 - | ask_time',
    // The rules path's own bare-hour rule (CL1 round 6): «الساعة 5» is asked.
    'أروح عالبنك | 2026-09-28 - | ask_am_pm',
  ]);
});

test('FY1 N1: a clause that narrates what already happened is not a commitment, on either path', async () => {
  const rules = await withMemoryStorage(() => proposeRules(N1_PAST_EVENT, N1_NOW));
  assert.equal(rules.status, 'no_commitment');
  assert.equal(rules.noCommitmentReason, 'past_event');
  assert.deepEqual(rules.items, []);

  const { contract } = await proposeModel(N1_PAST_EVENT, N1_NOW, recordedModel().provider);
  assert.equal(contract.status, 'no_commitment');
  assert.deepEqual(contract.items, []);

  // English and Hebrew say it the same way; an obligation or a day ahead in
  // the same clause keeps it a request.
  for (const text of ['I had a meeting with Sam at 3pm today', 'היתה לי פגישה עם סאם היום בשלוש']) {
    const other = await withMemoryStorage(() => proposeRules(text, N1_NOW));
    assert.equal(other.status, 'no_commitment', text);
  }
  const ahead = await withMemoryStorage(() => proposeRules('كان عندي اجتماع مع سامي بس تأجل لبكرا الساعة 5 المسا', N1_NOW));
  assert.notEqual(ahead.status, 'no_commitment');
});

test('FY1 N1: one commitment whose hour has passed today is asked about, on the rules path', async () => {
  const proposal = await withMemoryStorage(() => proposeRules(N1_ALONE, N1_NOW));
  assert.equal(proposal.status, 'needs_clarification');
  assert.deepEqual(proposal.items.map(line), ['أبعت الإيميل للمدير | 2026-09-27 - | ask_time']);
  assertAskedAhead(proposal.items[0]!, N1_NOW);
  // This evening is still on offer, on today.
  assert.ok(proposal.items[0]!.clarification!.options.some((option) => option.optionId === 'evening' && option.value.localDate === '2026-09-27'));
});

test('FY1 N1: one commitment whose hour has passed today is asked about, on the model path, from the model\'s reading', async () => {
  const model = recordedModel();
  const { contract } = await proposeModel(N1_ALONE, N1_NOW, model.provider);
  assert.equal(contract.status, 'needs_clarification');
  assert.equal(contract.provenance.executedEngine, 'gemini');
  assert.equal(model.calls(), 1);
  assert.deepEqual(contract.items.map(line), ['أبعت الإيميل للمدير | 2026-09-27 - | ask_time']);
  assertAskedAhead(contract.items[0]!, N1_NOW);
});

test('FY1 N1: a clause the model read as nothing, recovered by the rules at an hour that has passed, is asked about — never a rejection', async () => {
  // «موعد الأسنان اليوم الساعة 3» is a commitment noun with a time, so the
  // boundary recovers it with the rules when the model says nothing; its 15:00
  // has gone by 18:08.
  const nothing = {
    type: 'informational_context', action: null, title: null, person: null, dueAt: null, remindAt: null, localTimeSpec: null,
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureImplied: false },
    flexibility: 'movable', category: null, categoryConfidence: 0,
    confidence: { overall: 0.9, type: 1, action: 1, time: 1, priority: 1 },
    missingFields: [], ambiguityFlags: ['informational_without_action'], explicitReminderRequest: false, explicitPressureRequest: false,
  };
  const bread = {
    ...nothing, type: 'task', action: 'أشتري خبز', title: 'أشتري خبز', ambiguityFlags: [],
    dueAt: null, localTimeSpec: { date: '2026-09-28', time: null, timezone: TZ },
  };
  const model = recordedModel({ 'موعد الأسنان اليوم الساعة 3 العصر': nothing, 'وبكرا بدي أشتري خبز': bread });
  const { contract } = await proposeModel('موعد الأسنان اليوم الساعة 3 العصر، وبكرا بدي أشتري خبز', N1_NOW, model.provider);
  assert.notEqual(contract.status, 'rejected');
  const dentist = contract.items.find((item) => item.title.includes('الأسنان'));
  assert.ok(dentist, JSON.stringify(contract.items.map(line)));
  assert.equal(dentist.needsClarification, true);
  assert.equal(dentist.resolvedTime, null);
  assert.equal(dentist.clarification?.questionKey, 'ask_time');
  assertAskedAhead(dentist, N1_NOW);
  assert.ok(contract.items.some((item) => item.title === 'أشتري خبز'));
});

// ── N4: an appointment with no hour is an all-day event on its day ───────

async function confirmedDoctorOnRules(): Promise<{ answered: { resolvedTime: string | null; resolvedDate?: string; allDayEvent?: boolean; needsClarification: boolean }; commitment: Commitment }> {
  const uid = 'fy1-doctor';
  const proposal = await proposeMobileCapture({ text: DOCTOR, timezone: TZ, referenceTime: N1_NOW.toISOString() }, { participantId: uid });
  const item = proposal.items[0]!;
  assert.equal(item.resolvedDate, '2026-10-04');
  assert.equal(item.clarification?.questionKey, 'ask_time');
  const updated = await clarifyMobileCapture({
    proposalId: proposal.proposalId, itemId: item.itemId, questionId: item.clarification!.questionId, optionId: 'none',
    timezone: TZ, referenceTime: N1_NOW.toISOString(),
  }, { participantId: uid });
  const answered = updated.items.find((candidate) => candidate.itemId === item.itemId)!;
  await confirmMobileCapture({ proposalId: proposal.proposalId, itemIds: [item.itemId] }, { participantId: uid });
  const commitment = Object.values((await getParticipantStateSnapshot(uid)).commitments)[0]!;
  return { answered, commitment };
}

function planFor(commitments: Commitment[], date: string) {
  const input = buildDailyPlanInput({ uid: 'fy1', date, timezone: TZ, commitments, profile: null, busyBlocks: [], builtAt: N1_NOW.toISOString() });
  return {
    pinned: input.constraints.fixedEvents.map((event) => event.sourceCommitmentId),
    floating: input.constraints.items.map((item) => item.itemId),
  };
}

test('FY1 N4: the doctor answered «بدون وقت محدد» stays on Sunday as an all-day event, not a deadline', async () => {
  const { answered, commitment } = await withMemoryStorage(confirmedDoctorOnRules);
  assert.equal(answered.needsClarification, false);
  assert.equal(answered.resolvedTime, null);
  assert.equal(answered.resolvedDate, '2026-10-04');
  // What tells the card to say «الأحد · بدون وقت» and not «لحد الأحد».
  assert.equal(answered.allDayEvent, true);
  assert.equal(commitment.status, 'active');
  assert.deepEqual(
    { kind: commitment.timeSpec.kind, allDay: commitment.timeSpec.allDay, dueAt: commitment.timeSpec.dueAt },
    // Local midnight of Sunday 4 Oct in Jerusalem.
    { kind: 'scheduled_event', allDay: true, dueAt: '2026-10-03T21:00:00.000Z' },
  );
});

test('FY1 N4: the planner does not put the all-day appointment on today, or at any hour of its own day', async () => {
  const { commitment } = await withMemoryStorage(confirmedDoctorOnRules);
  for (const date of ['2026-09-27', '2026-10-03', '2026-10-04']) {
    const plan = planFor([commitment], date);
    assert.deepEqual(plan, { pinned: [], floating: [] }, date);
  }
});

test('FY1 N4: on the model path the answered doctor is the same all-day event', async () => {
  const doctorAnswer = {
    type: 'task', action: 'موعد دكتور', title: 'موعد دكتور', person: null, dueAt: null, remindAt: null, localTimeSpec: null,
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureImplied: false },
    flexibility: 'movable', category: null, categoryConfidence: 0,
    confidence: { overall: 0.8, type: 1, action: 1, time: 0.5, priority: 1 },
    missingFields: ['time'], ambiguityFlags: [], explicitReminderRequest: false, explicitPressureRequest: false,
  };
  const run = await proposeModel(DOCTOR, N1_NOW, recordedModel({ [DOCTOR]: doctorAnswer }).provider);
  const item = run.contract.items[0]!;
  assert.equal(item.resolvedDate, '2026-10-04');
  const updated = await answerClarification(
    { proposalId: run.contract.proposalId, itemId: item.itemId, questionId: item.clarification!.questionId, optionId: 'none' },
    { now: N1_NOW, timezone: TZ, scopeId: 'fy1' },
    { store: run.store, recordEvent: () => undefined },
  );
  assert.equal(updated.items[0]!.allDayEvent, true);
  const confirmed = await confirmCapture(
    { proposalId: run.contract.proposalId, scopeId: 'fy1', selectedItemIds: [item.itemId], idempotencyKey: 'k-fy1-doctor', now: N1_NOW },
    { store: run.store, persistence: run.persistence },
  );
  assert.equal(confirmed.success, true);
  const pending = Object.values((await run.persistence.snapshot()).commitments);
  await run.persistence.persistAtomically(pending.map((commitment): Command => ({ type: 'ConfirmCommitment', commitmentId: commitment.id, now: N1_NOW.toISOString() })));
  const commitment = Object.values((await run.persistence.snapshot()).commitments)[0]!;
  assert.equal(commitment.timeSpec.kind, 'scheduled_event');
  assert.equal(commitment.timeSpec.allDay, true);
  assert.equal(commitment.timeSpec.dueAt, '2026-10-03T21:00:00.000Z');
  assert.deepEqual(planFor([commitment], '2026-09-27'), { pinned: [], floating: [] });
});

test('FY1 N4: a task (not an appointment) answered «بدون وقت محدد» is unchanged — no day is invented as an event', async () => {
  const uid = 'fy1-task';
  const commitment = await withMemoryStorage(async () => {
    const proposal = await proposeMobileCapture({ text: 'بدي أتصل بسامي يوم الأحد', timezone: TZ, referenceTime: N1_NOW.toISOString() }, { participantId: uid });
    const item = proposal.items[0]!;
    const updated = await clarifyMobileCapture({
      proposalId: proposal.proposalId, itemId: item.itemId, questionId: item.clarification!.questionId, optionId: 'none',
      timezone: TZ, referenceTime: N1_NOW.toISOString(),
    }, { participantId: uid });
    assert.equal(updated.items[0]!.allDayEvent, undefined);
    await confirmMobileCapture({ proposalId: proposal.proposalId, itemIds: [item.itemId] }, { participantId: uid });
    return Object.values((await getParticipantStateSnapshot(uid)).commitments)[0]!;
  });
  assert.equal(commitment.timeSpec.kind, 'unscheduled');
  assert.equal(commitment.timeSpec.allDay, false);
});

// ── N6: «آخر الشهر» in the person's words is this month's ────────────────

test('FY1 N6: the literal «أحضّر تقرير آخر الشهر» on the model path keeps the phrase and drops the model\'s 31 October', async () => {
  const { contract } = await proposeModel(N6_REPORT, N6_NOW, recordedModel().provider);
  assert.equal(contract.provenance.executedEngine, 'gemini');
  // The rules path's own answer to the same words (FX3 probe «بدي أحضّر تقرير
  // آخر الشهر»): the report keeps what it is, and the hour is asked.
  assert.deepEqual(contract.items.map(line), ['أحضّر تقرير آخر الشهر | - - | ask_time']);
});

test('FY1 N6: the rules path is unchanged — «أحضّر تقرير آخر الشهر» keeps its title', async () => {
  const proposal = await withMemoryStorage(() => proposeRules(N6_REPORT, N6_NOW));
  assert.deepEqual(proposal.items.map(line), ['أحضّر تقرير آخر الشهر | - - | ask_time']);
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

test('FY1 N6: a model day after this month\'s end is discarded; none, the last day or an earlier day is the model\'s', async () => {
  const rows: Array<[string | null, string]> = [
    ['2026-10-31', 'أحضّر تقرير آخر الشهر | - - | ask_time'],
    // Before the month's end: not the N6 defect, and possibly right (fix round, I2).
    ['2026-09-29', 'أحضّر تقرير آخر الشهر | 2026-09-29 - | ask_time'],
    [null, 'أحضّر تقرير آخر الشهر | - - | ask_time'],
    // This month's last day on the person's clock: the model's day stays, and
    // the hour is asked (the idafa is not a deadline, FX3).
    ['2026-09-30', 'أحضّر تقرير آخر الشهر | 2026-09-30 - | ask_time'],
  ];
  for (const [date, expected] of rows) {
    const { contract } = await proposeModel(N6_REPORT, N6_NOW, recordedModel({ [N6_REPORT]: reportAnswer(date) }).provider);
    assert.deepEqual(contract.items.map(line), [expected], String(date));
  }
});

test('FY1 N6: a deadline at this month\'s end settles on it when the model gave a later day; next month is the model\'s', async () => {
  const bill = 'بدي أدفع فاتورة الكهربا قبل آخر الشهر';
  const { contract: later } = await proposeModel(bill, N6_NOW, recordedModel({ [bill]: reportAnswer('2026-10-31', 'أدفع فاتورة الكهربا') }).provider);
  assert.deepEqual(later.items.map(line), ['أدفع فاتورة الكهربا | 2026-09-30 - | settled']);
  // An earlier model day is kept and its hour asked (FX3 I-2, unchanged by the narrowed ruling).
  for (const date of ['2026-09-29', '2026-09-25']) {
    const { contract } = await proposeModel(bill, N6_NOW, recordedModel({ [bill]: reportAnswer(date, 'أدفع فاتورة الكهربا') }).provider);
    assert.deepEqual(contract.items.map(line), [`أدفع فاتورة الكهربا | ${date} - | ask_time`], date);
  }
  // «الشهر الجاي» is not this month: the model's day is not second-guessed.
  const next = 'بدي أدفع فاتورة الكهربا قبل آخر الشهر الجاي';
  const { contract } = await proposeModel(next, N6_NOW, recordedModel({ [next]: reportAnswer('2026-10-31', 'أدفع فاتورة الكهربا') }).provider);
  assert.equal(contract.items[0]!.resolvedDate, '2026-10-31');
  // A clause that names its own day keeps the model's reading of that day.
  const tomorrow = 'بدي أحضّر تقرير آخر الشهر بكرا';
  const withDay = await proposeModel(tomorrow, N6_NOW, recordedModel({ [tomorrow]: reportAnswer('2026-09-28') }).provider);
  assert.equal(withDay.contract.items[0]!.resolvedDate, '2026-09-28');
  assert.equal(withDay.contract.items[0]!.title, 'أحضّر تقرير آخر الشهر');
});

test('FY1 N6: the 1st of the month between 00:00 and 03:00 local keeps FX3\'s edge', async () => {
  // 00:30 on 1 Oct in Jerusalem is still 30 Sep in UTC, and the model answers
  // the UTC month's end. That day is before the person's month's end, so the
  // narrowed ruling leaves it to FX3: the model's day, and the hour asked.
  const firstAt0030 = new Date('2026-09-30T21:30:00.000Z');
  const bill = 'بدي أدفع فاتورة الكهربا قبل آخر الشهر';
  const { contract } = await proposeModel(bill, firstAt0030, recordedModel({ [bill]: reportAnswer('2026-09-30', 'أدفع فاتورة الكهربا') }).provider);
  assert.deepEqual(contract.items.map(line), ['أدفع فاتورة الكهربا | 2026-09-30 - | ask_time']);
  // With no model day, FX3 settles the person's month's end.
  const none = await proposeModel(bill, firstAt0030, recordedModel({ [bill]: reportAnswer(null, 'أدفع فاتورة الكهربا') }).provider);
  assert.deepEqual(none.contract.items.map(line), ['أدفع فاتورة الكهربا | 2026-10-31 - | settled']);
});

// ── Fix round (review FY1-review.md: I1, I2, I3, the event branch, M1) ────

test('FY1 fix I1: a conditional or a correction is not past narration — the commitment is kept', async () => {
  const rows: Array<[string, string | null]> = [
    ['إذا كان عندي وقت يوم السبت بدي أنظف السيارة', '2026-10-03'],
    ['لو كان عندي وقت يوم الخميس بروح عالجيم', '2026-10-01'],
    // Kept, as at 460c097b. Which of its two days is read is the rules' first
    // weekday, as before FY1 — not this fix's to change.
    ['كان عندي موعد يوم الأحد بس صار يوم الاثنين الساعة 10', null],
  ];
  for (const [text, date] of rows) {
    const proposal = await withMemoryStorage(() => proposeRules(text, N1_NOW));
    assert.notEqual(proposal.status, 'no_commitment', text);
    assert.equal(proposal.items.length, 1, text);
    if (date) assert.equal(proposal.items[0]!.resolvedDate, date, text);
  }
  // English and Hebrew conditionals are not refused as narration either. (The
  // message classifier reads these two as informational, as it did at
  // 460c097b; that is not the past gate's doing.)
  for (const text of ['if I had time on Saturday I would wash the car', 'אם היה לי זמן ביום שבת הייתי שוטף את האוטו', 'If we had a meeting, remind me', 'אבל זה נדחה, היתה לי פגישה ביום שני']) {
    const read = await extractWithFallback(text, { now: N1_NOW, timezone: TZ }, { llmProvider: NO_MODEL });
    assert.notEqual(read.fallbackReason, 'semantic_safety:past_no_action', text);
  }
  for (const text of ['I had a meeting with Sam at 3pm today', 'היתה לי פגישה עם סאם היום בשלוש']) {
    const read = await extractWithFallback(text, { now: N1_NOW, timezone: TZ }, { llmProvider: NO_MODEL });
    assert.equal(read.fallbackReason, 'semantic_safety:past_no_action', text);
  }
  // A correction with no day of its own is kept too: its passed hour is asked.
  const moved = await withMemoryStorage(() => proposeRules('كان عندي موعد الساعة 3 بس صار الساعة 8 المسا', N1_NOW));
  assert.notEqual(moved.status, 'no_commitment');
  // N1's literal past meeting is still nothing.
  const past = await withMemoryStorage(() => proposeRules(N1_PAST_EVENT, N1_NOW));
  assert.equal(past.status, 'no_commitment');
});

test('FY1 fix I2: a model day is kept when the words put an offset on the month\'s end or name another month', async () => {
  const SEP_10 = new Date('2026-09-10T09:00:00.000Z');
  const rows: Array<[string, Date, string]> = [
    ['أخلص التقرير قبل آخر الشهر بأسبوع', SEP_10, '2026-09-23'],
    ['submit the report two days before the end of the month', SEP_10, '2026-09-28'],
    ['להגיש את הדוח שבוע לפני סוף החודש', SEP_10, '2026-09-23'],
    ['לסיים דוח עד סוף חודש אוקטובר', N6_NOW, '2026-10-31'],
    ['أدفع الإيجار بعد آخر الشهر بيومين', N6_NOW, '2026-10-02'],
    ['pay the bill after the end of the month', N6_NOW, '2026-10-01'],
  ];
  for (const [text, now, date] of rows) {
    const { contract } = await proposeModel(text, now, recordedModel({ [text]: reportAnswer(date, text) }).provider);
    assert.equal(contract.items[0]?.resolvedDate, date, text);
  }
  // The literal N6 row is still discarded and asked.
  const { contract } = await proposeModel(N6_REPORT, N6_NOW, recordedModel().provider);
  assert.deepEqual(contract.items.map(line), ['أحضّر تقرير آخر الشهر | - - | ask_time']);
});

async function answerN1Alone(freeText: string) {
  const uid = 'fy1-typed';
  return withMemoryStorage(async () => {
    const proposal = await proposeMobileCapture({ text: N1_ALONE, timezone: TZ, referenceTime: N1_NOW.toISOString() }, { participantId: uid });
    const item = proposal.items[0]!;
    assert.equal(item.clarification?.questionKey, 'ask_time');
    const updated = await clarifyMobileCapture({
      proposalId: proposal.proposalId, itemId: item.itemId, questionId: item.clarification!.questionId, freeText,
      timezone: TZ, referenceTime: N1_NOW.toISOString(),
    }, { participantId: uid });
    return updated.items.map(line);
  });
}

test('FY1 fix I3: a typed answer to the passed-hour question wins over the hour it replaces', async () => {
  assert.deepEqual(await answerN1Alone('الساعة 7 المسا'), ['أبعت الإيميل للمدير | 2026-09-27 19:00 | settled']);
  assert.deepEqual(await answerN1Alone('بكرا الساعة 10'), ['أبعت الإيميل للمدير | 2026-09-28 10:00 | settled']);
  // A bare hour is read the way a typed bare hour is read for any item (the
  // doctor's «الساعة 4» is 04:00): its next occurrence, never the passed 15:00.
  assert.deepEqual(await answerN1Alone('الساعة 4'), ['أبعت الإيميل للمدير | 2026-09-28 04:00 | settled']);
  // A typed part of the day is the lexicon's hour (evening 18:00, not the
  // button's 19:00 — as for any item), placed on its next occurrence.
  assert.deepEqual(await answerN1Alone('بالمسا'), ['أبعت الإيميل للمدير | 2026-09-28 18:00 | settled']);
});

test('FY1 fix I3: a typed answer that is itself already past is "not understood", never a generic failure', async () => {
  await assert.rejects(
    () => withMemoryStorage(async () => {
      const proposal = await proposeMobileCapture({ text: N1_ALONE, timezone: TZ, referenceTime: N1_NOW.toISOString() }, { participantId: 'fy1-past-answer' });
      const item = proposal.items[0]!;
      await clarifyMobileCapture({
        proposalId: proposal.proposalId, itemId: item.itemId, questionId: item.clarification!.questionId, freeText: 'اليوم الساعة 9 الصبح',
        timezone: TZ, referenceTime: N1_NOW.toISOString(),
      }, { participantId: 'fy1-past-answer' });
    }),
    (error: unknown) => (error as { failure?: string }).failure === 'answer_not_understood',
  );
});

async function answeredNoTime(text: string) {
  const uid = 'fy1-event';
  return withMemoryStorage(async () => {
    const proposal = await proposeMobileCapture({ text, timezone: TZ, referenceTime: N1_NOW.toISOString() }, { participantId: uid });
    const item = proposal.items[0]!;
    assert.equal(item.clarification?.questionKey, 'ask_time', text);
    const updated = await clarifyMobileCapture({
      proposalId: proposal.proposalId, itemId: item.itemId, questionId: item.clarification!.questionId, optionId: 'none',
      timezone: TZ, referenceTime: N1_NOW.toISOString(),
    }, { participantId: uid });
    await confirmMobileCapture({ proposalId: proposal.proposalId, itemIds: [item.itemId] }, { participantId: uid });
    const commitment = Object.values((await getParticipantStateSnapshot(uid)).commitments)[0]!;
    return { answered: updated.items[0]!, commitment };
  });
}

test('FY1 fix, event branch: a meeting or a wedding with a day answered «بدون وقت محدد» is an all-day event too; a task is not', async () => {
  for (const [text, date] of [
    ['meeting with Sam on Tuesday', '2026-09-29'],
    ['اجتماع مع سامي يوم الثلاثاء', '2026-09-29'],
    ['بدي أروح عالعرس يوم الخميس', '2026-10-01'],
    ['חתונה של דנה ביום חמישי', '2026-10-01'],
  ] as const) {
    const { answered, commitment } = await answeredNoTime(text);
    assert.equal(answered.allDayEvent, true, text);
    assert.equal(answered.resolvedDate, date, text);
    assert.equal(commitment.timeSpec.kind, 'scheduled_event', text);
    assert.equal(commitment.timeSpec.allDay, true, text);
    assert.deepEqual(planFor([commitment], '2026-09-27'), { pinned: [], floating: [] }, text);
  }
  for (const text of ['بدي أشتري هدية للعرس يوم الخميس', 'prepare the slides for the meeting on Tuesday', 'بدي أتصل بسامي يوم الأحد']) {
    const { answered, commitment } = await answeredNoTime(text);
    assert.equal(answered.allDayEvent, undefined, text);
    assert.notEqual(commitment.timeSpec.kind, 'scheduled_event', text);
  }
});

async function editedToNoTime(text: string) {
  const store = new MemoryCaptureProposalStore();
  const persistence = new TransactionalCapturePersistenceAdapter(createEmptyDomainState());
  const contract = await proposeCapture(text, { now: N1_NOW, timezone: TZ, scopeId: 'fy1-m1', requestedEngine: 'rules' }, { store, persistence });
  const item = contract.items[0]!;
  assert.equal(item.needsClarification, false, text);
  const result = await confirmCapture(
    { proposalId: contract.proposalId, scopeId: 'fy1-m1', selectedItemIds: [item.itemId], idempotencyKey: `k-${text}`, now: N1_NOW, edits: [{ itemId: item.itemId, resolvedTime: null }] },
    { store, persistence },
  );
  assert.equal(result.success, true, JSON.stringify(result));
  return Object.values((await persistence.snapshot()).commitments)[0]!;
}

test('FY1 fix M1: the review edit sheet\'s "no time" keeps an appointment on its day; a task loses its time as before', async () => {
  const doctor = await editedToNoTime('موعد دكتور يوم الأحد الساعة 10 الصبح');
  assert.deepEqual(
    { kind: doctor.timeSpec.kind, allDay: doctor.timeSpec.allDay, dueAt: doctor.timeSpec.dueAt, remindAt: doctor.timeSpec.remindAt },
    { kind: 'scheduled_event', allDay: true, dueAt: '2026-10-03T21:00:00.000Z', remindAt: null },
  );
  const medicine = await editedToNoTime('لازم أشتري دوا من الصيدلية يوم الأحد الساعة 5 المسا');
  assert.deepEqual({ kind: medicine.timeSpec.kind, dueAt: medicine.timeSpec.dueAt }, { kind: 'unscheduled', dueAt: null });
});
