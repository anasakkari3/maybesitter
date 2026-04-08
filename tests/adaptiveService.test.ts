import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveAdaptiveSignals,
  getAdaptiveBehavior,
  getAdaptiveBehaviorFromState,
  normalizeAdaptiveSignals,
} from '../lib/services/adaptiveService.ts';
import {
  MemoryBehaviorFeedbackStore,
  recordBehaviorFeedback,
} from '../lib/services/behaviorFeedbackService.ts';
import {
  applyCommand,
  createEmptyDomainState,
  type DomainState,
} from '../src/domain/stateMachine.ts';

const now = '2026-04-08T08:00:00.000Z';

function addActive(
  state: DomainState,
  id: string,
  options: {
    status?: 'active' | 'completed';
    ack?: 'not_seen' | 'ignored' | 'postponed';
  } = {}
): DomainState {
  state = applyCommand(state, {
    type: 'CreateDraft',
    now,
    commitment: {
      id,
      kind: 'task',
      title: `Commitment ${id}`,
      timeSpec: { kind: 'unscheduled', dueAt: null, remindAt: null, timezone: 'UTC' },
    },
    draftStatus: 'pending_confirmation',
  }).newState;
  state = applyCommand(state, {
    type: 'ConfirmCommitment',
    commitmentId: id,
    now,
    reminders: [],
  }).newState;

  if (options.status === 'completed') {
    return applyCommand(state, { type: 'Complete', commitmentId: id, now }).newState;
  }

  const commitment = state.commitments[id];
  if (options.ack === 'ignored') {
    state.commitments[id] = { ...commitment, currentAckState: 'ignored' };
  }
  if (options.ack === 'postponed') {
    state.commitments[id] = {
      ...commitment,
      currentAckState: 'postponed',
      postponedUntil: '2026-04-09T08:00:00.000Z',
    };
  }

  return state;
}

test('adaptiveService: missing data is safe and deterministic', () => {
  const first = getAdaptiveBehavior();
  const second = getAdaptiveBehavior({});

  assert.deepEqual(first, {
    userType: 'disciplined',
    pressureLevel: 'low',
    suggestionStyle: 'minimal',
  });
  assert.deepEqual(second, first);
  assert.deepEqual(normalizeAdaptiveSignals({
    ignoredCommitmentsCount: Number.NaN,
    completionRate: 2,
    delayFrequency: -1,
    clarificationFrequency: null,
  }), {
    ignoredCommitmentsCount: 0,
    completionRate: 1,
    delayFrequency: 0,
    clarificationFrequency: 0,
  });
});

test('adaptiveService: classifies disciplined, inconsistent, and avoidant users', () => {
  assert.deepEqual(getAdaptiveBehavior({
    ignoredCommitmentsCount: 0,
    completionRate: 0.9,
    delayFrequency: 0.05,
    clarificationFrequency: 0.1,
  }), {
    userType: 'disciplined',
    pressureLevel: 'low',
    suggestionStyle: 'minimal',
  });

  assert.deepEqual(getAdaptiveBehavior({
    ignoredCommitmentsCount: 1,
    completionRate: 0.7,
    delayFrequency: 0.2,
    clarificationFrequency: 0.1,
  }), {
    userType: 'inconsistent',
    pressureLevel: 'medium',
    suggestionStyle: 'supportive',
  });

  assert.deepEqual(getAdaptiveBehavior({
    ignoredCommitmentsCount: 3,
    completionRate: 0.9,
    delayFrequency: 0.1,
    clarificationFrequency: 0,
  }), {
    userType: 'avoidant',
    pressureLevel: 'high',
    suggestionStyle: 'direct',
  });
});

test('adaptiveService: derives simple session behavior from DomainState', () => {
  let state = createEmptyDomainState();
  state = addActive(state, 'done', { status: 'completed' });
  state = addActive(state, 'ignored', { ack: 'ignored' });
  state = addActive(state, 'delayed', { ack: 'postponed' });

  const signals = deriveAdaptiveSignals(state, { clarificationFrequency: 0.4 });
  const behavior = getAdaptiveBehaviorFromState(state, { clarificationFrequency: 0.4 });

  assert.deepEqual(signals, {
    ignoredCommitmentsCount: 1,
    completionRate: 1 / 3,
    delayFrequency: 1 / 3,
    clarificationFrequency: 0.4,
  });
  assert.deepEqual(behavior, {
    userType: 'avoidant',
    pressureLevel: 'high',
    suggestionStyle: 'direct',
  });
});

test('adaptiveService: empty DomainState does not overfit absence of history', () => {
  assert.deepEqual(getAdaptiveBehaviorFromState(createEmptyDomainState()), {
    userType: 'disciplined',
    pressureLevel: 'low',
    suggestionStyle: 'minimal',
  });
});

test('adaptiveService: behavior feedback updates classification over time', () => {
  const feedbackStore = new MemoryBehaviorFeedbackStore();
  const date = new Date(now);

  assert.deepEqual(getAdaptiveBehaviorFromState(createEmptyDomainState(), {
    sessionId: 'session-a',
    feedbackStore,
  }), {
    userType: 'disciplined',
    pressureLevel: 'low',
    suggestionStyle: 'minimal',
  });

  recordBehaviorFeedback('suggestion_ignored', { now: date, sessionId: 'session-a', feedbackStore });
  recordBehaviorFeedback('clarification_failed', { now: date, sessionId: 'session-a', feedbackStore });

  assert.deepEqual(getAdaptiveBehaviorFromState(createEmptyDomainState(), {
    sessionId: 'session-a',
    feedbackStore,
  }), {
    userType: 'inconsistent',
    pressureLevel: 'medium',
    suggestionStyle: 'supportive',
  });
});
