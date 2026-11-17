/**
 * Capture lists the QA audit at de7fcb84 found lost or merged (fix lane B3).
 * Every capture here is read on the rules path, which is what the chat and
 * `POST /capture` fall to when the model is capped or fails (CA3.1) — and the
 * clause split is the same one the model path reads, so a list the splitter
 * keeps whole reaches the model as one clause and comes back as one item
 * (NAPI-A8.1, NA3.4, NA3.2).
 *
 *   NAPI-A8.2  one clause that lost its hour — passed, or two clauses at the
 *              same hour — sent every item of a list back to be asked, with
 *              no question for any but the first.
 *   NAPI-A8.1  a colon or comma list of errands was one clause.
 *   NA3.4      errands joined by «و» / "and" / «ו» were one clause.
 *   CA3.1      «، وروح عالبنك…», ", and go to the bank…": the «و» stayed in
 *              the title, the bank fell on another day than the sentence
 *              named, and without the «،» the two were one untimed item.
 *   NA3.2      a sentence that opens with its day and hour («بكرا الساعة 3
 *              العصر لازم…») was glued to the sentence before it.
 *
 * Synthetic text only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyDomainState } from '../../src/domain/stateMachine.ts';
import { MemoryCaptureProposalStore, proposeCapture } from '../../lib/services/captureBoundary/index.ts';
import { splitCaptureClauses } from '../../src/extraction/clauseSplitter.ts';
import { localTimeSpecFor } from '../../src/extraction/timeLexicon.ts';

const TZ = 'Asia/Jerusalem';
/** Thursday 12 November 2026, 08:00 in Jerusalem. */
const NOW = new Date('2026-11-12T06:00:00.000Z');
const TODAY = '2026-11-12';
const TOMORROW = '2026-11-13';
const SUNDAY = '2026-11-15';

async function rules(text: string) {
  return proposeCapture(
    text,
    { now: NOW, timezone: TZ, scopeId: 'b3-capture-lists', requestedEngine: 'rules' },
    {
      store: new MemoryCaptureProposalStore(),
      persistence: { snapshot: async () => createEmptyDomainState(), persistAtomically: async () => ({ state: createEmptyDomainState() }) },
    } as never,
  );
}

const when = (iso: string | null | undefined) => {
  if (!iso) return null;
  const local = localTimeSpecFor(new Date(iso), TZ)!;
  return `${local.date} ${local.time}`;
};

/* ── NAPI-A8.2: one lost hour does not take the list's other hours ── */

test('NAPI-A8.2: a passed hour in a newline list is asked about alone; the other lines keep theirs', async () => {
  const proposal = await rules('take vitamins at 7am\ncall the bank at 10am\nbuy bread at 12pm');
  assert.equal(proposal.items.length, 3);
  const [vitamins, bank, bread] = proposal.items;
  assert.equal(vitamins!.resolvedTime, null);
  assert.equal(vitamins!.needsClarification, true);
  assert.ok(vitamins!.clarification, 'the passed hour has a question to ask it with');
  assert.equal(when(bank!.resolvedTime), `${TODAY} 10:00`);
  assert.equal(when(bread!.resolvedTime), `${TODAY} 12:00`);
  assert.equal(bank!.needsClarification, false);
  assert.equal(bread!.needsClarification, false);
});

test('NAPI-A8.2: two lines at the same hour are two times accounted for, not one lost', async () => {
  const proposal = await rules('call mom tomorrow at 5pm\npay the bill tomorrow at 5pm');
  assert.deepEqual(proposal.items.map((item) => when(item.resolvedTime)), [`${TOMORROW} 17:00`, `${TOMORROW} 17:00`]);
  assert.ok(proposal.items.every((item) => !item.needsClarification));
});

test('NAPI-A8.2: a clause that names two hours and yields one item is still asked, with a question', async () => {
  const proposal = await rules('buy milk tomorrow at 5pm and at 7pm\ncall the bank tomorrow at 10am');
  const milk = proposal.items.find((item) => /milk/i.test(item.title))!;
  const bank = proposal.items.find((item) => /bank/i.test(item.title))!;
  assert.equal(milk.needsClarification, true);
  assert.ok(milk.clarification, 'an item the valve clears carries a question');
  assert.equal(when(bank.resolvedTime), `${TOMORROW} 10:00`);
});

/* ── NAPI-A8.1: a colon or comma list of errands is one item each ──── */

for (const [label, text, words] of [
  ['en colon', 'Today I need to: buy milk, call the bank, email Sami, pay the rent', ['milk', 'bank', 'Sami', 'rent']],
  ['en comma', 'buy milk, call the bank, email Sami', ['milk', 'bank', 'Sami']],
  ['en comma + and', 'Call mom, pay the electricity bill, book a haircut and buy a birthday gift for Lina', ['mom', 'electricity', 'haircut', 'gift']],
  ['he colon', 'היום אני צריך: לקנות חלב, להתקשר לבנק, לשלם שכר דירה', ['חלב', 'בנק', 'שכר']],
  ['ar latin comma', 'بكرا لازم: أشتري خبز, أتصل بالبنك, أرتب الخزانة', ['خبز', 'بنك', 'الخزانة']],
  ['en list head', 'Things for tomorrow: call the plumber, buy bread, send the report', ['plumber', 'bread', 'report']],
] as const) {
  test(`NAPI-A8.1 (${label}): every errand of the list is its own item`, async () => {
    const proposal = await rules(text);
    assert.equal(proposal.items.length, words.length, JSON.stringify(proposal.items.map((item) => item.title)));
    words.forEach((word, index) => assert.ok(proposal.items[index]!.title.includes(word), `${index}: ${word}`));
  });
}

/* ── NA3.4: errands joined by «و» / "and" / «ו» ─────────────────────── */

for (const [label, text, words] of [
  ['ar «و»', 'لازم اليوم أتصل بالبنك وأدفع فاتورة الكهربا وأرتب الخزانة', ['بنك', 'فاتورة', 'الخزانة']],
  ['ar «بدي»', 'بدي أشتري خبز وأغسل السيارة وأتصل بسامي', ['خبز', 'السيارة', 'سامي']],
  ['en "and"', 'I need to call the bank and pay the water bill and email Dana', ['bank', 'water', 'Dana']],
  ['he «ו»', 'אני צריך להתקשר לבנק ולשלם את החשבון', ['בנק', 'חשבון']],
  ['he «וללכת»', 'אני צריך להתקשר לאמא וללכת לבנק', ['אמא', 'בנק']],
] as const) {
  test(`NA3.4 (${label}): each joined errand is its own item, with no joiner at its head`, async () => {
    const proposal = await rules(text);
    assert.equal(proposal.items.length, words.length, JSON.stringify(proposal.items.map((item) => item.title)));
    words.forEach((word, index) => assert.ok(proposal.items[index]!.title.includes(word), `${index}: ${word}`));
    for (const item of proposal.items) assert.doesNotMatch(item.title, /^(?:و|and\s)/i, item.title);
  });
}

/* ── CA3.1: «، وروح…», ", and go…", «… وروح…» with their own hours ─── */

for (const [label, text] of [
  ['a: «، و»', 'اتصل بماما بكرا الساعة 5 المسا، وروح عالبنك الساعة 10 الصبح'],
  ['b: ", and"', 'tomorrow at 5pm call mom, and go to the bank at 10am'],
  ['c: «و» alone', 'بكرا الساعة 5 المسا اتصل بماما وروح عالبنك الساعة 10 الصبح'],
] as const) {
  test(`CA3.1 (${label}): two items, both tomorrow, each at its own hour, no «و» in a title`, async () => {
    const proposal = await rules(text);
    assert.deepEqual(proposal.items.map((item) => when(item.resolvedTime)), [`${TOMORROW} 17:00`, `${TOMORROW} 10:00`],
      JSON.stringify(proposal.items.map((item) => item.title)));
    assert.ok(proposal.items.every((item) => !item.needsClarification));
    for (const item of proposal.items) assert.doesNotMatch(item.title, /^(?:و|and\s)/i, item.title);
  });
}

test('CA3.1: «، ويوم الأحد…» keeps neither the «و» nor a stray «يوم» in the second title', async () => {
  const proposal = await rules('بكرا الساعة 4 العصر لازم أجيب الدوا من الصيدلية، ويوم الأحد الساعة 11 الصبح اجتماع مع المدرّس');
  assert.deepEqual(proposal.items.map((item) => when(item.resolvedTime)), [`${TOMORROW} 16:00`, `${SUNDAY} 11:00`]);
  const meeting = proposal.items[1]!.title;
  assert.doesNotMatch(meeting, /^\u0648/, meeting);
  assert.doesNotMatch(meeting, /(?:^|\s)\u0648?\u064A\u0648\u0645(?:\s|$)/, meeting);
});

test('CA3.1: a day the second conjunct names itself is its own, never the first one\'s', async () => {
  const proposal = await rules('tomorrow at 5pm call mom, and on Sunday go to the bank at 10am');
  assert.deepEqual(proposal.items.map((item) => when(item.resolvedTime)), [`${TOMORROW} 17:00`, `${SUNDAY} 10:00`]);
});

/* ── NA3.2: a sentence that opens with its day and hour ────────────── */

test('NA3.2: «… . بكرا الساعة 3 العصر لازم أشتري خبز» is a second item', async () => {
  const proposal = await rules('لازم أتصل بالدكتور. بكرا الساعة 3 العصر لازم أشتري خبز.');
  assert.equal(proposal.items.length, 2, JSON.stringify(proposal.items.map((item) => item.title)));
  assert.ok(proposal.items[0]!.title.includes('الدكتور'));
  assert.ok(proposal.items[1]!.title.includes('خبز'));
  assert.equal(when(proposal.items[1]!.resolvedTime), `${TOMORROW} 15:00`);
});

test('NA3.2: «… . يوم الأحد الساعة 11 الصبح عندي اجتماع…» is a second item on Sunday', async () => {
  const proposal = await rules('بكرا الساعة 4 العصر لازم أجيب الدوا من الصيدلية. يوم الأحد الساعة 11 الصبح عندي اجتماع مع المدرّس.');
  assert.deepEqual(proposal.items.map((item) => when(item.resolvedTime)), [`${TOMORROW} 16:00`, `${SUNDAY} 11:00`]);
});

test('NA3.2: an English sentence opening with its day and hour is a second item', async () => {
  const proposal = await rules('I need to renew my passport. Tomorrow at 3pm I have to pick up the car from the garage.');
  assert.equal(proposal.items.length, 2, JSON.stringify(proposal.items.map((item) => item.title)));
  assert.equal(when(proposal.items[1]!.resolvedTime), `${TOMORROW} 15:00`);
});

/* ── What stays one item ────────────────────────────────────────────── */

for (const text of [
  'coffee with Sam and Dana tomorrow at 5pm',
  'buy bread, milk and eggs tomorrow',
  'لازم أشتري خبز وحليب وبيض',
  'Email Sami, the new manager, about the budget',
  'Pick up Dana, Lior and Noam from school at 4pm',
  'Call mom and dad tomorrow at 6pm',
  'بدي أحكي مع أحمد وسامي بكرا الساعة 6 المسا',
  'קפה עם דני ורוני מחר ב-17:00',
  'Interview on Tuesday and call at 3pm',
  'عندي موعد دكتور بكرا. الساعة 5 المسا',
  'Meeting with Sam on Sunday. I\'ll be there at 10',
  'Dentist on Sunday. Remind me tomorrow.',
]) {
  test(`one commitment stays one clause: «${text}»`, () => {
    assert.equal(splitCaptureClauses(text).length, 1, JSON.stringify(splitCaptureClauses(text)));
  });
}

/* ── NAPI-A8.2 on the model path: a wall clock with no instant ──────── */

/**
 * Gemini answers a timed clause with `localTimeSpec: {date, time}` and,
 * about half the time, `dueAt: null, remindAt: null` (eval run, lane B3).
 * The reconciler only corrected an instant the model gave, so such an item
 * had an hour on its spec and no time to show: needs-clarification, and no
 * question (the reading still had its hour). Every line of a timed list could
 * go that way at once.
 */
const modelTask = (title: string, date: string, time: string) => ({
  kind: 'commitment', type: 'task', action: title, title, person: null, dueAt: null, remindAt: null,
  localTimeSpec: { date, time, timezone: TZ },
  priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureImplied: false },
  flexibility: 'movable', category: null, categoryConfidence: 0, itemKind: 'task', itemKindConfidence: 1,
  confidence: { overall: 0.8, type: 1, action: 0.8, time: 0.8, priority: 1 },
  missingFields: [], ambiguityFlags: [], explicitReminderRequest: false, explicitPressureRequest: false,
});

test('NAPI-A8.2 (model path): a list whose model objects carry only a wall clock keeps every stated hour', async () => {
  const lines: Array<[string, string, string]> = [
    ['להתקשר לבנק ב-10:00', 'להתקשר לבנק', '10:00'],
    ['לקנות לחם ב-12:00', 'לקנות לחם', '12:00'],
    ['לאסוף את הילדים ב-16:00', 'לאסוף את הילדים', '16:00'],
    ['להתקשר לאמא ב-20:00', 'להתקשר לאמא', '20:00'],
  ];
  const answers = new Map(lines.map(([clause, title, time]) => [clause, modelTask(title, TODAY, time)]));
  const provider = async (prompt: string) => {
    const payload = JSON.parse(/BEGIN_UNTRUSTED_USER_MESSAGE\n([\s\S]*)\nEND_UNTRUSTED_USER_MESSAGE/.exec(prompt)![1]!);
    return Array.isArray(payload)
      ? JSON.stringify({ items: payload.map((clause: string, clauseIndex: number) => ({ clauseIndex, ...answers.get(clause) })) })
      : JSON.stringify(answers.get(payload));
  };
  const proposal = await proposeCapture(
    lines.map(([clause]) => clause).join('\n'),
    { now: NOW, timezone: TZ, scopeId: 'b3-model-wall-clock', requestedEngine: 'model' },
    {
      store: new MemoryCaptureProposalStore(),
      llmProvider: provider,
      llmEngine: 'gemini',
      persistence: { snapshot: async () => createEmptyDomainState(), persistAtomically: async () => ({ state: createEmptyDomainState() }) },
    } as never,
  );
  assert.equal(proposal.provenance.executedEngine, 'gemini');
  assert.deepEqual(proposal.items.map((item) => when(item.resolvedTime)), lines.map(([, , time]) => `${TODAY} ${time}`));
  assert.ok(proposal.items.every((item) => !item.needsClarification));
});

/* ── Review round (lane B3): the carried day, the first verb's object, the cost ── */

test('review: the carried day is the whole day phrase — "next", «الجاي», «הבא» go with it', () => {
  assert.deepEqual(splitCaptureClauses('Call mom next Sunday at 5pm, buy gift at 7pm'),
    ['Call mom next Sunday at 5pm', 'buy gift at 7pm next Sunday']);
  assert.deepEqual(splitCaptureClauses('Call mom this Sunday at 5pm, buy gift at 7pm'),
    ['Call mom this Sunday at 5pm', 'buy gift at 7pm this Sunday']);
  assert.deepEqual(splitCaptureClauses('اتصل بماما الأحد الجاي الساعة 5 المسا، واشتري هدية الساعة 7 المسا'),
    ['اتصل بماما الأحد الجاي الساعة 5 المسا', 'واشتري هدية الساعة 7 المسا الأحد الجاي']);
  assert.deepEqual(splitCaptureClauses('להתקשר לאמא ביום ראשון הבא ב-17:00, ולקנות מתנה ב-19:00'),
    ['להתקשר לאמא ביום ראשון הבא ב-17:00', 'ולקנות מתנה ב-19:00 ביום ראשון הבא']);
});

test('review: the day of an appointment is not carried to a separate errand after it', () => {
  for (const [text, second] of [
    ['Dentist on Sunday at 5pm, call mom at 6pm', 'call mom at 6pm'],
    ['عندي موعد دكتور بكرا الساعة 5 المسا، واتصل بماما الساعة 6 المسا', 'واتصل بماما الساعة 6 المسا'],
    ['תור לרופא מחר ב-17:00, ולהתקשר לאמא ב-18:00', 'ולהתקשר לאמא ב-18:00'],
  ] as const) {
    assert.equal(splitCaptureClauses(text)[1], second, text);
  }
});

test('review: a first verb with no object of its own is not cut off — "Read and reply to emails" is one item', () => {
  assert.deepEqual(splitCaptureClauses('Read and reply to emails'), ['Read and reply to emails']);
  assert.deepEqual(splitCaptureClauses('Read and reply to emails tomorrow'), ['Read and reply to emails tomorrow']);
  // A first verb with its object still splits.
  assert.equal(splitCaptureClauses('read the contract and email Dana').length, 2);
});

test('review: a 2000-character chain of "and" is split in bounded time', () => {
  // Every join is a candidate split (an errand verb onto an object after it),
  // and every second one is not (a bare noun): the worst shape for the scan.
  for (const [joiner, words] of [
    [' and ', ['buy milk tomorrow at 5pm', 'call Sam', 'bread']],
    [' و', ['أشتري خبز بكرا الساعة 5', 'أتصل بسامي', 'حليب']],
    [', ', ['לקנות חלב מחר ב-17:00', 'להתקשר לסאם', 'לחם']],
  ] as const) {
    const chain = Array.from({ length: 400 }, (_, index) => words[index % 3]).join(joiner).slice(0, 2000);
    assert.ok(chain.length > 1900, `${chain.length}`);
    const started = performance.now();
    const clauses = splitCaptureClauses(chain);
    const elapsed = performance.now() - started;
    assert.ok(clauses.length >= 1);
    assert.ok(elapsed < 1000, `${joiner.trim() || 'comma'}: ${Math.round(elapsed)} ms`);
  }
});
