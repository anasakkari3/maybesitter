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
test('both source reads ask for exactly 2,048 output tokens, and the prompt for at most 12 observations', async () => {
  const { SEMANTIC_MAX_OUTPUT_TOKENS, analyzeSource, analyzeSourceStaged } = await import('../../lib/intelligence/analyzeSource.ts');
  const { createMemoryStorage } = await import('../../lib/storage/memoryAdapter.ts');
  assert.equal(SEMANTIC_MAX_OUTPUT_TOKENS, 2_048);
  assert.match(semanticPrompt(), /at most 12 observations/);
  const asked: number[] = [];
  const generate = async (request: { maxOutputTokens?: number }) => { asked.push(request.maxOutputTokens ?? 0); return { text: '{"observations":[]}' } as never; };
  await analyzeSourceStaged('uid-1', 'gmail', 'Please review the report by Friday.', { generate } as never);
  await analyzeSource('uid-1', 'manual', 'ref-1', 'Please review the report by Friday.', '2026-10-24T10:00:00.000Z',
    { generate, fallbackForManual: false, storage: createMemoryStorage() } as never).catch(() => undefined);
  assert.deepEqual(asked, [2_048, 2_048]);
});

test('an answer cut mid-JSON keeps the whole observations before the cut, and nothing invented', async () => {
  const { parseObservationsAnswer } = await import('../../lib/intelligence/analyzeSource.ts');
  const source = 'Please send the report by Friday. The meeting moved to Monday at 10.';
  const cut = '{"observations":[{"kind":"request","evidence":"Please send the report by Friday","confidence":0.9},{"kind":"event","evidence":"The meeting moved to Monday at 10","confidence":0.8},{"kind":"goal","evidence":"Learn Spa';
  const kept = validateSemanticObservations(parseObservationsAnswer(cut), source);
  assert.deepEqual(kept.map((item) => item.kind), ['request', 'event']);
  assert.throws(() => parseObservationsAnswer('{"observations":[{"kind":"goal","evid'), /source_answer_unreadable/);
  // Inspection Q814-R2-002: only the answer's own shape is salvaged.
  assert.throws(() => parseObservationsAnswer('[{"kind":"commitment","evidence":"Please send the report by Friday","confidence":0.9},'), /source_answer_unreadable/);
  assert.throws(() => parseObservationsAnswer('{"other":[{"kind":"commitment","evidence":"Please send the report by Friday","confidence":0.9},'), /source_answer_unreadable/);
  assert.throws(() => parseObservationsAnswer('Sure! {"observations":[{"kind":"request","evidence":"Please send the report by Friday","confidence":0.9},'), /source_answer_unreadable/);
});

test('one message\'s permit reserves the worst case: 12,000 input characters and the 2,048-token answer', async () => {
  const { M5A_PERMIT_TOKENS } = await import('../../lib/intelligence/m5aGmailScan.ts');
  const { SEMANTIC_MAX_OUTPUT_TOKENS } = await import('../../lib/intelligence/analyzeSource.ts');
  assert.ok(M5A_PERMIT_TOKENS.oneCall >= 6_000 + SEMANTIC_MAX_OUTPUT_TOKENS);
  assert.ok(M5A_PERMIT_TOKENS.twoCalls > M5A_PERMIT_TOKENS.oneCall);
});

// Inspection Q814-R2-001: each slot of a two-call permit holds its own share.
test('a two-call permit reserves the semantic read its full share, and settles each slot by its own', async () => {
  const { reserveQuotaPermit, settleQuotaPermitSlot, startQuotaPermitSlot } = await import('../../lib/llm/usageGuard.ts');
  const { createMemoryStorage } = await import('../../lib/storage/memoryAdapter.ts');
  const storage = createMemoryStorage();
  const now = new Date('2026-10-24T10:00:00.000Z');
  const reserved = await reserveQuotaPermit('uid-slots', 'semantic_observation',
    { owner: 'o', calls: 2, tokenBudget: 11_500, slotBudgets: [9_000, 2_500] }, { storage, now });
  assert.equal(reserved.outcome, 'ok');
  const dayPath = 'users/uid-slots/usage/2026-10-24';
  assert.equal((await storage.get<{ m5aReservedTokens?: number }>(dayPath))?.m5aReservedTokens, 11_500);
  assert.ok(await startQuotaPermitSlot(reserved.permit!, 0, { storage, now }));
  await settleQuotaPermitSlot(reserved.permit!, 0, { promptTokens: 6_000, outputTokens: 2_048 }, { storage, now });
  // The semantic slot's own 9,000 is released, the capture slot's 2,500 still held.
  assert.equal((await storage.get<{ m5aReservedTokens?: number }>(dayPath))?.m5aReservedTokens, 2_500);
});

// Staging, the owner's real mailbox (2026-10-24): job alerts became one
// opportunity per listed job and the jobs' requirements became the person's
// constraints; unsubscribe/do-not-reply lines and a bare date came back too.
test('the prompt keeps job-ad requirements, per-listing opportunities and boilerplate out', () => {
  const prompt = semanticPrompt();
  assert.match(prompt, /requirements in a job advert/);
  assert.match(prompt, /at most one opportunity/);
  assert.match(prompt, /unsubscribe and do-not-reply lines/);
  // Inspection SEM-816-001/002: the subject is content, and no rule drops a
  // notice for being routine (an interview confirmation, a sign-in alert).
  assert.match(prompt, /A subject line is content/);
  assert.ok(!/routine account notice/.test(prompt));
  assert.match(prompt, /Transactional, service, security, scheduling and account notices/);
});

test('evidence with no words — a bare date or number — is dropped', () => {
  const source = 'Updated 24/10/2026. Please confirm the meeting on Monday.';
  const kept = validateSemanticObservations({ observations: [
    { kind: 'event', evidence: '24/10/2026', confidence: 0.9 },
    { kind: 'request', evidence: 'Please confirm the meeting on Monday', confidence: 0.9 },
  ] }, source);
  assert.deepEqual(kept.map((item) => item.kind), ['request']);
  // Words with a time, and Arabic and Hebrew evidence, stay.
  const mixed = 'Call at 10:00 tomorrow. تسليم المشروع الخميس 23:59. הפגישה ב-10 ביום שני.';
  assert.deepEqual(validateSemanticObservations({ observations: [
    { kind: 'request', evidence: 'Call at 10:00 tomorrow', confidence: 0.9 },
    { kind: 'event', evidence: 'تسليم المشروع الخميس 23:59', confidence: 0.9 },
    { kind: 'event', evidence: 'הפגישה ב-10 ביום שני', confidence: 0.9 },
  ] }, mixed).length, 3);
});
