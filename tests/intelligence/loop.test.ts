import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryStorage, resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { analyzeSource } from '../../lib/intelligence/analyzeSource.ts';
import { putObservations } from '../../lib/intelligence/observationStore.ts';
import { proposeFromObservations, validateSuggestions } from '../../lib/intelligence/proposalEngine.ts';
import { reviewSuggestion } from '../../lib/intelligence/reviewSuggestion.ts';
import { answerIntelligenceQuestion } from '../../lib/intelligence/answerQuestion.ts';
import { loadDomainState } from '../../lib/services/mobile/participantState.ts';
import { createStorageRuntimeMemoryStore } from '../../lib/runtimeMemory/runtimeMemoryStore.ts';
import { intelligenceEnabled } from '../../lib/intelligence/gate.ts';

const NOW = '2026-09-30T10:00:00.000Z';

test('staging gate stays closed in production, even if the feature flag is on', () => {
  // Released to production by the owner on 2026-10-01; the kill switch still
  // wins, and any other environment stays off.
  assert.equal(intelligenceEnabled({ MAYBESITTER_ENV: 'production', MAYBESITTER_FEATURE_PROACTIVE_LOOP: 'true' }), true);
  assert.equal(intelligenceEnabled({ MAYBESITTER_ENV: 'production', MAYBESITTER_FEATURE_PROACTIVE_LOOP: 'true', MAYBESITTER_KILL_SWITCH_PROACTIVE_LOOP: 'true' }), false);
  assert.equal(intelligenceEnabled({ MAYBESITTER_ENV: 'development', MAYBESITTER_FEATURE_PROACTIVE_LOOP: 'true' }), false);
  assert.equal(intelligenceEnabled({ MAYBESITTER_ENV: 'staging', MAYBESITTER_FEATURE_PROACTIVE_LOOP: 'true', MAYBESITTER_KILL_SWITCH_PROACTIVE_LOOP: 'true' }), false);
  assert.equal(intelligenceEnabled({ MAYBESITTER_ENV: 'staging', MAYBESITTER_FEATURE_PROACTIVE_LOOP: 'true' }), true);
});

test('one source yields different information, and no invented fact survives validation', async () => {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  try {
    const input = 'I want to learn React. My exam is tomorrow. Complete the application registration.';
    const observations = await analyzeSource('alice', 'manual', 'note-1', input, NOW, { generate: async () => ({
      text: JSON.stringify({ observations: [
        { kind: 'goal', evidence: 'I want to learn React', confidence: 0.9 },
        { kind: 'event', evidence: 'My exam is tomorrow', confidence: 0.8 },
        { kind: 'request', evidence: 'Complete the application registration', confidence: 0.9 },
        { kind: 'outcome', evidence: 'I finished the exam', confidence: 0.99 },
      ] }), model: 'fake', latencyMs: 1, promptTokens: 1, outputTokens: 1,
    }) });
    assert.deepEqual(observations.map(item => item.kind), ['goal', 'event', 'request']);
    assert.equal((await loadDomainState(storage, 'alice')).commitments['anything'], undefined);
    assert.equal((await analyzeSource('alice', 'manual', 'note-1', input, NOW, { generate: async () => ({
      text: JSON.stringify({ observations: [{ kind: 'goal', evidence: 'I want to learn React', confidence: 0.9 }] }),
      model: 'fake', latencyMs: 1, promptTokens: 1, outputTokens: 1,
    }) })).length, 1);
    assert.equal((await storage.list('users/bob/intelligenceObservations')).length, 0);
  } finally { resetStorageForTests(); }
});

test('an external follow-up keeps the requested workflow stage even when the model restarts it', async () => {
  const storage = createMemoryStorage();
  const [request] = await putObservations('alice', 'gmail', 'mail1', NOW, [{
    kind: 'request', evidence: 'Please complete your job application at the registration link by Friday.', confidence: 0.9,
  }], storage);
  const suggestions = validateSuggestions({ suggestions: [{
    kind: 'action', title: 'Apply for the job', reason: 'You need to submit an application',
    observationIds: [request.id], confidence: 0.8, durationMinutes: 30,
  }] }, [request], NOW);
  assert.equal(suggestions.length, 1);
  assert.match(suggestions[0]!.title, /complete your job application/i);
  assert.doesNotMatch(suggestions[0]!.title, /^Apply for the job$/);
});

test('a time-sensitive event receives a preparation pass when the first pass only warns', async () => {
  const storage = createMemoryStorage();
  const [exam, party] = await putObservations('alice', 'manual', 'note', NOW, [
    { kind: 'event', evidence: 'Exam tomorrow', confidence: 0.9 },
    { kind: 'event', evidence: 'Party tonight', confidence: 0.9 },
  ], storage);
  let calls = 0;
  const suggestions = await proposeFromObservations('alice', NOW, { storage, generate: async () => {
    calls++;
    return { text: JSON.stringify({ suggestions: calls === 1 ? [{
      kind: 'warning', title: 'Consider the party timing', reason: 'Exam tomorrow and party tonight',
      observationIds: [exam.id, party.id], confidence: 0.7, durationMinutes: 0,
    }] : [{
      kind: 'action', title: 'Review exam notes', reason: 'Exam tomorrow',
      observationIds: [exam.id], confidence: 0.8, durationMinutes: 45,
    }] }), model: 'fake', latencyMs: 1, promptTokens: 1, outputTokens: 1 };
  } });
  assert.equal(calls, 2);
  assert.deepEqual(suggestions.map(item => item.kind), ['warning', 'action']);
});

test('multi-step proposal is reviewed before work exists; retries create one action and one goal', async () => {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  try {
    const [goal, exam, party] = await putObservations('alice', 'manual', 'note-2', NOW, [
      { kind: 'goal', evidence: 'I want more Pilates time', confidence: 1 },
      { kind: 'event', evidence: 'Exam tomorrow', confidence: 1 },
      { kind: 'event', evidence: 'Party tonight', confidence: 1 },
    ], storage);
    const suggestions = await proposeFromObservations('alice', NOW, { storage, generate: async () => ({
      text: JSON.stringify({ suggestions: [
        { kind: 'goal', title: 'Practice Pilates more often', reason: 'You want more Pilates time', observationIds: [goal.id], confidence: 0.8, durationMinutes: 0 },
        { kind: 'action', title: 'Review exam topics', reason: 'The exam is tomorrow', observationIds: [exam.id], confidence: 0.85, durationMinutes: 45 },
        { kind: 'question', title: 'How prepared are you for the exam?', reason: 'The party is tonight and readiness is unknown', observationIds: [exam.id, party.id], confidence: 0.7, durationMinutes: 0 },
      ] }), model: 'fake', latencyMs: 1, promptTokens: 1, outputTokens: 1,
    }) });
    assert.equal(suggestions.length, 3);
    assert.equal(Object.keys((await loadDomainState(storage, 'alice')).commitments).length, 0);
    const action = suggestions.find(item => item.kind === 'action')!;
    const acceptedAction = await reviewSuggestion('alice', action.id, 'accept', NOW, storage, { title: 'Review biology topics' });
    assert.equal(acceptedAction?.status, 'accepted');
    assert.equal((await loadDomainState(storage, 'alice')).commitments[acceptedAction!.linkedEntityId!]?.title, 'Review biology topics');
    assert.equal((await reviewSuggestion('alice', action.id, 'accept', NOW, storage))?.linkedEntityId, acceptedAction?.linkedEntityId);
    assert.equal(Object.keys((await loadDomainState(storage, 'alice')).commitments).length, 1);
    const goalSuggestion = suggestions.find(item => item.kind === 'goal')!;
    await reviewSuggestion('alice', goalSuggestion.id, 'accept', NOW, storage);
    await reviewSuggestion('alice', goalSuggestion.id, 'accept', NOW, storage);
    const memories = await createStorageRuntimeMemoryStore(undefined, storage).listAll('alice');
    assert.equal(memories.length, 1);
    assert.equal(memories[0]?.provenance?.origin, 'proactive_suggestion');
    const question = suggestions.find(item => item.kind === 'question')!;
    assert.equal((await answerIntelligenceQuestion('alice', question.id, 'I am prepared', NOW, storage))?.status, 'accepted');
    assert.equal((await answerIntelligenceQuestion('alice', question.id, 'I am prepared', NOW, storage))?.status, 'accepted');
    assert.equal((await storage.list('users/alice/intelligenceObservations')).length, 4);
    const repeated = await proposeFromObservations('alice', '2026-09-30T11:00:00.000Z', { storage, generate: async () => ({
      text: JSON.stringify({ suggestions: suggestions.map(item => ({
        kind: item.kind, title: item.title, reason: item.reason,
        observationIds: item.observationIds, confidence: item.confidence, durationMinutes: item.durationMinutes,
      })) }), model: 'fake', latencyMs: 1, promptTokens: 1, outputTokens: 1,
    }) });
    assert.equal(repeated.find(item => item.id === question.id)?.status, 'accepted');
  } finally { resetStorageForTests(); }
});
