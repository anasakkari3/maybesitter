import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyDomainState, type Commitment, type DomainState } from '../../src/domain/stateMachine.ts';
import { NEXT_STEP_ARMS } from '../../src/contracts/v1/experimentContracts.ts';
import type { PreferenceMemory, FactMemory } from '../../src/domain/memory/memoryTypes.ts';
import { armCandidatesFromDomainState, selectNextStepForArm, selectNextStepForArmFromState } from '../../lib/experiments/nextStepArms.ts';

const NOW = new Date('2026-08-17T18:00:00.000Z');

function commitment(id: string, overrides: Partial<Commitment> = {}): Commitment {
  return {
    id, kind: 'task', title: `Step ${id}`, description: null, person: null, status: 'active',
    priority: { level: 'normal', source: 'user_explicit', pressureAllowed: false, pressureLevel: 'none' },
    timeSpec: { kind: 'due_by', dueAt: '2026-08-17T20:00:00.000Z', remindAt: null, timezone: 'UTC' },
    currentAckState: 'aware', postponedUntil: null, createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z', confirmedAt: '2026-08-15T00:00:00.000Z', completedAt: null, droppedAt: null,
    ...overrides,
  };
}

function stateWith(...items: Commitment[]): DomainState {
  return { ...createEmptyDomainState(), commitments: Object.fromEntries(items.map((item) => [item.id, item])) };
}

function makePreference(overrides: Partial<PreferenceMemory> = {}): PreferenceMemory {
  return {
    id: 'pref_1', userId: 'user_1', statement: 'avoid gym three days in a row', scope: 'gym',
    strength: 'hard', polarity: 'avoid', confidence: 0.9, status: 'active',
    createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z', evidenceIds: ['obs_1'],
    ...overrides,
  };
}

function makeFact(overrides: Partial<FactMemory> = {}): FactMemory {
  return {
    id: 'fact_1', userId: 'user_1', statement: 'Wolt shifts pay more', scope: 'wolt',
    confidence: 0.85, status: 'active', createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z',
    evidenceIds: ['obs_1'],
    ...overrides,
  };
}

const armContext = { now: NOW, locale: 'en' as const, proposalId: 'stated-preference-test', timezone: 'UTC' };

test('safety: stated-preference is never in the live-traffic arm list', () => {
  assert.ok(!(NEXT_STEP_ARMS as readonly string[]).includes('stated-preference'));
});

test('regression: with no facts or preferences, stated-preference output equals the baseline exactly', () => {
  const state = stateWith(
    commitment('c1', { timeSpec: { kind: 'due_by', dueAt: '2026-08-16T09:00:00.000Z', remindAt: null, timezone: 'UTC' } }),
    commitment('c2', { priority: { level: 'high', source: 'user_explicit', pressureAllowed: false, pressureLevel: 'none' } }),
    commitment('c3'),
  );
  const candidates = armCandidatesFromDomainState(state);
  const generic = selectNextStepForArm('generic', candidates, armContext);
  const stated = selectNextStepForArm('stated-preference', candidates, armContext, undefined, { preferences: [], facts: [] });

  assert.deepEqual(stated.recommendation, generic.recommendation);
  assert.equal(stated.selectedCommitmentId, generic.selectedCommitmentId);
  assert.equal(stated.fallbackReason, 'no_stated_state');
});

test('no arm may propose a commitment the baseline ruled ineligible, including stated-preference', () => {
  const state = stateWith(
    commitment('unconfirmed', { confirmedAt: null }),
    commitment('closed', { status: 'completed', completedAt: '2026-08-16T00:00:00.000Z' }),
    commitment('eligible'),
  );
  const candidates = armCandidatesFromDomainState(state);
  const selection = selectNextStepForArm('stated-preference', candidates, armContext, undefined, {
    preferences: [makePreference({ scope: 'nonexistent-scope' })],
    facts: [],
  });
  assert.equal(selection.selectedCommitmentId, 'eligible');
});

test('a matching fact contributes a bonus and appears in the decision trace', () => {
  const state = stateWith(
    commitment('wolt-shift', { title: 'Wolt evening shift' }),
    commitment('other-task', { title: 'Unrelated task' }),
  );
  const candidates = armCandidatesFromDomainState(state);
  const selection = selectNextStepForArm('stated-preference', candidates, armContext, undefined, {
    preferences: [],
    facts: [makeFact({ scope: 'wolt' })],
  });
  assert.equal(selection.selectedCommitmentId, 'wolt-shift');
  assert.equal(selection.preferenceTrace?.length, 1);
  assert.equal(selection.preferenceTrace?.[0].effect, 'bonus');
  assert.equal(selection.preferenceTrace?.[0].kind, 'fact');
});

test('a hard avoid preference vetoes an otherwise-selectable candidate', () => {
  const state = stateWith(
    commitment('gym-session', {
      title: 'Gym session',
      timeSpec: { kind: 'due_by', dueAt: '2026-08-16T09:00:00.000Z', remindAt: null, timezone: 'UTC' },
    }),
    commitment('other-task', { title: 'Unrelated task' }),
  );
  const candidates = armCandidatesFromDomainState(state);
  const selection = selectNextStepForArm('stated-preference', candidates, armContext, undefined, {
    preferences: [makePreference({ scope: 'gym', polarity: 'avoid', strength: 'hard' })],
    facts: [],
  });
  assert.notEqual(selection.selectedCommitmentId, 'gym-session');
  assert.equal(selection.selectedCommitmentId, 'other-task');
});

test('a hard avoid preference that vetoes the only eligible candidate does not fall back to selecting it', () => {
  const state = stateWith(commitment('gym-session', { title: 'Gym session' }));
  const candidates = armCandidatesFromDomainState(state);
  const selection = selectNextStepForArm('stated-preference', candidates, armContext, undefined, {
    preferences: [makePreference({ scope: 'gym', polarity: 'avoid', strength: 'hard' })],
    facts: [],
  });
  assert.equal(selection.selectedCommitmentId, null);
  assert.notEqual(selection.selectedCommitmentId, 'gym-session');
  assert.equal(selection.fallbackReason, 'all_vetoed');
  assert.equal(selection.preferenceTrace?.length, 1);
  assert.equal(selection.preferenceTrace?.[0].effect, 'veto');
});

test('a soft avoid preference is a penalty, not a veto: it can still be selected if nothing else is eligible', () => {
  const state = stateWith(commitment('gym-session', { title: 'Gym session' }));
  const candidates = armCandidatesFromDomainState(state);
  const selection = selectNextStepForArm('stated-preference', candidates, armContext, undefined, {
    preferences: [makePreference({ scope: 'gym', polarity: 'avoid', strength: 'soft' })],
    facts: [],
  });
  assert.equal(selection.selectedCommitmentId, 'gym-session');
  assert.equal(selection.preferenceTrace?.[0].effect, 'penalty');
});

test('a superseded preference has no effect even if present in the input list', () => {
  const state = stateWith(commitment('gym-session', { title: 'Gym session' }), commitment('other-task', { title: 'Unrelated task' }));
  const candidates = armCandidatesFromDomainState(state);
  const activeVeto = selectNextStepForArm('stated-preference', candidates, armContext, undefined, {
    preferences: [makePreference({ scope: 'gym', polarity: 'avoid', strength: 'hard', status: 'active' })],
    facts: [],
  });
  const supersededVeto = selectNextStepForArm('stated-preference', candidates, armContext, undefined, {
    preferences: [makePreference({ scope: 'gym', polarity: 'avoid', strength: 'hard', status: 'superseded' })],
    facts: [],
  });
  assert.notEqual(activeVeto.selectedCommitmentId, 'gym-session');
  assert.equal(supersededVeto.selectedCommitmentId, 'gym-session');
});

test('a preference below the confidence floor has no effect', () => {
  const state = stateWith(commitment('gym-session', { title: 'Gym session' }), commitment('other-task', { title: 'Unrelated task' }));
  const candidates = armCandidatesFromDomainState(state);
  const selection = selectNextStepForArm('stated-preference', candidates, armContext, undefined, {
    preferences: [makePreference({ scope: 'gym', polarity: 'avoid', strength: 'hard', confidence: 0.3 })],
    facts: [],
  });
  // Below the 0.5 confidence floor, the preference contributes nothing: no veto, no
  // trace entry. 'gym-session' wins the tie against 'other-task' on baseline ordering
  // alone (alphabetical tiebreak), exactly as if no preference had been recorded.
  assert.equal(selection.preferenceTrace?.length, 0);
  assert.equal(selection.selectedCommitmentId, 'gym-session');
});

test('multiple applicable signals combine in the trace and the total bonus', () => {
  const state = stateWith(
    commitment('wolt-shift', { title: 'Wolt evening shift' }),
    commitment('other-task', { title: 'Unrelated task' }),
  );
  const candidates = armCandidatesFromDomainState(state);
  const selection = selectNextStepForArm('stated-preference', candidates, armContext, undefined, {
    preferences: [makePreference({ id: 'pref_2', scope: 'wolt', polarity: 'prefer', strength: 'soft' })],
    facts: [makeFact({ scope: 'wolt' })],
  });
  assert.equal(selection.selectedCommitmentId, 'wolt-shift');
  assert.equal(selection.preferenceTrace?.length, 2);
});
