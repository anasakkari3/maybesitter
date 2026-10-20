/**
 * M5b-1 Gate B — the memory summary route: gates, validation, nothing stored
 * (PLAN-M5b-1 R1.1, Wire "GET /api/mobile/memory/summary", Verification
 * "Summary"; M5B1-007, M5B1-008, M5B1-010, M5B-030, M5B-031, M5B-037,
 * M5B-038, M5B-048).
 *
 * Every validation case goes through the real route with the gate's scripted
 * model behind the named seam (support.ts): the model answers a sentence, the
 * route validates it against the rows it sent. A rejected answer is
 * `{ status: 'unavailable' }` after exactly one model call — so a rejection is
 * the validator's, never a gate's. Every rule has a passing control beside
 * its rejecting case, so deleting a rule turns its case red, and an
 * over-strict build turns the control red.
 *
 * Refs follow PLAN R1.1: the newest 40 active rows in `listMemory` order,
 * `r1` the newest. `addRows` creates rows one minute apart, so the last row
 * given is `r1`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { reserveCall, callsToday } from '../../../lib/llm/usageGuard.ts';
import { setPersonalizationConsent, PERSONALIZATION_CONSENT_VERSION } from '../../../lib/consents/personalizationConsentService.ts';
import { setConsent } from '../../../lib/consents/consentService.ts';
import { PERSONALIZATION_CONSENT } from '../../../src/contracts/v1/consentContracts.ts';
import { createStoragePersonalizationConsentStore } from '../../../lib/personalizationControls/consentStore.ts';
import {
  addRows,
  begin,
  currentStorage,
  diffSnapshots,
  end,
  isUsagePath,
  promptOf,
  scriptedModel,
  show,
  snapshotStorage,
  summary,
  useSummaryModel,
} from './support.ts';

test.afterEach(() => end());

type Row = { content: string; language?: 'ar' | 'en' | 'he' | 'mixed' };
type Listed = Array<{ id: string; ref: string; content: string }>;
type Sentence = { text: string; refs: string[] };

/** The ref of the row whose content is `content`. */
function ref(listed: Listed, content: string): string {
  const row = listed.find((candidate) => candidate.content === content);
  assert.ok(row, `fixture: no row «${content}»`);
  return row!.ref;
}

async function run(rows: Row[], sentences: Sentence[] | ((listed: Listed) => Sentence[]), language = 'en') {
  const uid = await begin();
  const listed = await addRows(uid, rows);
  const model = scriptedModel(() => ({ sentences: typeof sentences === 'function' ? sentences(listed) : sentences }));
  await useSummaryModel(model);
  const answer = await summary(uid, language);
  return { uid, listed, model, answer };
}

async function expectReady(rows: Row[], sentences: Sentence[] | ((listed: Listed) => Sentence[]), language = 'en') {
  const result = await run(rows, sentences, language);
  assert.equal(result.answer.status, 200, show(result.answer.body));
  assert.equal(result.model.calls.length, 1, 'expected exactly one model call');
  assert.equal(result.answer.body.summary?.status, 'ready', `a valid paragraph was refused: ${show(result.answer.body)}`);
  return result;
}

async function expectRejected(rows: Row[], sentences: Sentence[] | ((listed: Listed) => Sentence[]), language = 'en') {
  const result = await run(rows, sentences, language);
  assert.equal(result.answer.status, 200, show(result.answer.body));
  assert.equal(result.model.calls.length, 1, 'the model was not called once, so this rejection is not the validator\'s');
  assert.deepEqual(result.answer.body.summary, { status: 'unavailable' }, `an invalid paragraph was shown: ${show(result.answer.body)}`);
  return result;
}

const one = (text: string): Sentence[] => [{ text, refs: ['r1'] }];

/* ── wire, alias mapping, coverage ─────────────────────────────────── */

test('R1.1 / Wire: a valid paragraph answers ready with language, sentences mapped back to memory ids, coveredCount and totalCount', async () => {
  const rows = [{ content: 'Likes tea in the morning' }, { content: 'Works from home on Sunday' }];
  const { listed, model, answer } = await expectReady(rows, (l) => [
    { text: 'Likes tea in the morning.', refs: [ref(l, 'Likes tea in the morning')] },
    { text: 'Works from home on Sunday.', refs: [ref(l, 'Works from home on Sunday')] },
  ]);
  const body = answer.body;
  assert.equal(body.success, true);
  assert.equal(body.summary.language, 'en');
  assert.equal(body.summary.coveredCount, 2);
  assert.equal(body.summary.totalCount, 2);
  assert.deepEqual(body.summary.sentences, [
    { text: 'Likes tea in the morning.', memoryIds: [listed.find((row) => row.content === 'Likes tea in the morning')!.id] },
    { text: 'Works from home on Sunday.', memoryIds: [listed.find((row) => row.content === 'Works from home on Sunday')!.id] },
  ]);
  assert.deepEqual(Object.keys(body.summary).sort(), ['coveredCount', 'language', 'sentences', 'status', 'totalCount']);
  // One structured call, purpose memory_summary, and the real ids never reach the model.
  const call = model.calls[0]!;
  assert.equal(call.via, 'generateStructured');
  assert.equal((call.request as any).purpose, 'memory_summary');
  const prompt = promptOf(call.request);
  for (const row of listed) {
    assert.ok(!prompt.includes(row.id), `a real memory id reached the model: ${row.id}`);
    assert.ok(prompt.includes(row.content), `row «${row.content}» was not sent`);
  }
  assert.match(prompt, /\br1\b/);
  assert.match(prompt, /\br2\b/);
});

test('R1.1 alias mapping: refs are r1… in listMemory order (newest first), each ref the alias of its own row', async () => {
  const rows = [{ content: 'Oldest row about tea' }, { content: 'Middle row about walks' }, { content: 'Newest row about books' }];
  const { listed, answer } = await expectReady(rows, [
    { text: 'Newest row about books.', refs: ['r1'] },
    { text: 'Middle row about walks.', refs: ['r2'] },
    { text: 'Oldest row about tea.', refs: ['r3'] },
  ]);
  assert.deepEqual(listed.map((row) => row.content), ['Newest row about books', 'Middle row about walks', 'Oldest row about tea'], 'fixture: list order');
  assert.deepEqual(answer.body.summary.sentences.map((sentence: any) => sentence.memoryIds[0]), listed.map((row) => row.id));
});

test('R1.1 more than 40 rows: only the newest 40 are sent (r1…r40), coveredCount 40, totalCount 41', async () => {
  const rows = Array.from({ length: 41 }, (_, index) => ({ content: `Remembered thing number ${index}` }));
  const { listed, model, answer } = await expectReady(rows, (l) => [
    { text: 'Remembered thing number 40.', refs: l.slice(0, 20).map((row) => row.ref) },
    { text: 'Remembered thing number 1.', refs: l.slice(20, 40).map((row) => row.ref) },
  ]);
  assert.equal(answer.body.summary.coveredCount, 40);
  assert.equal(answer.body.summary.totalCount, 41);
  const prompt = promptOf(model.calls[0]!.request);
  assert.match(prompt, /\br40\b/);
  assert.doesNotMatch(prompt, /\br41\b/, 'a 41st row was sent');
  assert.ok(!prompt.includes(listed[40]!.content), 'the oldest row was sent');
});

test('R1.1 / Wire: a bad language answers 400 and calls nothing', async () => {
  const uid = await begin();
  await addRows(uid, [{ content: 'Likes tea' }]);
  const model = scriptedModel(() => ({ sentences: one('Likes tea.') }));
  await useSummaryModel(model);
  for (const language of ['fr', '', 'AR']) {
    const answer = await summary(uid, language);
    assert.equal(answer.status, 400, `language «${language}»: ${show(answer.body)}`);
  }
  assert.equal(model.calls.length, 0);
});

test('R1.1 / Wire: ar and he are answered in their own language field', async () => {
  const ar = await expectReady([{ content: 'بحب أروح عالنادي الصبح', language: 'ar' }], one('بتحب تروح عالنادي الصبح.'), 'ar');
  assert.equal(ar.answer.body.summary.language, 'ar');
  end();
  const he = await expectReady([{ content: 'אוהב ספורט בבוקר', language: 'he' }], one('אוהב ספורט בבוקר.'), 'he');
  assert.equal(he.answer.body.summary.language, 'he');
});

/* ── gates (M5B1-008: capability → module → AI → rows; no consent) ──── */

test('R1.1 gate 1: off or killed answers 404 m5b_unavailable with no model call', async () => {
  for (const switches of [{ on: false }, { on: true, killed: true }, { on: null }]) {
    const uid = await begin(switches as any);
    await addRows(uid, [{ content: 'Likes tea' }]);
    const model = scriptedModel(() => ({ sentences: one('Likes tea.') }));
    await useSummaryModel(model);
    const answer = await summary(uid);
    assert.equal(answer.status, 404, show(answer.body));
    assert.deepEqual({ success: answer.body.success, error: answer.body.error }, { success: false, error: 'm5b_unavailable' });
    assert.equal(model.calls.length, 0);
    end();
  }
});

test('R1.1 gate 2: the memory module off answers the module\'s own 404, with no model call', async () => {
  const uid = await begin({ memory: false });
  const model = scriptedModel(() => ({ sentences: one('Likes tea.') }));
  await useSummaryModel(model);
  const answer = await summary(uid);
  assert.equal(answer.status, 404, show(answer.body));
  assert.equal(answer.body.reason, 'feature_unavailable', 'not the memory module\'s 404 (moduleDisabledResponse)');
  assert.equal(model.calls.length, 0);
});

test('R1.1 gate 3: AI disabled answers unavailable with no model call and usage counters byte-unchanged', async () => {
  const uid = await begin({ aiDisabled: true });
  await addRows(uid, [{ content: 'Likes tea' }]);
  const model = scriptedModel(() => ({ sentences: one('Likes tea.') }));
  await useSummaryModel(model);
  const usageBefore = await snapshotStorage((path) => !isUsagePath(path));
  const answer = await summary(uid);
  assert.equal(answer.status, 200, show(answer.body));
  assert.deepEqual(answer.body.summary, { status: 'unavailable' });
  assert.equal(model.calls.length, 0);
  assert.deepEqual(diffSnapshots(usageBefore, await snapshotStorage((path) => !isUsagePath(path))), [], 'AI disabled still touched the usage guard');
});

test('R1.1 gate 3: no configured provider (none) answers unavailable without a reservation', async () => {
  const uid = await begin();
  await addRows(uid, [{ content: 'Likes tea' }]);
  // The seam is never installed: the configured provider is `none` in the harness.
  const before = await callsToday(uid, { storage: currentStorage() as any });
  const answer = await summary(uid);
  assert.equal(answer.status, 200, show(answer.body));
  assert.deepEqual(answer.body.summary, { status: 'unavailable' });
  assert.deepEqual(await callsToday(uid, { storage: currentStorage() as any }), before, 'a reservation was spent on a provider that cannot answer');
});

test('R1.1 a cap reached answers unavailable with no model call', async () => {
  const uid = await begin();
  await addRows(uid, [{ content: 'Likes tea' }]);
  const model = scriptedModel(() => ({ sentences: one('Likes tea.') }));
  await useSummaryModel(model);
  // The per-user minute cap (8) spent by other features in this minute.
  for (let index = 0; index < 8; index += 1) await reserveCall(uid, 'plan_explanation', { storage: currentStorage() as any });
  const answer = await summary(uid);
  assert.equal(answer.status, 200, show(answer.body));
  assert.deepEqual(answer.body.summary, { status: 'unavailable' });
  assert.equal(model.calls.length, 0);
});

test('R1.1 gate 4: 0 rows answers { status: empty } with no model call and no reservation', async () => {
  const uid = await begin();
  const model = scriptedModel(() => ({ sentences: one('Likes tea.') }));
  await useSummaryModel(model);
  const before = await callsToday(uid, { storage: currentStorage() as any });
  const answer = await summary(uid);
  assert.equal(answer.status, 200, show(answer.body));
  assert.deepEqual(answer.body, { success: true, summary: { status: 'empty' } });
  assert.equal(model.calls.length, 0);
  assert.deepEqual(await callsToday(uid, { storage: currentStorage() as any }), before);
});

test('M5B1-013 usage: a ready summary reserves exactly one call', async () => {
  const uid = await begin();
  await addRows(uid, [{ content: 'Likes tea' }]);
  await useSummaryModel(scriptedModel(() => ({ sentences: one('Likes tea.') })));
  const before = await callsToday(uid, { storage: currentStorage() as any });
  const answer = await summary(uid);
  assert.equal(answer.body.summary?.status, 'ready', show(answer.body));
  const after = await callsToday(uid, { storage: currentStorage() as any });
  assert.equal(after.user - before.user, 1);
});

test('M5B1-008: no personalization consent is read — every consent state gives the same ready answer and one call', async () => {
  const states: Array<[string, (uid: string) => Promise<void>]> = [
    ['never asked', async () => {}],
    ['declined', async (uid) => { await setPersonalizationConsent(uid, { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, { storage: currentStorage() as any }); }],
    ['withdrawn', async (uid) => {
      await setPersonalizationConsent(uid, { state: 'granted', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, { storage: currentStorage() as any });
      await setPersonalizationConsent(uid, { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, { storage: currentStorage() as any });
    }],
    ['granted', async (uid) => { await setPersonalizationConsent(uid, { state: 'granted', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, { storage: currentStorage() as any }); }],
    ['store-only', async (uid) => { await createStoragePersonalizationConsentStore(currentStorage() as any).write(uid, 'enabled', new Date().toISOString()); }],
    ['answer-only', async (uid) => { await setConsent(PERSONALIZATION_CONSENT, uid, { state: 'granted', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, { storage: currentStorage() as any }); }],
  ];
  const answers: unknown[] = [];
  for (const [label, setup] of states) {
    const uid = await begin();
    const listed = await addRows(uid, [{ content: 'Likes tea' }]);
    await setup(uid);
    const model = scriptedModel(() => ({ sentences: one('Likes tea.') }));
    await useSummaryModel(model);

    // A storage spy: no read of users/{uid}/consents/personalization during the request.
    const storage = currentStorage() as any;
    const reads: string[] = [];
    const get = storage.get.bind(storage);
    const runTransaction = storage.runTransaction.bind(storage);
    storage.get = async (path: string, ...rest: unknown[]) => { reads.push(path); return get(path, ...rest); };
    storage.runTransaction = async (fn: (tx: any) => Promise<unknown>) => runTransaction(async (tx: any) => {
      const txGet = tx.get.bind(tx);
      tx.get = async (path: string, ...rest: unknown[]) => { reads.push(path); return txGet(path, ...rest); };
      return fn(tx);
    });
    let answer;
    try {
      answer = await summary(uid);
    } finally {
      storage.get = get;
      storage.runTransaction = runTransaction;
    }
    assert.equal(answer.status, 200, `${label}: ${show(answer.body)}`);
    assert.equal(answer.body.summary?.status, 'ready', `${label}: the consent state changed the answer: ${show(answer.body)}`);
    assert.equal(model.calls.length, 1, `${label}: model calls`);
    assert.ok(!reads.some((path) => /\/consents\/personalization$/.test(path)), `${label}: the summary read the personalization consent store`);
    answers.push(answer.body.summary.sentences.map((sentence: any) => ({ text: sentence.text, memoryIds: sentence.memoryIds.map((id: string) => id === listed[0]!.id) })));
    end();
  }
  for (const answer of answers) assert.deepEqual(answer, answers[0]);
});

test('R1.1 nothing is persisted: storage is byte-identical after a ready and after a rejected summary (usage counters excepted)', async () => {
  const uid = await begin();
  await addRows(uid, [{ content: 'Likes tea' }]);
  let text = 'Likes tea.';
  await useSummaryModel(scriptedModel(() => ({ sentences: one(text) })));
  const before = await snapshotStorage(isUsagePath);
  const ready = await summary(uid);
  assert.equal(ready.body.summary?.status, 'ready', show(ready.body));
  assert.deepEqual(diffSnapshots(before, await snapshotStorage(isUsagePath)), [], 'a ready summary wrote something');
  text = 'Likes tea at 7.';
  const rejected = await summary(uid);
  assert.deepEqual(rejected.body.summary, { status: 'unavailable' }, show(rejected.body));
  assert.deepEqual(diffSnapshots(before, await snapshotStorage(isUsagePath)), [], 'a rejected summary wrote something');
});

/* ── shape rules ───────────────────────────────────────────────────── */

test('R1.1 shape: a sentence with no refs rejects', async () => {
  await expectRejected([{ content: 'Likes tea' }], [{ text: 'Likes tea.', refs: [] }]);
});

test('R1.1 shape: an unknown ref rejects', async () => {
  await expectRejected([{ content: 'Likes tea' }], [{ text: 'Likes tea.', refs: ['r1', 'r9'] }]);
});

test('R1.1 shape: refs that do not cover every supplied row reject; covering them passes', async () => {
  const rows = [{ content: 'Likes tea' }, { content: 'Walks the dog' }];
  await expectRejected(rows, (l) => [{ text: 'Likes tea.', refs: [ref(l, 'Likes tea')] }]);
  end();
  await expectReady(rows, (l) => [{ text: 'Likes tea and walks the dog.', refs: [ref(l, 'Likes tea'), ref(l, 'Walks the dog')] }]);
});

test('R1.1 shape: 9 sentences reject, 8 pass', async () => {
  await expectRejected([{ content: 'Likes tea' }], Array.from({ length: 9 }, () => ({ text: 'Likes tea.', refs: ['r1'] })));
  end();
  await expectReady([{ content: 'Likes tea' }], Array.from({ length: 8 }, () => ({ text: 'Likes tea.', refs: ['r1'] })));
});

test('R1.1 shape: an empty sentence and a 221-character sentence reject; 220 characters pass', async () => {
  await expectRejected([{ content: 'Likes tea' }], one(''));
  end();
  const long = `Likes tea${' and tea'.repeat(30)}`;
  await expectRejected([{ content: 'Likes tea' }], one(long.slice(0, 220) + 'a'));
  end();
  await expectReady([{ content: 'Likes tea' }], one(long.slice(0, 219) + '.'));
});

/* ── numbers: whole tokens copied from cited rows ──────────────────── */

test('R1.1 numbers: an invented number rejects; the same number copied whole from the cited row passes', async () => {
  await expectRejected([{ content: 'Goes to the gym' }], one('Goes to the gym at 7.'));
  end();
  await expectReady([{ content: 'Goes to the gym at 7' }], one('Goes to the gym at 7.'));
});

test('R1.1 numbers: a partial token rejects — 2 against a cited 12', async () => {
  await expectRejected([{ content: 'Standup at 12' }], one('Standup at 2.'));
});

test('R1.1 numbers: 9:00 against a cited 09:00 rejects; 09:00 and 12:00 from 09:00-12:00 pass', async () => {
  await expectRejected([{ content: 'Focus 09:00-12:00' }], one('Focus from 9:00 on.'));
  end();
  await expectReady([{ content: 'Focus 09:00-12:00' }], one('Focus from 09:00 to 12:00.'));
});

test('R1.1 numbers: a number present only in an uncited row rejects', async () => {
  const rows = [{ content: 'Gym at 09:00' }, { content: 'Reads books' }];
  await expectRejected(rows, (l) => [
    { text: 'Reads books at 09:00.', refs: [ref(l, 'Reads books')] },
    { text: 'Gym at 09:00.', refs: [ref(l, 'Gym at 09:00')] },
  ]);
});

test('M5B-031 numerals: Arabic-Indic, full-width, superscript, fraction, circled and Roman-numeral characters each reject, even where NFKC would make a cited token', async () => {
  const cases: Array<[Row, string, string]> = [
    [{ content: 'رياضة الساعة 12', language: 'ar' }, 'عندك رياضة الساعة ١٢.', 'ar'],
    [{ content: 'Gym at 12' }, 'Gym at １２.', 'en'],
    [{ content: 'Meets in room 2' }, 'Meets in room ².', 'en'],
    [{ content: 'Walks 1/2 hour' }, 'Walks ½ hour.', 'en'],
    [{ content: 'Step 1 is coffee' }, 'Step ① is coffee.', 'en'],
    [{ content: 'Reads chapter XII' }, 'Reads chapter Ⅻ.', 'en'],
  ];
  for (const [row, text, language] of cases) {
    await expectRejected([row], one(text), language);
    end();
  }
});

/* ── spelled-out numbers, times, ordinals, quantities ──────────────── */

test('R1.1 spelled-out numbers and times reject in each language', async () => {
  const cases: Array<[Row, string, string]> = [
    [{ content: 'بشتغل بالمكتب', language: 'ar' }, 'بتشتغل بالمكتب من عشرة للظهر.', 'ar'],
    [{ content: 'Works at the office' }, 'Works at the office from ten to noon.', 'en'],
    [{ content: 'עובד במשרד', language: 'he' }, 'עובד במשרד מעשר עד הצהריים.', 'he'],
    [{ content: 'بروح عالنادي', language: 'ar' }, 'بتروح عالنادي مرتين بالجمعة.', 'ar'],
    [{ content: 'Goes to the gym' }, 'Goes to the gym twice a week.', 'en'],
  ];
  for (const [row, text, language] of cases) {
    await expectRejected([row], one(text), language);
    end();
  }
});

test('R1.1 a number word copied from a cited row passes', async () => {
  await expectReady([{ content: 'Goes to the gym twice a week' }], one('Goes to the gym twice a week.'));
  end();
  await expectReady([{ content: 'بروح عالنادي مرتين بالجمعة', language: 'ar' }], one('بتروح عالنادي مرتين بالجمعة.'), 'ar');
});

test('M5B-031 ordinals and multiplicatives reject in each language', async () => {
  const cases: Array<[Row, string, string]> = [
    [{ content: 'Takes a step early' }, 'Takes the first step early.', 'en'],
    [{ content: 'بعمل خطوة بكير', language: 'ar' }, 'بتعمل أول خطوة بكير.', 'ar'],
    [{ content: 'بعمل الشغلة بعدين', language: 'ar' }, 'بتعمل الشغلة التانية بعدين.', 'ar'],
    [{ content: 'עושה צעד מוקדם', language: 'he' }, 'עושה את הצעד הראשון מוקדם.', 'he'],
    [{ content: 'Drinks espresso' }, 'Drinks a double espresso.', 'en'],
    [{ content: 'بشرب مي', language: 'ar' }, 'بتشرب مي ضعفين.', 'ar'],
    [{ content: 'שותה אספרסו', language: 'he' }, 'שותה אספרסו כפול.', 'he'],
  ];
  for (const [row, text, language] of cases) {
    await expectRejected([row], one(text), language);
    end();
  }
});

test('M5B-031 an ordinal copied from a cited row passes', async () => {
  await expectReady([{ content: 'First thing: coffee' }], one('First thing in the day is coffee.'));
});

test('M5B-038 quantity words with no digit reject in each language', async () => {
  const cases: Array<[Row, string, string]> = [
    [{ content: 'Kids go to school' }, 'Both kids go to school.', 'en'],
    [{ content: 'Buys shoes' }, 'Buys a pair of shoes.', 'en'],
    [{ content: 'Reads pages' }, 'Reads a couple of pages.', 'en'],
    [{ content: 'Bakes cookies' }, 'Bakes a dozen cookies.', 'en'],
    [{ content: 'Visits family' }, 'Visits family every fortnight.', 'en'],
    [{ content: 'بحب المشي', language: 'ar' }, 'بتمشي ساعتين.', 'ar'],
    [{ content: 'بجهز الشنطة', language: 'ar' }, 'بتجهز الشنطة بيومين.', 'ar'],
    [{ content: 'بشوف أهلي', language: 'ar' }, 'بتشوف أهلها كل جمعتين.', 'ar'],
    [{ content: 'بروح عالنادي', language: 'ar' }, 'بتروح عالنادي مرتين.', 'ar'],
    [{ content: 'פוגש את המשפחה', language: 'he' }, 'פוגש את המשפחה כל שבועיים.', 'he'],
    [{ content: 'קונה נעליים', language: 'he' }, 'קונה זוג נעליים.', 'he'],
    [{ content: 'אוהבים ספורט', language: 'he' }, 'שניהם אוהבים ספורט.', 'he'],
  ];
  for (const [row, text, language] of cases) {
    await expectRejected([row], one(text), language);
    end();
  }
});

test('M5B-038 a dual copied from a cited row passes («يومين»)', async () => {
  await expectReady([{ content: 'بسافر يومين بالشهر', language: 'ar' }], one('بتسافر يومين بالشهر.'), 'ar');
});

test('M5B1-007 stacked Arabic clitics: uncited «وبالساعتين», «فللساعتين», «وبيومين» reject', async () => {
  const cases: Array<[Row, string]> = [
    [{ content: 'بخلص شغلي', language: 'ar' }, 'بتخلص شغلها وبالساعتين بترتاح.'],
    [{ content: 'بقعد بالمكتبة', language: 'ar' }, 'بتقعد فللساعتين بالمكتبة.'],
    [{ content: 'بجهز حالي', language: 'ar' }, 'بتجهز حالها وبيومين بتسافر.'],
  ];
  for (const [row, text] of cases) {
    await expectRejected([row], one(text), 'ar');
    end();
  }
});

test('M5B1-007 stacked Arabic clitics: the same word copied from a cited row passes', async () => {
  await expectReady([{ content: 'بخلص شغلي وبالساعتين برتاح', language: 'ar' }], one('بتخلص شغلها وبالساعتين بترتاح.'), 'ar');
  end();
  await expectReady([{ content: 'بجهز حالي وبيومين بسافر', language: 'ar' }], one('بتجهز حالها وبيومين بتسافر.'), 'ar');
});

test('M5B1-010 stacked Hebrew clitics: uncited «ומהשעתיים», «ובשבועיים» reject; copied from a cited row they pass', async () => {
  await expectRejected([{ content: 'נח אחרי העבודה', language: 'he' }], one('נח ומהשעתיים האלה נהנה.'), 'he');
  end();
  await expectRejected([{ content: 'מתכונן לטיסה', language: 'he' }], one('מתכונן ובשבועיים טס.'), 'he');
  end();
  await expectReady([{ content: 'נח ומהשעתיים האלה נהנה', language: 'he' }], one('נח ומהשעתיים האלה נהנה.'), 'he');
  end();
  await expectReady([{ content: 'מתכונן ובשבועיים טס', language: 'he' }], one('מתכונן ובשבועיים טס.'), 'he');
});

/* ── Roman numerals (M5B-038, amended by M5B-048) ──────────────────── */

test('M5B-048 Roman: XII, IV and MD reject, and so do uncited xii, iv and Xii', async () => {
  const cases: Array<[string, string]> = [
    ['Reads every night', 'Reads chapter XII every night.'],
    ['Gets a drip weekly', 'Gets an IV drip weekly.'],
    ['Sees the doctor on Sunday', 'Sees the MD on Sunday.'],
    ['Reads a chapter', 'Reads chapter xii.'],
    ['Gets a drip weekly', 'Gets an iv drip weekly.'],
    ['Reads a chapter', 'Reads chapter Xii.'],
  ];
  for (const [row, text] of cases) {
    await expectRejected([{ content: row }], one(text));
    end();
  }
});

test('M5B-048 Roman: words that are not well-formed numerals pass (did, mid, civil, ill), and single letters pass (I, i, V, v)', async () => {
  await expectReady([{ content: 'Did a walk' }], one('Did a mid morning walk, felt civil, not ill.'));
  end();
  await expectReady([{ content: 'Likes tea' }], one('I like tea and i like vitamin V and v too.'));
});

test('M5B-048 Roman: XII copied as a whole token from a cited row passes; xii against a cited XII rejects (case-exact)', async () => {
  await expectReady([{ content: 'Reads chapter XII' }], one('Reads chapter XII again.'));
  end();
  await expectRejected([{ content: 'Reads chapter XII' }], one('Reads chapter xii again.'));
});

/* ── language (M5B-030, M5B-037) ───────────────────────────────────── */

test('M5B-030 language: an English sentence in Arabic prose and in Hebrew prose rejects; a mostly-Latin Hebrew sentence rejects', async () => {
  await expectRejected([{ content: 'بحب الرياضة', language: 'ar' }], one('Likes sports a lot.'), 'ar');
  end();
  await expectRejected([{ content: 'אוהב ספורט', language: 'he' }], one('Likes sports a lot.'), 'he');
  end();
  await expectRejected([{ content: 'Morning focus block' }], one('Morning focus block קבוע.'), 'he');
});

test('M5B-030 language: an Arabic sentence citing an English row name passes («بحب الـ Gym»)', async () => {
  await expectReady([{ content: 'Gym' }], one('بحب الـ Gym'), 'ar');
});

test('M5B-030 adversarial: a whole English row copied with one Arabic word added rejects (check 1)', async () => {
  await expectRejected([{ content: 'Morning focus block at the gym' }], one('Morning focus block at the gym عندي'), 'ar');
});

test('M5B-030 adversarial: a 4-word foreign run rejects (span bound); a 3-word run copied from the cited row passes', async () => {
  const prose = (span: string) => `عندي عادة ثابتة كل يوم الصبح اسمها ${span} وبحبها كتير.`;
  await expectRejected([{ content: 'Deep work focus block' }], one(prose('Deep work focus block')), 'ar');
  end();
  await expectReady([{ content: 'Deep work block' }], one(prose('Deep work block')), 'ar');
});

test('M5B-030 adversarial: a 33-letter foreign run rejects; 32 letters copied from the cited row pass', async () => {
  const prose = (span: string) => `عندي عادة ثابتة كل يوم الصبح اسمها ${span} وبحبها كتير.`;
  assert.equal('InternationalizationWorkshopsDads'.length, 33);
  await expectRejected([{ content: 'Internationalization Workshops Dads' }], one(prose('Internationalization Workshops Dads')), 'ar');
  end();
  await expectReady([{ content: 'Internationalization Workshops Dad' }], one(prose('Internationalization Workshops Dad')), 'ar');
});

test('M5B-030 adversarial: two separate one-word English names in one Arabic sentence reject (second span)', async () => {
  const rows = [{ content: 'Peloton' }, { content: 'Pilates' }];
  await expectRejected(rows, (l) => [{ text: 'بحب نادي Peloton وكمان صف Pilates بالمسا.', refs: [ref(l, 'Peloton'), ref(l, 'Pilates')] }], 'ar');
});

test('M5B-030 adversarial: a one-word span in no cited row rejects, and so does one copied from an uncited row; cited, it passes', async () => {
  await expectRejected([{ content: 'بروح عالنادي مع صاحبتي', language: 'ar' }], one('بتروح عالنادي مع Samira.'), 'ar');
  end();
  const rows = [{ content: 'بروح عالنادي مع صاحبتي', language: 'ar' as const }, { content: 'Samira' }];
  await expectRejected(rows, (l) => [
    { text: 'بتروح عالنادي مع Samira.', refs: [ref(l, 'بروح عالنادي مع صاحبتي')] },
    { text: 'صاحبتك اسمها Samira.', refs: [ref(l, 'Samira')] },
  ], 'ar');
  end();
  await expectReady(rows, (l) => [
    { text: 'بتروح عالنادي مع Samira.', refs: [ref(l, 'بروح عالنادي مع صاحبتي'), ref(l, 'Samira')] },
  ], 'ar');
});

test('M5B-030 adversarial: «maybesitter» alone is not counted', async () => {
  await expectReady([{ content: 'بحب الرياضة', language: 'ar' }], one('MaybeSitter بيعرف إنك بتحب الرياضة.'), 'ar');
});

test('M5B-037 every letter counts: a Cyrillic, Greek or Han foreign part not copied from a cited row rejects in en, ar and he', async () => {
  await expectRejected([{ content: 'Likes the gym in the morning' }], one('Likes the gym in the morning, говорит она.'), 'en');
  end();
  await expectRejected([{ content: 'بحب الرياضة الصبح', language: 'ar' }], one('بتحب الرياضة الصبح كثير Ελλάδα.'), 'ar');
  end();
  await expectRejected([{ content: 'אוהב ספורט בבוקר', language: 'he' }], one('אוהב ספורט בבוקר 健身房很好.'), 'he');
});

test('M5B-037 look-alikes: one Cyrillic or Greek letter inside a target word makes it foreign — rejected uncited, passes as the one span copied from a cited row', async () => {
  // «Mоm» with a Cyrillic о (U+043E), «Mοm» with a Greek ο (U+03BF), against a Latin row.
  await expectRejected([{ content: 'Mom' }], one('Mоm.'), 'en');
  end();
  await expectRejected([{ content: 'Mom' }], one('Mοm.'), 'en');
  end();
  await expectReady([{ content: 'Calls Mоm daily' }], one('Calls Mоm daily.'), 'en');
});

test('M5B-037 a Han run copied from a cited row passes within 32 letters and rejects at 33', async () => {
  const han = (count: number) => '茶'.repeat(count);
  const sentence = (count: number) => `My favourite tea shop is called ${han(count)} and I go there often.`;
  await expectReady([{ content: `Tea shop ${han(32)}` }], one(sentence(32)), 'en');
  end();
  await expectRejected([{ content: `Tea shop ${han(33)}` }], one(sentence(33)), 'en');
});
