/**
 * Whether a model is asked at all, and what happens to what it says
 * (UC-3.10a, #194).
 *
 * The acceptance criterion here is the *negative* one, and it is asserted the
 * way the issue asks rather than the way that is easy: with `aiProcessing`
 * consent off, the fake provider records **zero calls**. Asserting only that
 * the stored explanation is the template would pass on a system that sent every
 * commitment title to Vertex and then threw the answer away.
 *
 * The rest of the file is the fallback matrix: every way the model can fail to
 * be usable ends in the same deterministic sentence, and the `source` field
 * says which happened so the fallback rate is measurable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import { setAiConsent } from '../../lib/consents/aiConsentService.ts';
import { AI_CONSENT_VERSION } from '../../src/contracts/v1/consentContracts.ts';
import type { LlmProvider, LlmRequest } from '../../src/extraction/llm/llmProvider.ts';
import { LLMUnavailableError } from '../../src/extraction/llm/llmProvider.ts';
import { explainPlan, explanationPrompt } from '../../lib/services/dailyPlan/explanationService.ts';
import { explanationFactsFrom, templateExplanation } from '../../lib/services/dailyPlan/explanationValidator.ts';
import type { Plan } from '../../src/contracts/v1/planningContracts.ts';

const UID = 'user_explain_1';
const TZ = 'Asia/Jerusalem';

const PLAN: Plan = {
  version: 1,
  schema: 'planning-v1',
  scopeId: `${UID}:2026-09-15`,
  horizon: { startsAt: '2026-09-14T21:00:00.000Z', endsAt: '2026-09-15T21:00:00.000Z' },
  scheduled: [
    {
      itemId: 'c1',
      interval: { startsAt: '2026-09-15T06:00:00.000Z', endsAt: '2026-09-15T06:30:00.000Z' },
      reservedInterval: { startsAt: '2026-09-15T06:00:00.000Z', endsAt: '2026-09-15T06:30:00.000Z' },
    },
  ],
  unscheduled: [{ itemId: 'c2', reason: { code: 'NO_FEASIBLE_SLOT', itemId: 'c2', detail: 'no room' } }],
  constraintReasons: [],
  inputDigest: 'digest-1',
} as unknown as Plan;

const TITLES = new Map([['c1', 'Write the summary'], ['c2', 'Call the bank']]);
const FACTS = explanationFactsFrom(PLAN, TITLES, TZ, 'en');

/** A provider that counts every call it receives, and answers what it is told to. */
function fakeProvider(answer: string | Error, delayMs = 0): LlmProvider & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  return {
    name: 'gemini',
    calls,
    async generateJson(request: LlmRequest) {
      calls.push(request);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (answer instanceof Error) throw answer;
      return { text: answer, model: 'fake', latencyMs: 1, promptTokens: 10, outputTokens: 5 };
    },
  };
}

async function withStorage<T>(fn: (storage: StorageAdapter) => Promise<T>): Promise<T> {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  try {
    return await fn(storage);
  } finally {
    resetStorageForTests();
  }
}

const NO_METERING = { reserve: async () => 'ok' as const, commit: async () => {}, log: () => {} };

test('with AI consent off, the provider is never called', async () => {
  await withStorage(async (storage) => {
    // Nothing recorded at all: "missing means declined" is the consent rule.
    const provider = fakeProvider('{"text":"anything"}');
    const outcome = await explainPlan(UID, PLAN, TITLES, FACTS, TZ, {
      storage, provider, ...NO_METERING,
    });

    assert.equal(provider.calls.length, 0, 'a commitment title was sent to a model without consent');
    assert.equal(outcome.explanation.source, 'template');
    assert.equal(outcome.fallbackReason, 'consent_required');
    assert.equal(outcome.explanation.text, templateExplanation(FACTS));
  });
});

test('with consent explicitly declined, the provider is still never called', async () => {
  await withStorage(async (storage) => {
    await setAiConsent(UID, { state: 'declined', version: AI_CONSENT_VERSION }, { storage });
    const provider = fakeProvider('{"text":"anything"}');
    await explainPlan(UID, PLAN, TITLES, FACTS, TZ, { storage, provider, ...NO_METERING });
    assert.equal(provider.calls.length, 0);
  });
});

test('with consent granted, a valid answer is used verbatim', async () => {
  await withStorage(async (storage) => {
    await setAiConsent(UID, { state: 'granted', version: AI_CONSENT_VERSION }, { storage });
    const provider = fakeProvider('{"text":"You have 1 thing at 09:00, and 1 that did not fit."}');
    const outcome = await explainPlan(UID, PLAN, TITLES, FACTS, TZ, { storage, provider, ...NO_METERING });

    assert.equal(provider.calls.length, 1);
    assert.equal(outcome.explanation.source, 'model');
    assert.equal(outcome.explanation.validated, true);
    assert.equal(outcome.explanation.text, 'You have 1 thing at 09:00, and 1 that did not fit.');
  });
});

const REFUSED: Array<[string, string]> = [
  ['a time that is not in the plan', '{"text":"You have 1 thing at 16:45."}'],
  ['an invented title', '{"text":"I placed 1 thing: \\"Collect the parcel\\"."}'],
  ['a §13 forbidden phrase', '{"text":"I placed 1 thing at 09:00. I know you better than you know yourself."}'],
  ['a count the plan does not support', '{"text":"I placed 4 things at 09:00."}'],
  ['an answer that is not the agreed JSON', 'not json at all'],
];

for (const [label, answer] of REFUSED) {
  test(`${label} is replaced by the template`, async () => {
    await withStorage(async (storage) => {
      await setAiConsent(UID, { state: 'granted', version: AI_CONSENT_VERSION }, { storage });
      const provider = fakeProvider(answer);
      const outcome = await explainPlan(UID, PLAN, TITLES, FACTS, TZ, { storage, provider, ...NO_METERING });

      assert.equal(provider.calls.length, 1, 'the model was not even asked');
      assert.equal(outcome.explanation.source, 'template');
      assert.equal(outcome.explanation.text, templateExplanation(FACTS));
      assert.ok(outcome.fallbackReason, 'the fallback was not given a reason, so its rate cannot be measured');
    });
  });
}

test('a provider that never answers falls back once the deadline passes', async () => {
  await withStorage(async (storage) => {
    await setAiConsent(UID, { state: 'granted', version: AI_CONSENT_VERSION }, { storage });
    const provider = fakeProvider('{"text":"too late"}', 50);
    const outcome = await explainPlan(UID, PLAN, TITLES, FACTS, TZ, {
      storage, provider, timeoutMs: 5, ...NO_METERING,
    });
    assert.equal(outcome.explanation.source, 'template');
    assert.equal(outcome.fallbackReason, 'timeout');
  });
});

test('a provider that throws falls back rather than failing the morning', async () => {
  await withStorage(async (storage) => {
    await setAiConsent(UID, { state: 'granted', version: AI_CONSENT_VERSION }, { storage });
    const provider = fakeProvider(new LLMUnavailableError('upstream_500'));
    const outcome = await explainPlan(UID, PLAN, TITLES, FACTS, TZ, { storage, provider, ...NO_METERING });
    assert.equal(outcome.explanation.source, 'template');
    assert.equal(outcome.fallbackReason, 'upstream_500');
  });
});

test('the cost cap falls back without asking the model', async () => {
  await withStorage(async (storage) => {
    await setAiConsent(UID, { state: 'granted', version: AI_CONSENT_VERSION }, { storage });
    const provider = fakeProvider('{"text":"never sent"}');
    const outcome = await explainPlan(UID, PLAN, TITLES, FACTS, TZ, {
      storage,
      provider,
      reserve: async () => 'user_cap' as const,
      commit: async () => {},
      log: () => {},
    });
    assert.equal(provider.calls.length, 0);
    assert.equal(outcome.explanation.source, 'template');
    assert.match(String(outcome.fallbackReason), /^cost_cap:/);
  });
});

test('the prompt carries ids, titles, local times and reason codes — and nothing else', () => {
  const prompt = explanationPrompt(PLAN, TITLES, TZ, 'en');
  assert.match(prompt, /c1 "Write the summary" 09:00-09:30/);
  assert.match(prompt, /c2 NO_FEASIBLE_SLOT/);
  assert.ok(!prompt.includes(UID), 'the prompt names the account');
  assert.ok(!prompt.includes('2026-09-15T06:00'), 'the prompt leaks absolute instants the user never sees');
});
