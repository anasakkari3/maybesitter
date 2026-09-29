/**
 * The final UAT's capture defect N19 (Monday 28 Sep 2026, 10:04, Gemini path
 * consented): «سجّل موعد دكتور اليوم» reached the review card as «موعد دكتور ·
 * بدون وقت» with «أي وقت بناسبك؟» — no day — while «عندي موعد دكتور اليوم»,
 * a minute later, kept «اليوم».
 *
 * Root cause: not the imperative. «سجّل» is taken off the title only
 * (`stripCaptureCommand`), and the rules path keeps the day for every probe
 * below. On the model path the day is the model's: the validator fills an
 * absent one from the words only for a weekday (CL1 round 1, «سجّل موعد دكتور
 * يوم الأحد» with `localTimeSpec: null`) and for this month's end, never for
 * «اليوم»/«بكرا»/"today"/«היום». So a Gemini answer with no day lost the day
 * the person said. Gemini does drop it: its recorded round-2 answer for
 * «واليوم لازم أرتب الغرفة» (`fixtures/uat-2026-09-27-round2-gemini.json`)
 * has no day, and `fy1CaptureRegressions` pinned that lost day until this
 * fix. The UAT's own N19 answer was not recorded; the server log has
 * that call at 07:04:05Z answering in 131 output tokens against 175–182 for
 * every other single-clause capture of the run — the size of an answer with
 * `dueAt` and `localTimeSpec` both null. Re-asked live on the fix morning,
 * Gemini gave the day for both sentences (`fixtures/uat-2026-09-28-final-
 * gemini.json`, replayed below): it is the model's variance, and the words
 * have to hold the day when the model drops it.
 *
 * Rows that script a model answer say so; the recorded rows never do.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { LLMUnavailableError } from '../../src/extraction/llm/llmProvider.ts';
import {
  answerClarification,
  confirmCapture,
  MemoryCaptureProposalStore,
  proposeCapture,
  TransactionalCapturePersistenceAdapter,
} from '../../lib/services/captureBoundary/index.ts';
import { guardedMobileExtract } from '../../lib/services/mobile/safety.ts';
import { clarifyMobileCapture, proposeMobileCapture } from '../../lib/services/mobile/mobileCaptureService.ts';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { createEmptyDomainState } from '../../src/domain/stateMachine.ts';
import { setAiConsent } from '../../lib/consents/aiConsentService.ts';
import { AI_CONSENT_VERSION } from '../../src/contracts/v1/consentContracts.ts';
import { resetProviderForTests } from '../../src/extraction/llm/index.ts';
import { instantFromLocal } from '../../src/extraction/timeLexicon.ts';

const TZ = 'Asia/Jerusalem';
/** Monday 28 Sep 2026, 10:05 in Jerusalem. */
const NOW = new Date('2026-09-28T07:05:00.000Z');
const TODAY = '2026-09-28';
const TOMORROW = '2026-09-29';

const CALLS = (JSON.parse(readFileSync(new URL('./fixtures/uat-2026-09-28-final-gemini.json', import.meta.url), 'utf8')) as {
  calls: Array<{ case: string; payload: string | string[]; answer: Record<string, unknown> }>;
}).calls;

function payloadOf(prompt: string): string | string[] {
  const lines = prompt.split('\n');
  return JSON.parse(lines[lines.indexOf('BEGIN_UNTRUSTED_USER_MESSAGE') + 1]!) as string | string[];
}

/** Gemini's recording for the payload; anything else is a failed call. */
async function recorded(prompt: string): Promise<string> {
  const payload = payloadOf(prompt);
  const hit = CALLS.find((call) => JSON.stringify(call.payload) === JSON.stringify(payload));
  if (hit) return JSON.stringify(hit.answer);
  throw new LLMUnavailableError('provider_error');
}

/**
 * SCRIPTED: Gemini's recorded «سجّل موعد دكتور اليوم» answer with the day
 * taken out — `dueAt`, `remindAt` and `localTimeSpec` null, `time` missing —
 * the shape the UAT's short answer had. The title is the clause's own.
 */
function noDayModel(title: string) {
  const base = CALLS.find((call) => call.case === 'FINAL N19 log a doctor today')!.answer;
  const answer = {
    ...base, action: title, title, dueAt: null, remindAt: null, localTimeSpec: null,
    missingFields: ['time'], ambiguityFlags: [],
  };
  return async (prompt: string): Promise<string> => {
    const payload = payloadOf(prompt);
    return Array.isArray(payload)
      ? JSON.stringify({ items: payload.map((_, clauseIndex) => ({ clauseIndex, ...answer })) })
      : JSON.stringify(answer);
  };
}

async function proposeModel(text: string, provider: (prompt: string) => Promise<string>) {
  const store = new MemoryCaptureProposalStore();
  const persistence = new TransactionalCapturePersistenceAdapter(createEmptyDomainState());
  const contract = await proposeCapture(
    text,
    { now: NOW, timezone: TZ, scopeId: 'n19', requestedEngine: 'model' },
    { store, persistence, extractor: guardedMobileExtract, llmProvider: provider, llmEngine: 'gemini' },
  );
  return { contract, store, persistence };
}

type Item = { title: string; resolvedDate?: string; resolvedTime: string | null; clarification?: { questionKey?: string; params?: { date?: string } } | null };
/** What the card and the question show: the day, the hour, and the day the question names. */
const shown = (item: Item) => [item.resolvedDate ?? null, item.resolvedTime, item.clarification?.questionKey ?? null, item.clarification?.params?.date ?? null];

const PROBES: ReadonlyArray<{ text: string; title: string; day: string }> = [
  { text: 'سجّل موعد دكتور اليوم', title: 'موعد دكتور', day: TODAY },
  { text: 'عندي موعد دكتور اليوم', title: 'عندي موعد دكتور', day: TODAY },
  { text: 'سجّل موعد أسنان بكرا', title: 'موعد أسنان', day: TOMORROW },
  { text: 'سجّل اجتماع اليوم', title: 'اجتماع', day: TODAY },
  { text: 'ذكّرني اليوم أتصل بأمي', title: 'أتصل بأمي', day: TODAY },
  { text: 'log a doctor appointment today', title: 'doctor appointment', day: TODAY },
  { text: 'תרשום תור לרופא היום', title: 'תור לרופא', day: TODAY },
];

test('N19 recorded: Gemini\'s answers on the fix morning keep «اليوم» for both sentences, the hour asked on that day', async () => {
  for (const text of ['سجّل موعد دكتور اليوم', 'عندي موعد دكتور اليوم']) {
    const { contract } = await proposeModel(text, recorded);
    assert.equal(contract.provenance.executedEngine, 'gemini', text);
    assert.equal(contract.items.length, 1, text);
    assert.deepEqual(shown(contract.items[0]!), [TODAY, null, 'ask_time', TODAY], text);
  }
});

for (const probe of PROBES) {
  test(`N19 model path (SCRIPTED no-day answer): «${probe.text}» keeps its day, and the question names it`, async () => {
    const { contract } = await proposeModel(probe.text, noDayModel(probe.title));
    assert.equal(contract.provenance.executedEngine, 'gemini');
    assert.equal(contract.items.length, 1);
    assert.deepEqual(shown(contract.items[0]!), [probe.day, null, 'ask_time', probe.day]);
    // Said, not guessed: the card does not mark «اليوم» as an estimate.
    assert.equal((contract.items[0] as { dateEstimated?: boolean }).dateEstimated, false);
  });

  test(`N19 rules path: «${probe.text}» keeps its day, and the question names it`, async () => {
    setStorageForTests(createMemoryStorage());
    try {
      const proposal = await proposeMobileCapture({ text: probe.text, timezone: TZ, referenceTime: NOW.toISOString() });
      assert.equal(proposal.items.length, 1);
      assert.deepEqual(shown(proposal.items[0]!), [probe.day, null, 'ask_time', probe.day]);
    } finally {
      resetStorageForTests();
    }
  });
}

test('N19 × N18: the model\'s no-day «سجّل موعد دكتور اليوم» answered «بدون وقت محدد» is an all-day appointment today', async () => {
  const { contract, store, persistence } = await proposeModel('سجّل موعد دكتور اليوم', noDayModel('موعد دكتور'));
  const item = contract.items[0]!;
  const none = item.clarification!.options.find((option) => !option.value.localTime && !option.value.localDate)!;
  await answerClarification(
    { proposalId: contract.proposalId, itemId: item.itemId, questionId: item.clarification!.questionId, optionId: none.optionId },
    { now: NOW, timezone: TZ, scopeId: 'n19' },
    { store, recordEvent: () => undefined },
  );
  const confirmed = await confirmCapture(
    { proposalId: contract.proposalId, scopeId: 'n19', selectedItemIds: [item.itemId], idempotencyKey: 'k-n19', now: NOW },
    { store, persistence },
  );
  assert.equal(confirmed.success, true, JSON.stringify(confirmed));
  const [saved] = Object.values((await persistence.snapshot()).commitments);
  assert.deepEqual(
    [saved!.timeSpec.kind, saved!.timeSpec.allDay, saved!.timeSpec.dueAt],
    ['scheduled_event', true, '2026-09-27T21:00:00.000Z'],
  );
});

test('N19 guard (SCRIPTED): words that put it on another day than today get no «today» from the fill', async () => {
  // «مش اليوم» / "not today": the words name today only to rule it out.
  for (const text of ['بدي أتصل بسامي بس مش اليوم', 'call Sam, but not today']) {
    const { contract } = await proposeModel(text, noDayModel('أتصل بسامي'));
    assert.equal(contract.items[0]?.resolvedDate ?? null, null, text);
  }
});

test('N19 guard (SCRIPTED, review M2): a day ruled out or left open gets no fill — the item is asked with no day', async () => {
  const texts = [
    'بدي أتصل بسامي بس مش بكرا',
    'بدي أتصل بسامي، ومش بكرا',
    'call Sam, but not tomorrow',
    'להתקשר לסאמי אבל לא מחר',
    'اليوم أو بكرا بدي أتصل بسامي',
    'اليوم ولا بكرا بدي أتصل بسامي',
    'call Sam today or tomorrow',
    'להתקשר לסאמי היום או מחר',
  ];
  for (const text of texts) {
    const { contract } = await proposeModel(text, noDayModel('أتصل بسامي'));
    const item = contract.items[0]!;
    assert.deepEqual([item.resolvedDate ?? null, item.resolvedTime, item.needsClarification], [null, null, true], text);
    // The rules path reads the same words the same way: no day, asked.
    setStorageForTests(createMemoryStorage());
    try {
      const proposal = await proposeMobileCapture({ text, timezone: TZ, referenceTime: NOW.toISOString() });
      const rules = proposal.items[0]!;
      assert.deepEqual([rules.resolvedDate ?? null, rules.resolvedTime, rules.needsClarification], [null, null, true], `rules: ${text}`);
    } finally {
      resetStorageForTests();
    }
  }
});

test('N19 guard (review M2): the plain day words still fill beside the guard', async () => {
  // Not a negation or an alternative: «بكرا» alone, and "or" between two
  // people rather than two days.
  for (const [text, day] of [
    ['بدي أتصل بسامي بكرا', TOMORROW],
    ['call Sam or Rami tomorrow', TOMORROW],
    ['להתקשר לסאמי מחר', TOMORROW],
  ] as const) {
    const { contract } = await proposeModel(text, noDayModel('أتصل بسامي'));
    assert.equal(contract.items[0]?.resolvedDate, day, text);
  }
});

test('N19 guard (SCRIPTED): a model day is never moved — only an absent one is filled', async () => {
  // L4 ruling: the fill is for a missing day. A model that read a day keeps
  // it here, even beside «اليوم» (a model *tomorrow* under «اليوم» is FZ1's
  // own narrow move, not this fill's).
  const base = CALLS.find((call) => call.case === 'FINAL N19 log a doctor today')!.answer;
  const answer = { ...base, dueAt: null, remindAt: null, localTimeSpec: { date: '2026-09-30', time: null, timezone: TZ } };
  const { contract } = await proposeModel('سجّل موعد دكتور اليوم', async () => JSON.stringify(answer));
  assert.equal(contract.items[0]?.resolvedDate, '2026-09-30');
});

/* ── Rules-path titles of an unsettled day (FINAL-BACKEND review, last item) ── */

/*
 * The rules path took the day word out of the title and left its negation or
 * its «أو» behind: «أتصل بسامي بس مش», «أو بدي أتصل بسامي», "call Sam or".
 * An unsettled day is not a time the item took — the item is asked — so the
 * phrase stays in the title exactly as the person said it.
 */
const M2_TITLES: ReadonlyArray<{ text: string; phrase: string }> = [
  { text: 'بدي أتصل بسامي بس مش بكرا', phrase: 'بس مش بكرا' },
  { text: 'بدي أتصل بسامي، ومش بكرا', phrase: 'ومش بكرا' },
  { text: 'call Sam, but not tomorrow', phrase: 'but not tomorrow' },
  { text: 'להתקשר לסאמי אבל לא מחר', phrase: 'אבל לא מחר' },
  { text: 'اليوم أو بكرا بدي أتصل بسامي', phrase: 'اليوم أو بكرا' },
  { text: 'اليوم ولا بكرا بدي أتصل بسامي', phrase: 'اليوم ولا بكرا' },
  { text: 'call Sam today or tomorrow', phrase: 'today or tomorrow' },
  { text: 'להתקשר לסאמי היום או מחר', phrase: 'היום או מחר' },
];

async function rulesTitles(text: string, referenceTime = NOW.toISOString()): Promise<string[]> {
  setStorageForTests(createMemoryStorage());
  try {
    const proposal = await proposeMobileCapture({ text, timezone: TZ, referenceTime });
    return proposal.items.map((item) => item.title);
  } finally {
    resetStorageForTests();
  }
}

/**
 * A connector or a negation standing alone at either end of a title. «مش
 * لازم …» ("no need to …") opens a title rightly: that negation is the
 * person's, on the obligation, not a day's left behind. So does the whole
 * unsettled phrase when the «،» made it a clause of its own («ومش بكرا»).
 */
const DANGLING_EDGE = new RegExp(
  [
    '^(?:و?مش|مو|مب|بلاش|أو|او|ولا|و?بس|و|or|not|but|and|לא|ולא|או|אבל)(?=\\s|$)(?!\\s+(?:لازم|ضروري|مهم)(?:\\s|$))(?!\\s+(?:مش\\s+|not\\s+|לא\\s+)?(?:اليوم|بكرا|today|tomorrow|היום|מחר)(?:\\s|$))',
    '(?:^|\\s)(?:و?مش|مو|مب|بلاش|أو|او|ولا|و?بس|و|or|not|but|and|לא|ולא|או|אבל)$',
  ].join('|'),
  'iu',
);

test('M2 titles: the rules path keeps an unsettled day phrase verbatim, never a dangling «مش/أو/or/לא»', async () => {
  for (const { text, phrase } of M2_TITLES) {
    const titles = await rulesTitles(text);
    // «، ومش بكرا» included: a clause that is only a time is merged into the
    // one before it (`splitCaptureClauses`), so it is one item.
    assert.equal(titles.length, 1, `${text}: ${JSON.stringify(titles)}`);
    assert.ok(titles.some((title) => title.includes(phrase)), `${text}: the titles ${JSON.stringify(titles)} lost «${phrase}»`);
    for (const title of titles) assert.ok(!DANGLING_EDGE.test(title), `${text}: dangling edge in «${title}»`);
  }
});

test('M2 titles: a settled day word still leaves the title', async () => {
  assert.deepEqual(await rulesTitles('بدي أتصل بسامي بكرا'), ['أتصل بسامي']);
  assert.deepEqual(await rulesTitles('call Sam tomorrow'), ['call Sam']);
  assert.deepEqual(await rulesTitles('להתקשר לסאמי מחר'), ['להתקשר לסאמי']);
});

test('M2 titles sweep: no rules-path title in the probe corpora starts or ends with a dangling connector or negation', async () => {
  const corpus = (name: string) => (JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as {
    rules: Array<{ text: string; referenceTime?: string }>;
  }).rules;
  const rows = [
    ...corpus('cl1-capture-probes.json').map((row) => ({ text: row.text, referenceTime: '2026-09-26T07:00:00.000Z' })),
    ...corpus('fx3-capture-probes.json').map((row) => ({ text: row.text, referenceTime: row.referenceTime ?? '2026-09-27T07:00:00.000Z' })),
    ...M2_TITLES.map((row) => ({ text: row.text, referenceTime: NOW.toISOString() })),
  ];
  assert.ok(rows.length > 100, `only ${rows.length} probes; the sweep would be vacuous`);
  const dangling: string[] = [];
  for (const row of rows) {
    for (const title of await rulesTitles(row.text, row.referenceTime)) {
      if (DANGLING_EDGE.test(title)) dangling.push(`${row.text} → «${title}»`);
    }
  }
  assert.deepEqual(dangling, []);
});

/* ── Model-path titles of an unsettled day (closure UAT round 6, shot 506) ── */

/*
 * On the phone, «بدي أتصل بسامي بس مش بكرا» went to Gemini (backend log:
 * `capture_extraction`, outcome ok, 12:54:08Z) and came back titled «أتصل
 * بسامي». The item was rightly asked with no day, but «فهمت منك:» showed the
 * call without its limit: the model's short title dropped «بس مش بكرا», and
 * nothing on the model path put it back (the rules path keeps it, above).
 * The words are the person's; the title keeps them, and the day stays unfilled.
 */

/** SCRIPTED: one answer per clause, each with its own title and no day. */
function titledNoDayModel(titles: readonly string[]) {
  const base = CALLS.find((call) => call.case === 'FINAL N19 log a doctor today')!.answer;
  const answerFor = (title: string) => ({
    ...base, action: title, title, dueAt: null, remindAt: null, localTimeSpec: null,
    missingFields: ['time'], ambiguityFlags: [],
  });
  return async (prompt: string): Promise<string> => {
    const payload = payloadOf(prompt);
    return Array.isArray(payload)
      ? JSON.stringify({ items: payload.map((_, clauseIndex) => ({ clauseIndex, ...answerFor(titles[clauseIndex] ?? titles[0]!) })) })
      : JSON.stringify(answerFor(titles[0]!));
  };
}

const R6_MODEL_TITLES: ReadonlyArray<{ text: string; model: string; title: string }> = [
  { text: 'بدي أتصل بسامي بس مش بكرا', model: 'أتصل بسامي', title: 'أتصل بسامي بس مش بكرا' },
  { text: 'بدي أتصل بسامي، ومش بكرا', model: 'أتصل بسامي', title: 'أتصل بسامي ومش بكرا' },
  { text: 'call Sam, but not tomorrow', model: 'call Sam', title: 'call Sam, but not tomorrow' },
  { text: 'להתקשר לסאמי אבל לא מחר', model: 'להתקשר לסאמי', title: 'להתקשר לסאמי אבל לא מחר' },
  { text: 'اليوم أو بكرا بدي أتصل بسامي', model: 'أتصل بسامي', title: 'اليوم أو بكرا أتصل بسامي' },
  { text: 'اليوم ولا بكرا بدي أتصل بسامي', model: 'أتصل بسامي', title: 'اليوم ولا بكرا أتصل بسامي' },
  { text: 'call Sam today or tomorrow', model: 'call Sam', title: 'call Sam today or tomorrow' },
  { text: 'today or tomorrow, call Sam', model: 'call Sam', title: 'today or tomorrow, call Sam' },
  { text: 'להתקשר לסאמי היום או מחר', model: 'להתקשר לסאמי', title: 'להתקשר לסאמי היום או מחר' },
  // A model title that is not the person's words verbatim still gets the limit.
  { text: 'call Sam, but not tomorrow', model: 'Phone Sam', title: 'Phone Sam not tomorrow' },
  // A model title that stops inside the phrase gets the rest of it.
  { text: 'بدي أتصل بسامي بس مش بكرا', model: 'أتصل بسامي بس مش', title: 'أتصل بسامي بس مش بكرا' },
  // Already there: nothing is added twice.
  { text: 'بدي أتصل بسامي بس مش بكرا', model: 'أتصل بسامي بس مش بكرا', title: 'أتصل بسامي بس مش بكرا' },
  { text: 'call Sam, but not tomorrow', model: 'Phone Sam, not tomorrow', title: 'Phone Sam, not tomorrow' },
];

for (const probe of R6_MODEL_TITLES) {
  test(`R6 model path (SCRIPTED «${probe.model}»): «${probe.text}» keeps its unsettled day in the title, asked with no day`, async () => {
    const { contract } = await proposeModel(probe.text, titledNoDayModel([probe.model]));
    assert.equal(contract.provenance.executedEngine, 'gemini');
    assert.equal(contract.items.length, 1, JSON.stringify(contract.items.map((item) => item.title)));
    const item = contract.items[0]!;
    assert.equal(item.title, probe.title);
    assert.ok(!DANGLING_EDGE.test(item.title), `dangling edge in «${item.title}»`);
    assert.deepEqual([item.resolvedDate ?? null, item.resolvedTime, item.needsClarification], [null, null, true]);
  });
}

test('R6 model path (SCRIPTED): a settled day word still leaves the model\'s title, and the day is filled', async () => {
  for (const [text, model] of [
    ['بدي أتصل بسامي بكرا', 'أتصل بسامي'],
    ['call Sam tomorrow', 'call Sam'],
    ['להתקשר לסאמי מחר', 'להתקשר לסאמי'],
    // A time-only clause is merged into the call: one item, the day taken.
    ['بدي أتصل بسامي، بكرا', 'أتصل بسامي'],
  ] as const) {
    const { contract } = await proposeModel(text, titledNoDayModel([model]));
    assert.equal(contract.items.length, 1, text);
    assert.deepEqual([contract.items[0]!.title, contract.items[0]!.resolvedDate], [model, TOMORROW], text);
  }
});

test('R6 model path (SCRIPTED): in a two-clause capture only the unsettled clause keeps its phrase', async () => {
  const { contract } = await proposeModel(
    'بدي أتصل بسامي بس مش بكرا، وبكرا بدي أروح عالسوق',
    titledNoDayModel(['أتصل بسامي', 'أروح عالسوق']),
  );
  assert.deepEqual(
    contract.items.map((item) => [item.title, item.resolvedDate ?? null]),
    [['أتصل بسامي بس مش بكرا', null], ['أروح عالسوق', TOMORROW]],
  );
});

// ── R6 month end: «حزرنا التاريخ» whatever day the model gave ─────────────
/*
 * UAT round 6 (Gemini consented, `capture_extraction` ok on all three runs):
 * «لازم أحضّر تقرير آخر الشهر» ×3 reached the card on Wednesday 30 Sep with
 * the hour asked every time, but one run of three had no «حزرنا التاريخ»
 * (shots 572/574/576). The day is read from a name for the report, not said
 * as a date (controller ruling N6): it is marked a guess. The mark was set
 * only when the model gave no day, or a later one FY1 discarded — so a model
 * that itself answered 30 Sep left the day unmarked.
 */
const R6_MONTH_END = 'لازم أحضّر تقرير آخر الشهر';
const MONTH_LAST = '2026-09-30';

/** SCRIPTED: the recorded month-end answer shape, with the day (and hour) the variant says. */
function monthEndModel(date: string | null, clock: string | null = null, flags: string[] = ['vague_time']) {
  const answer = {
    type: 'task', action: null, title: 'أحضّر تقرير', person: null,
    dueAt: date ? new Date(`${date}T${clock ?? '00:00'}:00+03:00`).toISOString() : null, remindAt: null,
    localTimeSpec: date ? { date, time: clock, timezone: TZ } : null,
    priority: { level: 'high', source: 'user_explicit', pressureAllowed: false, pressureImplied: false },
    flexibility: 'movable', category: null, categoryConfidence: 0,
    confidence: { overall: 1, type: 1, action: 1, time: 0.5, priority: 1 },
    missingFields: date ? [] : ['time'], ambiguityFlags: flags, explicitReminderRequest: false, explicitPressureRequest: false,
  };
  return async (): Promise<string> => JSON.stringify(answer);
}

const R6_MONTH_END_VARIANTS: ReadonlyArray<{ name: string; provider: () => Promise<string> }> = [
  { name: 'the model\'s own 30 Sep, all day at midnight', provider: monthEndModel(MONTH_LAST) },
  { name: 'the model\'s own 30 Sep, no vague flag', provider: monthEndModel(MONTH_LAST, null, []) },
  { name: 'no day from the model', provider: monthEndModel(null) },
  { name: 'the model\'s 30 Sep at 23:59', provider: monthEndModel(MONTH_LAST, '23:59') },
  { name: 'the model\'s 30 Sep at 09:00, no vague flag', provider: monthEndModel(MONTH_LAST, '09:00', []) },
  { name: 'the model\'s 31 Oct', provider: monthEndModel('2026-10-31') },
  { name: 'the model\'s 1 Oct', provider: monthEndModel('2026-10-01') },
];

test('R6 month end (SCRIPTED, the model\'s 29 Sep): the model\'s earlier day is kept (FY1 I2) and marked a guess, the hour asked', async () => {
  for (const provider of [monthEndModel('2026-09-29'), monthEndModel('2026-09-29', null, []), monthEndModel('2026-09-29', '23:59')]) {
    const { contract } = await proposeModel(R6_MONTH_END, provider);
    const item = contract.items[0]!;
    assert.deepEqual(
      [item.resolvedDate ?? null, item.resolvedTime, item.needsClarification, item.clarification?.questionKey ?? null, item.dateEstimated],
      ['2026-09-29', null, true, 'ask_time', true],
    );
  }
});

for (const variant of R6_MONTH_END_VARIANTS) {
  test(`R6 month end (SCRIPTED, ${variant.name}): «${R6_MONTH_END}» is on 30 Sep, marked a guess, the hour asked`, async () => {
    const { contract } = await proposeModel(R6_MONTH_END, variant.provider);
    assert.equal(contract.provenance.executedEngine, 'gemini');
    assert.equal(contract.items.length, 1);
    const item = contract.items[0]!;
    assert.deepEqual(
      [item.resolvedDate ?? null, item.resolvedTime, item.needsClarification, item.clarification?.questionKey ?? null, item.dateEstimated],
      [MONTH_LAST, null, true, 'ask_time', true],
    );
  });
}

test('R6 month end: the rules path marks the same day the same way', async () => {
  setStorageForTests(createMemoryStorage());
  const proposal = await proposeMobileCapture({ text: R6_MONTH_END, timezone: TZ, referenceTime: NOW.toISOString() }).finally(() => resetStorageForTests());
  const item = proposal.items[0]!;
  assert.deepEqual([item.resolvedDate ?? null, item.resolvedTime, item.clarification?.questionKey ?? null, item.dateEstimated], [MONTH_LAST, null, 'ask_time', true]);
});

test('R6 month end (SCRIPTED): a counted offset, another month or a date the person named is not marked by the month-end rule', async () => {
  const rows: ReadonlyArray<[string, string, string | null]> = [
    // A counted day is the words' own, said rather than guessed (N15).
    ['لازم أخلص التقرير قبل آخر الشهر بيومين', '2026-09-28', '2026-09-28'],
    // Next month's end is the model's to read.
    ['بدي أحضّر تقرير آخر الشهر الجاي', '2026-10-31', '2026-10-31'],
    // A date the person named is theirs.
    ['بدي أحضّر تقرير آخر الشهر يوم 29', '2026-09-29', '2026-09-29'],
    ['بدي أحضّر تقرير آخر الشهر يوم 30', '2026-09-30', '2026-09-30'],
    ['بدي أحضّر تقرير آخر الشهر 29/9', '2026-09-29', '2026-09-29'],
  ];
  for (const [text, modelDay, expected] of rows) {
    const { contract } = await proposeModel(text, monthEndModel(modelDay));
    const item = contract.items[0]!;
    assert.equal(item.resolvedDate ?? null, expected, text);
    assert.notEqual(item.dateEstimated, true, text);
  }
});

/* ── Round 6, re-run on 191f0f9d: the day's «مش» read as a refusal ── */

/*
 * On the phone (17:01–17:03, shots 577–579, Gemini `capture_extraction` ok
 * ×3), «بدي أتصل بسامي بس مش بكرا» gave no review at all: «ما لقينا التزام» /
 * «تمام. ما عملنا تذكير.» — `noCommitmentReason: negated_request`. Nothing in
 * the words refuses a reminder (neither `NEGATED_REQUEST` in the mobile guard
 * nor the validator's own check matches); the only negation is the day's.
 * The one answer that reproduces it end to end is Gemini flagging
 * `negated_request`, and that answer declines on 388bfd7a exactly as it does
 * after the title fix — the title is not read for it. A «مش»/"not"/«לא» that
 * rules out a day is a limit on the call, not a refusal of it: the model's flag
 * is dropped when the unsettled day is the words' only negation. A refusal the
 * person wrote still declines.
 */

const GENAI_STUB_URL = 'maybesitter-test:google-genai-r6';
const GENAI_STUB_SOURCE = `
export class GoogleGenAI {
  constructor(options) { this.options = options; }
  get models() {
    return { generateContent: async (input) => globalThis.__r6VertexGenerate(input) };
  }
}
`;
type R6Globals = typeof globalThis & { __r6VertexGenerate?: () => Promise<unknown> };

/** The model's no-day answer for the call, with the flags given. */
function callAnswer(title: string, ambiguityFlags: string[]) {
  const base = CALLS.find((call) => call.case === 'FINAL N19 log a doctor today')!.answer;
  return {
    ...base, action: title, title, dueAt: null, remindAt: null, localTimeSpec: null,
    missingFields: ['time'], ambiguityFlags,
  };
}

/**
 * The route's own path, in process: `proposeMobileCapture` with the account's
 * consent read from storage and the Vertex SDK stubbed, so the metered,
 * consent-gated provider, `guardedMobileExtract` and the capture boundary all
 * run as they do behind `/api/mobile/capture`. `answer: null` is no consent:
 * the rules path.
 */
async function proposeThroughRoute(text: string, answer: Record<string, unknown> | null) {
  setStorageForTests(createMemoryStorage());
  let calls = 0;
  (globalThis as R6Globals).__r6VertexGenerate = async () => {
    calls += 1;
    return { text: JSON.stringify(answer), modelVersion: 'gemini-2.5-flash', usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 } };
  };
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === '@google/genai') return { url: GENAI_STUB_URL, shortCircuit: true };
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url === GENAI_STUB_URL) return { format: 'module', source: GENAI_STUB_SOURCE, shortCircuit: true };
      return nextLoad(url, context);
    },
  });
  const previous = { provider: process.env.MAYBESITTER_LLM_PROVIDER, location: process.env.MAYBESITTER_VERTEX_LOCATION };
  try {
    const uid = 'r6-route';
    if (answer) {
      await setAiConsent(uid, { state: 'granted', version: AI_CONSENT_VERSION });
      process.env.MAYBESITTER_LLM_PROVIDER = 'gemini';
      process.env.MAYBESITTER_VERTEX_LOCATION = 'europe-west1';
    }
    resetProviderForTests();
    const proposal = await proposeMobileCapture({ text, timezone: TZ, referenceTime: NOW.toISOString() }, { participantId: uid });
    return { proposal, calls };
  } finally {
    hooks.deregister();
    delete (globalThis as R6Globals).__r6VertexGenerate;
    if (previous.provider === undefined) delete process.env.MAYBESITTER_LLM_PROVIDER;
    else process.env.MAYBESITTER_LLM_PROVIDER = previous.provider;
    if (previous.location === undefined) delete process.env.MAYBESITTER_VERTEX_LOCATION;
    else process.env.MAYBESITTER_VERTEX_LOCATION = previous.location;
    resetProviderForTests();
    resetStorageForTests();
  }
}

const itemsOf = (proposal: { items: Item[] }) => proposal.items.map((item) => [item.title, item.resolvedDate ?? null, (item as { needsClarification?: boolean }).needsClarification ?? null]);

test('R6 route (SCRIPTED Gemini flags negated_request): «بدي أتصل بسامي بس مش بكرا» is an asked call, not «ما عملنا تذكير»', async () => {
  const { proposal, calls } = await proposeThroughRoute('بدي أتصل بسامي بس مش بكرا', callAnswer('أتصل بسامي', ['negated_request']));
  assert.equal(calls, 1);
  assert.deepEqual(
    [proposal.status, proposal.provenance.executedEngine, (proposal as { noCommitmentReason?: string }).noCommitmentReason ?? null],
    ['needs_clarification', 'gemini', null],
  );
  assert.deepEqual(itemsOf(proposal), [['أتصل بسامي بس مش بكرا', null, true]]);
});

test('R6 route: the same capture without consent (rules) and with a plain model answer is the same asked call', async () => {
  for (const answer of [null, callAnswer('أتصل بسامي', [])]) {
    const { proposal } = await proposeThroughRoute('بدي أتصل بسامي بس مش بكرا', answer);
    assert.equal(proposal.status, 'needs_clarification', JSON.stringify(answer));
    assert.deepEqual(itemsOf(proposal), [['أتصل بسامي بس مش بكرا', null, true]]);
  }
});

test('R6 boundary (SCRIPTED negated_request): every unsettled-day shape survives as an asked item that keeps its phrase', async () => {
  for (const { text, phrase } of M2_TITLES) {
    const model = /[a-z]/i.test(text) ? 'call Sam' : /[א-ת]/.test(text) ? 'להתקשר לסאמי' : 'أتصل بسامي';
    const { contract } = await proposeModel(text, async () => JSON.stringify(callAnswer(model, ['negated_request'])));
    assert.equal(contract.status, 'needs_clarification', text);
    assert.equal(contract.items.length, 1, text);
    const item = contract.items[0]!;
    assert.ok(item.title.includes(phrase), `${text}: «${item.title}» lost «${phrase}»`);
    assert.deepEqual([item.resolvedDate ?? null, item.resolvedTime, item.needsClarification], [null, null, true], text);
  }
});

test('R6 boundary: a refusal the person wrote still declines, beside an unsettled day or not', async () => {
  // Refused by the words themselves, whatever the model says.
  for (const text of ['لا تذكرني أتصل بسامي بكرا', "don't remind me to call Sam tomorrow", 'אל תזכיר לי להתקשר לסאמי מחר']) {
    const { contract } = await proposeModel(text, async () => JSON.stringify(callAnswer('x', [])));
    assert.deepEqual([contract.status, contract.noCommitmentReason], ['no_commitment', 'negated_request'], text);
  }
  // The model's flag stands where the words carry a negation of their own:
  // another negation beside the day's, or no unsettled day at all.
  for (const text of ['never mind calling Sam, not tomorrow', 'خلص ما عاد بدي أتصل بسامي', 'call Sam tomorrow']) {
    const { contract } = await proposeModel(text, async () => JSON.stringify(callAnswer('call Sam', ['negated_request'])));
    assert.deepEqual([contract.status, contract.noCommitmentReason], ['no_commitment', 'negated_request'], text);
  }
});

// ── UAT round 6, D1: a bare early hour on the model path is always asked ──

/*
 * «بكرا الساعة 5 لازم أروح عالبنك» ×4 on the consented Gemini path (shots
 * 581–584): runs 2–4 asked «أي 5 قصدت؟», run 1 went straight to «أروح عالبنك
 * · بكرا · 17:00 · لازم», settled, no mark. The words give the number and
 * no half of the day; the rules path asks صبح or مسا (CL1 round 6), and the
 * model's half of the day is the same guess (controller ruling, r6). Every
 * row below is SCRIPTED: the model answers one way per variant, and the item
 * must end as the same am/pm question on the day the person said.
 */
const R6_BANK = 'بكرا الساعة 5 لازم أروح عالبنك';

function bankModel(fields: Record<string, unknown>, title = 'أروح عالبنك') {
  const answer = {
    type: 'task', action: title, title, person: null,
    dueAt: null, remindAt: null, localTimeSpec: null,
    priority: { level: 'high', source: 'user_explicit', pressureAllowed: false, pressureImplied: false },
    flexibility: 'movable', category: null, categoryConfidence: 0,
    confidence: { overall: 0.9, type: 1, action: 0.9, time: 0.9, priority: 1 },
    missingFields: [], ambiguityFlags: [], explicitReminderRequest: false, explicitPressureRequest: false,
    ...fields,
  };
  return async (prompt: string): Promise<string> => {
    const payload = payloadOf(prompt);
    return Array.isArray(payload)
      ? JSON.stringify({ items: payload.map((_, clauseIndex) => ({ clauseIndex, ...answer })) })
      : JSON.stringify(answer);
  };
}

const at = (date: string, time: string) => new Date(`${date}T${time}:00+03:00`).toISOString();
const R6_BANK_VARIANTS: ReadonlyArray<{ name: string; fields: Record<string, unknown> }> = [
  // UAT run 1, and Gemini's recorded answer for this sentence (uat-2026-09-27-gemini.json).
  { name: '17:00, no flags, confident', fields: { dueAt: at(TOMORROW, '17:00'), localTimeSpec: { date: TOMORROW, time: '17:00', timezone: TZ } } },
  { name: '17:00 with vague_time', fields: { dueAt: at(TOMORROW, '17:00'), localTimeSpec: { date: TOMORROW, time: '17:00', timezone: TZ }, ambiguityFlags: ['vague_time'] } },
  { name: '05:00, no flags', fields: { dueAt: at(TOMORROW, '05:00'), localTimeSpec: { date: TOMORROW, time: '05:00', timezone: TZ } } },
  { name: '05:00 with vague_time', fields: { dueAt: at(TOMORROW, '05:00'), localTimeSpec: { date: TOMORROW, time: '05:00', timezone: TZ }, ambiguityFlags: ['vague_time'] } },
  { name: 'the instant only (14:00Z), no local spec', fields: { dueAt: at(TOMORROW, '17:00') } },
  { name: 'remindAt 17:00 only', fields: { remindAt: at(TOMORROW, '17:00'), localTimeSpec: { date: TOMORROW, time: '17:00', timezone: TZ } } },
  { name: 'no hour, the day only', fields: { localTimeSpec: { date: TOMORROW, time: null, timezone: TZ }, missingFields: ['time'], ambiguityFlags: ['vague_time'] } },
  { name: 'no time and no day at all', fields: { missingFields: ['time'] } },
  { name: '17:00 at full confidence', fields: { dueAt: at(TOMORROW, '17:00'), localTimeSpec: { date: TOMORROW, time: '17:00', timezone: TZ }, confidence: { overall: 1, type: 1, action: 1, time: 1, priority: 1 } } },
];

type AmPmItem = {
  resolvedDate?: string; resolvedTime: string | null; needsClarification: boolean;
  clarification?: { questionKey?: string; options: Array<{ optionId: string; value: { localDate?: string; localTime?: string } }> } | null;
};
/** The card and its question: the day, no hour, asked صبح or مسا about the 5 on that day. */
const amPmShown = (item: AmPmItem) => [
  item.resolvedDate ?? null, item.resolvedTime, item.needsClarification, item.clarification?.questionKey ?? null,
  (item.clarification?.options ?? []).map((option) => `${option.optionId} ${option.value.localDate} ${option.value.localTime}`),
];
const ASKED_TOMORROW = [TOMORROW, null, true, 'ask_am_pm', [`am ${TOMORROW} 05:00`, `pm ${TOMORROW} 17:00`]];

for (const variant of R6_BANK_VARIANTS) {
  test(`R6 D1 model path (SCRIPTED, ${variant.name}): «${R6_BANK}» is asked صبح or مسا, never settled`, async () => {
    const { contract } = await proposeModel(R6_BANK, bankModel(variant.fields));
    assert.equal(contract.provenance.executedEngine, 'gemini');
    assert.equal(contract.status, 'needs_clarification');
    assert.equal(contract.items.length, 1);
    assert.equal(contract.items[0]!.title, 'أروح عالبنك');
    assert.deepEqual(amPmShown(contract.items[0]!), ASKED_TOMORROW);
  });
}

test('R6 D1: the rules path asks the same question about the same sentence', async () => {
  setStorageForTests(createMemoryStorage());
  const proposal = await proposeMobileCapture({ text: R6_BANK, timezone: TZ, referenceTime: NOW.toISOString() }).finally(() => resetStorageForTests());
  assert.deepEqual(amPmShown(proposal.items[0]!), ASKED_TOMORROW);
});

for (const variant of [R6_BANK_VARIANTS[0]!, R6_BANK_VARIANTS[6]!]) test(`R6 D1 (SCRIPTED, ${variant.name}): answered «مسا», the model-path item is the bank tomorrow at 17:00, confirmed as a time to be at`, async () => {
  const { contract, store, persistence } = await proposeModel(R6_BANK, bankModel(variant.fields));
  const item = contract.items[0]!;
  const updated = await answerClarification(
    { proposalId: contract.proposalId, itemId: item.itemId, questionId: item.clarification!.questionId, optionId: 'pm' },
    { now: NOW, timezone: TZ, scopeId: 'n19' },
    { store, recordEvent: () => undefined },
  );
  assert.deepEqual([updated.items[0]!.resolvedTime, updated.items[0]!.needsClarification], [at(TOMORROW, '17:00'), false]);
  const confirmed = await confirmCapture(
    { proposalId: contract.proposalId, scopeId: 'n19', selectedItemIds: [item.itemId], idempotencyKey: 'k-r6-bank', now: NOW },
    { store, persistence },
  );
  assert.equal(confirmed.success, true, JSON.stringify(confirmed));
  const [saved] = Object.values((await persistence.snapshot()).commitments);
  assert.deepEqual([saved!.timeSpec.kind, saved!.timeSpec.dueAt], ['scheduled_event', at(TOMORROW, '17:00')]);
});

test('R6 D1 (SCRIPTED): English and Hebrew bare early hours are asked on the model path too', async () => {
  const rows: ReadonlyArray<readonly [string, string]> = [
    ['I have to go to the bank tomorrow at 5', 'go to the bank'],
    ['מחר ב-5 אני חייבת ללכת לבנק', 'ללכת לבנק'],
    ['بكرا الساعة 5:30 لازم أروح عالبنك', 'أروح عالبنك'],
  ];
  for (const [text, title] of rows) {
    const minutes = text.includes('5:30') ? '30' : '00';
    const { contract } = await proposeModel(text, bankModel({ dueAt: at(TOMORROW, `17:${minutes}`), localTimeSpec: { date: TOMORROW, time: `17:${minutes}`, timezone: TZ } }, title));
    assert.equal(contract.items.length, 1, text);
    assert.deepEqual(amPmShown(contract.items[0]!), [TOMORROW, null, true, 'ask_am_pm', [`am ${TOMORROW} 05:${minutes}`, `pm ${TOMORROW} 17:${minutes}`]], text);
  }
});

test('R6 D1 (SCRIPTED): in a two-clause capture the bank is asked and the other clause is untouched', async () => {
  const text = `${R6_BANK}، وبدي أشتري خبز`;
  const provider = async (prompt: string): Promise<string> => {
    const payload = payloadOf(prompt);
    const read = async (clause: string) => JSON.parse(await (clause.includes('البنك') || clause.includes('عالبنك')
      ? bankModel(R6_BANK_VARIANTS[0]!.fields)
      : bankModel({ localTimeSpec: null, missingFields: ['time'], priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureImplied: false } }, 'أشتري خبز'))(`BEGIN_UNTRUSTED_USER_MESSAGE\n${JSON.stringify(clause)}`)) as Record<string, unknown>;
    if (!Array.isArray(payload)) return JSON.stringify(await read(payload));
    return JSON.stringify({ items: await Promise.all(payload.map(async (clause, clauseIndex) => ({ ...(await read(clause)), clauseIndex }))) });
  };
  const { contract } = await proposeModel(text, provider);
  assert.equal(contract.provenance.executedEngine, 'gemini');
  const bank = contract.items.find((item) => item.title === 'أروح عالبنك')!;
  assert.deepEqual(amPmShown(bank), ASKED_TOMORROW);
  assert.ok(contract.items.some((item) => item.title === 'أشتري خبز'));
});

test('R6 D1 (SCRIPTED): a bare early hour today whose morning has gone is asked, the afternoon the only option — as on the rules path', async () => {
  const text = 'اليوم الساعة 5 لازم أروح عالبنك';
  const { contract } = await proposeModel(text, bankModel({ dueAt: at(TODAY, '17:00'), localTimeSpec: { date: TODAY, time: '17:00', timezone: TZ } }));
  assert.deepEqual(amPmShown(contract.items[0]!), [TODAY, null, true, 'ask_am_pm', [`pm ${TODAY} 17:00`]]);
  setStorageForTests(createMemoryStorage());
  const rules = await proposeMobileCapture({ text, timezone: TZ, referenceTime: NOW.toISOString() }).finally(() => resetStorageForTests());
  assert.deepEqual(amPmShown(rules.items[0]!), [TODAY, null, true, 'ask_am_pm', [`pm ${TODAY} 17:00`]]);
});

test('R6 D1 controls (SCRIPTED): a period word, a night hour, 12 in the evening, a bare 7–12 and a passed hour keep their own readings', async () => {
  const settled = async (text: string, date: string, time: string) => {
    const { contract } = await proposeModel(text, bankModel({ dueAt: at(date, time), localTimeSpec: { date, time, timezone: TZ } }));
    return [contract.items[0]!.resolvedTime, contract.items[0]!.needsClarification, contract.items[0]!.clarification?.questionKey ?? null];
  };
  // «5 المسا» / "5pm" / «5 בערב»: the half of the day is said.
  assert.deepEqual(await settled('بكرا الساعة 5 المسا لازم أروح عالبنك', TOMORROW, '17:00'), [at(TOMORROW, '17:00'), false, null]);
  assert.deepEqual(await settled('I have to go to the bank tomorrow at 5pm', TOMORROW, '17:00'), [at(TOMORROW, '17:00'), false, null]);
  assert.deepEqual(await settled('מחר ב-5 בערב אני חייבת ללכת לבנק', TOMORROW, '17:00'), [at(TOMORROW, '17:00'), false, null]);
  // «الساعة 2 بالليل»: the small hours, said (FZ1 N10).
  assert.deepEqual(await settled('بكرا الساعة 2 بالليل لازم أبعت الإيميل', TOMORROW, '02:00'), [at(TOMORROW, '02:00'), false, null]);
  // A bare 7–12 is the base behaviour: the model's reading of the number is kept.
  assert.deepEqual(await settled('بكرا الساعة 9 لازم أروح عالبنك', TOMORROW, '09:00'), [at(TOMORROW, '09:00'), false, null]);
  // «12 المسا»: noon to some, midnight to others — the hour is asked (POLISH M7).
  assert.deepEqual(await settled('بكرا الساعة 12 المسا لازم أروح عالبنك', TOMORROW, '12:00'), [null, true, 'ask_time']);
  // A passed hour that is not a bare early one: a new time is asked.
  assert.deepEqual(await settled('اليوم الساعة 9 لازم أروح عالبنك', TODAY, '09:00'), [null, true, 'ask_time']);
});

test('R6 D1 (SCRIPTED): two bare hours are not narrowed to a question about one of them, and neither is settled', async () => {
  const text = 'بكرا الساعة 5 أو الساعة 6 لازم أروح عالبنك';
  const { contract } = await proposeModel(text, bankModel(R6_BANK_VARIANTS[0]!.fields));
  const item = contract.items[0]!;
  assert.deepEqual([item.resolvedTime, item.needsClarification], [null, true]);
  assert.notEqual(item.clarification?.questionKey, 'ask_am_pm');
});

test('R6 D1 (SCRIPTED): the reading kept for the answer is one reading — its instant is the clock the question is about, and no hour is missing', async () => {
  for (const index of [0, 5, 6]) {
    const variant = R6_BANK_VARIANTS[index]!;
    const { contract, store } = await proposeModel(R6_BANK, bankModel(variant.fields));
    const kept = (await store.get(contract.proposalId))!.resultsByItemId!.get(contract.items[0]!.itemId)!;
    const stated = at(TOMORROW, '05:00');
    assert.deepEqual(
      [kept.localTimeSpec?.time, kept.remindAt ?? kept.dueAt, kept.remindAt ? kept.dueAt : null, kept.missingFields.includes('time')],
      ['05:00', stated, null, false],
      variant.name,
    );
  }
});

/* ── A clock number left in the title (closure UAT round 6, sibling lane) ── */

/*
 * «بكرا 5 المسا لازم أتصل بأمي» was titled «5 لازم أتصل بأمي» on the rules
 * path: `stripTiming` lifted the part of the day («المسا») before the clocks,
 * so the clock «5 المسا» — the reading the item's 17:00 came from — was a bare
 * «5» by the time the clock patterns looked for it, and stayed in the title
 * (and kept «لازم» there, since the obligation strip is anchored at the start).
 * «بكرا الساعة 5 المسا» was clean only because «الساعة» marks the 5 by itself.
 * The number goes with its time words; the day and the hour are unchanged.
 * A number the item did not take as its hour (a quantity, a bare «5» with no
 * marker) stays where the person put it.
 */
const R6_TITLE_HOURS: ReadonlyArray<{ text: string; title: string; date: string | null; time: string | null }> = [
  { text: 'بكرا 5 المسا لازم أتصل بأمي', title: 'أتصل بأمي', date: TOMORROW, time: '2026-09-29T14:00:00.000Z' },
  { text: 'بكرا الساعة 5 المسا لازم أتصل بأمي', title: 'أتصل بأمي', date: TOMORROW, time: '2026-09-29T14:00:00.000Z' },
  { text: '5 المسا بكرا بدي أتصل بأمي', title: 'أتصل بأمي', date: TOMORROW, time: '2026-09-29T14:00:00.000Z' },
  { text: 'لازم أتصل بأمي بكرا 5 المسا', title: 'أتصل بأمي', date: TOMORROW, time: '2026-09-29T14:00:00.000Z' },
  { text: 'بكرا ٥ المسا لازم أتصل بأمي', title: 'أتصل بأمي', date: TOMORROW, time: '2026-09-29T14:00:00.000Z' },
  { text: 'بكرا 5 الصبح لازم أتصل بأمي', title: 'أتصل بأمي', date: TOMORROW, time: '2026-09-29T02:00:00.000Z' },
  { text: 'اليوم 8 بالليل لازم أتصل بأمي', title: 'أتصل بأمي', date: TODAY, time: '2026-09-28T17:00:00.000Z' },
  { text: 'بكرا 5 م لازم أتصل بأمي', title: 'أتصل بأمي', date: TOMORROW, time: '2026-09-29T14:00:00.000Z' },
  { text: 'tomorrow 5pm call mom', title: 'call mom', date: TOMORROW, time: '2026-09-29T14:00:00.000Z' },
  { text: 'מחר ב-5 בערב להתקשר לאמא', title: 'להתקשר לאמא', date: TOMORROW, time: '2026-09-29T14:00:00.000Z' },
  { text: 'מחר 5 בערב להתקשר לאמא', title: 'להתקשר לאמא', date: TOMORROW, time: '2026-09-29T14:00:00.000Z' },
  { text: 'מחר ב5 בערב להתקשר לאמא', title: 'להתקשר לאמא', date: TOMORROW, time: '2026-09-29T14:00:00.000Z' },
  // A number that is not the hour keeps its place.
  { text: 'أكتب 3 نقاط للنقاش', title: 'أكتب 3 نقاط للنقاش', date: null, time: null },
  { text: 'اشتري 2 كيلو بندورة', title: 'اشتري 2 كيلو بندورة', date: null, time: null },
  { text: 'أكتب 3 نقاط للنقاش بكرا المسا', title: 'أكتب 3 نقاط للنقاش', date: TOMORROW, time: '2026-09-29T15:00:00.000Z' },
  { text: 'من الساعة 2 للساعة 4 المسا اجتماع', title: 'اجتماع', date: TODAY, time: '2026-09-28T11:00:00.000Z' },
];

test('R6 title hour: on the rules path a clock number leaves the title with its time words, the day and hour unchanged', async () => {
  const seen: unknown[] = [];
  for (const probe of R6_TITLE_HOURS) {
    setStorageForTests(createMemoryStorage());
    try {
      const proposal = await proposeMobileCapture({ text: probe.text, timezone: TZ, referenceTime: NOW.toISOString() });
      seen.push([probe.text, proposal.items.map((item) => [item.title, item.resolvedDate ?? null, item.resolvedTime])]);
    } finally {
      resetStorageForTests();
    }
  }
  assert.deepEqual(seen, R6_TITLE_HOURS.map((probe) => [probe.text, [[probe.title, probe.date, probe.time]]]));
});

test('R6 title hour: a bare «5» the item did not take as its hour stays in the title, and is asked as it was', async () => {
  setStorageForTests(createMemoryStorage());
  try {
    const proposal = await proposeMobileCapture({ text: 'بكرا 5 لازم أتصل بأمي', timezone: TZ, referenceTime: NOW.toISOString() });
    const item = proposal.items[0]!;
    assert.deepEqual([proposal.items.length, item.title, item.resolvedDate ?? null, item.resolvedTime], [1, '5 لازم أتصل بأمي', TOMORROW, null]);
  } finally {
    resetStorageForTests();
  }
});

test('R6 title hour (SCRIPTED): the model path keeps the model\'s clean title and its 17:00; with the model down the rules fallback is clean too', async () => {
  const text = 'بكرا 5 المسا لازم أتصل بأمي';
  const fields = { dueAt: at(TOMORROW, '17:00'), localTimeSpec: { date: TOMORROW, time: '17:00', timezone: TZ } };
  for (const title of ['أتصل بأمي', 'لازم أتصل بأمي']) {
    const { contract } = await proposeModel(text, bankModel(fields, title));
    assert.equal(contract.provenance.executedEngine, 'gemini');
    assert.deepEqual(contract.items.map((item) => [item.title, item.resolvedDate ?? null, item.resolvedTime]), [[title, TOMORROW, at(TOMORROW, '17:00')]]);
  }
  const { contract } = await proposeModel(text, async () => { throw new LLMUnavailableError('provider_error'); });
  assert.notEqual(contract.provenance.executedEngine, 'gemini');
  assert.deepEqual(contract.items.map((item) => [item.title, item.resolvedDate ?? null, item.resolvedTime]), [['أتصل بأمي', TOMORROW, at(TOMORROW, '17:00')]]);
});

test('R6 title hour: a capture that is only «بكرا 5 المسا» asks what to do, as «بكرا الساعة 5 المسا» and "tomorrow 5pm" do — not rejected over a title «5»', async () => {
  const seen: unknown[] = [];
  for (const text of ['بكرا 5 المسا', 'اليوم 8 بالليل', 'بكرا الساعة 5 المسا', 'tomorrow 5pm', 'מחר ב-5 בערב']) {
    setStorageForTests(createMemoryStorage());
    try {
      const proposal = await proposeMobileCapture({ text, timezone: TZ, referenceTime: NOW.toISOString() });
      seen.push([text, proposal.status, proposal.items.map((item) => [item.resolvedDate ?? null, item.clarification?.questionKey ?? null])]);
    } finally {
      resetStorageForTests();
    }
  }
  assert.deepEqual(seen, [
    ['بكرا 5 المسا', 'needs_clarification', [[TOMORROW, 'ask_action']]],
    ['اليوم 8 بالليل', 'needs_clarification', [[TODAY, 'ask_action']]],
    ['بكرا الساعة 5 المسا', 'needs_clarification', [[TOMORROW, 'ask_action']]],
    ['tomorrow 5pm', 'needs_clarification', [[TOMORROW, 'ask_action']]],
    ['מחר ב-5 בערב', 'needs_clarification', [[TOMORROW, 'ask_action']]],
  ]);
});

/* ── A stated hour replaced by the part of the day's hour (closure UAT round 6) ── */

/*
 * «بكرا 5 العصر لازم أتصل بأمي» was proposed at 14:00, "tomorrow 5 in the
 * evening" and «بكرا خمسة المسا» at 18:00: the rules read a number as the
 * hour only after «الساعة» or right before a meridiem they knew (مسا, صبح,
 * بالليل, pm…), never before العصر, الضهر, "in the evening", «אחר הצהריים»,
 * and never a spelled one, so the part of the day gave its own hour and the
 * number stayed in the title. On the model path nothing checked the model's
 * hour against the words: «بكرا 5 المسا» answered 18:00 was shown at 18:00,
 * unmarked. The rule the typed answers already follow (FZ1 M5a) now reads
 * the capture too, on both engines: the number right before the part of the
 * day is the hour, the part of the day picks its half, and a pair that names
 * no hour anybody can read («12 الصبح», «11 الضهر») is asked.
 */
const hourShown = (item: Item & { timeEstimated?: boolean }) => [
  item.title,
  item.resolvedTime ? new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(item.resolvedTime)) : null,
  item.timeEstimated === true,
  item.clarification?.questionKey ?? null,
];
const R6_STATED_HOURS: ReadonlyArray<readonly [string, string, string | null, boolean, string | null]> = [
  // [text, title, hour, marked «حزرنا الساعة», question]
  ['بكرا 5 العصر لازم أتصل بأمي', 'أتصل بأمي', '17:00', false, null],
  ['بكرا ٥ العصر لازم أتصل بأمي', 'أتصل بأمي', '17:00', false, null],
  ['بكرا خمسة العصر لازم أتصل بأمي', 'أتصل بأمي', '17:00', false, null],
  ['بكرا خمسة المسا لازم أتصل بأمي', 'أتصل بأمي', '17:00', false, null],
  ['بكرا الساعة خمسة المسا لازم أتصل بأمي', 'أتصل بأمي', '17:00', false, null],
  ['بكرا 5 بعد الضهر لازم أتصل بأمي', 'أتصل بأمي', '17:00', false, null],
  ['بكرا 5 عالمسا لازم أتصل بأمي', 'أتصل بأمي', '17:00', false, null],
  ['بكرا 5 بالمسا لازم أتصل بأمي', 'أتصل بأمي', '17:00', false, null],
  ['بكرا 2 الضهر لازم أتصل بأمي', 'أتصل بأمي', '14:00', false, null],
  ['بكرا وحدة الضهر لازم أتصل بأمي', 'أتصل بأمي', '13:00', false, null],
  ['بكرا اتناعش الضهر لازم أتصل بأمي', 'أتصل بأمي', '12:00', false, null],
  ['بكرا تمانية الصبح لازم أتصل بأمي', 'أتصل بأمي', '08:00', false, null],
  ['بكرا 5 الصبح بكير لازم أتصل بأمي', 'أتصل بأمي', '05:00', false, null],
  ['بكرا إحدعش الصبح لازم أتصل بأمي', 'أتصل بأمي', '11:00', false, null],
  ['بكرا الساعة إحدعش المسا لازم أتصل بأمي', 'أتصل بأمي', '23:00', false, null],
  // The spoken 11 and 12 after «الساعة», as said: read as «الساعة 11» is (the title kept «الساعة إحدعش»).
  ['بكرا الساعة إحدعش لازم أتصل بأمي', 'أتصل بأمي', '11:00', false, null],
  ['بكرا الساعة اتناعش لازم أتصل بأمي', 'أتصل بأمي', '12:00', false, null],
  ['بكرا الساعة اتنين لازم أتصل بأمي', 'أتصل بأمي', null, false, 'ask_am_pm'],
  ['بكرا عشرة المسا لازم أتصل بأمي', 'أتصل بأمي', '22:00', false, null],
  ['بكرا تلاتة بالليل لازم أتصل بأمي', 'أتصل بأمي', '03:00', false, null],
  ['بكرا 5:30 العصر لازم أتصل بأمي', 'أتصل بأمي', '17:30', false, null],
  ['بكرا خمسة ونص المسا لازم أتصل بأمي', 'أتصل بأمي', '17:30', false, null],
  ['tomorrow 5 in the evening call mom', 'call mom', '17:00', false, null],
  ['tomorrow 5 in the afternoon call mom', 'call mom', '17:00', false, null],
  ['tomorrow 8 in the morning call mom', 'call mom', '08:00', false, null],
  ['tomorrow 11 at night call mom', 'call mom', '23:00', false, null],
  ['מחר 5 אחר הצהריים להתקשר לאמא', 'להתקשר לאמא', '17:00', false, null],
  ['מחר 8 בבוקר להתקשר לאמא', 'להתקשר לאמא', '08:00', false, null],
  // The part of the day the number is said with, not another one in the sentence (was 21:00).
  ['بكرا 9 الصبح بدي أجهز للاجتماع اللي العصر', 'أجهز للاجتماع اللي', '09:00', false, null],
  // A pair that names no hour anybody can read is asked, never settled.
  ['بكرا 12 الصبح لازم أتصل بأمي', 'أتصل بأمي', null, false, 'ask_time'],
  ['tomorrow at 12 in the morning call mom', 'call mom', null, false, 'ask_time'],
  ['بكرا الساعة 11 الضهر لازم أتصل بأمي', 'أتصل بأمي', null, false, 'ask_time'],
  ['מחר 11 בצהריים להתקשר לאמא', 'להתקשר לאמא', null, false, 'ask_time'],
  ['بكرا 9 العصر لازم أتصل بأمي', 'أتصل بأمي', null, false, 'ask_time'],
  ['بكرا اتناعش المسا لازم أتصل بأمي', 'أتصل بأمي', null, false, 'ask_time'],
  // Unchanged.
  ['بكرا 5 المسا لازم أتصل بأمي', 'أتصل بأمي', '17:00', false, null],
  ['بكرا الساعة 5 العصر لازم أتصل بأمي', 'أتصل بأمي', '17:00', false, null],
  ['بكرا بالمسا لازم أتصل بأمي', 'أتصل بأمي', '18:00', true, null],
  ['بكرا الساعة 5 لازم أتصل بأمي', 'أتصل بأمي', null, false, 'ask_am_pm'],
  ['بكرا 5 لازم أتصل بأمي', '5 لازم أتصل بأمي', null, false, 'ask_time'],
  ['بكرا 2 بالليل لازم أتصل بأمي', 'أتصل بأمي', '02:00', false, null],
  ['بكرا 12 المسا لازم أتصل بأمي', 'أتصل بأمي', null, false, 'ask_time'],
  ['بكرا الصبح أكتب 3 نقاط للنقاش', 'أكتب 3 نقاط للنقاش', '09:00', true, null],
  ['بكرا المسا اشتري 2 كيلو بندورة', 'اشتري 2 كيلو بندورة', '18:00', true, null],
  ['بكرا المسا بدي أمشي ساعتين', 'أمشي ساعتين', '18:00', true, null],
  ['بكرا عندي 3 اجتماعات العصر', 'عندي 3 اجتماعات', '14:00', true, null],
  ['من الساعة 2 للساعة 4 المسا اجتماع', 'اجتماع', '14:00', false, null],
];

test('R6 stated hour: on the rules path the number before the part of the day is the hour, in the half that part names; its words leave the title', async () => {
  const seen: unknown[] = [];
  for (const [text] of R6_STATED_HOURS) {
    setStorageForTests(createMemoryStorage());
    try {
      const proposal = await proposeMobileCapture({ text, timezone: TZ, referenceTime: NOW.toISOString() });
      seen.push([text, ...proposal.items.map((item) => hourShown(item))]);
    } finally {
      resetStorageForTests();
    }
  }
  assert.deepEqual(seen, R6_STATED_HOURS.map(([text, ...shownRow]) => [text, shownRow]));
});

test('R6 stated hour: «اليوم 9 الصبح» at 10:05 is a passed hour and asked, as it was', async () => {
  setStorageForTests(createMemoryStorage());
  try {
    const proposal = await proposeMobileCapture({ text: 'اليوم 9 الصبح لازم أتصل بأمي', timezone: TZ, referenceTime: NOW.toISOString() });
    assert.deepEqual(proposal.items.map((item) => [item.resolvedDate, ...hourShown(item)]), [[TODAY, 'أتصل بأمي', null, false, 'ask_time']]);
  } finally {
    resetStorageForTests();
  }
});

const R6_STATED_MODEL: ReadonlyArray<readonly [string, string, string | null, string | null, boolean, string | null]> = [
  // [text, title, the model's hour, shown hour, marked, question]
  ['بكرا 5 المسا لازم أتصل بأمي', 'أتصل بأمي', '18:00', '17:00', false, null],
  ['بكرا الساعة 5 المسا لازم أتصل بأمي', 'أتصل بأمي', '18:00', '17:00', false, null],
  ['بكرا 5 العصر لازم أتصل بأمي', 'أتصل بأمي', '14:00', '17:00', false, null],
  ['بكرا الساعة 5 العصر لازم أتصل بأمي', 'أتصل بأمي', '05:00', '17:00', false, null],
  ['بكرا خمسة المسا لازم أتصل بأمي', 'أتصل بأمي', '18:00', '17:00', false, null],
  ['tomorrow 5 in the evening call mom', 'call mom', '18:00', '17:00', false, null],
  ['מחר 5 בערב להתקשר לאמא', 'להתקשר לאמא', '18:00', '17:00', false, null],
  ['بكرا 10 بالليل لازم أتصل بأمي', 'أتصل بأمي', '20:00', '22:00', false, null],
  ['بكرا 5 م لازم أتصل بأمي', 'أتصل بأمي', '18:00', '17:00', false, null],
  ['tomorrow 5am call mom', 'call mom', '17:00', '05:00', false, null],
  // The model's day with no hour: the words give it.
  ['بكرا 5 العصر لازم أتصل بأمي', 'أتصل بأمي', null, '17:00', false, null],
  // The model agreeing is left alone.
  ['بكرا 5 العصر لازم أتصل بأمي', 'أتصل بأمي', '17:00', '17:00', false, null],
  // No hour to read: the model's is dropped and the hour asked.
  ['بكرا 12 الصبح لازم أتصل بأمي', 'أتصل بأمي', '00:00', null, false, 'ask_time'],
  ['بكرا 11 الضهر لازم أتصل بأمي', 'أتصل بأمي', '12:00', null, false, 'ask_time'],
  // Unchanged: a range keeps the model's start; a part of the day alone is our marked guess.
  ['بكرا من 5 لـ 7 المسا اجتماع', 'اجتماع', '17:00', '17:00', false, null],
  ['بكرا بالمسا لازم أتصل بأمي', 'أتصل بأمي', '18:00', '18:00', true, null],
];

test('R6 stated hour (SCRIPTED): on the model path a model hour that contradicts the stated number and part of the day loses to the words', async () => {
  const seen: unknown[] = [];
  for (const [text, title, modelHour] of R6_STATED_MODEL) {
    const fields = modelHour
      ? { dueAt: at(TOMORROW, modelHour), localTimeSpec: { date: TOMORROW, time: modelHour, timezone: TZ } }
      : { localTimeSpec: { date: TOMORROW, time: null, timezone: TZ }, missingFields: ['time'] };
    const { contract } = await proposeModel(text, bankModel(fields, title));
    assert.equal(contract.provenance.executedEngine, 'gemini', text);
    seen.push([text, modelHour, ...contract.items.map((item) => hourShown(item))]);
  }
  assert.deepEqual(seen, R6_STATED_MODEL.map(([text, title, modelHour, hour, marked, question]) => [text, modelHour, [title, hour, marked, question]]));
});

test('R6 stated hour (SCRIPTED): another clock hour in the words is another reading — a model that took it is not overruled', async () => {
  // «ذكرني الساعة 4 … موعد 5 المسا»: the model's 16:00 is the reminder the person asked for at 4.
  const text = 'بكرا ذكرني الساعة 4 إنه عندي موعد 5 المسا';
  const { contract, store } = await proposeModel(text, bankModel({ remindAt: at(TOMORROW, '16:00'), localTimeSpec: { date: TOMORROW, time: '16:00', timezone: TZ } }, 'عندي موعد'));
  const kept = (await store.get(contract.proposalId))!.resultsByItemId!.get(contract.items[0]!.itemId)!;
  assert.deepEqual([kept.localTimeSpec?.time, kept.remindAt], ['16:00', at(TOMORROW, '16:00')]);
});

test('R6 stated hour: a typed answer reads the number and its part of the day as the capture does', async () => {
  const seen: unknown[] = [];
  for (const freeText of ['خمسة المسا', '5 العصر', 'tomorrow 5 in the evening', '11 الضهر', '9 العصر']) {
    setStorageForTests(createMemoryStorage());
    try {
      const proposal = await proposeMobileCapture({ text: 'بكرا لازم أبعت الإيميل للمدير', timezone: TZ, referenceTime: NOW.toISOString() }, { participantId: 'r6-stated' });
      const item = proposal.items[0]!;
      assert.equal(item.clarification?.questionKey, 'ask_time');
      try {
        const updated = await clarifyMobileCapture({
          proposalId: proposal.proposalId, itemId: item.itemId, questionId: item.clarification!.questionId, freeText,
          timezone: TZ, referenceTime: NOW.toISOString(),
        }, { participantId: 'r6-stated' });
        seen.push([freeText, updated.items[0]!.resolvedTime]);
      } catch (error) {
        seen.push([freeText, `refused: ${(error as { failure?: string }).failure ?? String(error)}`]);
      }
    } finally {
      resetStorageForTests();
    }
  }
  assert.deepEqual(seen, [
    ['خمسة المسا', at(TOMORROW, '17:00')],
    ['5 العصر', at(TOMORROW, '17:00')],
    ['tomorrow 5 in the evening', at(TOMORROW, '17:00')],
    // A number outside its part of the day names no hour: not understood, the buttons stay (was 23:00, 21:00).
    ['11 الضهر', 'refused: answer_not_understood'],
    ['9 العصر', 'refused: answer_not_understood'],
  ]);
});

// ── UAT round 6 batch 3: a part of today that has gone is never offered, and never moved ──

/*
 * «لازم أتصل بأمي اليوم المسا وبعدين أشتري خبز» at 23:29 and 23:31, Monday 28
 * Sep 2026, Asia/Hebron (shots 679–683, build e1871874, rules path). The
 * evening had gone, so the call was asked «أي ساعة يوم الاثنين، 28 سبتمبر؟» —
 * rightly (a passed hour is asked, CL1 rounds 1 and 3; FY1 N1) — but the
 * buttons under that question were «الصبح / العصر / المسا» valued on *Tuesday*:
 * each part that had gone today was quietly re-dated to tomorrow
 * (`clarificationBuilder`, step 4's `dayFor` fallback), and the typed
 * «المسا» took the same way (`dayForAnswer`). Tapping «المسا» gave «أتصل بأمي
 * · بكرا · 19:00», no note, no mark.
 *
 * Owner rule: never silently pick or move a date or time; a passed time is
 * asked, never refused and never moved; nothing in the past is persisted. So
 * a question about a named day offers only the parts of *that* day still
 * ahead, plus «بدون وقت محدد» (always offered, #474 — on a named day it keeps
 * the day, UAT round 2 N3) and the typed box, where a day the person types
 * («بكرا المسا», R2-M1) is theirs to choose. A part of that day that has gone,
 * typed or tapped late, is not understood and the buttons stay (FY1 I3: an
 * answered time already behind now is not an answer anyone can keep).
 *
 * An item with no day at all («أشتري خبز», «أي وقت بناسبك؟») is unchanged:
 * its parts land on the next day they are ahead (the builder's contract test
 * "the parts of today that have gone are not offered").
 */
const HEBRON = 'Asia/Hebron';
const R6B3_MOM = 'لازم أتصل بأمي اليوم المسا وبعدين أشتري خبز';
/** A local clock on Monday 28 Sep 2026 in Hebron, read from the zone. */
const hebron = (time: string, date = TODAY) => instantFromLocal(date, time, HEBRON)!;
const hebronIso = (date: string, time: string) => hebron(time, date).toISOString();

type AskedItem = Item & { itemId: string; needsClarification?: boolean; clarification?: { questionId: string; questionKey?: string; params?: { date?: string }; options: Array<{ optionId: string; value: { localDate?: string; localTime?: string } }> } | null };
/** What the question offers: each button with the day and hour it would save. */
const offered = (item: AskedItem) => (item.clarification?.options ?? []).map((option) => `${option.optionId} ${option.value.localDate ?? '-'} ${option.value.localTime ?? '-'}`);

/** A rules-path capture at `now`, and its first item's answer at `answeredAt` (default `now`). */
async function rulesAsked(
  text: string,
  now: Date,
  answer?: { optionId?: string; freeText?: string },
  answeredAt: Date = now,
): Promise<{ items: AskedItem[]; answered?: AskedItem | string }> {
  setStorageForTests(createMemoryStorage());
  try {
    const proposal = await proposeMobileCapture({ text, timezone: HEBRON, referenceTime: now.toISOString() }, { participantId: 'r6-passed' });
    const items = proposal.items as AskedItem[];
    if (!answer) return { items };
    const item = items[0]!;
    try {
      const updated = await clarifyMobileCapture({
        proposalId: proposal.proposalId, itemId: item.itemId, questionId: item.clarification!.questionId, ...answer,
        timezone: HEBRON, referenceTime: answeredAt.toISOString(),
      }, { participantId: 'r6-passed' });
      return { items, answered: (updated.items as AskedItem[]).find((candidate) => candidate.itemId === item.itemId)! };
    } catch (error) {
      return { items, answered: `refused: ${(error as { failure?: string }).failure ?? String(error)}` };
    }
  } finally {
    resetStorageForTests();
  }
}

const cardOf = (answered: AskedItem | string | undefined) => (typeof answered === 'string' || !answered
  ? answered
  : [answered.resolvedDate ?? null, answered.resolvedTime, answered.needsClarification ?? null]);

test('R6 passed part (UAT literal, 23:29): the call is asked on today with only «بدون وقت محدد» — no passed part, nothing on tomorrow', async () => {
  const { items } = await rulesAsked(R6B3_MOM, hebron('23:29'));
  const mom = items.find((item) => item.title === 'أتصل بأمي')!;
  assert.deepEqual(shown(mom), [TODAY, null, 'ask_time', TODAY]);
  assert.deepEqual(offered(mom), ['none - -']);
  // The bread has no day: its parts are on the next day they are ahead, as before.
  const bread = items.find((item) => item.title === 'أشتري خبز')!;
  assert.deepEqual(shown(bread), [null, null, 'ask_time', null]);
  assert.deepEqual(offered(bread), [`morning ${TOMORROW} 09:00`, `afternoon ${TOMORROW} 14:00`, `evening ${TOMORROW} 19:00`, 'none - -']);
});

test('R6 passed part (23:29): every way of saying the passed evening is refused, the buttons kept; a day the person types is theirs', async () => {
  const seen: unknown[] = [];
  const answers: Array<{ optionId?: string; freeText?: string }> = [
    // An old client's «المسا» (the button this question no longer has).
    { optionId: 'evening' },
    { freeText: 'المسا' }, { freeText: 'بالمسا' }, { freeText: 'الليلة' }, { freeText: 'اليوم المسا' }, { freeText: 'الصبح' },
    // Chosen, not picked for them: tomorrow typed is tomorrow.
    { freeText: 'بكرا المسا' },
    { optionId: 'none' },
  ];
  for (const answer of answers) {
    const { answered } = await rulesAsked(R6B3_MOM, hebron('23:29'), answer);
    seen.push([answer.optionId ?? answer.freeText, cardOf(answered)]);
  }
  assert.deepEqual(seen, [
    ['evening', 'refused: option_not_found'],
    ['المسا', 'refused: answer_not_understood'],
    ['بالمسا', 'refused: answer_not_understood'],
    ['الليلة', 'refused: answer_not_understood'],
    ['اليوم المسا', 'refused: answer_not_understood'],
    ['الصبح', 'refused: answer_not_understood'],
    ['بكرا المسا', [TOMORROW, hebronIso(TOMORROW, '19:00'), false]],
    // That day, no hour: today all day (UAT round 2, N3), never tomorrow.
    ['none', [TODAY, null, false]],
  ]);
});

test('R6 passed part ("tonight"/«الليلة»/«הערב», 23:29): asked on today with only «بدون وقت محدد»; the same word typed back is refused', async () => {
  const rows: ReadonlyArray<readonly [string, string]> = [
    ['لازم أتصل بأمي الليلة', 'الليلة'],
    ['لازم أتصل بأمي اليوم', 'المسا'],
    ['call mom tonight', 'tonight'],
    ['call mom this evening', 'in the evening'],
    ['להתקשר לאמא הערב', 'הערב'],
    ['להתקשר לאמא היום', 'בערב'],
  ];
  const seen: unknown[] = [];
  for (const [text, typed] of rows) {
    const { items, answered } = await rulesAsked(text, hebron('23:29'), { freeText: typed });
    seen.push([text, shown(items[0]!), offered(items[0]!), cardOf(answered)]);
  }
  assert.deepEqual(seen, rows.map(([text]) => [text, [TODAY, null, 'ask_time', TODAY], ['none - -'], 'refused: answer_not_understood']));
});

test('R6 passed part (15:00, 12:00, 06:00): a question about today offers only the parts of today still ahead, all on today', async () => {
  const text = 'لازم أتصل بأمي اليوم وبعدين أشتري خبز';
  const seen: unknown[] = [];
  for (const clock of ['15:00', '12:00', '06:00']) {
    const { items } = await rulesAsked(text, hebron(clock));
    seen.push([clock, shown(items[0]!), offered(items[0]!)]);
  }
  assert.deepEqual(seen, [
    ['15:00', [TODAY, null, 'ask_time', TODAY], [`evening ${TODAY} 19:00`, 'none - -']],
    ['12:00', [TODAY, null, 'ask_time', TODAY], [`afternoon ${TODAY} 14:00`, `evening ${TODAY} 19:00`, 'none - -']],
    ['06:00', [TODAY, null, 'ask_time', TODAY], [`morning ${TODAY} 09:00`, `afternoon ${TODAY} 14:00`, `evening ${TODAY} 19:00`, 'none - -']],
  ]);
});

test('R6 passed part (15:00): the evening still ahead is tonight; a part that has gone, typed, is refused — never tomorrow', async () => {
  const text = 'لازم أتصل بأمي اليوم وبعدين أشتري خبز';
  const seen: unknown[] = [];
  for (const answer of [{ optionId: 'evening' }, { freeText: 'المسا' }, { freeText: 'الصبح' }, { freeText: 'العصر' }, { freeText: 'بكرا الصبح' }]) {
    const { answered } = await rulesAsked(text, hebron('15:00'), answer);
    seen.push([answer.optionId ?? answer.freeText, cardOf(answered)]);
  }
  assert.deepEqual(seen, [
    ['evening', [TODAY, hebronIso(TODAY, '19:00'), false]],
    ['المسا', [TODAY, hebronIso(TODAY, '19:00'), false]],
    ['الصبح', 'refused: answer_not_understood'],
    ['العصر', 'refused: answer_not_understood'],
    ['بكرا الصبح', [TOMORROW, hebronIso(TOMORROW, '09:00'), false]],
  ]);
});

test('R6 passed part controls (15:00, 06:00): «اليوم المسا» still ahead is proposed tonight as before, nothing asked', async () => {
  for (const clock of ['15:00', '06:00']) {
    const { items } = await rulesAsked(R6B3_MOM, hebron(clock));
    const mom = items.find((item) => item.title === 'أتصل بأمي')!;
    assert.deepEqual(shown(mom), [TODAY, hebronIso(TODAY, '18:00'), null, null], clock);
  }
});

test('R6 passed part (race across the hour): a button tapped after its hour went is refused, the round kept — never rolled to tomorrow', async () => {
  // Asked at 18:59 with tonight's 19:00 on offer; tapped at 19:01.
  const late = await rulesAsked('لازم أتصل بأمي اليوم', hebron('18:59'), { optionId: 'evening' }, hebron('19:01'));
  assert.deepEqual(offered(late.items[0]!), [`evening ${TODAY} 19:00`, 'none - -']);
  assert.equal(late.answered, 'refused: answer_not_understood');
  // The am/pm chips for today: «5 المسا» offered at 16:59, tapped at 17:01.
  const amPm = await rulesAsked('اليوم الساعة 5 لازم أروح عالبنك', hebron('16:59'), { optionId: 'pm' }, hebron('17:01'));
  assert.deepEqual(offered(amPm.items[0]!), [`pm ${TODAY} 17:00`]);
  assert.equal(amPm.answered, 'refused: answer_not_understood');
});

test('R6 passed part (race): the refused tap does not spend the round — «بدون وقت محدد» still answers it', async () => {
  setStorageForTests(createMemoryStorage());
  try {
    const proposal = await proposeMobileCapture({ text: 'لازم أتصل بأمي اليوم', timezone: HEBRON, referenceTime: hebron('18:59').toISOString() }, { participantId: 'r6-race' });
    const item = proposal.items[0]!;
    const ask = (optionId: string) => clarifyMobileCapture({
      proposalId: proposal.proposalId, itemId: item.itemId, questionId: item.clarification!.questionId, optionId,
      timezone: HEBRON, referenceTime: hebron('19:01').toISOString(),
    }, { participantId: 'r6-race' });
    await assert.rejects(ask('evening'), (error: { failure?: string }) => error.failure === 'answer_not_understood');
    const updated = await ask('none');
    assert.deepEqual(cardOf(updated.items[0] as AskedItem), [TODAY, null, false]);
  } finally {
    resetStorageForTests();
  }
});

test('R6 passed part (23:29): the today am/pm chips are never offered once both halves have gone', async () => {
  const { items } = await rulesAsked('اليوم الساعة 5 لازم أروح عالبنك', hebron('23:29'));
  for (const option of items[0]!.clarification?.options ?? []) {
    if (!option.value.localTime) continue;
    assert.equal(option.value.localDate, TODAY, JSON.stringify(option));
    assert.ok(hebron(option.value.localTime).getTime() > hebron('23:29').getTime(), JSON.stringify(option));
  }
});

/** The mom clause read by a scripted model at `now`, and its first item answered through the same model. */
async function modelAsked(
  text: string,
  now: Date,
  capture: Record<string, unknown>,
  reread: Record<string, unknown>,
  answer: { optionId?: string; freeText?: string },
) {
  // The capture's own clause, then the clarify re-read (the sentence and the answer on two lines).
  const provider = async (prompt: string): Promise<string> => {
    const payload = payloadOf(prompt);
    const fields = typeof payload === 'string' && payload.includes('\n') ? reread : capture;
    return bankModel(fields, 'أتصل بأمي')(prompt);
  };
  const store = new MemoryCaptureProposalStore();
  const persistence = new TransactionalCapturePersistenceAdapter(createEmptyDomainState());
  const contract = await proposeCapture(
    text,
    { now, timezone: HEBRON, scopeId: 'r6-passed-model', requestedEngine: 'model' },
    { store, persistence, extractor: guardedMobileExtract, llmProvider: provider, llmEngine: 'gemini' },
  );
  const item = contract.items[0] as AskedItem;
  let answered: AskedItem | string;
  try {
    const updated = await answerClarification(
      { proposalId: contract.proposalId, itemId: item.itemId, questionId: item.clarification!.questionId, ...answer },
      { now, timezone: HEBRON, scopeId: 'r6-passed-model' },
      { store, extractor: guardedMobileExtract, llmProvider: provider, llmEngine: 'gemini', recordEvent: () => undefined },
    );
    answered = updated.items[0] as AskedItem;
  } catch (error) {
    answered = `refused: ${(error as { failure?: string }).failure ?? String(error)}`;
  }
  return { contract, item, answered, store, persistence };
}

const MODEL_TONIGHT = { dueAt: hebronIso(TODAY, '18:00'), localTimeSpec: { date: TODAY, time: '18:00', timezone: HEBRON } };
const MODEL_TOMORROW_EVENING = { dueAt: hebronIso(TOMORROW, '18:00'), localTimeSpec: { date: TOMORROW, time: '18:00', timezone: HEBRON } };

test('R6 passed part model path (SCRIPTED, the model\'s passed 18:00 today): asked on today with only «بدون وقت محدد», as on the rules path', async () => {
  for (const capture of [MODEL_TONIGHT, { localTimeSpec: { date: TODAY, time: null, timezone: HEBRON }, missingFields: ['time'], ambiguityFlags: ['vague_time'] }]) {
    const { contract, item } = await modelAsked('لازم أتصل بأمي اليوم المسا', hebron('23:29'), capture, MODEL_TONIGHT, { optionId: 'none' });
    assert.equal(contract.provenance.executedEngine, 'gemini');
    assert.deepEqual(shown(item), [TODAY, null, 'ask_time', TODAY], JSON.stringify(capture));
    assert.deepEqual(offered(item), ['none - -'], JSON.stringify(capture));
  }
});

test('R6 passed part model path (SCRIPTED): a re-read that puts the typed «المسا» on tomorrow is not taken — refused, the buttons kept', async () => {
  const seen: unknown[] = [];
  for (const [name, reread] of [['re-read tonight (passed)', MODEL_TONIGHT], ['re-read rolled to tomorrow', MODEL_TOMORROW_EVENING]] as const) {
    for (const freeText of ['المسا', 'الليلة']) {
      const { answered } = await modelAsked('لازم أتصل بأمي اليوم المسا', hebron('23:29'), MODEL_TONIGHT, reread, { freeText });
      seen.push([name, freeText, cardOf(answered)]);
    }
  }
  assert.deepEqual(seen, [
    ['re-read tonight (passed)', 'المسا', 'refused: answer_not_understood'],
    ['re-read tonight (passed)', 'الليلة', 'refused: answer_not_understood'],
    ['re-read rolled to tomorrow', 'المسا', 'refused: answer_not_understood'],
    ['re-read rolled to tomorrow', 'الليلة', 'refused: answer_not_understood'],
  ]);
});

test('R6 passed part model path (SCRIPTED): «بكرا المسا» typed is tomorrow; «بدون وقت محدد» is saved as today, all day — nothing past, nothing moved', async () => {
  const typed = await modelAsked('لازم أتصل بأمي اليوم المسا', hebron('23:29'), MODEL_TONIGHT, MODEL_TOMORROW_EVENING, { freeText: 'بكرا المسا' });
  assert.deepEqual(cardOf(typed.answered), [TOMORROW, hebronIso(TOMORROW, '19:00'), false]);

  const none = await modelAsked('لازم أتصل بأمي اليوم المسا', hebron('23:29'), MODEL_TONIGHT, MODEL_TONIGHT, { optionId: 'none' });
  assert.deepEqual(cardOf(none.answered), [TODAY, null, false]);
  const confirmed = await confirmCapture(
    { proposalId: none.contract.proposalId, scopeId: 'r6-passed-model', selectedItemIds: [none.item.itemId], idempotencyKey: 'k-r6-passed', now: hebron('23:29') },
    { store: none.store, persistence: none.persistence },
  );
  assert.equal(confirmed.success, true, JSON.stringify(confirmed));
  const [saved] = Object.values((await none.persistence.snapshot()).commitments);
  assert.deepEqual([saved!.timeSpec.allDay, saved!.timeSpec.dueAt], [true, hebronIso(TODAY, '00:00')]);
});

test('R6 passed part model path (SCRIPTED, the model\'s own «today»): a typed hour alone re-read onto tomorrow is refused; one still ahead today is taken', async () => {
  // No «اليوم» in the words: the day is the model's, so the words cannot pull
  // a rolled re-read back. The question is about Monday; Tuesday is not an answer to it.
  const seen: unknown[] = [];
  for (const text of ['لازم أتصل بأمي المسا', 'call mom in the evening']) {
    for (const freeText of ['المسا', 'الساعة 8 المسا', 'at 8pm']) {
      const reread = freeText === 'المسا' ? MODEL_TOMORROW_EVENING : { dueAt: hebronIso(TOMORROW, '20:00'), localTimeSpec: { date: TOMORROW, time: '20:00', timezone: HEBRON } };
      const { item, answered } = await modelAsked(text, hebron('23:29'), MODEL_TONIGHT, reread, { freeText });
      seen.push([text, freeText, offered(item), cardOf(answered)]);
    }
  }
  assert.deepEqual(seen, ['لازم أتصل بأمي المسا', 'call mom in the evening'].flatMap((text) => ['المسا', 'الساعة 8 المسا', 'at 8pm']
    .map((freeText) => [text, freeText, ['none - -'], 'refused: answer_not_understood'])));
  // Control: at 15:00 the same typed hour on the asked day is kept there.
  const ahead = await modelAsked('لازم أتصل بأمي', hebron('15:00'), { localTimeSpec: { date: TODAY, time: null, timezone: HEBRON }, missingFields: ['time'], ambiguityFlags: ['vague_time'] },
    { dueAt: hebronIso(TODAY, '20:00'), localTimeSpec: { date: TODAY, time: '20:00', timezone: HEBRON } }, { freeText: 'الساعة 8 المسا' });
  assert.deepEqual(cardOf(ahead.answered), [TODAY, hebronIso(TODAY, '20:00'), false]);
});

/* ── Round 6, batch 4: the model's hour for «المسا» (build e1871874) ── */

/*
 * «لازم أتصل بأمي بكرا المسا» ×3 on Gemini (shots 772–774) was «بكرا ·
 * 21:00» twice and «بكرا · 18:00» once, «حزرنا الساعة» every time. Through
 * the route's own path: whatever hour the model gives for a part of the day
 * with no number, the phone gets the rules path's 18:00 on the model's day,
 * still marked as our guess.
 */
test('R6 batch 4 route (SCRIPTED Gemini 21:00, 19:30, no hour): «لازم أتصل بأمي بكرا المسا» reaches the phone as tomorrow 18:00, marked — as without consent', async () => {
  const text = 'لازم أتصل بأمي بكرا المسا';
  const evening = new Date(`${TOMORROW}T18:00:00+03:00`).toISOString();
  const cardOfRoute = (proposal: { items: Item[] }) => proposal.items.map((item) => [
    item.resolvedDate ?? null, item.resolvedTime, (item as { needsClarification?: boolean }).needsClarification, (item as { timeEstimated?: boolean }).timeEstimated,
  ]);
  const rules = await proposeThroughRoute(text, null);
  assert.deepEqual(cardOfRoute(rules.proposal), [[TOMORROW, evening, false, true]]);
  for (const time of ['21:00', '19:30', null]) {
    const answer = {
      ...callAnswer('أتصل بأمي', time ? [] : ['vague_time']),
      ...(time ? { dueAt: new Date(`${TOMORROW}T${time}:00+03:00`).toISOString(), missingFields: [] } : {}),
      localTimeSpec: { date: TOMORROW, time, timezone: TZ },
    };
    const { proposal, calls } = await proposeThroughRoute(text, answer);
    assert.equal(calls, 1, String(time));
    assert.equal(proposal.provenance.executedEngine, 'gemini', String(time));
    assert.deepEqual(cardOfRoute(proposal), cardOfRoute(rules.proposal), `Gemini answered ${time}`);
  }
});
