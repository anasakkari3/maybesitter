/**
 * M5b-1 Gate B — the summary's one end-to-end deadline (PLAN-M5b-1 R1.1
 * "One end-to-end deadline", M5B1-013).
 *
 * Fake timers (`Date`, `setTimeout`, `setInterval`) and a provider fake behind
 * the real `withSingleRetry` wrapper — the shape production installs
 * (`getDefaultProvider()` is `withSingleRetry(gemini)`). The fake behaves like
 * the Gemini adapter: it honours `timeoutMs` (45 s when absent, the
 * structured default), rejects with `LLMUnavailableError('timeout')` when it
 * runs out, and rejects at once when its `signal` aborts.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { LLMUnavailableError, withSingleRetry, type LlmProvider, type LlmResponse } from '../../../src/extraction/llm/index.ts';
import { callsToday } from '../../../lib/llm/usageGuard.ts';
import { addRows, begin, currentStorage, end, show, summary, useSummaryModel, type Raw } from './support.ts';

test.afterEach(() => end());

interface Attempt {
  via: 'generateStructured' | 'generateJson';
  request: any;
  signal: AbortSignal | undefined;
  settledAt: number | null;
}

function adapterLike(behaviour: { answerAtMs?: number | null; rejectAtOnce?: Error }): { provider: LlmProvider; attempts: Attempt[] } {
  const attempts: Attempt[] = [];
  const answer: LlmResponse = { text: JSON.stringify({ sentences: [{ text: 'Likes tea.', refs: ['r1'] }] }), model: 'fake', latencyMs: 1, promptTokens: 5, outputTokens: 5 };
  const attempt = (via: Attempt['via'], defaultTimeout: number) => (request: any): Promise<LlmResponse> => {
    const record: Attempt = { via, request, signal: request.signal, settledAt: null };
    attempts.push(record);
    if (behaviour.rejectAtOnce) {
      record.settledAt = Date.now();
      return Promise.reject(behaviour.rejectAtOnce);
    }
    return new Promise<LlmResponse>((resolve, reject) => {
      const timers: Array<ReturnType<typeof setTimeout>> = [];
      const settle = (fn: () => void) => { timers.forEach(clearTimeout); record.settledAt = Date.now(); fn(); };
      if (behaviour.answerAtMs !== null && behaviour.answerAtMs !== undefined) {
        timers.push(setTimeout(() => settle(() => resolve(answer)), behaviour.answerAtMs));
      }
      timers.push(setTimeout(() => settle(() => reject(new LLMUnavailableError('timeout'))), request.timeoutMs ?? defaultTimeout));
      const signal: AbortSignal | undefined = request.signal;
      if (signal) {
        if (signal.aborted) settle(() => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        else signal.addEventListener('abort', () => settle(() => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))), { once: true });
      }
    });
  };
  const inner: LlmProvider = { name: 'gemini', generateStructured: attempt('generateStructured', 45_000), generateJson: attempt('generateJson', 8_000) } as LlmProvider;
  return { provider: withSingleRetry(inner, { maxRetries: 1, delayMs: () => 300 }), attempts };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 25; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Drives the mocked clock in small steps until `ms` have passed or `done()` holds. */
async function advance(ms: number, done: () => boolean = () => false): Promise<void> {
  const step = 50;
  for (let passed = 0; passed < ms && !done(); passed += step) {
    mock.timers.tick(step);
    await flush();
  }
}

async function withFakeTimers(): Promise<number> {
  const now = Date.now();
  mock.timers.reset();
  mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now });
  return now;
}

async function setup(behaviour: { answerAtMs?: number | null; rejectAtOnce?: Error }) {
  const uid = await begin();
  await addRows(uid, [{ content: 'Likes tea' }]);
  const fake = adapterLike(behaviour);
  await useSummaryModel(fake.provider);
  const before = await callsToday(uid, { storage: currentStorage() as any });
  const started = await withFakeTimers();
  return { uid, fake, before, started };
}

function track(promise: Promise<Raw>): { result: () => Raw | null; settledAt: () => number | null } {
  let result: Raw | null = null;
  let settledAt: number | null = null;
  promise.then((value) => { result = value; settledAt = Date.now(); }, (error) => { result = { status: 599, body: String(error) }; settledAt = Date.now(); });
  return { result: () => result, settledAt: () => settledAt };
}

test('M5B1-013 a provider that never answers: one generateStructured call with retry:false, timeoutMs ≤ 8000 and a signal; unavailable within 10 s; the signal aborted; one reservation', async () => {
  const { uid, fake, before, started } = await setup({ answerAtMs: null });
  const answer = track(summary(uid));
  await advance(10_000, () => answer.result() !== null);
  assert.ok(answer.result(), 'the route had not answered 10 s after the request started');
  assert.ok((answer.settledAt()! - started) <= 10_000, `answered after ${answer.settledAt()! - started} ms`);
  assert.equal(answer.result()!.status, 200, show(answer.result()!.body));
  assert.deepEqual(answer.result()!.body.summary, { status: 'unavailable' });
  await advance(40_000);
  assert.equal(fake.attempts.length, 1, `expected one provider attempt, got ${fake.attempts.length}`);
  const [attempt] = fake.attempts;
  assert.equal(attempt!.via, 'generateStructured', 'the summary must not use generateJson');
  assert.equal(attempt!.request.retry, false, 'retry: false was not passed');
  assert.equal(typeof attempt!.request.timeoutMs, 'number', 'no explicit timeoutMs (the 45 s structured default outlives the budget)');
  assert.ok(attempt!.request.timeoutMs <= 8_000, `timeoutMs ${attempt!.request.timeoutMs} > 8000`);
  assert.ok(attempt!.signal instanceof AbortSignal, 'no signal was passed to the provider');
  assert.equal(attempt!.signal!.aborted, true, 'the signal was not aborted when the attempt / budget ran out');
  const after = await callsToday(uid, { storage: currentStorage() as any });
  assert.equal(after.user - before.user, 1, 'the usage guard did not move by exactly one reservation');
});

test('M5B1-013 a provider that rejects with the retryable timeout reason: still exactly one call, unavailable', async () => {
  const { uid, fake, before } = await setup({ rejectAtOnce: new LLMUnavailableError('timeout') });
  const answer = track(summary(uid));
  await advance(10_000, () => answer.result() !== null);
  assert.ok(answer.result(), 'no answer within the budget');
  assert.deepEqual(answer.result()!.body.summary, { status: 'unavailable' }, show(answer.result()!.body));
  await advance(2_000);
  assert.equal(fake.attempts.length, 1, 'the timeout was retried (drop of retry: false, or a route-level retry)');
  const after = await callsToday(uid, { storage: currentStorage() as any });
  assert.equal(after.user - before.user, 1, 'reserved again on the timeout path');
});

test('M5B1-013 a provider that answers at 9 s: unavailable (the attempt timed out), one call', async () => {
  const { uid, fake } = await setup({ answerAtMs: 9_000 });
  const answer = track(summary(uid));
  await advance(10_000, () => answer.result() !== null);
  assert.ok(answer.result(), 'no answer within the budget');
  assert.deepEqual(answer.result()!.body.summary, { status: 'unavailable' }, `a 9 s answer was accepted: ${show(answer.result()!.body)}`);
  assert.equal(fake.attempts.length, 1);
});

test('M5B1-013 gates and reads that leave less than 2 s of budget: unavailable, no reservation and no call', async () => {
  const { uid, fake, before } = await setup({ answerAtMs: 10 });
  // The memory read takes 8.5 s of the 10 s budget.
  const storage = currentStorage() as any;
  const list = storage.list.bind(storage);
  let slowed = false;
  storage.list = async (path: string, ...rest: unknown[]) => {
    if (!slowed && /\/memory$/.test(path)) {
      slowed = true;
      mock.timers.tick(8_500);
    }
    return list(path, ...rest);
  };
  try {
    const answer = track(summary(uid));
    await advance(10_000, () => answer.result() !== null);
    assert.ok(slowed, 'fixture: the memory rows were not read through storage.list on users/{uid}/memory');
    assert.ok(answer.result(), 'no answer within the budget');
    assert.deepEqual(answer.result()!.body.summary, { status: 'unavailable' }, show(answer.result()!.body));
  } finally {
    storage.list = list;
  }
  assert.equal(fake.attempts.length, 0, 'the model was called with under 2 s of budget left');
  assert.deepEqual(await callsToday(uid, { storage: currentStorage() as any }), before, 'a reservation was made with under 2 s left');
});

test('M5B1-013 the incoming request aborted mid-call: the provider\'s signal is aborted', async () => {
  const { uid, fake } = await setup({ answerAtMs: null });
  const controller = new AbortController();
  const answer = track(summary(uid, 'en', controller.signal));
  await advance(1_000, () => fake.attempts.length > 0);
  assert.equal(fake.attempts.length, 1, 'fixture: the model was not called');
  assert.equal(fake.attempts[0]!.signal?.aborted, false, 'aborted before the app gave up');
  controller.abort();
  await advance(200);
  assert.equal(fake.attempts[0]!.signal?.aborted, true, 'the app gave up but the model call was not cancelled');
  await advance(10_000, () => answer.result() !== null);
});
