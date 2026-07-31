import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createEmptyDomainState, type Commitment, type DomainState } from '../../src/domain/stateMachine.ts';
import { getAnalyticsEvents, resetAnalyticsEventsForTests, appendAnalyticsEvent } from '../../lib/analytics/eventStore.ts';
import { getLiveNextStep, recordLiveNextStepDecision } from '../../lib/services/nextStepLiveService.ts';
import { MODULE_FEATURE_FLAG_DEFAULTS, MODULE_KILL_SWITCH_DEFAULTS } from '../../src/contracts/v1/runtimeControls.ts';

const commitment: Commitment = {
  id: 'c1', kind: 'task', title: 'Call Maya', description: null, person: null, status: 'active',
  priority: { level: 'high', source: 'user_explicit', pressureAllowed: false, pressureLevel: 'none' },
  timeSpec: { kind: 'due_by', dueAt: '2026-08-31T10:00:00.000Z', remindAt: null, timezone: 'UTC' },
  currentAckState: 'aware', postponedUntil: null, createdAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-30T00:00:00.000Z', confirmedAt: '2026-08-30T00:00:00.000Z', completedAt: null, droppedAt: null,
};
const state: DomainState = { ...createEmptyDomainState(), commitments: { c1: commitment } };
const controls = (killed = false) => ({ version: 'v1' as const, featureFlags: { ...MODULE_FEATURE_FLAG_DEFAULTS, recommendation: true }, killSwitches: { ...MODULE_KILL_SWITCH_DEFAULTS, recommendation: killed } });
const context = (killed = false) => ({ anonymousUserId: 'pilot-user', consent: 'granted' as const, locale: 'en' as const, now: new Date('2026-08-31T09:00:00.000Z'), controls: controls(killed), emit: appendAnalyticsEvent });

test('V02 live loop: Capture state to recommendation, explanation, decision, and analytics without persistence', () => {
  for (const decision of ['accept', 'edit', 'defer', 'dismiss', 'done'] as const) {
    resetAnalyticsEventsForTests();
    const proposal = getLiveNextStep(state, context());
    assert.equal(proposal.state, 'ready');
    assert.ok(proposal.explanation?.summary);
    const outcome = recordLiveNextStepDecision(proposal, decision, context(), decision === 'edit' ? 'Call Maya tomorrow' : undefined);
    assert.equal(outcome.persisted, false);
    assert.deepEqual(getAnalyticsEvents().map((event) => event.eventName), ['recommendation_shown', `recommendation_${decision === 'accept' ? 'accepted' : decision === 'edit' ? 'edited' : decision === 'defer' ? 'deferred' : decision === 'dismiss' ? 'dismissed' : 'completed'}`]);
  }
});

test('V02 kill switch blocks recommendation and decisions while Capture remains untouched', () => {
  resetAnalyticsEventsForTests();
  const proposal = getLiveNextStep(state, context(true));
  assert.equal(proposal.state, 'insufficient_evidence');
  assert.equal(getAnalyticsEvents().length, 0);
  assert.throws(() => recordLiveNextStepDecision({ ...proposal, state: 'ready', availableActions: ['accept'] }, 'accept', context(true)), /kill_switch_active/);
});

test('V02 live loop preserves English, Arabic, and Hebrew locale contracts', () => {
  for (const locale of ['en', 'ar', 'he'] as const) {
    resetAnalyticsEventsForTests();
    const proposal = getLiveNextStep(state, { ...context(), locale });
    assert.equal(proposal.locale, locale);
    assert.equal(proposal.state, 'ready');
    assert.ok(proposal.explanation?.summary);
  }
});

test('V02 route is mounted and the operational owner and rollback controls are explicit', () => {
  const assistant = readFileSync('src/app/assistant/page.tsx', 'utf8');
  const runbook = readFileSync('docs/operations/V02_PILOT_RUNBOOK.md', 'utf8');
  assert.match(assistant, /<NextStepPanel/);
  assert.match(runbook, /Operational owner: \*\*Anas Akkari\*\*/);
  assert.match(runbook, /MAYBESITTER_KILL_SWITCH_RECOMMENDATION=true/);
  assert.match(runbook, /approve rollback/);
});
