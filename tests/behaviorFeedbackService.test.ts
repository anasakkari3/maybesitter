import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  FileBehaviorFeedbackStore,
  MemoryBehaviorFeedbackStore,
  getBehaviorFeedbackSignals,
  recordBehaviorFeedback,
} from '../lib/services/behaviorFeedbackService.ts';

const now = new Date('2026-04-08T08:00:00.000Z');

test('behaviorFeedbackService: records lightweight scoped counters deterministically', () => {
  const feedbackStore = new MemoryBehaviorFeedbackStore();

  recordBehaviorFeedback('action_completed', { now, sessionId: 'session-a', feedbackStore });
  recordBehaviorFeedback('suggestion_ignored', { now, sessionId: 'session-a', feedbackStore });
  recordBehaviorFeedback('action_delayed', { now, sessionId: 'session-a', feedbackStore });
  recordBehaviorFeedback('clarification_failed', { now, sessionId: 'session-a', feedbackStore });
  recordBehaviorFeedback('clarification_succeeded', { now, sessionId: 'session-a', feedbackStore });

  assert.deepEqual(feedbackStore.get('session-a'), {
    ignoredSuggestions: 1,
    completedActions: 1,
    delayedActions: 1,
    clarificationSuccesses: 1,
    clarificationFailures: 1,
    updatedAt: now.toISOString(),
  });
  assert.deepEqual(getBehaviorFeedbackSignals({ sessionId: 'session-a', feedbackStore }), {
    ignoredCommitmentsCount: 1,
    completionRate: 1 / 2,
    delayFrequency: 1 / 3,
    clarificationFrequency: 1 / 3,
  });
});

test('behaviorFeedbackService: sessions are isolated and file-backed state survives recreation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maybesitter-feedback-'));
  try {
    const filePath = join(dir, 'feedback.json');
    const firstStore = new FileBehaviorFeedbackStore(filePath);
    recordBehaviorFeedback('suggestion_ignored', { now, sessionId: 'session-a', feedbackStore: firstStore });

    const secondStore = new FileBehaviorFeedbackStore(filePath);
    assert.equal(secondStore.get('session-a').ignoredSuggestions, 1);
    assert.equal(secondStore.get('session-b').ignoredSuggestions, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
