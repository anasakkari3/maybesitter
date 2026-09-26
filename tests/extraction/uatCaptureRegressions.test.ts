/**
 * The first phone run's capture complaints, replayed (closure lane CL1).
 *
 * Every model answer here is one Gemini actually gave for these exact clauses
 * on 2026-09-26 (`fixtures/uat-2026-09-26-gemini.json`, recorded with
 * `scripts/live-capture-check.ts --raw`). The fake provider below answers a
 * clause with its recording and refuses anything it has no recording for, so
 * these tests are stable and still exercise the real boundary, splitter,
 * validator, lexicons, mapping and planner input.
 *
 *   D1  «…يوم الأحد. وبدي أدفع فاتورة الكهربا…» — six commitments, five items:
 *       the splitter did not treat «.» as a clause boundary, so the doctor and
 *       the electricity bill reached the model as one clause, and a model asked
 *       for one object returned the first.
 *   A3  the doctor came back «يُفضّل»: the lexicon read the merged clause, and
 *       «أدفع» (pay) from the bill half made it an errand.
 *   D2  «الساعة 5» was written as a `due_by`, which the planner treats as a
 *       deadline and floats ahead of — «أشتري دوا … الساعة 5» landed 15:30.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LLMUnavailableError } from '../../src/extraction/llm/llmProvider.ts';
import { extract } from '../../src/extraction/ruleBasedExtractor.ts';
import { validateExtractionResult } from '../../src/extraction/schemaValidator.ts';
import { mapExtractionToCommand } from '../../src/extraction/mapExtractionToCommand.ts';
import {
  confirmCapture,
  MemoryCaptureProposalStore,
  proposeCapture,
  TransactionalCapturePersistenceAdapter,
} from '../../lib/services/captureBoundary/index.ts';
import { buildDailyPlanInput } from '../../lib/services/dailyPlan/buildDailyPlan.ts';
import { applyEditToCommands } from '../../lib/services/captureBoundary/applyEdits.ts';
import { patchTimeSpecForTest } from '../../lib/services/mobile/commitmentService.ts';
import { createEmptyDomainState, type Command, type Commitment } from '../../src/domain/stateMachine.ts';
import type { ExtractionContext } from '../../src/extraction/extractionTypes.ts';

const TZ = 'Asia/Jerusalem';
/** Saturday 26 Sep 2026, 10:00 in Jerusalem — the UAT morning. */
const NOW = new Date('2026-09-26T07:00:00.000Z');
const context: ExtractionContext = { now: NOW, timezone: TZ };

const UAT_SIX = 'سجّل موعد دكتور يوم الأحد. وبدي أدفع فاتورة الكهربا قبل آخر الشهر، ولازم أرد على إيميل سامي بخصوص المشروع، وذكرني أتصل بأمي بكرا المسا، وكمان عندي تمرين بالجيم يوم الثلاثاء الساعة 7 المسا، وبدي أخلص تقرير الشغل قبل الخميس.';
const UAT_MEDICINE = 'لازم أشتري دوا من الصيدلية اليوم الساعة 5 المسا';

const RECORDED = (JSON.parse(readFileSync(new URL('./fixtures/uat-2026-09-26-gemini.json', import.meta.url), 'utf8')) as {
  responses: Record<string, unknown>;
}).responses;

/** The clause the extractor put between the untrusted-message markers. */
function clauseOf(prompt: string): string {
  const lines = prompt.split('\n');
  const at = lines.indexOf('BEGIN_UNTRUSTED_USER_MESSAGE');
  return JSON.parse(lines[at + 1]!) as string;
}

/** Answers with the recording for a clause, and records which clauses it was asked. */
function recordedModel() {
  const asked: string[] = [];
  const provider = async (prompt: string): Promise<string> => {
    const clause = clauseOf(prompt);
    asked.push(clause);
    const answer = RECORDED[clause];
    if (answer === undefined) throw new LLMUnavailableError('provider_error');
    return JSON.stringify(answer);
  };
  return { provider, asked };
}

async function propose(text: string, llmProvider?: (prompt: string) => Promise<string>) {
  const store = new MemoryCaptureProposalStore();
  const persistence = new TransactionalCapturePersistenceAdapter(createEmptyDomainState());
  const contract = await proposeCapture(
    text,
    { now: NOW, timezone: TZ, scopeId: 'cl1-uat', requestedEngine: llmProvider ? 'model' : 'rules' },
    { store, persistence, ...(llmProvider ? { llmProvider, llmEngine: 'gemini' as const } : {}) },
  );
  return { contract, store, persistence };
}

async function confirmAll(run: Awaited<ReturnType<typeof propose>>): Promise<Commitment[]> {
  const itemIds = run.contract.items.filter((item) => !item.needsClarification).map((item) => item.itemId);
  const result = await confirmCapture(
    { proposalId: run.contract.proposalId, scopeId: 'cl1-uat', selectedItemIds: itemIds, idempotencyKey: `k-${run.contract.proposalId}` },
    { store: run.store, persistence: run.persistence },
  );
  assert.equal(result.success, true);
  // Activated the way `activateConfirmedItems` does after a mobile confirm, so
  // the planner sees what a confirmed capture really is.
  const pending = Object.values((await run.persistence.snapshot()).commitments)
    .filter((commitment) => commitment.status === 'pending_confirmation');
  await run.persistence.persistAtomically(pending.map((commitment): Command => ({
    type: 'ConfirmCommitment', commitmentId: commitment.id, now: NOW.toISOString(),
  })));
  return Object.values((await run.persistence.snapshot()).commitments);
}

// ── D1: no stated commitment is dropped ─────────────────────────────────

test('D1: the six-commitment UAT capture proposes six items, the electricity bill included', async () => {
  const model = recordedModel();
  const { contract } = await propose(UAT_SIX, model.provider);
  assert.deepEqual(contract.items.map((item) => item.title), [
    'موعد دكتور',
    'أدفع فاتورة الكهربا',
    'أرد على إيميل سامي',
    'أتصل بأمي',
    'تمرين بالجيم',
    'أخلص تقرير الشغل',
  ]);
  // Every clause was read by the model, and the proposal says so: a sixth
  // clause handed to the rules would relabel the whole capture.
  assert.equal(model.asked.length, 6);
  assert.equal(contract.provenance.executedEngine, 'gemini');
  assert.equal(contract.provenance.fallbackUsed, false);
});

test('D1: a sentence end is a clause boundary on the rules path too', async () => {
  const { contract } = await propose('سجّل موعد دكتور يوم الأحد. وبدي أدفع فاتورة الكهربا قبل آخر الشهر');
  assert.equal(contract.items.length, 2);
  assert.match(contract.items[1]!.title, /فاتورة الكهربا/);
  // The same, with no «و» opening the second sentence: only the full stop
  // (or the question mark) separates them.
  for (const text of [
    'سجّل موعد دكتور يوم الأحد. أدفع فاتورة الكهربا قبل آخر الشهر',
    'Book the dentist on Sunday. Pay the electricity bill tomorrow at 5pm',
    'תזמין תור לרופא ביום ראשון. לשלם את חשבון החשמל מחר',
    'can you remind me to call mom tomorrow at 6pm? pay the electricity bill on Sunday',
  ]) {
    const { contract: split } = await propose(text);
    assert.equal(split.items.length, 2, text);
  }
});

test('D1: without punctuation, «و» before بدي/لازم/ذكرني still starts a new commitment', async () => {
  const { contract } = await propose('سجّل موعد دكتور يوم الأحد وبدي أدفع فاتورة الكهربا ولازم أرد على إيميل سامي');
  assert.equal(contract.items.length, 3);
  const { contract: english } = await propose('book the dentist on Sunday and I need to pay the electricity bill');
  assert.equal(english.items.length, 2);
  const { contract: hebrew } = await propose('לקבוע תור לרופא ביום ראשון וצריך לשלם את חשבון החשמל');
  assert.equal(hebrew.items.length, 2);
});

test('D1: an ordinary «و», an abbreviation and a decimal do not split a commitment', async () => {
  for (const text of [
    'بدي أشتري خبز وحليب بكرا',
    'call Dr. Haddad tomorrow at 10am',
    'pay 12.50 for parking tomorrow at 9am',
  ]) {
    const { contract } = await propose(text);
    assert.equal(contract.items.length, 1, text);
  }
});

test('D1: a clause the model reads as nothing, beside others, is recovered by the rules rather than dropped', async () => {
  // Gemini's own answer for the bill clause, with the one thing a model can
  // get wrong here changed: it filed the request as context.
  const dismissive = async (prompt: string): Promise<string> => {
    const clause = clauseOf(prompt);
    if (clause === 'بدي أدفع فاتورة الكهربا قبل آخر الشهر') {
      return JSON.stringify({ ...(RECORDED[clause] as object), type: 'informational_context' });
    }
    return JSON.stringify(RECORDED[clause]);
  };
  const { contract } = await propose(UAT_SIX, dismissive);
  assert.equal(contract.items.length, 6);
  assert.match(contract.items[1]!.title, /فاتورة الكهربا/);
});

// ── A3: the doctor is a Must on the model path ──────────────────────────

test('A3: «سجّل موعد دكتور يوم الأحد», first clause of the long capture, is high on the Gemini path', async () => {
  const { contract } = await propose(UAT_SIX, recordedModel().provider);
  const doctor = contract.items[0]!;
  assert.equal(doctor.title, 'موعد دكتور');
  assert.equal(doctor.priority, 'high');
  assert.equal(doctor.priorityEstimated, true);
  assert.equal(doctor.resolvedDate, '2026-09-27');
});

test('A3: the model leaving localTimeSpec null does not hide the day the text names', () => {
  // This is the answer Gemini gave in the UAT run (for the merged clause):
  // no localTimeSpec at all, although the text says Sunday.
  const answer = RECORDED['سجّل موعد دكتور يوم الأحد. وبدي أدفع فاتورة الكهربا قبل آخر الشهر'];
  const result = validateExtractionResult(answer, 'سجّل موعد دكتور يوم الأحد', context);
  assert.equal(result.priority.level, 'high');
  assert.equal(result.priority.source, 'inferred');
});

// ── D2: «الساعة 5» is a time to do it at, «قبل» is a deadline ─────────────

test('D2: the recorded Gemini answer for «… الساعة 5 المسا» maps to a fixed-time commitment', async () => {
  const run = await propose(UAT_MEDICINE, recordedModel().provider);
  assert.equal(run.contract.items[0]!.resolvedTime, '2026-09-26T14:00:00.000Z');
  const [commitment] = await confirmAll(run);
  assert.equal(commitment!.timeSpec.kind, 'scheduled_event');
  assert.equal(commitment!.timeSpec.dueAt, '2026-09-26T14:00:00.000Z');
});

test('D2: the planner keeps «أشتري دوا … الساعة 5 المسا» at 17:00 rather than floating it ahead as a deadline', async () => {
  const run = await propose(UAT_MEDICINE, recordedModel().provider);
  const commitments = await confirmAll(run);
  const input = buildDailyPlanInput({
    uid: 'cl1-uat', date: '2026-09-26', timezone: TZ, commitments, busyBlocks: [], profile: null, builtAt: NOW.toISOString(),
  });
  assert.deepEqual(input.constraints.items, [], 'a fixed-time commitment is not a floating item');
  assert.equal(input.constraints.fixedEvents.length, 1);
  assert.equal(input.constraints.fixedEvents[0]!.interval.startsAt, '2026-09-26T14:00:00.000Z');
  assert.equal(input.constraints.fixedEvents[0]!.sourceCommitmentId, commitments[0]!.id);
});

test('D2: the gym «يوم الثلاثاء الساعة 7 المسا» in the six-commitment capture keeps its 19:00 as a fixed time', async () => {
  const run = await propose(UAT_SIX, recordedModel().provider);
  const gym = run.contract.items.find((item) => item.title === 'تمرين بالجيم')!;
  assert.equal(gym.needsClarification, false);
  assert.equal(gym.resolvedTime, '2026-09-29T16:00:00.000Z');
  const stored = await run.store.get(run.contract.proposalId);
  const draft = stored!.commandsByItemId.get(gym.itemId)!.find((c): c is Extract<Command, { type: 'CreateDraft' }> => c.type === 'CreateDraft')!;
  assert.equal(draft.commitment.timeSpec?.kind, 'scheduled_event');
});

test('D2: «قبل الخميس الساعة 5 المسا» stays a deadline, on the model path', async () => {
  const run = await propose('بدي أخلص تقرير الشغل قبل الخميس الساعة 5 المسا', recordedModel().provider);
  const [commitment] = await confirmAll(run);
  assert.equal(commitment!.timeSpec.kind, 'due_by');
  const input = buildDailyPlanInput({
    uid: 'cl1-uat', date: '2026-10-01', timezone: TZ, commitments: [commitment!], busyBlocks: [], profile: null, builtAt: NOW.toISOString(),
  });
  assert.deepEqual(input.constraints.fixedEvents, []);
  assert.equal(input.constraints.items[0]!.deadlineAt, '2026-10-01T14:00:00.000Z');
});

test('D2: the rules path reads "at" as a fixed time and "by/before/until" as a deadline, in all three languages', () => {
  const kindOf = (text: string) => {
    const result = extract(text, context);
    assert.ok(result.dueAt, `no time read from ${text}`);
    const draft = mapExtractionToCommand(result, NOW.toISOString())
      .find((c): c is Extract<Command, { type: 'CreateDraft' }> => c.type === 'CreateDraft')!;
    return draft.commitment.timeSpec?.kind;
  };
  for (const text of [
    UAT_MEDICINE,
    'buy medicine from the pharmacy today at 5pm',
    'לקנות תרופה בבית מרקחת היום ב-17:00',
    'عندي تمرين بالجيم يوم الثلاثاء الساعة 7 المسا',
  ]) assert.equal(kindOf(text), 'scheduled_event', text);
  for (const text of [
    'finish the report by 5pm today',
    'send the invoice before 5pm today',
    'بدي أخلص تقرير الشغل قبل الخميس الساعة 5 المسا',
    'لازم أخلص التقرير لحد الساعة 5 المسا اليوم',
    'לסיים את הדוח עד 17:00 היום',
    // A named part of the day is not a clock time: unchanged, still a deadline.
    'call mom tomorrow evening',
  ]) assert.equal(kindOf(text), 'due_by', text);
});

test('D2: moving a fixed-time item in review, or later through the edit route, keeps it fixed', () => {
  const draftOf = (text: string) => mapExtractionToCommand(extract(text, context), NOW.toISOString());
  const kindAfterEdit = (text: string) => {
    const rewritten = applyEditToCommands(draftOf(text), { resolvedTime: '2026-09-26T15:00:00.000Z' });
    return rewritten.find((c): c is Extract<Command, { type: 'CreateDraft' }> => c.type === 'CreateDraft')!.commitment.timeSpec?.kind;
  };
  assert.equal(kindAfterEdit(UAT_MEDICINE), 'scheduled_event');
  assert.equal(kindAfterEdit('finish the report by 5pm today'), 'due_by');

  const fixed = { kind: 'scheduled_event' as const, dueAt: '2026-09-26T14:00:00.000Z', endAt: null, remindAt: null, allDay: false, timezone: TZ };
  assert.equal(patchTimeSpecForTest(fixed, { dueDate: '2026-09-26T15:00:00.000Z' }, NOW)?.kind, 'scheduled_event');
  assert.equal(patchTimeSpecForTest({ ...fixed, kind: 'due_by' }, { dueDate: '2026-09-26T15:00:00.000Z' }, NOW)?.kind, 'due_by');
  assert.equal(patchTimeSpecForTest(fixed, { dueDate: null, reminderTime: null }, NOW)?.kind, 'unscheduled');
});
