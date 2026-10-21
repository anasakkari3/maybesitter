/**
 * M6a-2 Gate B — «اكتبها بالعربي»: `POST /api/mobile/memory/{id}/translation`
 * proposes, nothing is saved; confirming is the existing PATCH (PLAN-M6a-2,
 * D53-1 (b)). Gate author: Claude, written before Task B's build.
 *
 * Seam (named for Task B): `setMemoryTranslationDependenciesForTests({ provider } | null)`
 * exported from `lib/services/mobile/memoryTranslation.ts`. The provider
 * replaces the configured one; the gates, the usage guard and the validation
 * stay real. Timers run on the global `setTimeout` / `Date`.
 */
import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import type { LlmProvider } from '../../../src/extraction/llm/index.ts';
import { callsToday } from '../../../lib/llm/usageGuard.ts';
import {
  addRows, call, currentStorage, diffSnapshots, isUsagePath, loadModule, promptOf, scriptedModel, show, snapshotStorage,
} from '../m5b/support.ts';
import { begin as beginM5b, end, route, setAccount } from '../m5b/support.ts';
import { execFileSync } from 'node:child_process';
import { tokenFor } from '../../support/fakeAuth.ts';
import { fileURLToPath } from 'node:url';

const ENV = ['MAYBESITTER_FEATURE_MEMORY_TRANSLATION', 'MAYBESITTER_KILL_SWITCH_MEMORY_TRANSLATION'] as const;
let saved: Record<string, string | undefined> | null = null;
let seam: ((deps: { provider?: LlmProvider } | null) => void) | null = null;

async function start(options: { on?: boolean; killed?: boolean; environment?: string; locale?: string; memory?: boolean; aiDisabled?: boolean } = {}): Promise<string> {
  const uid = await beginM5b(
    { environment: options.environment ?? 'staging', memory: options.memory ?? true, aiDisabled: options.aiDisabled ?? false },
    { locale: options.locale ?? 'ar' },
  );
  saved = Object.fromEntries(ENV.map((key) => [key, process.env[key]]));
  process.env.MAYBESITTER_FEATURE_MEMORY_TRANSLATION = (options.on ?? true) ? 'true' : 'false';
  process.env.MAYBESITTER_KILL_SWITCH_MEMORY_TRANSLATION = options.killed ? 'true' : 'false';
  return uid;
}

afterEach(() => {
  seam?.(null);
  seam = null;
  if (saved) {
    for (const key of ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    saved = null;
  }
  end();
});

async function useModel(provider: LlmProvider): Promise<void> {
  const module = await loadModule('lib/services/mobile/memoryTranslation.ts');
  assert.equal(typeof module.setMemoryTranslationDependenciesForTests, 'function', 'the gate\'s named seam is not exported');
  seam = module.setMemoryTranslationDependenciesForTests as typeof seam;
  seam!({ provider });
}

const DISCLOSURE = 'memory-translation-disclosure-v1';
// M6A2-R2-003: the request names the disclosure version the person was shown.
const translate = (uid: string, id: string, locale = 'ar') =>
  call(uid, 'memory/[id]/translation', 'POST', { params: { id }, body: { locale, disclosureVersion: DISCLOSURE } });

const answering = (text: string) => scriptedModel(() => ({ text }));

/* ── the happy path, and nothing saved ─────────────────────────────── */

test('R1 an English fact gets one proposal in Arabic, and nothing is persisted', async () => {
  const uid = await start();
  const [row] = await addRows(uid, [{ content: 'Goes to the gym twice a week', language: 'en' }]);
  // Arabic: «بيروح الجيم مرتين بالأسبوع».
  const model = answering('بيروح الجيم مرتين بالأسبوع');
  await useModel(model);
  const before = await snapshotStorage(isUsagePath);
  const usageBefore = await callsToday(uid, { storage: currentStorage() as any });
  const result = await translate(uid, row!.id);
  assert.equal(result.status, 200, show(result.body));
  assert.equal(result.body.proposal.status, 'ready');
  assert.equal(result.body.proposal.memoryId, row!.id);
  assert.equal(result.body.proposal.to, 'ar');
  assert.equal(model.calls.length, 1);
  assert.match(promptOf(model.calls[0]!.request), /Goes to the gym twice a week/);
  const after = await snapshotStorage(isUsagePath);
  // M6A2-R007: usage documents are excluded from the comparison and checked on their own.
  assert.deepEqual(diffSnapshots(before, after), [], 'a proposal persisted something outside the usage documents');
  const usageAfter = await callsToday(uid, { storage: currentStorage() as any });
  assert.equal(usageAfter.user - usageBefore.user, 1, 'not exactly one reservation');
  assert.equal(usageAfter.tokens - usageBefore.tokens, 20, 'the answer\'s tokens were not committed (commitUsage)');
});

test('R1 confirming is the existing PATCH: one supersession, user-stated, origin kept', async () => {
  const uid = await start();
  const [row] = await addRows(uid, [{ content: 'Prefers quiet mornings', language: 'en' }]);
  const text = 'بيفضّل الصبح هادي';
  await useModel(answering(text));
  const proposal = (await translate(uid, row!.id)).body.proposal;
  const patched = await call(uid, 'memory/[id]', 'PATCH', { params: { id: row!.id }, body: { content: proposal.text } });
  assert.equal(patched.status, 200, show(patched.body));
  const listed = await call(uid, 'memory', 'GET');
  const items = listed.body.items as Array<{ id: string; content: string; source: string; language: string }>;
  assert.equal(items.length, 1);
  assert.equal(items[0]!.content, text);
  assert.equal(items[0]!.source, 'user_stated');
  // M6A2-R004: the language follows the saved text, not the record it replaced.
  assert.equal(items[0]!.language, 'ar', 'Arabic text stored with the old record\'s language');
});

/* ── refusals ───────────────────────────────────────────────────────── */

test('R1 a goal, a fact already in the target language, and a stranger\'s record are refused without a model call', async () => {
  const uid = await start();
  const rows = await addRows(uid, [
    { content: 'Learn Spanish', language: 'en', kind: 'goal' },
    { content: 'بحب القهوة', language: 'ar' },
  ]);
  const model = answering('x');
  await useModel(model);
  const goal = rows.find((r) => r.content === 'Learn Spanish')!;
  const arabic = rows.find((r) => r.content !== 'Learn Spanish')!;
  const g = await translate(uid, goal.id);
  assert.equal(g.status, 422, show(g.body));
  assert.equal(g.body.reason ?? g.body.error, 'not_translatable');
  const a = await translate(uid, arabic.id);
  assert.equal(a.status, 422, show(a.body));
  assert.equal(a.body.reason ?? a.body.error, 'already_in_language');
  const stranger = await translate('m6-someone-else', arabic.id);
  assert.equal(stranger.status, 404, show(stranger.body));
  assert.equal(model.calls.length, 0);
});

test('R1 off, killed and production answer 404 feature_unavailable and read no memory', async () => {
  for (const options of [{ on: false }, { killed: true }, { environment: 'production' }]) {
    const uid = await start(options);
    const [row] = await addRows(uid, [{ content: 'Walks daily', language: 'en' }]);
    const model = answering('x');
    await useModel(model);
    const storage = currentStorage() as any;
    const reads: string[] = [];
    const originals = Object.fromEntries(['get', 'getMany', 'list', 'listGroup'].map((name) => [name, storage[name]]));
    for (const name of Object.keys(originals)) {
      storage[name] = function (this: unknown, ...args: any[]) {
        reads.push(`${name}:${Array.isArray(args[0]) ? args[0].join(',') : String(args[0])}`);
        return originals[name].apply(storage, args);
      };
    }
    let result;
    try {
      result = await translate(uid, row!.id);
    } finally {
      for (const name of Object.keys(originals)) storage[name] = originals[name];
    }
    assert.equal(result.status, 404, `${JSON.stringify(options)}: ${show(result.body)}`);
    assert.equal(result.body.reason ?? result.body.error, 'feature_unavailable', show(result.body));
    assert.deepEqual(reads.filter((read) => /(^|[/:,])memory($|[/,])/.test(read)), [], `memory read while off: ${reads.join(' ')}`);
    assert.equal(model.calls.length, 0);
    seam?.(null); seam = null;
    if (saved) { for (const key of ENV) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } saved = null; }
    end();
  }
});

test('R1 the body is strict: an unknown locale, an extra key, or a missing or outdated disclosure version is 400', async () => {
  const uid = await start();
  const [row] = await addRows(uid, [{ content: 'Walks daily', language: 'en' }]);
  const model = answering('x');
  await useModel(model);
  for (const body of [
    { locale: 'fr', disclosureVersion: DISCLOSURE },
    { locale: 'ar', disclosureVersion: DISCLOSURE, extra: 1 },
    {},
    { locale: 'ar' },
    { locale: 'ar', disclosureVersion: 'memory-translation-disclosure-v0' },
  ]) {
    const result = await call(uid, 'memory/[id]/translation', 'POST', { params: { id: row!.id }, body });
    assert.equal(result.status, 400, `${JSON.stringify(body)}: ${show(result.body)}`);
  }
  assert.equal(model.calls.length, 0);
});

test('R1 a body over 1 KiB is refused before it is parsed', async () => {
  const uid = await start();
  const [row] = await addRows(uid, [{ content: 'Walks daily', language: 'en' }]);
  const handler = await route('memory/[id]/translation', 'POST');
  const headers = new Headers({ 'Content-Type': 'application/json', authorization: `Bearer ${tokenFor(uid)}` });
  const body = JSON.stringify({ locale: 'ar', disclosureVersion: DISCLOSURE, pad: 'x'.repeat(1100) });
  const response = await handler(new Request(`http://localhost:3000/api/mobile/memory/${row!.id}/translation`, { method: 'POST', headers, body }), { params: Promise.resolve({ id: row!.id }) });
  assert.equal(response.status, 413, await response.text());
});

test('R1 anonymous requests are 401', async () => {
  await start();
  const handler = await route('memory/[id]/translation', 'POST');
  const response = await handler(
    new Request('http://localhost:3000/api/mobile/memory/mem_x/translation', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ locale: 'ar', disclosureVersion: DISCLOSURE }),
    }),
    { params: Promise.resolve({ id: 'mem_x' }) },
  );
  assert.equal(response.status, 401);
});

test('R1 the memory module off answers the module\'s 404 with no model call', async () => {
  const uid = await start({ memory: false });
  const model = answering('x');
  await useModel(model);
  const result = await translate(uid, 'mem_anything');
  assert.equal(result.status, 404, show(result.body));
  assert.equal(result.body.reason, 'feature_unavailable', show(result.body));
  assert.equal(model.calls.length, 0);
});

test('R1 AI disabled answers unavailable with no model call and no reservation', async () => {
  const uid = await start({ aiDisabled: true });
  const [row] = await addRows(uid, [{ content: 'Walks daily', language: 'en' }]);
  const model = answering('بيمشي كل يوم');
  await useModel(model);
  const before = await callsToday(uid, { storage: currentStorage() as any });
  const result = await translate(uid, row!.id);
  assert.equal(result.status, 200, show(result.body));
  assert.deepEqual(result.body.proposal, { status: 'unavailable' });
  assert.equal(model.calls.length, 0);
  assert.deepEqual(await callsToday(uid, { storage: currentStorage() as any }), before);
});

test('R1 no configured provider (none) answers unavailable without a reservation', async () => {
  const uid = await start();
  const [row] = await addRows(uid, [{ content: 'Walks daily', language: 'en' }]);
  // The seam is never installed: the harness's configured provider is `none`.
  const before = await callsToday(uid, { storage: currentStorage() as any });
  const result = await translate(uid, row!.id);
  assert.equal(result.status, 200, show(result.body));
  assert.deepEqual(result.body.proposal, { status: 'unavailable' });
  assert.deepEqual(await callsToday(uid, { storage: currentStorage() as any }), before);
});

test('R1 a superseded or revoked record is 404 with no model call', async () => {
  const uid = await start();
  const rows = await addRows(uid, [{ content: 'Walks daily', language: 'en' }, { content: 'Reads at night', language: 'en' }]);
  const edited = rows.find((r) => r.content === 'Walks daily')!;
  const revoked = rows.find((r) => r.content === 'Reads at night')!;
  const patched = await call(uid, 'memory/[id]', 'PATCH', { params: { id: edited.id }, body: { content: 'Walks every day' } });
  assert.equal(patched.status, 200, show(patched.body));
  const storage = currentStorage() as any;
  const path = (storage.pathsForTests() as string[]).find((candidate) => candidate.endsWith(`/memory/${revoked.id}`))!;
  const record = await storage.get(path);
  await storage.set(path, { ...record, status: 'revoked', revokedAt: new Date().toISOString() });
  const model = answering('x');
  await useModel(model);
  for (const id of [edited.id, revoked.id]) {
    const result = await translate(uid, id);
    assert.equal(result.status, 404, `${id}: ${show(result.body)}`);
  }
  assert.equal(model.calls.length, 0);
});

test('R1 a model answer with an extra field is refused (strict schema): unavailable', async () => {
  const uid = await start();
  const [row] = await addRows(uid, [{ content: 'Walks daily', language: 'en' }]);
  await useModel(scriptedModel(() => ({ text: 'بيمشي كل يوم', note: 'translated' })));
  const result = await translate(uid, row!.id);
  assert.equal(result.status, 200, show(result.body));
  assert.deepEqual(result.body.proposal, { status: 'unavailable' });
});

test('R1 legacy metadata (M6A2-R2-004): eligibility and from follow the text, not the stored language', async () => {
  const uid = await start();
  const rows = await addRows(uid, [
    { content: 'Walks daily', language: 'ar' as any },
    { content: 'بحب الشاي', language: 'en' },
  ]);
  const englishText = rows.find((r) => r.content === 'Walks daily')!;
  const arabicText = rows.find((r) => r.content !== 'Walks daily')!;
  await useModel(answering('بيمشي كل يوم'));
  const ready = await translate(uid, englishText.id);
  assert.equal(ready.status, 200, show(ready.body));
  assert.equal(ready.body.proposal.status, 'ready', show(ready.body));
  assert.equal(ready.body.proposal.from, 'en');
  const already = await translate(uid, arabicText.id);
  assert.equal(already.status, 422, show(already.body));
  assert.equal(already.body.reason ?? already.body.error, 'already_in_language');
});

/* ── validation (each refusal: status unavailable, nothing saved) ───── */

const VALIDATION: Array<[string, string, string, 'ready' | 'unavailable']> = [
  // [case, source (en), proposal (ar), expected]
  ['frequency kept: twice ↔ مرتين', 'Gym twice a week', 'جيم مرتين بالأسبوع', 'ready'],
  ['frequency dropped', 'Gym twice a week', 'جيم بالأسبوع', 'unavailable'],
  ['digits kept', 'Sleeps at 11', 'بينام الساعة 11', 'ready'],
  ['digit changed', 'Sleeps at 11', 'بينام الساعة 12', 'unavailable'],
  ['half an hour ↔ نص ساعة', 'Half an hour commute', 'نص ساعة مشوار', 'ready'],
  ['a quantity added', 'Commutes by bus', 'بيروح بالباص مرتين', 'unavailable'],
  ['English answer for an Arabic target', 'Walks daily', 'Walks every day', 'unavailable'],
  ['a brand inside Arabic is fine', 'Uses Notion for tasks', 'بيستعمل Notion للمهام', 'ready'],
  ['three foreign tokens is too many', 'Uses Notion for tasks', 'بيستعمل Notion and Todoist للمهام', 'unavailable'],
  ['too long (> 2.5×)', 'Walks', 'بيمشي كتير كتير كتير كتير', 'unavailable'],
  // M6A2-R3-005: each quantity class, both ways.
  ['cardinal kept: three ↔ تلات', 'Reads three books a month', 'بيقرا تلات كتب بالشهر', 'ready'],
  ['cardinal dropped', 'Reads three books a month', 'بيقرا كتب بالشهر', 'unavailable'],
  ['ordinal kept: first ↔ أول', 'First coffee at 8', 'أول قهوة الساعة 8', 'ready'],
  ['ordinal dropped', 'First coffee at 8', 'قهوة الساعة 8', 'unavailable'],
  ['once kept: once ↔ مرة', 'Calls mom once a week', 'بيتصل بإمه مرة بالأسبوع', 'ready'],
  ['once turned twice', 'Calls mom once a week', 'بيتصل بإمه مرتين بالأسبوع', 'unavailable'],
  ['quarter kept: quarter ↔ ربع', 'A quarter hour walk', 'مشوار ربع ساعة', 'ready'],
  ['quarter turned half', 'A quarter hour walk', 'مشوار نص ساعة', 'unavailable'],
  ['counted duration kept: two hours ↔ ساعتين', 'Two hours of reading', 'ساعتين قراءة', 'ready'],
  ['counted duration changed: two hours → ساعة', 'Two hours of reading', 'ساعة قراءة', 'unavailable'],
  ['a clitic on a number word: و+تلات', 'Tea and three coffees', 'شاي وتلات قهوات', 'ready'],
  ['a numeric-looking token it cannot classify refuses', 'Wakes at 7', 'بيصحى الساعة 7ish', 'unavailable'],
];

for (const [name, source, proposal, expected] of VALIDATION) {
  test(`R1 validation: ${name} → ${expected}`, async () => {
    const uid = await start();
    const [row] = await addRows(uid, [{ content: source, language: 'en' }]);
    await useModel(answering(proposal));
    const result = await translate(uid, row!.id);
    assert.equal(result.status, 200, show(result.body));
    assert.equal(result.body.proposal.status, expected, show(result.body));
    if (expected === 'unavailable') assert.equal(result.body.proposal.text, undefined);
  });
}

test('R1 Hebrew target: an English fact in a Hebrew account gets a Hebrew proposal; a dropped frequency is refused', async () => {
  for (const [answer, expected] of [['חדר כושר פעמיים בשבוע', 'ready'], ['חדר כושר בשבוע', 'unavailable']] as const) {
    const uid = await start({ locale: 'he' });
    const [row] = await addRows(uid, [{ content: 'Gym twice a week', language: 'en' }]);
    await useModel(answering(answer));
    const result = await translate(uid, row!.id, 'he');
    assert.equal(result.status, 200, show(result.body));
    assert.equal(result.body.proposal.status, expected, show(result.body));
    if (expected === 'ready') assert.deepEqual([result.body.proposal.from, result.body.proposal.to], ['en', 'he']);
    seam?.(null); seam = null;
    if (saved) { for (const key of ENV) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } saved = null; }
    end();
  }
});

test('R1 Arabic → English: an Arabic fact in an English account gets an English proposal; a dropped frequency is refused', async () => {
  for (const [answer, expected] of [['Goes to the gym twice a week', 'ready'], ['Goes to the gym weekly', 'unavailable']] as const) {
    const uid = await start({ locale: 'en' });
    const [row] = await addRows(uid, [{ content: 'بروح الجيم مرتين بالأسبوع', language: 'ar' }]);
    await useModel(answering(answer));
    const result = await translate(uid, row!.id, 'en');
    assert.equal(result.status, 200, show(result.body));
    assert.equal(result.body.proposal.status, expected, show(result.body));
    if (expected === 'ready') assert.deepEqual([result.body.proposal.from, result.body.proposal.to], ['ar', 'en']);
    seam?.(null); seam = null;
    if (saved) { for (const key of ENV) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } saved = null; }
    end();
  }
});

test('R1 other scripts and letterless text (M6A2-R3-002) are 422 not_translatable before any reservation', async () => {
  const uid = await start();
  const rows = await addRows(uid, [
    { content: 'Любит чай', language: 'mixed' }, // Russian: "likes tea"
    { content: '11:30', language: 'mixed' },
  ]);
  const model = answering('x');
  await useModel(model);
  const before = await callsToday(uid, { storage: currentStorage() as any });
  for (const row of rows) {
    const result = await translate(uid, row.id);
    assert.equal(result.status, 422, `${row.content}: ${show(result.body)}`);
    assert.equal(result.body.reason ?? result.body.error, 'not_translatable', show(result.body));
  }
  assert.equal(model.calls.length, 0);
  assert.deepEqual(await callsToday(uid, { storage: currentStorage() as any }), before);
});

test('R1 an aborted request (the panel closed) aborts the provider call and spends nothing more', async () => {
  const uid = await start();
  const [row] = await addRows(uid, [{ content: 'Walks daily', language: 'en' }]);
  let signal: AbortSignal | undefined;
  let attempts = 0;
  const hanging = {
    name: 'gemini',
    generateJson: async (request: any) => { attempts += 1; signal = request.signal; return new Promise<never>(() => {}); },
    generateStructured: async (request: any) => { attempts += 1; signal = request.signal; return new Promise<never>(() => {}); },
  } as unknown as LlmProvider;
  await useModel(hanging);
  const controller = new AbortController();
  const pending = call(uid, 'memory/[id]/translation', 'POST', {
    params: { id: row!.id }, body: { locale: 'ar', disclosureVersion: DISCLOSURE }, signal: controller.signal,
  }).catch((error) => ({ status: 499, body: String(error) }));
  for (let index = 0; index < 50 && signal === undefined; index += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(signal, 'the provider was never called');
  controller.abort();
  const settled = await Promise.race([pending, new Promise((resolve) => setTimeout(() => resolve('hung'), 2_000))]);
  assert.notEqual(settled, 'hung', 'the route kept waiting after the request was aborted');
  assert.equal(signal!.aborted, true, 'the provider signal was not aborted with the request');
  assert.equal(attempts, 1);
});

test('A1 (SIM-M6A2-01) a mixed record is judged by the script with the most letters, not the first one', async () => {
  const uid = await start();
  const rows = await addRows(uid, [
    // Arabic: "M6D uses public transport to the university" — Arabic with a Latin marker first.
    { content: 'M6D بستخدم المواصلات للجامعة', language: 'mixed' },
    // Arabic: "gym twice" — 3 Latin letters, 5 Arabic.
    { content: 'Gym مرتين', language: 'mixed' },
    // English with one Arabic word: "for tasks".
    { content: 'Uses Notion daily للمهام', language: 'mixed' },
  ]);
  const model = answering('بيستعمل Notion كل يوم للمهام');
  await useModel(model);
  const byContent = (text: string) => rows.find((r) => r.content === text)!.id;
  for (const text of ['M6D بستخدم المواصلات للجامعة', 'Gym مرتين']) {
    const result = await translate(uid, byContent(text));
    assert.equal(result.status, 422, `${text}: ${show(result.body)}`);
    assert.equal(result.body.reason ?? result.body.error, 'already_in_language');
  }
  assert.equal(model.calls.length, 0, 'an Arabic-majority fact reached the model');
  const english = await translate(uid, byContent('Uses Notion daily للمهام'));
  assert.equal(english.status, 200, show(english.body));
  assert.equal(english.body.proposal.from, 'en');
});

/* ── budget ─────────────────────────────────────────────────────────── */

async function flush(): Promise<void> {
  for (let index = 0; index < 25; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

test('R1 one attempt of at most 8 s inside 10 s: a model that never answers gives unavailable, its signal aborted, one reservation', async () => {
  const uid = await start();
  const [row] = await addRows(uid, [{ content: 'Walks daily', language: 'en' }]);
  const attempts: Array<{ timeoutMs?: number; signal?: AbortSignal; retry?: boolean }> = [];
  const hanging = {
    name: 'gemini',
    generateJson: async (request: any) => { attempts.push(request); return new Promise<never>(() => {}); },
    generateStructured: async (request: any) => { attempts.push(request); return new Promise<never>(() => {}); },
  } as unknown as LlmProvider;
  await useModel(hanging);
  const before = await callsToday(uid, { storage: currentStorage() as any });
  const started = Date.now();
  mock.timers.reset();
  mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: started });
  try {
    let result: any = null;
    let settledAt: number | null = null;
    translate(uid, row!.id).then((value) => { result = value; settledAt = Date.now(); }, (error) => { result = { status: 599, body: String(error) }; settledAt = Date.now(); });
    for (let passed = 0; passed < 10_000 && result === null; passed += 50) { mock.timers.tick(50); await flush(); }
    assert.ok(result, 'no answer within 10 s');
    assert.ok(settledAt! - started <= 10_000, `answered after ${settledAt! - started} ms`);
    assert.equal(result.status, 200, show(result.body));
    assert.deepEqual(result.body.proposal, { status: 'unavailable' });
    for (let passed = 0; passed < 40_000; passed += 50) { mock.timers.tick(50); await flush(); }
    assert.equal(attempts.length, 1, `expected one attempt, got ${attempts.length}`);
    assert.ok(typeof attempts[0]!.timeoutMs === 'number' && attempts[0]!.timeoutMs <= 8_000, `timeoutMs ${attempts[0]!.timeoutMs}`);
    assert.equal(attempts[0]!.retry, false, 'retry: false was not passed');
    assert.equal(attempts[0]!.signal?.aborted, true, 'the signal was not aborted');
  } finally {
    mock.timers.reset();
  }
  // GB-M6A2-AMEND-1 (Claude, from Codex's build report): read the usage day the
  // reservation was made on; after the reset the clock is no longer pinned.
  const after = await callsToday(uid, { storage: currentStorage() as any, now: new Date(started) });
  assert.equal(after.user - before.user, 1, 'not exactly one reservation');
});

/* ── freshness (M6A2-R006) ─────────────────────────────────────────── */

async function setStaleAfter(uid: string, id: string, staleAfter: string): Promise<void> {
  const storage = currentStorage() as any;
  const path = (storage.pathsForTests() as string[]).find((candidate) => candidate.endsWith(`/memory/${id}`));
  assert.ok(path, `no stored record ${id}`);
  const record = await storage.get(path);
  assert.equal(record.scopeId, uid);
  await storage.set(path, { ...record, staleAfter });
}

test('R1 freshness: a record 1 ms past staleAfter is 404 with no call; 1 ms before, it is translated', async () => {
  const uid = await start();
  const rows = await addRows(uid, [{ content: 'Walks daily', language: 'en' }, { content: 'Reads at night', language: 'en' }]);
  const now = Date.now(); // the harness pins the process clock
  const stale = rows.find((r) => r.content === 'Walks daily')!;
  const fresh = rows.find((r) => r.content === 'Reads at night')!;
  await setStaleAfter(uid, stale.id, new Date(now - 1).toISOString());
  await setStaleAfter(uid, fresh.id, new Date(now + 1).toISOString());
  const model = answering('بيقرا بالليل');
  await useModel(model);
  const expired = await translate(uid, stale.id);
  assert.equal(expired.status, 404, show(expired.body));
  assert.equal(model.calls.length, 0, 'an expired record was sent to the model');
  const live = await translate(uid, fresh.id);
  assert.equal(live.status, 200, show(live.body));
  assert.equal(live.body.proposal.status, 'ready', show(live.body));
});

/* ── release and disclosure ─────────────────────────────────────────── */

test('R1 parity (M6A2-R3-001): /capabilities/m6 keeps exactly { success, searchHistory }, so installed apps keep search', async () => {
  const uid = await start();
  const probe = await call(uid, 'capabilities/m6', 'GET');
  assert.equal(probe.status, 200, show(probe.body));
  assert.deepEqual(Object.keys(probe.body).sort(), ['searchHistory', 'success']);
});

test('R1 the new /capabilities/m6b carries memoryTranslation and the disclosure version: on in staging, false when off or in production; flags.sh pins it', async () => {
  for (const [options, expected] of [[{}, true], [{ on: false }, false], [{ killed: true }, false], [{ environment: 'production' }, false]] as const) {
    const uid = await start(options as any);
    const probe = await call(uid, 'capabilities/m6b', 'GET');
    assert.equal(probe.status, 200, `${JSON.stringify(options)}: ${show(probe.body)}`);
    // M6A2-R4-002: the version the app must have copy for, so a later disclosure bump turns old apps off instead of failing them.
    assert.deepEqual(probe.body, { success: true, memoryTranslation: expected, disclosureVersion: DISCLOSURE }, JSON.stringify(options));
    seam?.(null); seam = null;
    if (saved) { for (const key of ENV) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } saved = null; }
    end();
  }
  const script = fileURLToPath(new URL('../../../infra/cloudrun/flags.sh', import.meta.url));
  const production = execFileSync('bash', [script, 'production'], { encoding: 'utf8' });
  assert.match(production, /MAYBESITTER_FEATURE_MEMORY_TRANSLATION=false/, 'not pinned off for production');
  assert.match(production, /MAYBESITTER_KILL_SWITCH_MEMORY_TRANSLATION=false/);
  const staging = execFileSync('bash', [script, 'staging'], { encoding: 'utf8' });
  assert.match(staging, /MAYBESITTER_FEATURE_MEMORY_TRANSLATION=true/, 'not on for staging');
  assert.match(staging, /MAYBESITTER_KILL_SWITCH_MEMORY_TRANSLATION=false/);
});

test('R1 the disclosure is a versioned claim set', async () => {
  const contracts = await loadModule('src/contracts/v1/consentContracts.ts');
  assert.equal(contracts.MEMORY_TRANSLATION_DISCLOSURE_VERSION, 'memory-translation-disclosure-v1');
  assert.deepEqual(contracts.MEMORY_TRANSLATION_DISCLOSURE_CLAIMS_V1, [
    'what_is_sent:one_stored_memory_fact_you_chose',
    'to_whom:google_cloud_vertex_ai_gemini,via_our_server,eu_region',
    'why:propose_a_translation',
    'what_is_kept:no_text_until_you_save_it,usage_counts_without_text',
  ]);
});

test('R1 an English fact asked for in en is already in language (422)', async () => {
  const uid = await start({ locale: 'en' });
  await setAccount(uid, { locale: 'en' });
  const [row] = await addRows(uid, [{ content: 'Walks daily', language: 'en' }]);
  await useModel(answering('x'));
  const result = await translate(uid, row!.id, 'en');
  assert.equal(result.status, 422, show(result.body));
});

test('R1 no content in logs: neither the stored fact nor the proposal reaches console.*, ready or refused', async () => {
  const uid = await start();
  const rows = await addRows(uid, [{ content: 'Sleeps at 11 secretly', language: 'en' }]);
  const lines: string[] = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const original = methods.map((name) => console[name]);
  methods.forEach((name) => { console[name] = (...args: unknown[]) => { lines.push(args.map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack}` : typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')); }; });
  try {
    await useModel(answering('بينام الساعة 11 بالسر'));
    await translate(uid, rows[0]!.id);
    seam?.(null);
    await useModel(answering('بينام الساعة 12 بالسر')); // refused: the digit changed
    await translate(uid, rows[0]!.id);
  } finally {
    methods.forEach((name, index) => { console[name] = original[index]!; });
  }
  for (const line of lines) {
    assert.ok(!/secretly|بالسر/.test(line), `content in a log line: ${line.slice(0, 120)}`);
  }
});

/* ── review r5 advice (low): usage and the call log on refused answers ── */

test('R1 a refused answer still commits its tokens (M6A2-R5-001): strict-schema refusal and a validator refusal', async () => {
  for (const answer of [() => ({ text: 'بيمشي كل يوم', note: 'x' }), () => ({ text: 'بينام الساعة 12' })]) {
    const uid = await start();
    const [row] = await addRows(uid, [{ content: 'Sleeps at 11', language: 'en' }]);
    await useModel(scriptedModel(answer));
    const before = await callsToday(uid, { storage: currentStorage() as any });
    const result = await translate(uid, row!.id);
    assert.deepEqual(result.body.proposal, { status: 'unavailable' }, show(result.body));
    const after = await callsToday(uid, { storage: currentStorage() as any });
    assert.equal(after.tokens - before.tokens, 20, 'a refused answer\'s tokens were not committed');
    seam?.(null); seam = null;
    if (saved) { for (const key of ENV) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } saved = null; }
    end();
  }
});

function findLlmCall(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.event === 'llm_call' && record.purpose === 'memory_translate') return record;
  for (const child of Object.values(record)) {
    const found = findLlmCall(child);
    if (found) return found;
  }
  return null;
}

test('R1 one sanitized llm_call per answered translation (M6A2-R5-002): purpose, outcome and token counts, no text', async () => {
  const uid = await start();
  const [row] = await addRows(uid, [{ content: 'Walks daily secretly', language: 'en' }]);
  await useModel(answering('بيمشي كل يوم بالسر'));
  const lines: string[] = [];
  const original = console.info;
  console.info = (...args: unknown[]) => { lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')); };
  try {
    const result = await translate(uid, row!.id);
    assert.equal(result.body.proposal?.status, 'ready', show(result.body));
  } finally {
    console.info = original;
  }
  const calls = lines.map((line) => { try { return findLlmCall(JSON.parse(line)); } catch { return null; } }).filter(Boolean) as Array<Record<string, unknown>>;
  assert.equal(calls.length, 1, `expected one memory_translate llm_call, got ${calls.length}`);
  assert.equal(calls[0]!.outcome, 'ok');
  assert.equal(calls[0]!.promptTokens, 10);
  assert.equal(calls[0]!.outputTokens, 10);
  for (const line of lines) assert.ok(!/secretly|بالسر/.test(line), 'content in a log line');
});

test('R1 routine machine records (M6A2-APP-001) are 422 not_translatable before any reservation', async () => {
  const uid = await start();
  const rows = await addRows(uid, [
    { content: 'quiet_hours:22:30-07:30', language: 'en', kind: 'preference' },
    { content: 'sleep_window:23:00-07:00', language: 'en', kind: 'preference' },
  ]);
  const model = answering('x');
  await useModel(model);
  const before = await callsToday(uid, { storage: currentStorage() as any });
  for (const row of rows) {
    const result = await translate(uid, row.id);
    assert.equal(result.status, 422, `${row.content}: ${show(result.body)}`);
    assert.equal(result.body.reason ?? result.body.error, 'not_translatable');
  }
  assert.equal(model.calls.length, 0);
  assert.deepEqual(await callsToday(uid, { storage: currentStorage() as any }), before);
});
