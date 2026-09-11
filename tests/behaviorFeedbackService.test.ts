/**
 * Behavioural feedback counters (UC-1.0c, #142).
 *
 * The file-backed case is gone with the file. What it was really checking —
 * that a second handle over the same backend sees the first one's writes — is
 * kept, and is now the thing that actually matters: two Cloud Run instances
 * are two handles over one Firestore, and a counter only one of them can see
 * is the defect this migration exists to remove.
 *
 * The concurrency case is new. The old store read the whole JSON document,
 * incremented, and wrote it back with no isolation, so two increments landing
 * together lost one. An undercounted "ignored" is not a rounding error: it is
 * the signal that decides how hard the assistant pushes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MemoryBehaviorFeedbackStore,
  StorageBehaviorFeedbackStore,
  getBehaviorFeedbackSignals,
  recordBehaviorFeedback,
} from '../lib/services/behaviorFeedbackService.ts';
import { createMemoryStorage } from '../lib/storage/memoryAdapter.ts';

const now = new Date('2026-04-08T08:00:00.000Z');

test('behaviorFeedbackService: records lightweight scoped counters deterministically', async () => {
  const feedbackStore = new MemoryBehaviorFeedbackStore();

  await recordBehaviorFeedback('action_completed', { now, sessionId: 'session-a', feedbackStore });
  await recordBehaviorFeedback('suggestion_ignored', { now, sessionId: 'session-a', feedbackStore });
  await recordBehaviorFeedback('action_delayed', { now, sessionId: 'session-a', feedbackStore });
  await recordBehaviorFeedback('clarification_failed', { now, sessionId: 'session-a', feedbackStore });
  await recordBehaviorFeedback('clarification_succeeded', { now, sessionId: 'session-a', feedbackStore });

  assert.deepEqual(await feedbackStore.get('session-a'), {
    ignoredSuggestions: 1,
    completedActions: 1,
    delayedActions: 1,
    clarificationSuccesses: 1,
    clarificationFailures: 1,
    updatedAt: now.toISOString(),
  });
  assert.deepEqual(await getBehaviorFeedbackSignals({ sessionId: 'session-a', feedbackStore }), {
    ignoredCommitmentsCount: 1,
    completionRate: 1 / 2,
    delayFrequency: 1 / 3,
    clarificationFrequency: 1 / 3,
  });
});

test('behaviorFeedbackService: sessions are isolated and a second handle sees the first handle writes', async () => {
  // One backend, two independent store objects: the simulated restart, and
  // also what two instances serving the same person look like.
  const shared = createMemoryStorage();
  const firstStore = new StorageBehaviorFeedbackStore(shared);
  await recordBehaviorFeedback('suggestion_ignored', { now, sessionId: 'session-a', feedbackStore: firstStore });

  const secondStore = new StorageBehaviorFeedbackStore(shared);
  assert.equal((await secondStore.get('session-a')).ignoredSuggestions, 1);
  assert.equal((await secondStore.get('session-b')).ignoredSuggestions, 0, 'one session read another session counters');
});

test('behaviorFeedbackService: concurrent increments do not lose one', async () => {
  // The defect the file-backed store had: read-modify-write of a whole
  // document with no isolation. Five increments must count five times.
  const feedbackStore = new MemoryBehaviorFeedbackStore();
  await Promise.all(
    Array.from({ length: 5 }, () =>
      recordBehaviorFeedback('suggestion_ignored', { now, sessionId: 'session-race', feedbackStore }),
    ),
  );

  assert.equal(
    (await feedbackStore.get('session-race')).ignoredSuggestions,
    5,
    'a concurrent increment was lost, which is how the old store undercounted',
  );
});

test('behaviorFeedbackService: clearing one scope leaves another intact', async () => {
  const feedbackStore = new MemoryBehaviorFeedbackStore();
  await recordBehaviorFeedback('action_completed', { now, sessionId: 'keep', feedbackStore });
  await recordBehaviorFeedback('action_completed', { now, sessionId: 'drop', feedbackStore });

  await feedbackStore.clear('drop');

  assert.equal((await feedbackStore.get('drop')).completedActions, 0);
  assert.equal((await feedbackStore.get('keep')).completedActions, 1, 'clearing one scope removed another');
});
