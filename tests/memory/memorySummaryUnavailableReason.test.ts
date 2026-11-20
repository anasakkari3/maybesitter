/**
 * Staging 2026-11-20 (qa-v3-recheck1120): the memory summary answered a bare
 * `{ status: 'unavailable' }` twice and nobody could tell why.
 *
 * The first answer (01:40:55Z) was the per-user minute cap: the account's
 * usage document for that UTC minute already held 8 calls (Firestore read at
 * 01:41:00Z, `minute 01:40, minuteCalls 8`), so `reserveCall` refused and no
 * model was called. The person saw nothing that said "wait a minute".
 *
 * A refusal the person can act on now says which one it is (`reason`), and
 * every `unavailable` writes one content-free log line naming its exit as a
 * fixed code, so the next one can be read from the logs instead of guessed.
 * An answer the validator refused, a provider error and the other exits carry
 * no `reason`: there is nothing the person could do about them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { reserveCall } from '../../lib/llm/usageGuard.ts';
import { readMonthSpend, recordFeatureSpend } from '../../lib/features/spendLedger.ts';
import { setFeaturePreference } from '../../lib/features/accountFeatures.ts';
import { addRows, begin, currentStorage, end, scriptedModel, show, summary, useSummaryModel } from '../acceptance/m5b/support.ts';

test.afterEach(() => end());

const ROW = 'عندي 3 محاضرات كل تلات';
const honest = () => scriptedModel(() => ({ sentences: [{ text: 'عندك 3 محاضرات كل تلات.', refs: ['r1'] }] }));

/** Runs `work` with `console.info` captured; the other channels are quietened. */
async function logged<T>(work: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const [info, warn, error] = [console.info, console.warn, console.error];
  console.info = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  console.warn = () => {};
  console.error = () => {};
  try { return { value: await work(), lines }; } finally {
    console.info = info;
    console.warn = warn;
    console.error = error;
  }
}

/** The summary's own log line: exactly one, content-free, naming its exit. */
function summaryLine(lines: string[], uid: string): Record<string, unknown> {
  const ours = lines.filter((line) => line.includes('"memory_summary"'));
  assert.equal(ours.length, 1, `expected one memory_summary line, got:\n${ours.join('\n')}`);
  const line = ours[0]!;
  assert.ok(!line.includes(uid), 'the raw uid was logged');
  for (const word of ['محاضرات', 'تلات', 'عندك']) assert.ok(!line.includes(word), `memory content was logged: ${line}`);
  return JSON.parse(line) as Record<string, unknown>;
}

async function withEnv<T>(values: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { return await run(); } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('the minute cap answers reason busy_now, with no model call, and logs its exit', async () => {
  const uid = await begin();
  await addRows(uid, [{ content: ROW, language: 'ar' }]);
  const model = honest();
  await useSummaryModel(model);
  for (let index = 0; index < 8; index += 1) await reserveCall(uid, 'capture_extraction', { storage: currentStorage() as any });
  const { value: answer, lines } = await logged(() => summary(uid, 'ar'));
  assert.equal(answer.status, 200, show(answer.body));
  assert.deepEqual(answer.body.summary, { status: 'unavailable', reason: 'busy_now' });
  assert.equal(model.calls.length, 0);
  const line = summaryLine(lines, uid);
  assert.equal(line.event, 'llm_call');
  assert.equal(line.outcome, 'cost_cap');
  assert.equal(line.fallbackReason, 'user_minute_cap');
});

test('the daily call cap answers reason daily_cap, with no model call', async () => {
  await withEnv({ MAYBESITTER_LLM_DAILY_CALL_CAP: '2' }, async () => {
    const uid = await begin();
    await addRows(uid, [{ content: ROW, language: 'ar' }]);
    const model = honest();
    await useSummaryModel(model);
    for (let index = 0; index < 2; index += 1) await reserveCall(uid, 'capture_extraction', { storage: currentStorage() as any });
    const { value: answer, lines } = await logged(() => summary(uid, 'ar'));
    assert.deepEqual(answer.body.summary, { status: 'unavailable', reason: 'daily_cap' }, show(answer.body));
    assert.equal(model.calls.length, 0);
    assert.equal(summaryLine(lines, uid).fallbackReason, 'user_cap');
  });
});

test('a spent monthly allowance for the memory add-on answers reason monthly_cap (enforce)', async () => {
  await withEnv({ MAYBESITTER_ADDON_GATE_MODE: 'enforce' }, async () => {
    const uid = await begin();
    await addRows(uid, [{ content: ROW, language: 'ar' }]);
    const model = honest();
    await useSummaryModel(model);
    // memory_learning's free allowance is 2 cents: spend 3.
    await recordFeatureSpend(uid, 'memory_learning', 30_000_000);
    const { value: answer, lines } = await logged(() => summary(uid, 'ar'));
    assert.deepEqual(answer.body.summary, { status: 'unavailable', reason: 'monthly_cap' }, show(answer.body));
    assert.equal(model.calls.length, 0);
    assert.equal(summaryLine(lines, uid).fallbackReason, 'cost_cap:user_monthly');
  });
});

test('the memory add-on switched off between the route check and the call answers reason not_included', async () => {
  await withEnv({ MAYBESITTER_ADDON_GATE_MODE: 'shadow' }, async () => {
    const uid = await begin();
    await addRows(uid, [{ content: ROW, language: 'ar' }]);
    const model = honest();
    await useSummaryModel(model);
    await setFeaturePreference(uid, 'memory_learning', false);
    // The route answers 404 for a feature the person switched off; the
    // service's own check is the backstop for a switch made mid-request.
    const { buildMemorySummary } = await import('../../lib/services/mobile/memorySummary.ts');
    const controller = new AbortController();
    const { value: result, lines } = await logged(() => buildMemorySummary({
      uid, language: 'ar', signal: controller.signal, abort: () => controller.abort(), startedAt: Date.now(),
    }));
    assert.deepEqual(result, { status: 'unavailable', reason: 'not_included' });
    assert.equal(model.calls.length, 0);
    assert.equal(summaryLine(lines, uid).fallbackReason, 'feature_locked');
  });
});

test('an answer the validator refused has no reason, is logged as schema_invalid, and never carries the text', async () => {
  const uid = await begin();
  await addRows(uid, [{ content: ROW, language: 'ar' }]);
  const model = scriptedModel(() => ({ sentences: [{ text: 'عندك 5 محاضرات كل تلات.', refs: ['r1'] }] }));
  await useSummaryModel(model);
  const { value: answer, lines } = await logged(() => summary(uid, 'ar'));
  assert.deepEqual(answer.body.summary, { status: 'unavailable' }, show(answer.body));
  assert.equal(model.calls.length, 1);
  const line = summaryLine(lines, uid);
  assert.equal(line.outcome, 'schema_invalid');
  assert.equal(line.fallbackReason, 'validator_refused');
  assert.equal(line.promptTokens, 10);
  assert.equal(line.outputTokens, 10);
});

test('a provider that fails has no reason and is logged as provider_error', async () => {
  const uid = await begin();
  await addRows(uid, [{ content: ROW, language: 'ar' }]);
  const model = scriptedModel(() => { throw new Error(`model failed on «${ROW}»`); });
  await useSummaryModel(model);
  const { value: answer, lines } = await logged(() => summary(uid, 'ar'));
  assert.deepEqual(answer.body.summary, { status: 'unavailable' }, show(answer.body));
  const line = summaryLine(lines, uid);
  assert.equal(line.outcome, 'unavailable');
  assert.equal(line.fallbackReason, 'provider_error');
});

test('a ready summary is logged as ok, with no reason anywhere', async () => {
  const uid = await begin();
  await addRows(uid, [{ content: ROW, language: 'ar' }]);
  await useSummaryModel(honest());
  const { value: answer, lines } = await logged(() => summary(uid, 'ar'));
  assert.equal(answer.body.summary?.status, 'ready', show(answer.body));
  assert.equal(answer.body.summary?.reason, undefined);
  const line = summaryLine(lines, uid);
  assert.equal(line.outcome, 'ok');
  assert.equal(line.fallbackReason, undefined);
});

// Review of #885: every exit code against its reason, as a table, so no
// mapping line can change unseen; the codes the person cannot act on have none.
test('each exit code maps to its reason; the rest carry none', async () => {
  const module = await import('../../lib/services/mobile/memorySummary.ts') as Record<string, unknown>;
  const reasonFor = module.memorySummaryUnavailableReasonFor as ((code: string) => string | undefined) | undefined;
  assert.equal(typeof reasonFor, 'function', 'memorySummaryUnavailableReasonFor is not exported');
  const table: Array<[string, string | undefined]> = [
    ['user_minute_cap', 'busy_now'],
    ['user_cap', 'daily_cap'],
    ['user_token_cap', 'daily_cap'],
    ['global_cap', 'daily_cap'],
    ['feature_budget', 'monthly_cap'],
    ['cost_cap:user_monthly', 'monthly_cap'],
    ['feature_locked', 'not_included'],
    ['unavailable', undefined],
    ['usage_guard_unavailable', undefined],
    ['route_budget', undefined],
    ['ai_consent', undefined],
    ['ai_disabled', undefined],
    ['provider_none', undefined],
    ['provider_error', undefined],
    ['timeout', undefined],
    ['validator_refused', undefined],
    ['unparseable', undefined],
    ['toString', undefined],
  ];
  for (const [code, reason] of table) assert.equal(reasonFor!(code), reason, code);
});

test('a call cut by the deadline is logged as timeout, with no reason', async () => {
  const uid = await begin();
  await addRows(uid, [{ content: ROW, language: 'ar' }]);
  const controller = new AbortController();
  const model = scriptedModel(() => { controller.abort(); throw new Error('aborted'); });
  await useSummaryModel(model);
  const { buildMemorySummary } = await import('../../lib/services/mobile/memorySummary.ts');
  const { value: result, lines } = await logged(() => buildMemorySummary({
    uid, language: 'ar', signal: controller.signal, abort: () => controller.abort(), startedAt: Date.now(),
  }));
  assert.deepEqual(result, { status: 'unavailable' });
  const line = summaryLine(lines, uid);
  assert.equal(line.outcome, 'unavailable');
  assert.equal(line.fallbackReason, 'timeout');
});

test('a reservation refused after the add-on hold gives the hold back (enforce)', async () => {
  await withEnv({ MAYBESITTER_ADDON_GATE_MODE: 'enforce' }, async () => {
    const uid = await begin();
    await addRows(uid, [{ content: ROW, language: 'ar' }]);
    const model = honest();
    await useSummaryModel(model);
    for (let index = 0; index < 8; index += 1) await reserveCall(uid, 'capture_extraction', { storage: currentStorage() as any });
    const { value: answer } = await logged(() => summary(uid, 'ar'));
    assert.deepEqual(answer.body.summary, { status: 'unavailable', reason: 'busy_now' }, show(answer.body));
    const month = await readMonthSpend(uid);
    assert.deepEqual(month.holds ?? {}, {}, 'the memory add-on hold was kept after the minute cap refused');
    assert.equal(month.features.memory_learning ?? 0, 0);
  });
});
