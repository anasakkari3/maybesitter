import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { geminiComplete } from '../../scripts/run-profile-eval.ts';
import { geminiOptions } from '../../scripts/run-capture-eval.ts';
import { captureLlmProvider } from '../../lib/llm/captureProvider.ts';
import { consentGatedProvider } from '../../lib/llm/consentGatedProvider.ts';
import { createMemoryStorage, setStorageForTests, resetStorageForTests } from '../../lib/storage/index.ts';
import { getAiConsent, setAiConsent } from '../../lib/consents/aiConsentService.ts';
import { AI_CONSENT_VERSION } from '../../src/contracts/v1/consentContracts.ts';
import { PROFILE_EXTRACTION_SCHEMA, buildProfilePrompt } from '../../src/profile/profilePrompt.ts';
import { GEMINI_EXTRACTION_SCHEMA } from '../../src/extraction/ollamaExtractionSchema.ts';
import { describeProfile } from '../../lib/services/mobile/profileDescribeService.ts';
import { runProfileEvaluation } from '../../src/evaluation/profileEvalRunner.ts';
import { runCaptureEvaluation } from '../../src/evaluation/captureEvalRunner.ts';
import { extract as ruleBasedExtract } from '../../src/extraction/ruleBasedExtractor.ts';
import { LLMUnavailableError, type LlmProvider, type LlmRequest } from '../../src/extraction/llm/index.ts';
import type { ReserveOptions } from '../../lib/llm/usageGuard.ts';

const reply = JSON.stringify({ suggestions: [{ kind: 'goal', category: 'learning', content: 'Finish thesis', confidence: 0.9, targetDate: null }] });
function harness() {
  const calls: LlmRequest[] = [];
  const reservations: { uid: string; options: ReserveOptions }[] = [];
  const commits: string[] = [];
  const provider: LlmProvider = {
    name: 'gemini',
    async generateJson(request) { calls.push(request); return { text: reply, model: 'stub', latencyMs: 0, promptTokens: 1, outputTokens: 2 }; },
    async generateStructured() { throw new Error('unexpected structured call'); },
  };
  return { calls, reservations, commits, dependencies: {
    provider,
    reserve: async (uid: string, _purpose: unknown, options: ReserveOptions = {}) => { reservations.push({ uid, options }); return 'ok' as const; },
    commit: async (uid: string) => { commits.push(uid); },
    log: () => {},
  } };
}
const savedEnv = { ...process.env };
test.beforeEach(() => {
  process.env.MAYBESITTER_LLM_PROVIDER = 'gemini';
  delete process.env.MAYBESITTER_AI_DISABLED;
  setStorageForTests(createMemoryStorage());
});
test.afterEach(() => { process.env = { ...savedEnv }; resetStorageForTests(); });

test('both actual CLI adapters reach the model through two gates without persisted synthetic consent', async () => {
  process.env.MAYBESITTER_EVAL_UID = 'real-user-must-not-be-used';
  for (const kind of ['profile', 'capture']) {
    const h = harness();
    const complete = kind === 'profile' ? await geminiComplete(h.dependencies) : (await geminiOptions(h.dependencies)).llmProvider!;
    await complete(buildProfilePrompt('Finish thesis'));
    const uid = `${kind}-eval-harness`;
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].uid, uid);
    assert.equal(h.calls[0].purpose, `${kind}_extraction`);
    assert.deepEqual(h.calls[0].responseSchema, kind === 'profile' ? PROFILE_EXTRACTION_SCHEMA : GEMINI_EXTRACTION_SCHEMA);
    assert.equal(h.reservations[0].uid, uid);
    assert.deepEqual(h.reservations[0].options, { userCap: Number.MAX_SAFE_INTEGER, globalCap: Number.MAX_SAFE_INTEGER });
    assert.deepEqual(h.commits, [uid]);
    assert.equal(await getAiConsent(uid), 'declined');
    assert.equal(await getAiConsent('real-user-must-not-be-used'), 'declined');
  }
});

test('CLI adapters reject unconfigured or non-Gemini engines', async () => {
  for (const provider of ['none', 'ollama']) {
    process.env.MAYBESITTER_LLM_PROVIDER = provider;
    await assert.rejects(geminiComplete(harness().dependencies), /requires/);
    await assert.rejects(geminiOptions(harness().dependencies), /requires/);
  }
});

test('synthetic adapters retain kill switch and reservation refusal', async () => {
  const h = harness();
  const complete = await geminiComplete(h.dependencies);
  process.env.MAYBESITTER_AI_DISABLED = 'true';
  await assert.rejects(complete('synthetic'), (error: unknown) => error instanceof LLMUnavailableError && error.reason === 'ai_disabled');
  assert.equal(h.calls.length, 0);
  assert.equal(h.reservations.length, 0);
  delete process.env.MAYBESITTER_AI_DISABLED;
  const limited = await geminiComplete({ ...h.dependencies, reserve: async () => 'user_token_cap' });
  await assert.rejects(limited('synthetic'), /cost_cap/);
  assert.equal(h.calls.length, 0);
});

test('production profile composition uses profile schema; revocation still stops before reservation', async () => {
  const h = harness();
  const uid = 'profile-production-test';
  await setAiConsent(uid, { state: 'granted', version: AI_CONSENT_VERSION });
  const complete = captureLlmProvider(uid, { ...h.dependencies, provider: consentGatedProvider(uid, { provider: h.dependencies.provider }), purpose: 'profile_extraction' });
  const proposal = await describeProfile(uid, 'Finish thesis', new Date(), { complete });
  assert.equal(proposal.suggestions.length, 1);
  assert.deepEqual(h.calls[0].responseSchema, PROFILE_EXTRACTION_SCHEMA);
  await setAiConsent(uid, { state: 'declined', version: AI_CONSENT_VERSION });
  await describeProfile(uid, 'Finish thesis', new Date(), { complete });
  assert.equal(h.calls.length, 1);
  assert.equal(h.reservations.length, 1);
});

test('a profile negative-only suite cannot pass on errors, malformed shape, or zero evaluated model responses', async () => {
  const cases = [{ id: 'synthetic', slice: 'sensitive', language: 'en', text: 'synthetic description', expected: { statedGoalKeywords: [], forbiddenSubstrings: [] } }];
  for (const complete of [async () => { throw new Error('private sentinel'); }, async () => '{}']) {
    const report = await runProfileEvaluation(cases, { complete });
    assert.equal(report.pass, false);
    assert.ok(!JSON.stringify(report).includes('private sentinel'));
  }
  assert.equal((await runProfileEvaluation([], { complete: async () => reply })).pass, false);
});

test('a Gemini capture report cannot pass using accurate rule fallback; guarded cases may skip calls', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'capture-provider-'));
  try {
    const datasetPath = join(dir, 'cases.jsonl');
    const cases = [
      { id: 'synthetic', slice: 'gold', message: 'Buy milk.', referenceTime: '2026-07-27T10:00:00+03:00', timezone: 'Asia/Jerusalem', expected: { type: 'task' } },
      { id: 'guard', slice: 'safety_negative', message: 'Yesterday I bought milk.', referenceTime: '2026-07-27T10:00:00+03:00', timezone: 'Asia/Jerusalem', expected: {} },
    ];
    writeFileSync(datasetPath, cases.map(c => JSON.stringify(c)).join('\n'));
    const options = { datasetPath, reportOutputPath: '', engineName: 'gemini', thresholds: { multilingualPassRatePercent: 0, multiItemPassRatePercent: 0 } };
    const unavailable = await runCaptureEvaluation({ ...options, options: { llmEngine: 'gemini', llmProvider: async () => { throw new LLMUnavailableError('provider_error'); } } });
    assert.equal(unavailable.caseResults[0].passed, true); // accurate rules are insufficient evidence
    assert.equal(unavailable.thresholdResults.modelCoveragePassed, false);
    assert.equal(unavailable.overallPassed, false);
    let calls = 0;
    const model = await runCaptureEvaluation({ ...options, options: { llmEngine: 'gemini', llmProvider: async () => {
      calls++;
      return JSON.stringify(ruleBasedExtract(cases[0].message, { now: new Date(cases[0].referenceTime), timezone: cases[0].timezone }));
    } } });
    assert.equal(model.thresholdResults.modelCoveragePassed, true);
    assert.equal(calls, 1); // past-no-action remains a pre-model safety refusal
    writeFileSync(datasetPath, JSON.stringify(cases[1]));
    const guardedOnly = await runCaptureEvaluation({ ...options, options: { llmEngine: 'gemini', llmProvider: async () => { throw new Error('must not call'); } } });
    assert.equal(guardedOnly.thresholdResults.modelCoveragePassed, false);
    assert.equal(guardedOnly.overallPassed, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
