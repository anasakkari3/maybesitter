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

// ── UAT round 6, batch 4: the model's hour for a part of the day ────
//
// «لازم أتصل بأمي بكرا المسا» ×3 on Gemini (build e1871874, shots 772–774)
// came back «بكرا · 21:00» twice and «بكرا · 18:00» once, marked «حزرنا
// الساعة» every time. The mark kept it honest, but the hour was the model's
// whim. When the clause's words give only a part of the day and no number,
// the model path takes the product's hour for it (`dayPartHour`) — the rules
// path's — on the model's day, still marked as our guess. A stated hour, a
// passed part of today and the bare-hour am/pm question are untouched.

/** Local wall-clock on 28 Sep 2026 in Jerusalem (UTC+3). */
const jlm = (time: string) => new Date(`${TODAY}T${time}:00+03:00`);

/** SCRIPTED: the call read by a model on `date` at `time` (`null`: a day and no hour, as Gemini answers a vague time). */
function callModel(date: string, time: string | null) {
  return scriptedModel(() => time
    ? { action: 'أتصل بأمي', title: 'أتصل بأمي', dueAt: at(date, time), localTimeSpec: { date, time, timezone: TZ } }
    : { action: 'أتصل بأمي', title: 'أتصل بأمي', localTimeSpec: { date, time: null, timezone: TZ }, missingFields: ['time'], ambiguityFlags: ['vague_time'] });
}

async function proposeAt(text: string, now: Date, provider?: (prompt: string) => Promise<string>) {
  const contract = await proposeCapture(
    text,
    { now, timezone: TZ, scopeId: 'r6-b4', requestedEngine: provider ? 'model' : 'rules' },
    {
      store: new MemoryCaptureProposalStore(),
      persistence: new TransactionalCapturePersistenceAdapter(createEmptyDomainState()),
      ...(provider ? { extractor: guardedMobileExtract, llmProvider: provider, llmEngine: 'gemini' } : {}),
    },
  );
  return contract;
}

type Card = { resolvedDate?: string; resolvedTime: string | null; needsClarification: boolean; timeEstimated?: boolean; clarification?: { questionKey?: string } | null };
/** What the review card shows: the day, the hour, whether it asks (and what), and the mark. */
const card = (item: Card) => [item.resolvedDate ?? null, item.resolvedTime, item.needsClarification, item.clarification?.questionKey ?? null, item.timeEstimated ?? null];

const MODEL_HOURS = ['18:00', '21:00', '20:00', '19:30', null] as const;

test('R6 batch 4 model path (SCRIPTED 18:00, 21:00, 20:00, 19:30, no hour): «لازم أتصل بأمي بكرا المسا» is tomorrow 18:00 every time, marked — the rules path\'s card', async () => {
  const text = 'لازم أتصل بأمي بكرا المسا';
  const now = jlm('15:00');
  const rules = await proposeAt(text, now);
  assert.deepEqual(card(rules.items[0]!), [TOMORROW, at(TOMORROW, '18:00'), false, null, true]);
  for (const time of MODEL_HOURS) {
    const contract = await proposeAt(text, now, callModel(TOMORROW, time));
    assert.equal(contract.provenance?.executedEngine, 'gemini', String(time));
    assert.equal(contract.items.length, 1, String(time));
    assert.deepEqual(card(contract.items[0]!), card(rules.items[0]!), `model answered ${time}`);
  }
});

/** Every part of the day, three languages: [text, day, product hour]. Read at 06:00, so every part is still ahead today. */
const PARTS_BY_MODEL: ReadonlyArray<readonly [string, string, string]> = [
  ['بكرا الصبح لازم أتصل بأمي', TOMORROW, '09:00'],
  ['بكرا الضهر لازم أتصل بأمي', TOMORROW, '12:00'],
  ['بكرا العصر لازم أتصل بأمي', TOMORROW, '14:00'],
  ['بكرا المسا لازم أتصل بأمي', TOMORROW, '18:00'],
  ['بكرا بالليل لازم أتصل بأمي', TOMORROW, '20:00'],
  ['لازم أتصل بأمي الليلة', TODAY, '20:00'],
  ['call mom this morning', TODAY, '09:00'],
  ['call mom this afternoon', TODAY, '14:00'],
  ['call mom this evening', TODAY, '18:00'],
  ['I need to call mom tonight', TODAY, '20:00'],
  ['מחר בבוקר אני צריך להתקשר לאמא', TOMORROW, '09:00'],
  ['מחר אחר הצהריים אני צריך להתקשר לאמא', TOMORROW, '14:00'],
  ['מחר בערב אני צריך להתקשר לאמא', TOMORROW, '18:00'],
  ['הלילה אני צריך להתקשר לאמא', TODAY, '20:00'],
];

for (const [text, date, time] of PARTS_BY_MODEL) {
  test(`R6 batch 4 model path (SCRIPTED an hour and a half off, and no hour): «${text}» is ${date} ${time}, marked, as on the rules path`, async () => {
    const now = jlm('06:00');
    const rules = await proposeAt(text, now);
    assert.deepEqual(card(rules.items[0]!), [date, at(date, time), false, null, true], 'rules');
    const [hour] = time.split(':').map(Number) as [number];
    const off = `${String(hour + 1).padStart(2, '0')}:30`;
    for (const modelTime of [off, null]) {
      const contract = await proposeAt(text, now, callModel(date, modelTime));
      assert.equal(contract.items.length, 1, String(modelTime));
      assert.deepEqual(card(contract.items[0]!), [date, at(date, time), false, null, true], `model answered ${modelTime}`);
    }
  });
}

test('R6 batch 4 model path (SCRIPTED): the product hour goes on the model\'s day, not one the words did not say', async () => {
  // No day in the words: the model's Wednesday stays Wednesday, at the part's hour.
  const contract = await proposeAt('لازم أتصل بأمي المسا', jlm('15:00'), callModel('2026-09-30', '21:00'));
  assert.deepEqual(card(contract.items[0]!), ['2026-09-30', at('2026-09-30', '18:00'), false, null, true]);
});

// ── Controls: a stated hour, the bare-hour question, a passed part of today ──

test('R6 batch 4 control (SCRIPTED): an hour the person stated is theirs — the part of the day does not replace it', async () => {
  const rows: ReadonlyArray<readonly [string, string, string]> = [
    ['بكرا الساعة 5 المسا لازم أتصل بأمي', '18:00', '17:00'],
    ['بكرا الساعة 7 المسا لازم أتصل بأمي', '19:00', '19:00'],
    ['بكرا الساعة سبعة المسا لازم أتصل بأمي', '19:00', '19:00'],
    ['call mom tomorrow evening at 7pm', '19:00', '19:00'],
    ['מחר בערב ב-19:30 להתקשר לאמא', '19:30', '19:30'],
  ];
  for (const [text, modelTime, shownTime] of rows) {
    const contract = await proposeAt(text, jlm('15:00'), callModel(TOMORROW, modelTime));
    assert.deepEqual(card(contract.items[0]!), [TOMORROW, at(TOMORROW, shownTime), false, null, false], text);
  }
});

test('R6 batch 4 control (SCRIPTED): a bare early hour is still asked صبح or مسا, and «12 المسا» still asked', async () => {
  const bare = await proposeAt('بكرا الساعة 5 لازم أروح عالبنك', jlm('15:00'), callModel(TOMORROW, '17:00'));
  assert.deepEqual(card(bare.items[0]!), [TOMORROW, null, true, 'ask_am_pm', false]);
  const twelve = await proposeAt('بكرا الساعة 12 المسا لازم أتصل بأمي', jlm('15:00'), callModel(TOMORROW, '12:00'));
  assert.deepEqual(card(twelve.items[0]!).slice(0, 3), [TOMORROW, null, true]);
});

test('R6 batch 4 passed part (SCRIPTED): «اليوم المسا» at 23:29 is asked on today whatever the model answered — never 18:00 gone by, never tomorrow', async () => {
  const text = 'لازم أتصل بأمي اليوم المسا';
  const now = jlm('23:29');
  const rules = await proposeAt(text, now);
  assert.deepEqual(card(rules.items[0]!), [TODAY, null, true, 'ask_time', false]);
  for (const [date, time] of [[TODAY, '18:00'], [TODAY, '21:00'], [TODAY, null], [TOMORROW, '18:00'], [TOMORROW, '21:00']] as const) {
    const contract = await proposeAt(text, now, callModel(date, time));
    assert.deepEqual(card(contract.items[0]!), card(rules.items[0]!), `model answered ${date} ${time}`);
  }
});

test('R6 batch 4 passed part (SCRIPTED): «اليوم المسا» at 19:00 answered 21:00 is asked, as the rules ask — the product hour has gone', async () => {
  const text = 'لازم أتصل بأمي اليوم المسا';
  const rules = await proposeAt(text, jlm('19:00'));
  assert.deepEqual(card(rules.items[0]!), [TODAY, null, true, 'ask_time', false]);
  const contract = await proposeAt(text, jlm('19:00'), callModel(TODAY, '21:00'));
  assert.deepEqual(card(contract.items[0]!), card(rules.items[0]!));
});

test('R6 batch 4 passed part (SCRIPTED): «اليوم الصبح» at 15:00 answered 10:00 or 16:00 is asked on today', async () => {
  const text = 'لازم أتصل بأمي اليوم الصبح';
  const rules = await proposeAt(text, jlm('15:00'));
  assert.deepEqual(card(rules.items[0]!), [TODAY, null, true, 'ask_time', false]);
  for (const time of ['10:00', '16:00', null] as const) {
    const contract = await proposeAt(text, jlm('15:00'), callModel(TODAY, time));
    assert.deepEqual(card(contract.items[0]!), card(rules.items[0]!), String(time));
  }
});

test('R6 batch 4 model path (SCRIPTED no hour, «vague»): the stored reading is the rules\' — nothing missing, nothing vague, an hour to remind at', async () => {
  const text = 'لازم أتصل بأمي بكرا المسا';
  const read = async (provider?: (prompt: string) => Promise<string>) => {
    const store = new MemoryCaptureProposalStore();
    const contract = await proposeCapture(
      text,
      { now: jlm('15:00'), timezone: TZ, scopeId: 'r6-b4', requestedEngine: provider ? 'model' : 'rules' },
      {
        store,
        persistence: new TransactionalCapturePersistenceAdapter(createEmptyDomainState()),
        ...(provider ? { extractor: guardedMobileExtract, llmProvider: provider, llmEngine: 'gemini' } : {}),
      },
    );
    const stored = await store.get(contract.proposalId);
    const result = stored!.resultsByItemId?.get(contract.items[0]!.itemId);
    assert.ok(result, 'no stored reading');
    return [result.localTimeSpec?.time ?? null, result.missingFields.includes('time'), result.ambiguityFlags.includes('vague_time')];
  };
  assert.deepEqual(await read(), ['18:00', false, false]);
  assert.deepEqual(await read(callModel(TOMORROW, null)), ['18:00', false, false]);
});

test('R6 batch 4 model path (SCRIPTED a reminder at 21:00): «ذكرني أتصل بأمي بكرا المسا» reminds at 18:00, marked', async () => {
  const provider = scriptedModel(() => ({
    action: 'أتصل بأمي', title: 'أتصل بأمي', explicitReminderRequest: true,
    remindAt: at(TOMORROW, '21:00'), localTimeSpec: { date: TOMORROW, time: '21:00', timezone: TZ },
  }));
  const contract = await proposeAt('ذكرني أتصل بأمي بكرا المسا', jlm('15:00'), provider);
  assert.deepEqual(card(contract.items[0]!), [TOMORROW, at(TOMORROW, '18:00'), false, null, true]);
});

test('R6 batch 4 control (SCRIPTED 19:00): an hour the clock readers miss is the model\'s to read — «المسا ع سبعة», «ع 7», «בערב בשבע», "evening at seven" keep 19:00', async () => {
  // The rules read these as the evening alone (18:00, marked); the model read
  // the seven, and the part of the day's hour does not replace it.
  for (const text of [
    'لازم أتصل بأمي بكرا المسا ع سبعة', 'لازم أتصل بأمي بكرا المسا عالسبعة', 'لازم أتصل بأمي بكرا المسا ع 7', 'لازم أتصل بأمي بكرا المسا ع ٧',
    'מחר בערב בשבע אני צריך להתקשר לאמא', 'מחר בערב ב7 אני צריך להתקשר לאמא', 'call mom tomorrow evening at seven', 'call mom tomorrow evening 7ish',
  ]) {
    const contract = await proposeAt(text, jlm('15:00'), callModel(TOMORROW, '19:00'));
    assert.deepEqual(card(contract.items[0]!).slice(0, 4), [TOMORROW, at(TOMORROW, '19:00'), false, null], text);
  }
});

test('R6 batch 4 control (SCRIPTED 16:00): a part-of-day word that is not a time — "the morning show" — is asked, as on the rules path', async () => {
  const text = 'call the morning show tomorrow';
  const rules = await proposeAt(text, jlm('15:00'));
  assert.deepEqual(card(rules.items[0]!), [TOMORROW, null, true, 'ask_time', false]);
  const contract = await proposeAt(text, jlm('15:00'), callModel(TOMORROW, '16:00'));
  assert.deepEqual(card(contract.items[0]!), card(rules.items[0]!));
});

test('R6 batch 4 control (SCRIPTED): midnight and the night\'s end are no evening — «نص الليل», «آخر الليل», "tonight at midnight", «בחצות» keep the model\'s hour', async () => {
  // Monday 22:00: the model reads each on Tuesday's small hours.
  const rows: ReadonlyArray<readonly [string, string]> = [
    ['اليوم نص الليل لازم أبعت الإيميل', '00:00'],
    ['اليوم آخر الليل لازم أبعت الإيميل', '01:00'],
    ['send the email tonight at midnight', '00:00'],
    ['הלילה בחצות אני צריך לשלוח את המייל', '00:00'],
  ];
  for (const [text, time] of rows) {
    const contract = await proposeAt(text, jlm('22:00'), callModel(TOMORROW, time));
    assert.deepEqual(card(contract.items[0]!).slice(0, 3), [TOMORROW, at(TOMORROW, time), false], text);
  }
});
