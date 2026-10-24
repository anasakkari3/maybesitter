import assert from 'node:assert/strict';
import test from 'node:test';
import { semanticFallback, semanticPrompt, validateSemanticObservations } from '../../lib/intelligence/semantic.ts';

test('keeps different observations from one source, only with exact evidence', () => {
  const source = 'I want to learn React. My exam is Friday. Complete registration for the job.';
  assert.deepEqual(validateSemanticObservations({ observations: [
    { kind: 'goal', evidence: 'I want to learn React', confidence: 0.9 },
    { kind: 'event', evidence: 'My exam is Friday', confidence: 0.8 },
    { kind: 'request', evidence: 'Complete registration for the job', confidence: 0.9 },
    { kind: 'outcome', evidence: 'I failed the exam', confidence: 0.99 },
  ] }, source).map(item => item.kind), ['goal', 'event', 'request']);
});

test('fallback preserves a goal or request without inventing a task', () => {
  assert.equal(semanticFallback('حابب الاقي وقت اتدرب بيلاتيس')[0]?.kind, 'goal');
  assert.equal(semanticFallback('Complete registration for your application')[0]?.kind, 'request');
});

// Live Gemini, 2026-10-24: a shoe-sale newsletter came back as an event and an
// opportunity (and an event forces a preparation suggestion downstream), and
// "Let me know" as a second request beside the real ask.
test('the prompt keeps promotions and a closing "let me know" out of what is addressed to the person', () => {
  const prompt = semanticPrompt();
  assert.match(prompt, /Unsolicited marketing — newsletters, promotions/);
  assert.match(prompt, /not addressed to the person/);
  // Inspection SEM-AUTOMATED-005: a flight change or a failed payment is not marketing.
  assert.match(prompt, /Transactional, service, security, scheduling and account notices about the person/);
  assert.ok(!/automated notices are not addressed/.test(prompt));
  assert.match(prompt, /One ask is one request/);
});

// Staging, 2026-10-24: a long e-mail's answer was cut at 1,024 output tokens
// mid-JSON, so the scan stopped and every resume failed on the same message.
test('the source read leaves room for its answer and asks for at most 12 observations', async () => {
  const { SEMANTIC_MAX_OUTPUT_TOKENS, analyzeSourceStaged } = await import('../../lib/intelligence/analyzeSource.ts');
  assert.ok(SEMANTIC_MAX_OUTPUT_TOKENS >= 2_048);
  assert.match(semanticPrompt(), /at most 12 observations/);
  let requested: number | undefined;
  await analyzeSourceStaged('uid-1', 'gmail', 'Please review the report by Friday.', {
    generate: async (request: { maxOutputTokens?: number }) => { requested = request.maxOutputTokens; return { text: '{"observations":[]}' } as never; },
  } as never);
  assert.equal(requested, SEMANTIC_MAX_OUTPUT_TOKENS);
});
