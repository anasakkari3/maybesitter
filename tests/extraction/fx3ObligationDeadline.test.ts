/**
 * The closure UAT's capture complaints of 2026-09-27, replayed (lane FX3).
 *
 *   #5  «لازم» in the person's own words did not make the item «لازم» (Must).
 *       «لازم أسلّم التقرير», «لازم أروح عالبنك», «لازم أحضّر الغداء» all came
 *       back «يُفضّل» on the model path: the prompt told the model that only
 *       "urgent" or "important" is an explicit level, its own few-shot showed
 *       «لازم أمرّ على الصيدلية» as normal, and nothing after the model read
 *       the person's words. Only the appointment rule could raise a level.
 *   #7  «قبل آخر الشهر» was dropped: the item came back «بدون وقت», or with a
 *       day and a question about the hour; nothing kept it as a deadline.
 *
 * The model answers are the ones Gemini actually gave for these exact clauses
 * (`fixtures/uat-2026-09-27-gemini.json`, recorded before the fix with
 * `scripts/live-capture-check.ts --only FX3 --record`). The fake provider
 * answers a clause with its recording and fails on anything else.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LLMUnavailableError } from '../../src/extraction/llm/llmProvider.ts';
import { statedObligation } from '../../src/extraction/priorityLexicon.ts';
import { lastDayOfMonth, readPeriodEndDeadline } from '../../src/extraction/timeLexicon.ts';
import { extract } from '../../src/extraction/ruleBasedExtractor.ts';
import { validateExtractionResult } from '../../src/extraction/schemaValidator.ts';
import {
  confirmCapture,
  MemoryCaptureProposalStore,
  proposeCapture,
  TransactionalCapturePersistenceAdapter,
} from '../../lib/services/captureBoundary/index.ts';
import { createEmptyDomainState, type Command, type Commitment } from '../../src/domain/stateMachine.ts';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { proposeMobileCapture } from '../../lib/services/mobile/mobileCaptureService.ts';

const TZ = 'Asia/Jerusalem';
/** Saturday 26 Sep 2026, 10:00 in Jerusalem — the recordings' reference time. */
const NOW = new Date('2026-09-26T07:00:00.000Z');
/** Local midnight of Wednesday 30 Sep 2026 in Jerusalem (UTC+3). */
const SEP_30_MIDNIGHT = '2026-09-29T21:00:00.000Z';

const UAT_SIX = 'بكرا لازم أسلّم التقرير للمدير، وسجّل موعد دكتور يوم الأحد، وبدي أتصل بأمي الساعة 5، ولازم أحضّر الغداء اليوم الساعة 2 الظهر، وبدي أدفع فاتورة الكهربا قبل آخر الشهر، وبكرا العصرية بدي أروح عالسوق';
const UAT_BANK = 'بكرا الساعة 5 لازم أروح عالبنك';
const BILL_CLAUSE = 'بدي أدفع فاتورة الكهربا قبل آخر الشهر';

const RECORDED = (JSON.parse(readFileSync(new URL('./fixtures/uat-2026-09-27-gemini.json', import.meta.url), 'utf8')) as {
  responses: Record<string, Record<string, unknown>>;
}).responses;

function payloadOf(prompt: string): string | string[] {
  const lines = prompt.split('\n');
  return JSON.parse(lines[lines.indexOf('BEGIN_UNTRUSTED_USER_MESSAGE') + 1]!) as string | string[];
}

function recordedModel(overrides: Record<string, unknown> = {}) {
  const answer = (clause: string) => {
    const recorded = clause in overrides ? overrides[clause] : RECORDED[clause];
    if (recorded === undefined) throw new LLMUnavailableError('provider_error');
    return recorded;
  };
  return async (prompt: string): Promise<string> => {
    const payload = payloadOf(prompt);
    return Array.isArray(payload)
      ? JSON.stringify({ items: payload.map((clause, clauseIndex) => ({ clauseIndex, ...(answer(clause) as object) })) })
      : JSON.stringify(answer(payload));
  };
}

async function propose(text: string, llmProvider?: (prompt: string) => Promise<string>, now = NOW) {
  const store = new MemoryCaptureProposalStore();
  const persistence = new TransactionalCapturePersistenceAdapter(createEmptyDomainState());
  const contract = await proposeCapture(
    text,
    { now, timezone: TZ, scopeId: 'fx3', requestedEngine: llmProvider ? 'model' : 'rules' },
    { store, persistence, ...(llmProvider ? { llmProvider, llmEngine: 'gemini' as const } : {}) },
  );
  return { contract, store, persistence };
}

async function confirmSettled(
  run: Awaited<ReturnType<typeof propose>>,
  edits: Parameters<typeof confirmCapture>[0]['edits'] = undefined,
  now = NOW,
): Promise<Commitment[]> {
  const itemIds = run.contract.items.filter((item) => !item.needsClarification).map((item) => item.itemId);
  const result = await confirmCapture(
    { proposalId: run.contract.proposalId, scopeId: 'fx3', selectedItemIds: itemIds, idempotencyKey: `k-${run.contract.proposalId}`, now, ...(edits ? { edits } : {}) },
    { store: run.store, persistence: run.persistence },
  );
  assert.equal(result.success, true, JSON.stringify(result));
  const pending = Object.values((await run.persistence.snapshot()).commitments)
    .filter((commitment) => commitment.status === 'pending_confirmation');
  await run.persistence.persistAtomically(pending.map((commitment): Command => ({
    type: 'ConfirmCommitment', commitmentId: commitment.id, now: now.toISOString(),
  })));
  return Object.values((await run.persistence.snapshot()).commitments);
}

const priorities = (items: ReadonlyArray<{ title: string; priority?: string; priorityEstimated?: boolean }>) =>
  items.map((item) => `${item.title} | ${item.priority} | ${item.priorityEstimated ? 'guess' : 'said'}`);

// ── #5: an obligation word in the person's own clause is Must ───────────

test('FX3 #5: the literal six-item capture on the model path: «لازم» clauses are Must as said, the «بدي» ones are not', async () => {
  const { contract } = await propose(UAT_SIX, recordedModel());
  assert.equal(contract.provenance.executedEngine, 'gemini');
  assert.deepEqual(priorities(contract.items), [
    'أسلّم التقرير للمدير | high | said',
    // The appointment rule's own reading, still marked as a guess.
    'موعد دكتور | high | guess',
    'أتصل بأمي | normal | guess',
    'أحضّر الغداء | high | said',
    'أدفع فاتورة الكهربا | normal | guess',
    'أروح عالسوق | normal | guess',
  ]);
});

test('FX3 #5: «بكرا الساعة 5 لازم أروح عالبنك» on the model path is Must, as said', async () => {
  const { contract } = await propose(UAT_BANK, recordedModel());
  assert.equal(contract.provenance.executedEngine, 'gemini');
  assert.deepEqual(priorities(contract.items), ['أروح عالبنك | high | said']);
});

test('FX3 #5: the same captures on the rules path give the same levels, clause by clause', async () => {
  const six = await propose(UAT_SIX);
  assert.equal(six.contract.provenance.executedEngine, 'rule-based');
  assert.deepEqual(six.contract.items.map((item) => item.priority), ['high', 'high', 'normal', 'high', 'normal', 'normal']);
  assert.deepEqual(six.contract.items.map((item) => item.priorityEstimated), [false, true, true, false, true, true]);
  const bank = await propose(UAT_BANK);
  assert.deepEqual(bank.contract.items.map((item) => [item.priority, item.priorityEstimated]), [['high', false]]);
});

test('FX3 #5: the model path raises its default for every obligation word, and nothing else', async () => {
  const answer = (title: string) => ({
    type: 'task', action: title, title, person: null, dueAt: null, remindAt: null, localTimeSpec: null,
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureImplied: false },
    flexibility: 'movable', category: null, categoryConfidence: 0,
    confidence: { overall: 0.8, type: 1, action: 0.8, time: 0.1, priority: 1 },
    missingFields: ['time'], ambiguityFlags: ['vague_time'], explicitReminderRequest: false, explicitPressureRequest: false,
  });
  const cases: Array<[string, 'high' | 'normal', boolean]> = [
    ['لازمني أجدد الباسبور', 'high', false],
    ['ضروري أخلص التقرير', 'high', false],
    ['I have to renew the passport', 'high', false],
    ['I must renew the passport', 'high', false],
    ['אני חייב לחדש את הדרכון', 'high', false],
    ['بدي أجدد الباسبور', 'normal', true],
    ['I want to renew the passport', 'normal', true],
    ['I need to renew the passport', 'normal', true],
    ['צריך לחדש את הדרכון', 'normal', true],
    ['مش لازم أجدد الباسبور', 'normal', true],
    ["I don't have to renew the passport", 'normal', true],
    ['לא חייב לחדש את הדרכון', 'normal', true],
  ];
  const drift: string[] = [];
  for (const [text, level, estimated] of cases) {
    const { contract } = await propose(text, recordedModel({ [text]: answer('Renew passport') }));
    const item = contract.items[0];
    if (contract.provenance.executedEngine !== 'gemini' || item?.priority !== level || item.priorityEstimated !== estimated) {
      drift.push(`${text}: ${contract.provenance.executedEngine} ${item?.priority} ${item?.priorityEstimated}`);
    }
  }
  assert.deepEqual(drift, []);
});

test('FX3 #5: which words are an obligation, per language', () => {
  const must = [
    'لازم أروح عالبنك', 'ولازم أحضّر الغداء', 'بكرا لازم أسلّم التقرير', 'لازمني أروح عالبنك', 'لازمنا نخلص',
    'ضروري أخلص التقرير', 'وضروري أتصل', 'مضطر أروح عالبنك', 'مضطرة أروح',
    'I must call Sam', 'I have to call Sam', 'she has to sign it', "I've got to call Sam", 'I have got to call Sam',
    'אני חייב להתקשר', 'חייבת לשלם', 'ואני חייבים לסיים', 'חובה לשלם היום',
  ];
  const notNeeded = [
    'مش لازم أروح', 'مو لازم أروح', 'ما لازم أروح', 'مش ضروري أخلص', 'مش مضطر أروح',
    "I don't have to call Sam", 'she does not have to sign', 'you needn\'t call',
    'לא חייב להתקשר', 'לא חייבת לשלם',
  ];
  const none = [
    'بدي أروح عالبنك', 'اللازم للبيت', 'الأوراق اللازمة', 'ملازم أول', 'تلازم', 'عندي مهمة',
    'I want to call Sam', 'I need to call Sam', 'I would like to call Sam', 'what I have to-do',
    'צריך להתקשר', 'רוצה להתקשר',
  ];
  const wrong = [
    ...must.filter((text) => statedObligation(text) !== 'must').map((text) => `must: ${text} → ${statedObligation(text)}`),
    ...notNeeded.filter((text) => statedObligation(text) !== 'not_needed').map((text) => `not_needed: ${text} → ${statedObligation(text)}`),
    ...none.filter((text) => statedObligation(text) !== null).map((text) => `none: ${text} → ${statedObligation(text)}`),
  ];
  assert.deepEqual(wrong, []);
});

test('FX3 #5: on the rules path «مش لازم» is no longer read as Must', async () => {
  const { contract } = await propose('مش لازم أروح عالبنك بكرا الساعة 10 الصبح');
  assert.deepEqual(contract.items.map((item) => item.priority), ['low']);
});

// ── #7: «قبل آخر الشهر» is a deadline on the month's last day ───────────

test('FX3 #7: the lexicon reads the end of the month, in three languages, and not the next or the last one', () => {
  const yes = [
    'بدي أدفع فاتورة الكهربا قبل آخر الشهر', 'أدفع الفاتورة آخر الشهر', 'أدفع الفاتورة اخر الشهر', 'بآخر الشهر',
    'لحد آخر الشهر', 'قبل نهاية الشهر', 'آخر هالشهر',
    'pay the bill by the end of the month', 'pay the bill by end of month', 'before the end of this month', 'at month end',
    'לשלם את החשבון עד סוף החודש', 'בסוף החודש', 'לפני סוף החודש',
  ];
  const no = [
    'قبل آخر الشهر الجاي', 'آخر الشهر الماضي', 'آخر الأسبوع', 'أول الشهر', 'آخر شي',
    'by the end of next month', 'end of last month', 'the end of the month after next',
    'עד סוף החודש הבא', 'סוף השבוע',
  ];
  const wrong = [
    ...yes.filter((text) => readPeriodEndDeadline(text) !== 'month').map((text) => `yes: ${text}`),
    ...no.filter((text) => readPeriodEndDeadline(text) !== null).map((text) => `no: ${text}`),
  ];
  assert.deepEqual(wrong, []);
  assert.equal(lastDayOfMonth(NOW, TZ), '2026-09-30');
  assert.equal(lastDayOfMonth(new Date('2027-02-10T12:00:00Z'), TZ), '2027-02-28');
  assert.equal(lastDayOfMonth(new Date('2028-02-10T12:00:00Z'), TZ), '2028-02-29');
  // 22:30 UTC on 31 Dec is already 1 Jan in Jerusalem (UTC+2): the month is
  // the person's, not the server's.
  assert.equal(lastDayOfMonth(new Date('2026-12-31T22:30:00Z'), TZ), '2027-01-31');
  assert.equal(lastDayOfMonth(new Date('2026-12-31T22:30:00Z'), 'UTC'), '2026-12-31');
});

const billShape = (item: { title: string; resolvedTime: string | null; resolvedDate?: string; dateEstimated?: boolean; needsClarification: boolean }) =>
  `${item.title} | ${item.resolvedDate ?? '-'} | ${item.resolvedTime ?? '-'} | ${item.dateEstimated ? 'guess' : 'said'} | ${item.needsClarification ? 'ask' : 'settled'}`;

test('FX3 #7: rules path — «قبل آخر الشهر» is a settled all-day deadline on 30 Sep, in ar/en/he', async () => {
  const cases: Array<[string, string]> = [
    [BILL_CLAUSE, 'أدفع فاتورة الكهربا'],
    ['أدفع فاتورة الكهربا آخر الشهر', 'أدفع فاتورة الكهربا'],
    ['pay the electricity bill by the end of the month', 'pay the electricity bill'],
    ['לשלם את חשבון החשמל עד סוף החודש', 'לשלם את חשבון החשמל'],
  ];
  for (const [text, title] of cases) {
    const run = await propose(text);
    assert.deepEqual(run.contract.items.map(billShape), [`${title} | 2026-09-30 | - | said | settled`], text);
    const [commitment] = await confirmSettled(run);
    assert.deepEqual(
      { kind: commitment!.timeSpec.kind, dueAt: commitment!.timeSpec.dueAt, remindAt: commitment!.timeSpec.remindAt, allDay: commitment!.timeSpec.allDay, status: commitment!.status },
      { kind: 'due_by', dueAt: SEP_30_MIDNIGHT, remindAt: null, allDay: true, status: 'active' },
      text,
    );
  }
});

test('FX3 #7: the reading itself is a complete, unflagged all-day deadline on both engines', () => {
  const context = { now: NOW, timezone: TZ };
  const readings = {
    rules: extract(BILL_CLAUSE, context),
    model: validateExtractionResult(RECORDED[BILL_CLAUSE], BILL_CLAUSE, context),
  };
  for (const [engine, reading] of Object.entries(readings)) {
    assert.deepEqual(
      {
        allDay: reading.allDay, dueAt: reading.dueAt, remindAt: reading.remindAt, date: reading.localTimeSpec?.date, time: reading.localTimeSpec?.time,
        anchor: reading.timeAnchor, vague: reading.ambiguityFlags.includes('vague_time'), missingTime: reading.missingFields.includes('time'),
      },
      { allDay: true, dueAt: SEP_30_MIDNIGHT, remindAt: null, date: '2026-09-30', time: null, anchor: 'deadline', vague: false, missingTime: false },
      engine,
    );
  }
});

test('FX3 #7: model path — the recorded answer (30 Sep with an invented 23:59) is the same all-day deadline', async () => {
  const run = await propose(UAT_SIX, recordedModel());
  const bill = run.contract.items.find((item) => item.title === 'أدفع فاتورة الكهربا')!;
  assert.equal(billShape(bill), 'أدفع فاتورة الكهربا | 2026-09-30 | - | said | settled');
  const commitments = await confirmSettled(run);
  const saved = commitments.find((commitment) => commitment.title === 'أدفع فاتورة الكهربا')!;
  assert.deepEqual([saved.timeSpec.kind, saved.timeSpec.dueAt, saved.timeSpec.allDay], ['due_by', SEP_30_MIDNIGHT, true]);
});

test('FX3 #7: model path — a model that names no day for it (the UAT answer) still gets the month\'s last day', async () => {
  const noDay = { ...RECORDED[BILL_CLAUSE], dueAt: null, remindAt: null, localTimeSpec: null, ambiguityFlags: ['vague_time'] };
  const run = await propose(UAT_SIX, recordedModel({ [BILL_CLAUSE]: noDay }));
  const bill = run.contract.items.find((item) => item.title === 'أدفع فاتورة الكهربا')!;
  assert.equal(billShape(bill), 'أدفع فاتورة الكهربا | 2026-09-30 | - | said | settled');
});

test('FX3 #7: said on the month\'s last day, the deadline is that same day and is not refused as past', async () => {
  const lastDay = new Date('2026-09-30T07:00:00.000Z');
  for (const provider of [undefined, recordedModel()]) {
    const run = await propose(BILL_CLAUSE, provider, lastDay);
    assert.equal(run.contract.status, 'proposed');
    assert.deepEqual(run.contract.items.map(billShape), ['أدفع فاتورة الكهربا | 2026-09-30 | - | said | settled']);
    const [commitment] = await confirmSettled(run, undefined, lastDay);
    assert.equal(commitment!.timeSpec.allDay, true);
  }
});

test('FX3 #7: through the mobile route\'s guarded extractor too, on the month\'s last day', async () => {
  setStorageForTests(createMemoryStorage());
  try {
    const proposal = await proposeMobileCapture({ text: BILL_CLAUSE, timezone: TZ, referenceTime: '2026-09-30T07:00:00.000Z' });
    assert.equal(proposal.status, 'proposed');
    assert.deepEqual(proposal.items.map(billShape), ['أدفع فاتورة الكهربا | 2026-09-30 | - | said | settled']);
    // A day later it is a new month, with its own last day.
    const october = await proposeMobileCapture({ text: BILL_CLAUSE, timezone: TZ, referenceTime: '2026-10-01T07:00:00.000Z' });
    assert.deepEqual(october.items.map(billShape), ['أدفع فاتورة الكهربا | 2026-10-31 | - | said | settled']);
  } finally {
    resetStorageForTests();
  }
});

test('FX3 #7: a clock time with it keeps the hour on that day, as a deadline', async () => {
  const run = await propose('بدي أدفع الفاتورة قبل آخر الشهر الساعة 5 المسا');
  assert.deepEqual(run.contract.items.map((item) => [item.resolvedTime, item.needsClarification]), [['2026-09-30T14:00:00.000Z', false]]);
  const [commitment] = await confirmSettled(run);
  assert.deepEqual([commitment!.timeSpec.kind, commitment!.timeSpec.allDay], ['due_by', false]);
});

test('FX3 #7: giving the all-day deadline an hour at confirm makes it a timed one, and clearing it makes it untimed', async () => {
  const timed = await propose(BILL_CLAUSE);
  const [withHour] = await confirmSettled(timed, [{ itemId: timed.contract.items[0]!.itemId, resolvedTime: '2026-09-29T06:00:00.000Z' }]);
  assert.deepEqual([withHour!.timeSpec.dueAt, withHour!.timeSpec.allDay], ['2026-09-29T06:00:00.000Z', false]);
  const cleared = await propose(BILL_CLAUSE);
  const result = await confirmCapture(
    { proposalId: cleared.contract.proposalId, scopeId: 'fx3', selectedItemIds: [cleared.contract.items[0]!.itemId], idempotencyKey: 'k-clear', now: NOW, edits: [{ itemId: cleared.contract.items[0]!.itemId, resolvedTime: null }] },
    { store: cleared.store, persistence: cleared.persistence },
  );
  assert.equal(result.success, true, JSON.stringify(result));
  const [untimed] = Object.values((await cleared.persistence.snapshot()).commitments);
  assert.deepEqual([untimed!.timeSpec.kind, untimed!.timeSpec.dueAt, untimed!.timeSpec.allDay], ['unscheduled', null, false]);
});

test('FX3 #7: the deadline stays with its own clause in the six-item capture; the other items are unchanged', async () => {
  const { contract } = await propose(UAT_SIX);
  assert.deepEqual(contract.items.map(billShape), [
    'أسلّم التقرير للمدير | 2026-09-27 | - | said | ask',
    // The rules' own title and reading, as before this lane.
    'وسجّل موعد دكتور | 2026-09-27 | - | guess | ask',
    'أتصل بأمي | 2026-09-26 | - | said | ask',
    'أحضّر الغداء | 2026-09-26 | 2026-09-26T11:00:00.000Z | said | settled',
    'أدفع فاتورة الكهربا | 2026-09-30 | - | said | settled',
    'أروح عالسوق | 2026-09-27 | 2026-09-27T11:00:00.000Z | said | settled',
  ]);
});
