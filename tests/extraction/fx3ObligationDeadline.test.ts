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
import { lastDayOfMonth, localTimeSpecFor, readPeriodEndDeadline } from '../../src/extraction/timeLexicon.ts';
import { extract } from '../../src/extraction/ruleBasedExtractor.ts';
import { validateExtractionResult } from '../../src/extraction/schemaValidator.ts';
import {
  answerClarification,
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

// ── Review round 1 (FX3-review.md): I-1, I-2, I-3 and the untested guards ──

/** One probe line, in the reviewer's harness format: title | date time | question | priority. */
async function probeLine(text: string, referenceTime = NOW.toISOString()) {
  setStorageForTests(createMemoryStorage());
  try {
    const p = await proposeMobileCapture({ text, timezone: TZ, referenceTime });
    return {
      status: p.status,
      items: p.items.map((it) => {
        const t = it.resolvedTime ? localTimeSpecFor(new Date(it.resolvedTime), TZ)?.time : null;
        return `${it.title} | ${it.resolvedDate ?? '-'} ${t ?? '-'} | ${it.clarification?.questionKey ?? ''} | ${it.priority}${it.priorityEstimated ? '~' : ''}`;
      }),
    };
  } finally {
    resetStorageForTests();
  }
}

test('FX3 I-1: the month-end phrase that nothing read stays in the title, and a noun it modifies is not a deadline (review rows, as at cb9982b7)', async () => {
  const rows: Array<[string, string, string]> = [
    ['بدي أحضّر تقرير آخر الشهر بكرا الساعة 10', 'proposed', 'أحضّر تقرير آخر الشهر | 2026-09-27 10:00 |  | normal~'],
    ['بدي أحضّر تقرير آخر الشهر', 'needs_clarification', 'أحضّر تقرير آخر الشهر | - - | ask_time | normal~'],
    ['بدي أحسب رواتب آخر الشهر بكرا الساعة 10', 'proposed', 'أحسب رواتب آخر الشهر | 2026-09-27 10:00 |  | normal~'],
    ['عندي جرد نهاية الشهر بكرا الساعة 9', 'proposed', 'عندي جرد نهاية الشهر | 2026-09-27 09:00 |  | normal~'],
    ['بكرا بدي أحكي مع صاحب البيت عن إيجار آخر الشهر', 'needs_clarification', 'أحكي مع صاحب البيت عن إيجار آخر الشهر | 2026-09-27 - | ask_time | normal~'],
    ['Prepare the end of the month report tomorrow at 10am', 'proposed', 'Prepare the end of the month report | 2026-09-27 10:00 |  | normal~'],
    ['Prepare the end of the month report', 'needs_clarification', 'Prepare the end of the month report | - - | ask_time | normal~'],
    ['Finish the month-end close tomorrow at 9am', 'proposed', 'Finish the month-end close | 2026-09-27 09:00 |  | normal~'],
    ['Tomorrow at 5pm call the landlord about the rent due by the end of the month', 'proposed', 'call the landlord about the rent due by the end of the month | 2026-09-27 17:00 |  | normal~'],
    ['להכין את דוח סוף החודש מחר ב-10', 'proposed', 'להכין את דוח סוף החודש | 2026-09-27 10:00 |  | normal~'],
    ['לשלם חשבון חשמל עד סוף החודש ולהתקשר לאמא מחר ב-5', 'needs_clarification', 'לשלם חשבון חשמל עד סוף החודש ולהתקשר לאמא | 2026-09-27 - | ask_am_pm | normal~'],
    ['بدي أتصل بأمي بكرا الساعة 5 وأدفع الفاتورة قبل آخر الشهر', 'needs_clarification', 'أتصل بأمي وأدفع الفاتورة قبل آخر الشهر | 2026-09-27 - | ask_am_pm | normal~'],
    ['Call mom tomorrow at 5pm and pay the bill by the end of the month', 'proposed', 'Call mom and pay the bill by the end of the month | 2026-09-27 17:00 |  | normal~'],
    ['להתקשר לאמא מחר ב-5 ולשלם חשבון חשמל עד סוף החודש', 'needs_clarification', 'להתקשר לאמא ולשלם חשבון חשמל עד סוף החודש | 2026-09-27 - | ask_am_pm | normal~'],
  ];
  const drift: string[] = [];
  for (const [text, status, line] of rows) {
    const actual = await probeLine(text);
    if (actual.status !== status || actual.items.length !== 1 || actual.items[0] !== line) drift.push(`${text}\n   want ${status}: ${line}\n   got  ${actual.status}: ${actual.items.join(' ;; ')}`);
  }
  assert.deepEqual(drift, []);
});

test('FX3 I-1: which month-end mentions are a deadline — the rule, both directions', () => {
  // A deadline: a limit word or a preposition before it («قبل», «لحد», «ب», "by", "at", «עד», «ב»),
  // or the phrase after a definite word / at the start of the clause.
  const deadline = [
    'بدي أدفع فاتورة الكهربا قبل آخر الشهر', 'لازم أخلص المشروع لحد آخر الشهر', 'بآخر الشهر بدي أدفع الإيجار',
    'بدي أدفع فاتورة الكهربا آخر الشهر', 'بدي أدفع الإيجار نهاية الشهر', 'أدفع الإيجار آخر هالشهر', 'آخر الشهر بدي أدفع الإيجار',
    'قبل ما يخلص الشهر لازم أجدد الإقامة', 'في آخر الشهر بدي أرتب الأوراق',
    'Pay the rent by the end of the month', 'pay rent before the end of this month', 'Pay the rent at month end', 'renew it by end of month',
    'לשלם שכר דירה עד סוף החודש', 'בסוף החודש לשלם שכר דירה', 'לשלם לפני סוף החודש', 'סוף החודש לשלם ארנונה',
  ];
  // Not one: the phrase modifying a noun — «تقرير آخر الشهر» (idafa, an indefinite noun
  // before it), "end of the month report" / "month-end close" (no preposition before it,
  // or a noun after it), «דוח סוף החודש» (smichut) — and other months.
  const notDeadline = [
    'بدي أحضّر تقرير آخر الشهر', 'أحسب رواتب آخر الشهر', 'عندي جرد نهاية الشهر', 'أحكي عن إيجار آخر الشهر', 'بدي أدفع فاتورة آخر الشهر',
    'Prepare the end of the month report', 'Finish the month-end close', 'the month end report', 'by the end of the month report',
    'להכין את דוח סוף החודש', 'ישיבת סוף החודש',
    'قبل آخر الشهر الجاي', 'by the end of next month', 'עד סוף החודש הבא',
  ];
  const wrong = [
    ...deadline.filter((text) => readPeriodEndDeadline(text) !== 'month').map((text) => `deadline: ${text}`),
    ...notDeadline.filter((text) => readPeriodEndDeadline(text) !== null).map((text) => `not: ${text}`),
  ];
  assert.deepEqual(wrong, []);
});

test('FX3 I-2 (narrowed by FY1 N6): model path — a model date after the month\'s last day is discarded and the deadline settles on it; an earlier one keeps the pre-FX3 reading (the date kept, the hour asked), and a past one is not a rejection', async () => {
  const answer = (date: string | null) => ({
    ...RECORDED[BILL_CLAUSE], dueAt: date ? new Date(`${date}T00:00:00+03:00`).toISOString() : null, remindAt: null,
    localTimeSpec: date ? { date, time: null, timezone: TZ } : null, ambiguityFlags: [], missingFields: [],
  });
  // The controller ruling on N6 (FY1, narrowed in its review): a model day
  // *after* this month's last day on the person's clock is discarded, and
  // FX3's no-day reading settles the deadline. Until FY1 it was kept and asked.
  const rows: Array<[string, string, string, string]> = [
    ['2026-10-31', NOW.toISOString(), 'proposed', `${BILL_CLAUSE.replace(/^بدي /, '')} | 2026-09-30 - | `],
    ['2026-09-29', NOW.toISOString(), 'needs_clarification', `${BILL_CLAUSE.replace(/^بدي /, '')} | 2026-09-29 - | ask_time`],
    ['2026-09-25', NOW.toISOString(), 'needs_clarification', `${BILL_CLAUSE.replace(/^بدي /, '')} | 2026-09-25 - | ask_time`],
    // The 1st at 00:30 in Jerusalem: the prompt's reference instant is still the 30th in UTC.
    ['2026-09-30', '2026-09-30T21:30:00.000Z', 'needs_clarification', `${BILL_CLAUSE.replace(/^بدي /, '')} | 2026-09-30 - | ask_time`],
  ];
  const drift: string[] = [];
  for (const [date, now, status, want] of rows) {
    const recorded = { ...answer(date), title: BILL_CLAUSE.replace(/^بدي /, ''), action: BILL_CLAUSE.replace(/^بدي /, '') };
    const { contract } = await propose(BILL_CLAUSE, recordedModel({ [BILL_CLAUSE]: recorded }), new Date(now));
    const got = contract.items.map((it) => `${it.title} | ${it.resolvedDate ?? '-'} ${it.resolvedTime ? 'T' : '-'} | ${it.clarification?.questionKey ?? ''}`);
    if (contract.status !== status || got.join() !== want) drift.push(`${date} @${now}: ${contract.status} ${got.join(' ;; ')}`);
  }
  assert.deepEqual(drift, []);
  // The model's own last day, and no day at all, still read as the all-day deadline — the 1st included.
  const onFirst = await propose(BILL_CLAUSE, recordedModel({ [BILL_CLAUSE]: { ...answer(null), title: 'أدفع فاتورة الكهربا', action: 'أدفع فاتورة الكهربا' } }), new Date('2026-09-30T21:30:00.000Z'));
  assert.deepEqual(onFirst.contract.items.map(billShape), ['أدفع فاتورة الكهربا | 2026-10-31 | - | said | settled']);
  const octLast = await propose(BILL_CLAUSE, recordedModel({ [BILL_CLAUSE]: { ...answer('2026-10-31'), title: 'أدفع فاتورة الكهربا', action: 'أدفع فاتورة الكهربا' } }), new Date('2026-09-30T21:30:00.000Z'));
  assert.deepEqual(octLast.contract.items.map(billShape), ['أدفع فاتورة الكهربا | 2026-10-31 | - | said | settled']);
});

test('FX3 I-3: «ما لازم أنسى» / «لازم ما أنسى» / "mustn\'t forget" / «אסור לי לשכוח» are obligations', async () => {
  for (const text of ['ما لازم أنسى أدفع الفاتورة', 'مش لازم تنسى تتصل فيه', 'لازم ما أنسى أدفع الفاتورة', 'ما لازمني أنسى الموعد', "I mustn't forget to pay the bill", 'I must not forget to pay', 'אסור לי לשכוח לשלם', 'אסור לשכוח את החשבון']) {
    assert.equal(statedObligation(text), 'must', text);
  }
  // …while a negated «لازم» before anything else is still "not needed".
  for (const text of ['ما لازم أروح', 'مش لازم أنام بكير', 'مش لازم أنسخ الملف', "I don't have to go", "you mustn't"]) {
    assert.notEqual(statedObligation(text), 'must', text);
  }
  assert.deepEqual((await probeLine('ما لازم أنسى أدفع الفاتورة بكرا الساعة 10')).items, ['ما لازم أنسى أدفع الفاتورة | 2026-09-27 10:00 |  | high']);
});

test('FX3 guards: a model «low» is never raised by an obligation word, and a stated hour with the month\'s end is kept', async () => {
  const low = { ...RECORDED['بكرا الساعة 5 لازم أروح عالبنك'], priority: { level: 'low', source: 'inferred', pressureAllowed: false, pressureImplied: false } };
  const kept = await propose(UAT_BANK, recordedModel({ [UAT_BANK]: low }));
  assert.deepEqual(priorities(kept.contract.items), ['أروح عالبنك | low | guess']);

  const withHour = 'بدي أدفع الإيجار آخر الشهر الساعة 10';
  const timed = {
    ...RECORDED[BILL_CLAUSE], title: 'أدفع الإيجار', action: 'أدفع الإيجار',
    dueAt: '2026-09-30T07:00:00.000Z', remindAt: null, localTimeSpec: { date: '2026-09-30', time: '10:00', timezone: TZ },
  };
  const run = await propose(withHour, recordedModel({ [withHour]: timed }));
  assert.deepEqual(run.contract.items.map((it) => [it.resolvedTime, it.needsClarification]), [['2026-09-30T07:00:00.000Z', false]]);
  const [commitment] = await confirmSettled(run);
  assert.deepEqual([commitment!.timeSpec.dueAt, commitment!.timeSpec.allDay], ['2026-09-30T07:00:00.000Z', false]);
});

test('FX3 clarify: an all-day item that is asked (a follow-up with no person) loses `allDay` when an hour is picked, and keeps its day when "no time" is', async () => {
  const followUp = 'follow up on the invoice by the end of the month';
  const answer = {
    type: 'follow_up', action: 'Follow up on the invoice', title: 'Follow up on the invoice', person: null,
    dueAt: null, remindAt: null, localTimeSpec: null,
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureImplied: false },
    flexibility: 'movable', category: null, categoryConfidence: 0,
    confidence: { overall: 0.8, type: 1, action: 0.9, time: 0.5, priority: 1 },
    missingFields: ['person'], ambiguityFlags: [], explicitReminderRequest: false, explicitPressureRequest: false,
  };
  // «بدون وقت محدد» to a question about the 30th is "the 30th, no hour", not
  // "no day" (UAT round 2, N3): the review kept saying the day, and the saved
  // commitment used to have none.
  for (const [optionId, want] of [['morning', ['due_by', false]], ['none', ['due_by', true]]] as const) {
    const run = await propose(followUp, recordedModel({ [followUp]: answer }));
    const item = run.contract.items[0]!;
    assert.equal(item.clarification?.questionKey, 'ask_time', JSON.stringify(item));
    assert.equal(item.clarification?.params.date, '2026-09-30');
    await answerClarification(
      { proposalId: run.contract.proposalId, itemId: item.itemId, questionId: item.clarification!.questionId, optionId },
      { now: NOW, timezone: TZ, scopeId: 'fx3' },
      { store: run.store, recordEvent: () => undefined },
    );
    const [commitment] = await confirmSettledAfterClarify(run);
    assert.deepEqual([commitment!.timeSpec.kind, commitment!.timeSpec.allDay], want, optionId);
  }
});

async function confirmSettledAfterClarify(run: Awaited<ReturnType<typeof propose>>): Promise<Commitment[]> {
  const stored = await run.store.get(run.contract.proposalId);
  const itemIds = stored!.contract.items.filter((item) => !item.needsClarification).map((item) => item.itemId);
  const result = await confirmCapture(
    { proposalId: run.contract.proposalId, scopeId: 'fx3', selectedItemIds: itemIds, idempotencyKey: `kc-${run.contract.proposalId}`, now: NOW },
    { store: run.store, persistence: run.persistence },
  );
  assert.equal(result.success, true, JSON.stringify(result));
  return Object.values((await run.persistence.snapshot()).commitments);
}
