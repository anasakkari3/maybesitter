import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyDomainState, type Commitment, type DomainState } from '../../src/domain/stateMachine.ts';
import { NEXT_STEP_ARMS, NEXT_STEP_EXPERIMENT_ID } from '../../src/contracts/v1/experimentContracts.ts';
import { MODULE_FEATURE_FLAG_DEFAULTS, MODULE_KILL_SWITCH_DEFAULTS } from '../../src/contracts/v1/runtimeControls.ts';
import { selectBaselineNextStep } from '../../lib/services/nextStepBaseline.ts';
import { getLiveNextStep, recordLiveNextStepDecision } from '../../lib/services/nextStepLiveService.ts';
import { appendAnalyticsEvent, getAnalyticsEvents, resetAnalyticsEventsForTests } from '../../lib/analytics/eventStore.ts';
import { NEXT_STEP_EXPERIMENT_ENV, resolveNextStepArm } from '../../lib/experiments/experimentControls.ts';
import { armCandidatesFromDomainState, selectNextStepForArm, selectNextStepForArmFromState } from '../../lib/experiments/nextStepArms.ts';
import { buildBehaviorProfile, kindAffinity, preferredHours, profileIsUsable } from '../../lib/experiments/behaviorProfile.ts';

const NOW = new Date('2026-09-07T18:00:00.000Z');
const ENABLED = { [NEXT_STEP_EXPERIMENT_ENV]: 'true' };

function commitment(id: string, overrides: Partial<Commitment> = {}): Commitment {
  return {
    id, kind: 'task', title: `Step ${id}`, description: null, person: null, status: 'active',
    priority: { level: 'normal', source: 'user_explicit', pressureAllowed: false, pressureLevel: 'none' },
    timeSpec: { kind: 'due_by', dueAt: '2026-09-07T20:00:00.000Z', remindAt: null, timezone: 'UTC' },
    currentAckState: 'aware', postponedUntil: null, createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z', confirmedAt: '2026-09-01T00:00:00.000Z', completedAt: null, droppedAt: null,
    ...overrides,
  };
}

function stateWith(...items: Commitment[]): DomainState {
  return { ...createEmptyDomainState(), commitments: Object.fromEntries(items.map((item) => [item.id, item])) };
}

const armContext = { now: NOW, locale: 'en' as const, proposalId: 'next-step-test', timezone: 'UTC' };

test('arms: the generic arm is byte-identical to the reviewed deterministic baseline', () => {
  const state = stateWith(
    commitment('c1', { timeSpec: { kind: 'due_by', dueAt: '2026-09-06T09:00:00.000Z', remindAt: null, timezone: 'UTC' } }),
    commitment('c2', { priority: { level: 'high', source: 'user_explicit', pressureAllowed: false, pressureLevel: 'none' } }),
    commitment('c3'),
  );
  const candidates = armCandidatesFromDomainState(state);
  const baseline = selectBaselineNextStep(candidates, NOW, 'en', 'next-step-test');
  const generic = selectNextStepForArm('generic', candidates, armContext);

  assert.deepEqual(generic.recommendation, baseline.recommendation);
  assert.equal(generic.selectedCommitmentId, baseline.selectedCommitmentId);
  assert.deepEqual(generic.adjustments, []);
});

test('arms: no arm may propose a commitment the baseline ruled ineligible', () => {
  const state = stateWith(
    commitment('unconfirmed', { confirmedAt: null }),
    commitment('closed', { status: 'completed', completedAt: '2026-09-05T00:00:00.000Z' }),
    commitment('eligible'),
  );
  for (const arm of NEXT_STEP_ARMS) {
    const selection = selectNextStepForArmFromState(arm, state, armContext);
    assert.equal(selection.selectedCommitmentId, 'eligible', `${arm} selected an ineligible commitment`);
    assert.equal(selection.recommendation.primaryStep?.commitmentId, 'eligible');
  }
});

test('arms: every arm keeps the product contract - one step, no persistence, no sensitive inference', () => {
  const state = stateWith(commitment('c1'));
  for (const arm of NEXT_STEP_ARMS) {
    const { recommendation } = selectNextStepForArmFromState(arm, state, armContext);
    assert.equal(recommendation.state, 'ready');
    assert.equal(recommendation.explanation?.sensitiveInferenceUsed, false);
    assert.equal(recommendation.persistence.occurred, false);
    assert.equal(recommendation.persistence.confirmationRequired, true);
    assert.ok(recommendation.explanation!.evidenceLabels.length <= 3);
  }
});

test('arms: the contextual arm prefers a short step late in the day', () => {
  const candidates = [
    { commitmentId: 'long', title: 'Long step', confirmed: true, status: 'active' as const, dueAt: '2026-09-07T20:00:00.000Z', remindAt: null, importance: 'normal' as const, explicitEffortMinutes: 120, kind: 'task' as const },
    { commitmentId: 'short', title: 'Short step', confirmed: true, status: 'active' as const, dueAt: '2026-09-07T20:00:00.000Z', remindAt: null, importance: 'normal' as const, explicitEffortMinutes: 10, kind: 'task' as const },
  ];
  const morning = { ...armContext, now: new Date('2026-09-07T09:00:00.000Z') };
  const evening = { ...armContext, now: new Date('2026-09-07T18:00:00.000Z') };

  assert.equal(selectNextStepForArm('contextual', candidates, evening).selectedCommitmentId, 'short');
  assert.equal(selectNextStepForArm('generic', candidates, evening).selectedCommitmentId, 'short');
  // In the morning the arm stops boosting short work and falls back to baseline ordering.
  assert.equal(
    selectNextStepForArm('contextual', candidates, morning).selectedCommitmentId,
    selectNextStepForArm('generic', candidates, morning).selectedCommitmentId,
  );
  assert.ok(selectNextStepForArm('contextual', candidates, evening).recommendation.explanation!.evidenceLabels.join(' ').length > 0);
});

test('arms: the contextual arm de-prioritizes non-urgent work during quiet hours', () => {
  const candidates = [
    { commitmentId: 'overdue', title: 'Overdue step', confirmed: true, status: 'active' as const, dueAt: '2026-09-06T09:00:00.000Z', remindAt: null, importance: 'low' as const, explicitEffortMinutes: null, kind: 'task' as const },
    { commitmentId: 'later', title: 'Later step', confirmed: true, status: 'active' as const, dueAt: '2026-09-10T09:00:00.000Z', remindAt: null, importance: 'high' as const, explicitEffortMinutes: null, kind: 'task' as const },
  ];
  const quiet = { ...armContext, now: new Date('2026-09-07T23:30:00.000Z') };
  const selection = selectNextStepForArm('contextual', candidates, quiet);

  assert.equal(selection.selectedCommitmentId, 'overdue');
  assert.equal(selection.adjustments.find((item) => item.commitmentId === 'later')?.labels.includes('outside your usual hours'), true);
});

test('arms: the personalized arm falls back until the user has enough of their own history', () => {
  const thin = stateWith(commitment('c1'), commitment('c2', { status: 'completed', completedAt: '2026-09-05T10:00:00.000Z' }));
  const selection = selectNextStepForArmFromState('personalized', thin, armContext);
  assert.equal(selection.fallbackReason, 'insufficient_history');

  const contextual = selectNextStepForArmFromState('contextual', thin, armContext);
  assert.equal(selection.selectedCommitmentId, contextual.selectedCommitmentId);
});

test('arms: the personalized arm prefers the kind this user actually finishes', () => {
  const history = [
    commitment('h1', { kind: 'task', status: 'completed', completedAt: '2026-09-01T14:00:00.000Z' }),
    commitment('h2', { kind: 'task', status: 'completed', completedAt: '2026-09-02T14:00:00.000Z' }),
    commitment('h3', { kind: 'task', status: 'completed', completedAt: '2026-09-03T14:00:00.000Z' }),
    commitment('h4', { kind: 'follow_up', status: 'dropped', droppedAt: '2026-09-01T14:00:00.000Z' }),
    commitment('h5', { kind: 'follow_up', status: 'dropped', droppedAt: '2026-09-02T14:00:00.000Z' }),
    commitment('h6', { kind: 'follow_up', status: 'dropped', droppedAt: '2026-09-03T14:00:00.000Z' }),
  ];
  // Identical open candidates apart from kind, so only the profile can break the tie.
  const state = stateWith(...history, commitment('a-follow', { kind: 'follow_up' }), commitment('b-task', { kind: 'task' }));

  const profile = buildBehaviorProfile(state, 'UTC');
  assert.equal(profileIsUsable(profile), true);
  assert.ok(kindAffinity(profile, 'task') > 0);
  assert.ok(kindAffinity(profile, 'follow_up') < 0);
  assert.deepEqual(preferredHours(profile), [14]);

  const personalized = selectNextStepForArmFromState('personalized', state, armContext);
  assert.equal(personalized.selectedCommitmentId, 'b-task');
  assert.equal(personalized.fallbackReason, null);
  // The generic arm has no reason to prefer either and breaks the tie alphabetically.
  assert.equal(selectNextStepForArmFromState('generic', state, armContext).selectedCommitmentId, 'a-follow');
});

test('arms: personalization reads only this user local history, never message content', () => {
  const state = stateWith(
    commitment('h1', { title: 'Call the hospital about Maya', status: 'completed', completedAt: '2026-09-01T14:00:00.000Z' }),
    commitment('h2', { status: 'completed', completedAt: '2026-09-02T14:00:00.000Z' }),
    commitment('h3', { status: 'dropped', droppedAt: '2026-09-03T14:00:00.000Z' }),
  );
  const profile = buildBehaviorProfile(state, 'UTC');
  assert.doesNotMatch(JSON.stringify(profile), /Maya|hospital|Call/i);
  assert.deepEqual(Object.keys(profile).sort(), ['completionRateByKind', 'completionsByHour', 'observations', 'overallCompletionRate']);
});

test('assignment: the experiment is off unless explicitly enabled', () => {
  assert.deepEqual(resolveNextStepArm('pilot-001', {}), { experimentId: NEXT_STEP_EXPERIMENT_ID, arm: 'generic', enabled: false });
  assert.equal(resolveNextStepArm('pilot-001', { [NEXT_STEP_EXPERIMENT_ENV]: 'false' }).enabled, false);
  assert.equal(resolveNextStepArm('pilot-001', ENABLED).enabled, true);
});

test('assignment: arms are stable per user and cover every arm across the cohort', () => {
  const seen = new Map<string, string>();
  for (let index = 1; index <= 150; index += 1) {
    const user = `pilot-${String(index).padStart(3, '0')}`;
    const arm = resolveNextStepArm(user, ENABLED).arm;
    assert.equal(resolveNextStepArm(user, ENABLED).arm, arm, 'assignment must be stable');
    seen.set(user, arm);
  }
  const counts = NEXT_STEP_ARMS.map((arm) => Array.from(seen.values()).filter((value) => value === arm).length);
  assert.equal(counts.reduce((total, count) => total + count, 0), 150);
  for (const count of counts) assert.ok(count > 0, 'every arm must receive users');
  // No arm should take more than half the cohort under a hash split.
  assert.ok(Math.max(...counts) <= 75);
});

const controls = { version: 'v1' as const, featureFlags: { ...MODULE_FEATURE_FLAG_DEFAULTS, recommendation: true }, killSwitches: { ...MODULE_KILL_SWITCH_DEFAULTS } };

test('assignment integrity: the arm on an event is the arm that produced the proposal', () => {
  const state = stateWith(commitment('c1'));
  for (let index = 1; index <= 12; index += 1) {
    resetAnalyticsEventsForTests();
    const anonymousUserId = `pilot-${String(index).padStart(3, '0')}`;
    const context = {
      anonymousUserId, consent: 'granted' as const, locale: 'en' as const, now: NOW,
      controls, emit: appendAnalyticsEvent, timezone: 'UTC', env: ENABLED,
    };
    const expected = resolveNextStepArm(anonymousUserId, ENABLED).arm;
    const proposal = getLiveNextStep(state, context);
    recordLiveNextStepDecision(proposal, 'accept', context);

    const events = getAnalyticsEvents();
    assert.equal(events.length, 2);
    for (const event of events) {
      assert.equal(event.experiment?.experimentId, NEXT_STEP_EXPERIMENT_ID);
      assert.equal(event.experiment?.arm, expected);
    }
  }
});

test('assignment integrity: a disabled experiment keeps every user on the reviewed baseline', () => {
  resetAnalyticsEventsForTests();
  const state = stateWith(commitment('c1'));
  const context = {
    anonymousUserId: 'pilot-001', consent: 'granted' as const, locale: 'en' as const, now: NOW,
    controls, emit: appendAnalyticsEvent, timezone: 'UTC', env: {},
  };
  const proposal = getLiveNextStep(state, context);
  assert.deepEqual(proposal, selectNextStepForArmFromState('generic', state, { ...armContext, proposalId: proposal.proposalId }).recommendation);
  assert.notEqual(getAnalyticsEvents()[0].experiment?.experimentId, NEXT_STEP_EXPERIMENT_ID);
});

test('cost and latency: every arm records a measurable latency and no model cost', () => {
  resetAnalyticsEventsForTests();
  const state = stateWith(commitment('c1'));
  getLiveNextStep(state, {
    anonymousUserId: 'pilot-002', consent: 'granted' as const, locale: 'en' as const, now: NOW,
    controls, emit: appendAnalyticsEvent, timezone: 'UTC', env: ENABLED,
  });
  const shown = getAnalyticsEvents()[0];
  assert.equal(shown.eventName, 'recommendation_shown');
  assert.equal(typeof shown.properties.latencyMs, 'number');
  assert.ok((shown.properties.latencyMs as number) >= 0);
  assert.equal(shown.properties.costMicros, 0);
});
