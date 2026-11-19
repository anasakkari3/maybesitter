/**
 * QA v3 V3-F34-02 / V3-F34-06: once the person's daily model limit
 * (`usageGuard`: calls or tokens a day) is reached, captures fall back to
 * rules and goal-plan regenerate answers 429 `daily_cap_reached` — in every
 * gate mode — while `/capabilities/features` kept saying `enabled: true`, so
 * «الميزات» said «شغّالة».
 *
 * The list now says so: every feature whose model calls count against that
 * daily limit reads `enabled: false, reason: 'daily_cap_reached'` until the
 * day turns. The gate mode is untouched (production stays `shadow`), the
 * person's own "off" still wins, and features that spend nothing or run on
 * their own counter (Gmail triage, M5a) are not affected.
 *
 * V3-F34-01 (owner decision: shadow logs a spent month, never refuses it): a
 * spent monthly budget under shadow still runs, so the list keeps
 * `enabled: true` there — it must not claim the budget stops anything.
 */
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { begin, call, end } from '../acceptance/m5b/support.ts';
import { reserveCall } from '../../lib/llm/usageGuard.ts';
import { recordFeatureSpend } from '../../lib/features/spendLedger.ts';

const KEYS = ['MAYBESITTER_ADDON_GATE_MODE', 'MAYBESITTER_LLM_DAILY_CALL_CAP', 'MAYBESITTER_LLM_MINUTE_CALL_CAP'] as const;
let saved: Record<string, string | undefined> | null = null;
function env(values: Partial<Record<(typeof KEYS)[number], string>>): void {
  saved ??= Object.fromEntries(KEYS.map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
}
afterEach(() => {
  if (saved) for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved = null;
  end();
});

async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const [warn, error] = [console.warn, console.error];
  console.warn = () => {};
  console.error = () => {};
  try { return await run(); } finally { console.warn = warn; console.error = error; }
}

type Row = { id: string; enabled: boolean; reason: string };
const listed = async (uid: string): Promise<Record<string, Row>> => {
  const answer = await quietly(() => call(uid, 'capabilities/features', 'GET'));
  assert.equal(answer.status, 200);
  return Object.fromEntries((answer.body.features as Row[]).map(row => [row.id, row]));
};
const state = (row: Row | undefined) => row ? [row.enabled, row.reason] : null;

for (const mode of ['shadow', 'enforce'] as const) {
  test(`${mode}: the daily model limit reached says so on every feature it pauses, and nowhere else`, async () => {
    env({ MAYBESITTER_ADDON_GATE_MODE: mode, MAYBESITTER_LLM_DAILY_CALL_CAP: '2', MAYBESITTER_LLM_MINUTE_CALL_CAP: '50' });
    const uid = await begin();
    await quietly(() => call(uid, 'capabilities/features/[id]', 'PUT', { params: { id: 'meeting_prep' }, body: { enabled: false } }));

    const before = await listed(uid);
    assert.deepEqual(state(before.assistant), [true, 'free_allowance']);
    assert.deepEqual(state(before.goal_plans), [true, 'free_allowance']);

    assert.equal(await reserveCall(uid, 'capture_extraction'), 'ok');
    assert.equal(await reserveCall(uid, 'capture_extraction'), 'ok');
    assert.equal(await reserveCall(uid, 'goal_decomposition'), 'user_cap');

    const after = await listed(uid);
    for (const id of ['assistant', 'goal_plans', 'memory_learning']) {
      assert.deepEqual(state(after[id]), [false, 'daily_cap_reached'], `${id} still says it works after the daily limit`);
    }
    // The person's own "off" wins; nothing to pause where nothing spends; Gmail has its own counter.
    assert.deepEqual(state(after.meeting_prep), [false, 'user_off']);
    assert.deepEqual(state(after.football), before.football ? state(before.football) : null);
    assert.deepEqual(state(after.gmail_reading), state(before.gmail_reading));
    // The gate mode is what the deployment set.
    const raw = await quietly(() => call(uid, 'capabilities/features', 'GET'));
    assert.equal(raw.body.mode, mode);
  });
}

test('off: the list is what it always was, whatever the day used', async () => {
  env({ MAYBESITTER_LLM_DAILY_CALL_CAP: '1', MAYBESITTER_LLM_MINUTE_CALL_CAP: '50' });
  delete process.env.MAYBESITTER_ADDON_GATE_MODE;
  const uid = await begin();
  await reserveCall(uid, 'capture_extraction');
  const after = await listed(uid);
  assert.ok(Object.values(after).every(row => row.enabled && row.reason === 'gate_off'));
});

test('V3-F34-01: under shadow a spent month still runs, so the list says enabled (with the reason), never that it stopped', async () => {
  env({ MAYBESITTER_ADDON_GATE_MODE: 'shadow' });
  const uid = await begin();
  await recordFeatureSpend(uid, 'goal_plans', 10_000_000_000);
  const after = await listed(uid);
  assert.deepEqual(state(after.goal_plans), [true, 'budget_spent']);
});
