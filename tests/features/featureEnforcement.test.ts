/**
 * The model providers obey the feature gate (owner direction, 2026-11-10).
 *
 * A refused feature never reserves a daily slot and never reaches the model;
 * an answered call charges its feature; and in `off` mode the providers do
 * exactly what they did before add-ons existed — no gate read, no ledger write.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { shareLlmProvider } from '../../lib/llm/shareProvider.ts';
import { captureLlmProvider } from '../../lib/llm/captureProvider.ts';
import { quotaScopeFor, retryAfterSecondsFor } from '../../lib/llm/usageGuard.ts';
import { LLMUnavailableError, type LlmProvider } from '../../src/extraction/llm/llmProvider.ts';
import { decideFeature, type FeatureDecision } from '../../lib/features/featureGate.ts';
import { featureHooksFor, msUntilNextMonth, type ProviderFeatureHooks } from '../../lib/features/providerGate.ts';
import { readMonthSpend, recordFeatureSpend } from '../../lib/features/spendLedger.ts';
import { centsToNanoUsd } from '../../lib/features/pricing.ts';
import type { FeatureId } from '../../lib/features/catalog.ts';

const NOW = new Date('2026-11-10T21:00:00.000Z');
const PROMPT = 'SYSTEM:\nsys\nUSER:\nhello';

function counters() {
  const seen = { provider: 0, reserve: 0, commit: 0, spend: [] as Array<[FeatureId, number]> };
  const provider: LlmProvider = {
    name: 'gemini',
    generateJson: async () => { seen.provider++; return { text: '{}', model: 'gemini-2.5-flash', latencyMs: 1, promptTokens: 1000, outputTokens: 100 }; },
    generateStructured: async () => { seen.provider++; return { text: '{}', model: 'gemini-2.5-flash', latencyMs: 1, promptTokens: 1000, outputTokens: 100 }; },
  };
  const base = {
    provider,
    consent: async () => 'granted' as const,
    reserve: async () => { seen.reserve++; return 'ok' as const; },
    commit: async () => { seen.commit++; },
    log: () => {},
    now: () => NOW,
  };
  return { seen, base };
}

function fixedGate(decision: Partial<FeatureDecision>, spend: Array<[FeatureId, number]>): ProviderFeatureHooks {
  return {
    hold: async (_uid, featureId) => ({
      decision: {
        featureId, tier: 'core', mode: 'enforce', allowed: true, enforced: true, reason: 'free_allowance',
        monthlyBudgetCents: 18, spentCents: 0, remainingNanoUsd: 1, ...decision,
      },
      hold: null,
    }),
    recordSpend: async (_uid, featureId, nanoUsd) => { spend.push([featureId, nanoUsd]); },
  };
}

async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const warn = console.warn;
  console.warn = () => {};
  try { return await run(); } finally { console.warn = warn; }
}

const share = (options: Parameters<typeof shareLlmProvider>[1]) =>
  shareLlmProvider('u1', options)({ system: 's', parts: [{ kind: 'text', text: 'hi' }], responseSchema: {} });

test('off mode: both providers call through with no gate read and no ledger write', async () => {
  const previous = process.env.MAYBESITTER_ADDON_GATE_MODE;
  delete process.env.MAYBESITTER_ADDON_GATE_MODE;
  try {
    const { seen, base } = counters();
    const spend: Array<[FeatureId, number]> = [];
    const features: ProviderFeatureHooks = { recordSpend: async (_u, f, n) => { spend.push([f, n]); } };
    await share({ ...base, features });
    await captureLlmProvider('u1', { ...base, features })(PROMPT);
    assert.deepEqual([seen.provider, seen.reserve, seen.commit, spend.length], [2, 2, 2, 0]);
  } finally {
    if (previous === undefined) delete process.env.MAYBESITTER_ADDON_GATE_MODE; else process.env.MAYBESITTER_ADDON_GATE_MODE = previous;
  }
});

test('a spent budget refuses before the daily reservation, as the monthly quota', async () => {
  for (const reason of ['budget_spent', 'free_cap_spent'] as const) {
    const { seen, base } = counters();
    const spend: Array<[FeatureId, number]> = [];
    const features = fixedGate({ allowed: false, reason }, spend);
    await quietly(async () => {
      await assert.rejects(share({ ...base, features }),
        (error: unknown) => error instanceof LLMUnavailableError && error.reason === 'cost_cap:user_monthly');
      await assert.rejects(captureLlmProvider('u1', { ...base, features })(PROMPT),
        (error: unknown) => error instanceof LLMUnavailableError && error.reason === 'cost_cap:user_monthly');
    });
    assert.deepEqual([seen.provider, seen.reserve, seen.commit, spend.length], [0, 0, 0, 0], reason);
  }
});

test('a locked feature and an unreadable gate refuse with their own reasons', async () => {
  const cases: Array<[FeatureDecision['reason'], string]> = [
    ['not_entitled', 'feature_locked'], ['user_off', 'feature_locked'], ['gate_unavailable', 'usage_guard_unavailable'],
  ];
  for (const [reason, expected] of cases) {
    const { seen, base } = counters();
    await quietly(() => assert.rejects(share({ ...base, features: fixedGate({ allowed: false, reason }, []) }),
      (error: unknown) => error instanceof LLMUnavailableError && error.reason === expected));
    assert.equal(seen.provider, 0);
  }
});

test('shadow never refuses; an answered call charges its own feature in n$', async () => {
  const { seen, base } = counters();
  const spend: Array<[FeatureId, number]> = [];
  await share({ ...base, features: fixedGate({ mode: 'shadow', enforced: false, allowed: false, reason: 'budget_spent' }, spend) });
  await share({ ...base, purpose: 'meeting_prep', features: fixedGate({}, spend) });
  await share({ ...base, purpose: 'semantic_observation', features: { ...fixedGate({}, spend), feature: 'gmail_reading' } });
  assert.equal(seen.provider, 3);
  // 1000 input × 300 n$ + 100 output × 2,500 n$ = 550,000 n$ each.
  assert.deepEqual(spend, [['assistant', 550_000], ['meeting_prep', 550_000], ['gmail_reading', 550_000]]);
});

test('end to end on one store: enforce stops a feature at its budget and charges until then', async () => {
  const storage = createMemoryStorage();
  const previous = process.env.MAYBESITTER_ADDON_GATE_MODE;
  process.env.MAYBESITTER_ADDON_GATE_MODE = 'enforce';
  try {
    const { seen, base } = counters();
    const features = featureHooksFor('meeting_prep', storage);
    await share({ ...base, purpose: 'meeting_prep', features });
    assert.equal((await readMonthSpend('u1', { storage, now: NOW })).features.meeting_prep, 550_000);
    await recordFeatureSpend('u1', 'meeting_prep', centsToNanoUsd(2), { storage, now: NOW });
    const decision = await quietly(() => decideFeature('u1', 'meeting_prep', { storage, now: NOW }));
    assert.equal(decision.reason, 'budget_spent');
    await quietly(() => assert.rejects(share({ ...base, purpose: 'meeting_prep', features }), /cost_cap:user_monthly/));
    assert.equal(seen.provider, 1);
  } finally {
    if (previous === undefined) delete process.env.MAYBESITTER_ADDON_GATE_MODE; else process.env.MAYBESITTER_ADDON_GATE_MODE = previous;
  }
});

test('the monthly scope waits until the next UTC month', () => {
  assert.equal(quotaScopeFor('feature_budget'), 'user_monthly');
  assert.equal(retryAfterSecondsFor('user_monthly', new Date('2026-11-30T23:59:00.000Z')), 60);
  assert.equal(msUntilNextMonth(new Date('2026-11-30T23:59:30.000Z')), 60_000);
  assert.equal(msUntilNextMonth(new Date('2026-11-01T00:00:00.000Z')), 30 * 86_400_000);
});

test('holds stop concurrent calls at the budget, settle to the real cost, and release on failure', async () => {
  const storage = createMemoryStorage();
  const previous = process.env.MAYBESITTER_ADDON_GATE_MODE;
  process.env.MAYBESITTER_ADDON_GATE_MODE = 'enforce';
  try {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let reached = 0;
    const slow: LlmProvider = {
      name: 'gemini',
      generateJson: async () => { throw new Error('unused'); },
      generateStructured: async () => {
        reached++;
        await gate;
        return { text: '{}', model: 'gemini-2.5-flash', latencyMs: 1, promptTokens: 1000, outputTokens: 100 };
      },
    };
    const { base } = counters();
    const features = featureHooksFor('meeting_prep', storage);
    // Free meeting prep is 2¢; each call holds its worst case (2,048 output
    // tokens ≈ 0.51¢), so only three fit at once however many are sent.
    const calls = Array.from({ length: 5 }, () => quietly(() => share({
      ...base, provider: slow, purpose: 'meeting_prep', features, maxOutputTokens: undefined,
    } as never).then(() => 'ok', (error: Error) => (error as LLMUnavailableError).reason)));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(reached, 3);
    release();
    const outcomes = await Promise.all(calls);
    assert.deepEqual(outcomes.filter(o => o === 'ok').length, 3);
    assert.deepEqual(outcomes.filter(o => o === 'cost_cap:user_monthly').length, 2);
    const month = await readMonthSpend('u1', { storage, now: NOW });
    assert.equal(month.features.meeting_prep, 3 * 550_000, 'settled to the real cost, not the hold');
    assert.deepEqual(month.holds, {}, 'no hold left behind');

    // A call that fails after its hold gives the hold back.
    const failing: LlmProvider = { ...slow, generateStructured: async () => { throw new Error('boom'); } };
    await quietly(() => assert.rejects(share({ ...base, provider: failing, purpose: 'goal_decomposition',
      features: featureHooksFor('goal_plans', storage) })));
    const after = await readMonthSpend('u1', { storage, now: NOW });
    assert.deepEqual([after.holds, after.features.goal_plans], [{}, undefined]);
  } finally {
    if (previous === undefined) delete process.env.MAYBESITTER_ADDON_GATE_MODE; else process.env.MAYBESITTER_ADDON_GATE_MODE = previous;
  }
});
