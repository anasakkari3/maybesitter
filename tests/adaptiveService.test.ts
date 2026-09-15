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
    maxPressureLevel: 'high',
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

/**
 * The classifier still tells the three groups apart — that is what the
 * personalization inventory shows the user, and it is a live input to the
 * pressure path rather than a constant. What changed in UC-3.13 (#199,
 * resolves #107) is the *direction* it may move things: `avoidant` used to
 * mean `pressureLevel: 'high'` worded `direct`, so three ignored commitments
 * moved a person to the strongest setting the product had. The field is now
 * `maxPressureLevel` — a cap the pressure path takes a minimum against — so
 * the more avoidant the reading, the lower the ceiling it imposes and the
 * smaller the suggested step. `disciplined` at `'high'` is not a louder
 * reminder; it is the absence of a reduction, bounded by the commitment and
 * the user's own ceiling above it.
 */
test('adaptiveService: classifies disciplined, inconsistent, and avoidant users', () => {
  const disciplined = getAdaptiveBehavior({
    ignoredCommitmentsCount: 0,
    completionRate: 0.9,
    delayFrequency: 0.05,
    clarificationFrequency: 0.1,
  });
  const inconsistent = getAdaptiveBehavior({
    ignoredCommitmentsCount: 1,
    completionRate: 0.7,
    delayFrequency: 0.2,
    clarificationFrequency: 0.1,
  });
  const avoidant = getAdaptiveBehavior({
    ignoredCommitmentsCount: 3,
    completionRate: 0.9,
    delayFrequency: 0.1,
    clarificationFrequency: 0,
  });

  assert.deepEqual(disciplined, {
    userType: 'disciplined',
    maxPressureLevel: 'high',
    suggestionStyle: 'minimal',
  });
  assert.deepEqual(inconsistent, {
    userType: 'inconsistent',
    maxPressureLevel: 'medium',
    suggestionStyle: 'supportive',
  });
  assert.deepEqual(avoidant, {
    userType: 'avoidant',
    maxPressureLevel: 'low',
    suggestionStyle: 'supportive',
  });

  // Stated as a property rather than three literals, so it also fails if a
  // fourth group is added at a higher level: the three groups are genuinely
  // different classifications, and none of them is a louder one.
  assert.deepEqual(
    [disciplined.userType, inconsistent.userType, avoidant.userType],
    ['disciplined', 'inconsistent', 'avoidant'],
  );
  // The cap is monotone in avoidance and strictly so: more avoidance is a
  // lower cap, never a higher one, and the three groups are not collapsed into
  // one value — a classifier folded flat is a classifier nothing can be tested
  // against, which is how the first pass at #199 passed while guaranteeing
  // nothing.
  const rank = { low: 0, medium: 1, high: 2 } as const;
  assert.ok(rank[avoidant.maxPressureLevel] < rank[inconsistent.maxPressureLevel]);
  assert.ok(rank[inconsistent.maxPressureLevel] < rank[disciplined.maxPressureLevel]);
  assert.notEqual(disciplined.suggestionStyle, avoidant.suggestionStyle);
  assert.ok(![disciplined, inconsistent, avoidant].some((b) => b.suggestionStyle === 'direct'));
});

test('adaptiveService: derives simple session behavior from DomainState', async () => {
  let state = createEmptyDomainState();
  state = addActive(state, 'done', { status: 'completed' });
  state = addActive(state, 'ignored', { ack: 'ignored' });
  state = addActive(state, 'delayed', { ack: 'postponed' });

  const signals = await deriveAdaptiveSignals(state, { clarificationFrequency: 0.4 });
  const behavior = await getAdaptiveBehaviorFromState(state, { clarificationFrequency: 0.4 });

  assert.deepEqual(signals, {
    ignoredCommitmentsCount: 1,
    completionRate: 1 / 3,
    delayFrequency: 1 / 3,
    clarificationFrequency: 0.4,
  });
  // One ignore out of three trackable commitments is enough to be read as
  // avoidant. That the label is this easy to earn is why it may not raise
  // pressure (#107).
  assert.deepEqual(behavior, {
    userType: 'avoidant',
    maxPressureLevel: 'low',
    suggestionStyle: 'supportive',
  });
});

test('adaptiveService: empty DomainState does not overfit absence of history', async () => {
  assert.deepEqual(await getAdaptiveBehaviorFromState(createEmptyDomainState()), {
    userType: 'disciplined',
    maxPressureLevel: 'high',
    suggestionStyle: 'minimal',
  });
});

test('adaptiveService: behavior feedback updates classification over time', async () => {
  const feedbackStore = new MemoryBehaviorFeedbackStore();
  const date = new Date(now);

  assert.deepEqual(await getAdaptiveBehaviorFromState(createEmptyDomainState(), {
    sessionId: 'session-a',
    feedbackStore,
  }), {
    userType: 'disciplined',
    maxPressureLevel: 'high',
    suggestionStyle: 'minimal',
  });

  await recordBehaviorFeedback('suggestion_ignored', { now: date, sessionId: 'session-a', feedbackStore });
  await recordBehaviorFeedback('clarification_failed', { now: date, sessionId: 'session-a', feedbackStore });

  assert.deepEqual(await getAdaptiveBehaviorFromState(createEmptyDomainState(), {
    sessionId: 'session-a',
    feedbackStore,
  }), {
    userType: 'inconsistent',
    maxPressureLevel: 'medium',
    suggestionStyle: 'supportive',
  });
});
