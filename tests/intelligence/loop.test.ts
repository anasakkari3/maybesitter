import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryStorage, resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { analyzeSource } from '../../lib/intelligence/analyzeSource.ts';
import { observationId, putObservations, reviewObservation } from '../../lib/intelligence/observationStore.ts';
import { groundCommitmentReasons, hideSavedGoalProposals, proposeFromObservations, validateSuggestions } from '../../lib/intelligence/proposalEngine.ts';
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

test('a generated reason cannot move the time of confirmed work it cites', async () => {
  const storage = createMemoryStorage();
  const [saved] = await putObservations('alice', 'commitment', 'meeting-1', NOW, [{
    kind: 'commitment', evidence: 'موعد سامي', confidence: 1,
  }], storage);
  const [suggestion] = validateSuggestions({ suggestions: [{
    kind: 'action', title: 'أكّد موعد سامي', reason: 'موعد سامي الساعة 6 المسا',
    observationIds: [saved!.id], confidence: 0.8, durationMinutes: 15,
  }] }, [saved!], NOW);
  const [grounded] = groundCommitmentReasons([suggestion!], [saved!], [{
    id: 'meeting-1', title: 'موعد سامي', timeSpec: { dueAt: '2026-09-30T16:00:00.000Z' },
  }], 'Asia/Jerusalem');
  assert.match(grounded!.reason, /19:00/);
  assert.doesNotMatch(grounded!.reason, /6 المسا/);
});

test('a saved goal becomes evidence for steps, never a second goal proposal', async () => {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  try {
    const [goal] = await putObservations('alice', 'manual', 'note-react', NOW, [
      { kind: 'goal', evidence: 'I want to learn React', confidence: 0.95 },
    ], storage);
    const confirmed = await reviewObservation('alice', goal!.id, 'confirmed', NOW, storage);
    assert.ok(confirmed?.linkedMemoryId);
    const oldPending = validateSuggestions({ suggestions: [{
      kind: 'goal', title: 'تعلّم React', reason: 'عندك هدف إنك تتعلّم React',
      observationIds: [goal!.id], confidence: 0.9, durationMinutes: 0,
    }] }, [goal!], NOW);
    assert.equal(hideSavedGoalProposals(oldPending, [confirmed!]).length, 0,
      'an older pending copy must leave the inbox after the goal is saved');
    let modelInput = '';
    const suggestions = await proposeFromObservations('alice', '2026-09-30T10:05:00.000Z', { storage, generate: async request => {
      modelInput = JSON.stringify(request.parts);
      return { text: JSON.stringify({ suggestions: [
        { kind: 'goal', title: 'تعلّم React', reason: 'عندك هدف إنك تتعلّم React', observationIds: [goal!.id], confidence: 0.9, durationMinutes: 0 },
        { kind: 'action', title: 'اختار درس React للمبتدئين', reason: 'خطوة أولى لهدفك', observationIds: [goal!.id], confidence: 0.8, durationMinutes: 30 },
      ] }), model: 'fake', latencyMs: 1, promptTokens: 1, outputTokens: 1 };
    } });
    assert.deepEqual(suggestions.map(item => item.kind), ['action']);
    assert.equal(modelInput.split(goal!.id).length - 1, 1,
      'the confirmed statement should enter the observations only once');
    assert.ok(!modelInput.includes(observationId('memory', confirmed.linkedMemoryId!, {
      kind: 'goal', evidence: 'I want to learn React', confidence: 0.95,
    })), 'the canonical copy must not appear as a second observation');
  } finally { resetStorageForTests(); }
});

test('a goal-only first pass gets one bounded second pass for concrete steps', async () => {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  try {
    const [goal] = await putObservations('alice', 'manual', 'note-pilates', NOW, [
      { kind: 'goal', evidence: 'I want more time for Pilates', confidence: 0.9 },
    ], storage);
    await reviewObservation('alice', goal!.id, 'confirmed', NOW, storage);
    const systems: string[] = [];
    const suggestions = await proposeFromObservations('alice', '2026-09-30T10:10:00.000Z', { storage, generate: async request => {
      systems.push(String(request.system));
      const rows = systems.length === 1 ? [
        { kind: 'goal', title: 'Practice Pilates', reason: 'You want more time for Pilates',
          observationIds: [goal!.id], confidence: 0.8, durationMinutes: 0 },
      ] : [
        { kind: 'action', title: 'Find a nearby Pilates class', reason: 'Start with a class option',
          observationIds: [goal!.id], confidence: 0.8, durationMinutes: 30 },
        { kind: 'action', title: 'Choose one open practice slot', reason: 'Reserve time after finding a class',
          observationIds: [goal!.id], confidence: 0.8, durationMinutes: 15 },
      ];
      return { text: JSON.stringify({ suggestions: rows }), model: 'fake', latencyMs: 1, promptTokens: 1, outputTokens: 1 };
    } });
    assert.equal(systems.length, 2);
    assert.match(systems[1]!, /Do not propose saving the goal again/);
    assert.deepEqual(suggestions.map(item => item.title), [
      'Find a nearby Pilates class', 'Choose one open practice slot',
    ]);
    assert.deepEqual(suggestions.map(item => item.position), [0, 1]);
  } finally { resetStorageForTests(); }
});

test('a time-sensitive event receives a preparation pass when the first pass only warns', async () => {
  const storage = createMemoryStorage();
  const [exam, party] = await putObservations('alice', 'manual', 'note', NOW, [
    { kind: 'event', evidence: 'Exam tomorrow', confidence: 0.9 },
    { kind: 'event', evidence: 'Party tonight', confidence: 0.9 },
  ], storage);
  let calls = 0;
  const systems: string[] = [];
  const suggestions = await proposeFromObservations('alice', NOW, { storage, generate: async (request: { system?: string }) => {
    calls++;
    systems.push(String(request?.system ?? ''));
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
  // Both passes carry the spoken-Arabic rule: real Gemini wrote formal MSA
  // («لديك… غداً… قد يؤثر») under a bare "Levantine" (staging, 2026-10-01).
  assert.equal(systems.length, 2);
  for (const system of systems) {
    assert.ok(system.includes('عندك not لديك'), 'a pass lost the Levantine register rule');
    assert.ok(system.includes('بكرا not غداً'), 'a pass lost the Levantine register rule');
  }
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
