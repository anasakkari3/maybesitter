/**
 * UAT round 6, D2: an hour the person did not say is marked as our guess.
 *
 * «لازم أتصل بأمي اليوم المسا وبعدين أشتري خبز» reached the review card as
 * «أتصل بأمي · اليوم · 18:00» with no mark (evidence/uat-closure-20260927/
 * shots/586-*). The person said «المسا»; 18:00 is the product's hour for it,
 * on the rules path and the model path alike. The owner's rule is never to
 * pick a time silently. Coordinator ruling (option a): the hour picked stays —
 * `dayPartBoundary.test.ts` pins it — and the item says it is a guess:
 * `timeEstimated`, shown on the card as «حزرنا الساعة».
 *
 * True exactly when the item shows a clock time and its clause gives a part of
 * the day with no number. False for an hour the person stated, for an hour the
 * person chose answering the question (a button or typed words), and for an
 * item with no time. A person's explicit choice clears it; the confirmed
 * commitment carries nothing of it.
 *
 * Rows that script a model answer say so.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  answerClarification,
  confirmCapture,
  MemoryCaptureProposalStore,
  proposeCapture,
  TransactionalCapturePersistenceAdapter,
} from '../../lib/services/captureBoundary/index.ts';
import { guardedMobileExtract } from '../../lib/services/mobile/safety.ts';
import { proposeMobileCapture } from '../../lib/services/mobile/mobileCaptureService.ts';
import { applyShareActionAllowlist } from '../../lib/services/share/shareAllowlist.ts';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { createEmptyDomainState } from '../../src/domain/stateMachine.ts';

const TZ = 'Asia/Jerusalem';
/** Monday 28 Sep 2026, 10:05 in Jerusalem. */
const NOW = new Date('2026-09-28T07:05:00.000Z');
const TODAY = '2026-09-28';
const TOMORROW = '2026-09-29';
const at = (date: string, time: string) => new Date(`${date}T${time}:00+03:00`).toISOString();

const OWNER = 'لازم أتصل بأمي اليوم المسا وبعدين أشتري خبز';

type Item = { title: string; resolvedTime: string | null; needsClarification: boolean; timeEstimated?: boolean };

async function proposeRules(text: string) {
  const store = new MemoryCaptureProposalStore();
  const persistence = new TransactionalCapturePersistenceAdapter(createEmptyDomainState());
  const contract = await proposeCapture(
    text,
    { now: NOW, timezone: TZ, scopeId: 'd2', requestedEngine: 'rules' },
    { store, persistence },
  );
  return { contract, store, persistence };
}

function payloadOf(prompt: string): string | string[] {
  const lines = prompt.split('\n');
  return JSON.parse(lines[lines.indexOf('BEGIN_UNTRUSTED_USER_MESSAGE') + 1]!) as string | string[];
}

/** SCRIPTED: a model answer per clause, chosen by `read(clause)`. */
function scriptedModel(read: (clause: string) => Record<string, unknown>) {
  const base = (fields: Record<string, unknown>) => ({
    type: 'task', person: null, dueAt: null, remindAt: null, localTimeSpec: null,
    priority: { level: 'high', source: 'user_explicit', pressureAllowed: false, pressureImplied: false },
    flexibility: 'movable', category: null, categoryConfidence: 0,
    confidence: { overall: 0.9, type: 1, action: 0.9, time: 0.9, priority: 1 },
    missingFields: [], ambiguityFlags: [], explicitReminderRequest: false, explicitPressureRequest: false,
    ...fields,
  });
  return async (prompt: string): Promise<string> => {
    const payload = payloadOf(prompt);
    return Array.isArray(payload)
      ? JSON.stringify({ items: payload.map((clause, clauseIndex) => ({ clauseIndex, ...base(read(clause)) })) })
      : JSON.stringify(base(read(payload)));
  };
}

async function proposeModel(text: string, provider: (prompt: string) => Promise<string>) {
  const store = new MemoryCaptureProposalStore();
  const persistence = new TransactionalCapturePersistenceAdapter(createEmptyDomainState());
  const contract = await proposeCapture(
    text,
    { now: NOW, timezone: TZ, scopeId: 'd2', requestedEngine: 'model' },
    { store, persistence, extractor: guardedMobileExtract, llmProvider: provider, llmEngine: 'gemini' },
  );
  return { contract, store, persistence };
}

/** SCRIPTED: the owner's sentence as a model reads it — the call at `callTime` today, the bread with no time. */
function ownerModel(callTime: string) {
  return scriptedModel((clause) => clause.includes('خبز')
    ? { action: 'أشتري خبز', title: 'أشتري خبز', missingFields: ['time'], priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureImplied: false } }
    : {
      action: 'أتصل بأمي', title: 'أتصل بأمي',
      dueAt: at(TODAY, callTime), localTimeSpec: { date: TODAY, time: callTime, timezone: TZ },
    });
}

const marks = (items: readonly Item[]) => items.map((item) => [item.title, item.resolvedTime, item.timeEstimated]);

// ── The owner's sentence ─────────────────────────────────────────────

test('D2 rules path: «اليوم المسا» keeps 18:00 and marks it as our guess; the bread, with no time, is not marked', async () => {
  const { contract } = await proposeRules(OWNER);
  assert.equal(contract.provenance?.executedEngine, 'rule-based');
  assert.deepEqual(marks(contract.items), [
    ['أتصل بأمي', at(TODAY, '18:00'), true],
    ['أشتري خبز', null, false],
  ]);
});

test('D2 rules path, through the mobile route service: the phone receives the mark', async () => {
  setStorageForTests(createMemoryStorage());
  const proposal = await proposeMobileCapture({ text: OWNER, timezone: TZ, referenceTime: NOW.toISOString() })
    .finally(() => resetStorageForTests());
  const call = proposal.items.find((item) => item.title === 'أتصل بأمي')!;
  assert.deepEqual([call.resolvedTime, call.timeEstimated], [at(TODAY, '18:00'), true]);
});

test('D2 model path (SCRIPTED, 18:00 for «المسا»): the same hour, the same mark', async () => {
  const { contract } = await proposeModel(OWNER, ownerModel('18:00'));
  assert.equal(contract.provenance?.executedEngine, 'gemini');
  const call = contract.items.find((item) => item.title === 'أتصل بأمي')!;
  const bread = contract.items.find((item) => item.title === 'أشتري خبز')!;
  assert.deepEqual([call.resolvedTime, call.timeEstimated], [at(TODAY, '18:00'), true]);
  assert.equal(bread.timeEstimated, false);
});

test('D2 model path (SCRIPTED, the model picks 19:00 for «المسا»): whatever hour it is, it is not one the person said', async () => {
  const { contract } = await proposeModel(OWNER, ownerModel('19:00'));
  const call = contract.items.find((item) => item.title === 'أتصل بأمي')!;
  assert.notEqual(call.resolvedTime, null);
  assert.equal(call.timeEstimated, true);
});

// ── Every part of the day, three languages; the hour itself unchanged ──

const PARTS_OF_DAY: ReadonlyArray<readonly [string, string, string]> = [
  ['بكرا الصبح لازم أتصل بأمي', TOMORROW, '09:00'],
  ['بكرا الضهر لازم أتصل بأمي', TOMORROW, '12:00'],
  ['بكرا العصر لازم أتصل بأمي', TOMORROW, '14:00'],
  ['اتصل بأمي بكرا المسا', TOMORROW, '18:00'],
  ['بكرا بالليل لازم أتصل بأمي', TOMORROW, '20:00'],
  ['I need to call mom tomorrow morning', TOMORROW, '09:00'],
  ['I need to call mom tomorrow afternoon', TOMORROW, '14:00'],
  ['call mom this evening', TODAY, '18:00'],
  ['I need to call mom tonight', TODAY, '20:00'],
  ['מחר בבוקר אני צריך להתקשר לאמא', TOMORROW, '09:00'],
  ['מחר אחר הצהריים אני צריך להתקשר לאמא', TOMORROW, '14:00'],
  ['מחר בערב אני צריך להתקשר לאמא', TOMORROW, '18:00'],
];

for (const [text, date, time] of PARTS_OF_DAY) {
  test(`D2 rules path: «${text}» keeps ${date} ${time}, marked as our guess`, async () => {
    const { contract } = await proposeRules(text);
    assert.equal(contract.items.length, 1);
    assert.deepEqual([contract.items[0]!.resolvedTime, contract.items[0]!.timeEstimated], [at(date, time), true]);
  });
}

// ── An hour the person said is theirs ────────────────────────────────

const STATED: ReadonlyArray<readonly [string, string, string]> = [
  ['بكرا الساعة 5 المسا لازم أتصل بأمي', TOMORROW, '17:00'],
  ['بكرا 6 المسا لازم أتصل بأمي', TOMORROW, '18:00'],
  ['بكرا الساعة سبعة المسا لازم أتصل بأمي', TOMORROW, '19:00'],
  ['بكرا الساعة 9 لازم أتصل بأمي', TOMORROW, '09:00'],
  ['بكرا الساعة 2 بالليل لازم أبعت الإيميل', TOMORROW, '02:00'],
  ['call mom tomorrow at 7pm', TOMORROW, '19:00'],
  ['call mom tomorrow evening at 7pm', TOMORROW, '19:00'],
  ['מחר ב-19:00 להתקשר לאמא', TOMORROW, '19:00'],
];

for (const [text, date, time] of STATED) {
  test(`D2 control: «${text}» states its hour — ${time}, not marked`, async () => {
    const { contract } = await proposeRules(text);
    assert.deepEqual([contract.items[0]!.resolvedTime, contract.items[0]!.timeEstimated], [at(date, time), false]);
  });
}

test('D2 control (SCRIPTED): the model path does not mark «5 المسا» either', async () => {
  const text = 'بكرا الساعة 5 المسا لازم أتصل بأمي';
  const { contract } = await proposeModel(text, scriptedModel(() => ({
    action: 'أتصل بأمي', title: 'أتصل بأمي', dueAt: at(TOMORROW, '17:00'), localTimeSpec: { date: TOMORROW, time: '17:00', timezone: TZ },
  })));
  assert.deepEqual([contract.items[0]!.resolvedTime, contract.items[0]!.timeEstimated], [at(TOMORROW, '17:00'), false]);
});

test('D2 control: an item with no time is never marked — asked for its hour, or «12 المسا» asked', async () => {
  for (const text of ['بكرا لازم أشتري خبز', 'بكرا الساعة 12 المسا لازم أتصل بأمي']) {
    const { contract } = await proposeRules(text);
    assert.deepEqual([contract.items[0]!.resolvedTime, contract.items[0]!.needsClarification, contract.items[0]!.timeEstimated], [null, true, false], text);
  }
});

// ── Answering the question: a person's choice clears it ─────────────

async function answer(text: string, reply: { optionId: string } | { freeText: string }) {
  const { contract, store } = await proposeRules(text);
  const item = contract.items[0]!;
  const next = await answerClarification(
    { proposalId: contract.proposalId, itemId: item.itemId, questionId: item.clarification!.questionId, ...reply },
    { now: NOW, timezone: TZ, scopeId: 'd2' },
    { store, recordEvent: () => undefined },
  );
  return { before: item, after: next.items[0]! };
}

test('D2 clarify: the صبح/مسا button is the person\'s choice — not marked', async () => {
  const { before, after } = await answer('بكرا الساعة 5 لازم أروح عالبنك', { optionId: 'pm' });
  assert.equal(before.clarification?.questionKey, 'ask_am_pm');
  assert.deepEqual([after.resolvedTime, after.timeEstimated], [at(TOMORROW, '17:00'), false]);
});

test('D2 clarify: a part-of-day button or typed answer to "what time?" is the person\'s choice — not marked', async () => {
  const button = await answer('بكرا لازم أتصل بأمي', { optionId: 'evening' });
  assert.deepEqual([button.after.resolvedTime, button.after.timeEstimated], [at(TOMORROW, '19:00'), false]);
  const typedPart = await answer('بكرا لازم أتصل بأمي', { freeText: 'المسا' });
  assert.deepEqual([typedPart.after.resolvedTime, typedPart.after.timeEstimated], [at(TOMORROW, '19:00'), false]);
  const typedHour = await answer('بكرا لازم أتصل بأمي', { freeText: 'الساعة 7 المسا' });
  assert.deepEqual([typedHour.after.resolvedTime, typedHour.after.timeEstimated], [at(TOMORROW, '19:00'), false]);
});

test('D2 clarify: a question about the action leaves the part-of-day hour a guess', async () => {
  const { before, after } = await answer('بكرا المسا', { freeText: 'أتصل بأمي' });
  assert.equal(before.clarification?.field, 'action');
  assert.equal(before.timeEstimated, false);
  assert.deepEqual([after.title, after.resolvedTime, after.timeEstimated], ['أتصل بأمي', at(TOMORROW, '18:00'), true]);
});

// ── Confirm and share ──────────────────────────────────────────────

test('D2 confirm: the guessed hour is saved as the hour shown, and nothing of the mark is persisted', async () => {
  const { contract, store, persistence } = await proposeRules(OWNER);
  const call = contract.items.find((item) => item.title === 'أتصل بأمي')!;
  const confirmed = await confirmCapture(
    { proposalId: contract.proposalId, scopeId: 'd2', selectedItemIds: [call.itemId], idempotencyKey: 'k-d2', now: NOW },
    { store, persistence },
  );
  assert.equal(confirmed.success, true, JSON.stringify(confirmed));
  const snapshot = await persistence.snapshot();
  const [saved] = Object.values(snapshot.commitments);
  assert.equal(saved!.timeSpec.dueAt, at(TODAY, '18:00'));
  assert.ok(!JSON.stringify(snapshot).includes('timeEstimated'));
});

test('D2 share: the mark survives the share allowlist beside its time, and is false without one', () => {
  const { proposal, drops } = applyShareActionAllowlist<{ items: Array<Record<string, unknown>> }>({
    version: 'v1',
    proposalId: 'p-d2',
    status: 'proposed',
    items: [
      { itemId: 'call', title: 'أتصل بأمي', resolvedTime: at(TODAY, '18:00'), needsClarification: false, timeEstimated: true },
      { itemId: 'bread', title: 'أشتري خبز', resolvedTime: null, needsClarification: true, timeEstimated: true },
      { itemId: 'odd', title: 'أتصل بسامي', resolvedTime: at(TODAY, '18:00'), needsClarification: false, timeEstimated: 'yes' },
    ],
  });
  assert.deepEqual(drops, []);
  assert.deepEqual(proposal.items.map((item) => [item.itemId, item.timeEstimated]), [
    ['call', true],
    ['bread', false],
    ['odd', false],
  ]);
});

test('D2 share: the owner\'s proposal passes the share allowlist whole', async () => {
  const { contract } = await proposeRules(OWNER);
  const { proposal, drops } = applyShareActionAllowlist<typeof contract>(contract);
  assert.deepEqual(drops, []);
  assert.deepEqual(marks(proposal.items), marks(contract.items));
});
