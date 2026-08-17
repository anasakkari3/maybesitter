import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import { createEmptyDomainState, type Commitment, type DomainState } from '../../src/domain/stateMachine.ts';
import { NEXT_STEP_ARMS } from '../../src/contracts/v1/experimentContracts.ts';
import type { PreferenceMemory, FactMemory } from '../../src/domain/memory/memoryTypes.ts';
import { ingestMessage, type MemoryIngestionServiceDeps } from '../../src/services/memoryIngestionService.ts';
import { FileObservationStore } from '../../src/domain/memory/observationStore.ts';
import { FileCommitmentMemoryStore } from '../../src/domain/memory/commitmentMemoryStore.ts';
import { FilePreferenceMemoryStore } from '../../src/domain/memory/preferenceMemoryStore.ts';
import { FileFactMemoryStore } from '../../src/domain/memory/factMemoryStore.ts';
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
    requiresConfirmation: false,
    ...overrides,
  };
}

function makeFact(overrides: Partial<FactMemory> = {}): FactMemory {
  return {
    id: 'fact_1', userId: 'user_1', statement: 'Wolt shifts pay more', scope: 'wolt',
    confidence: 0.85, status: 'active', createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z',
    evidenceIds: ['obs_1'], requiresConfirmation: false,
    ...overrides,
  };
}

const armContext = { now: NOW, locale: 'en' as const, proposalId: 'stated-preference-test', timezone: 'UTC' };

/**
 * Some benchmark scenarios only mean anything end to end — "landed in the confirm band"
 * and "produced an audit event" are properties of ingestion, and the point of the scenario
 * is what the arm then does with the result. Those run against real file-backed stores.
 */
function withIngestion(fn: (deps: MemoryIngestionServiceDeps) => void): void {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'maybesitter-stated-arm-test-'));
  try {
    fn({
      observationStore: new FileObservationStore(tmpDir),
      commitmentStore: new FileCommitmentMemoryStore(tmpDir),
      preferenceStore: new FilePreferenceMemoryStore(tmpDir),
      factStore: new FileFactMemoryStore(tmpDir),
    });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Two candidates the baseline scores identically, so ordering is decided purely by the
 * stated-preference signal. The ids are chosen so the baseline's alphabetical tiebreak
 * favours 'a-errand': anything selecting 'b-*' did so on the stated statement alone.
 */
function tiedPairState(matchingTitle: string): DomainState {
  return stateWith(
    commitment('a-errand', { title: 'Unrelated errand' }),
    commitment('b-match', { title: matchingTitle }),
  );
}

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

test('thesis: an explicit fact breaks a tie that baseline and personalized cannot break', () => {
  // Two candidates, identical in every dimension the baseline scores on (urgency,
  // importance, effort) — a genuine tie. No completion history exists, so the
  // personalized arm has nothing to learn from and falls back to the tie.
  const state = stateWith(
    commitment('a-task', { title: 'Wolt evening shift' }),
    commitment('b-task', { title: 'Unrelated errand' }),
  );
  const candidates = armCandidatesFromDomainState(state);

  const generic = selectNextStepForArm('generic', candidates, armContext);
  const personalized = selectNextStepForArmFromState('personalized', state, armContext);
  const stated = selectNextStepForArm('stated-preference', candidates, armContext, undefined, {
    preferences: [],
    facts: [makeFact({ scope: 'wolt', statement: 'Wolt shifts pay more than other work right now' })],
  });

  // Baseline and personalized break the tie alphabetically ('a-task' < 'b-task');
  // neither has any signal that distinguishes Wolt work as more valuable. On this
  // fixture the fact happens to point at 'a-task' too, so all three agree — that
  // agreement is NOT the divergence claim, it is only the setup.
  assert.equal(generic.selectedCommitmentId, 'a-task');
  assert.equal(personalized.selectedCommitmentId, 'a-task');
  assert.equal(stated.selectedCommitmentId, 'a-task');

  // The real claim: reverse which candidate the fact's scope matches, and the
  // stated-preference arm follows the fact while the baseline keeps picking
  // alphabetically. That divergence is what the fact buys, and it is asserted
  // directly against generic's pick on the same reversed state.
  // (selectNextStepForArmFromState does not accept statedInputs, so this uses the
  // lower-level selectNextStepForArm directly, same as the `stated` selection above.)
  const reversedTitles = stateWith(
    commitment('a-task', { title: 'Unrelated errand' }),
    commitment('b-task', { title: 'Wolt evening shift' }),
  );
  const reversedCandidates = armCandidatesFromDomainState(reversedTitles);
  const genericReversed = selectNextStepForArm('generic', reversedCandidates, armContext);
  const statedReversed = selectNextStepForArm(
    'stated-preference',
    reversedCandidates,
    armContext,
    undefined,
    { preferences: [], facts: [makeFact({ scope: 'wolt', statement: 'Wolt shifts pay more than other work right now' })] },
  );
  assert.equal(genericReversed.selectedCommitmentId, 'a-task');
  assert.equal(statedReversed.selectedCommitmentId, 'b-task');
  assert.notEqual(
    statedReversed.selectedCommitmentId,
    genericReversed.selectedCommitmentId,
    'the stated-preference arm diverges from the baseline on the strength of the stated fact alone',
  );
});

test('thesis: a hard avoid preference overrides what baseline urgency and priority alone would pick', () => {
  // gym-today dominates on the baseline's own terms — overdue (strongest signal,
  // latenessBand) and high priority — so the baseline and any arm that only reorders
  // within undisputed urgency would pick it. Only an explicit, semantic constraint
  // ("avoid three gym days in a row") can override that; nothing in the deterministic
  // scoring dimensions (time, priority, effort) carries that information.
  const state = stateWith(
    commitment('gym-today', {
      title: 'Gym session',
      priority: { level: 'high', source: 'user_explicit', pressureAllowed: false, pressureLevel: 'none' },
      timeSpec: { kind: 'due_by', dueAt: '2026-08-16T09:00:00.000Z', remindAt: null, timezone: 'UTC' },
    }),
    commitment('errand-today', { title: 'Unrelated errand' }),
  );
  const candidates = armCandidatesFromDomainState(state);

  const generic = selectNextStepForArm('generic', candidates, armContext);
  assert.equal(generic.selectedCommitmentId, 'gym-today', 'baseline strongly prefers gym-today: it is overdue and high priority');

  const stated = selectNextStepForArm('stated-preference', candidates, armContext, undefined, {
    preferences: [makePreference({ scope: 'gym', polarity: 'avoid', strength: 'hard', statement: 'avoid gym three days in a row' })],
    facts: [],
  });
  assert.equal(stated.selectedCommitmentId, 'errand-today', 'the explicit hard constraint vetoes gym-today even though it otherwise dominates on urgency and priority');
});

test('thesis: absent any stated facts or preferences, stated-preference degrades gracefully to the baseline (no false certainty)', () => {
  const state = stateWith(commitment('a-task', { title: 'Wolt evening shift' }), commitment('b-task', { title: 'Gym session' }));
  const candidates = armCandidatesFromDomainState(state);
  const generic = selectNextStepForArm('generic', candidates, armContext);
  const stated = selectNextStepForArm('stated-preference', candidates, armContext, undefined, { preferences: [], facts: [] });
  assert.deepEqual(stated.recommendation, generic.recommendation);
  assert.equal(stated.fallbackReason, 'no_stated_state');
});

test('ADR scenario: a soft preference is outweighed by overdue urgency', () => {
  // 'z-overdue' dominates on the baseline's own strongest terms (overdue + high priority).
  // 'a-gym' has everything else going for it: it carries a soft "I prefer" statement AND
  // wins the alphabetical tiebreak. A soft signal must still not pull the pick across an
  // urgency tier — only a hard signal (bonus or veto) is allowed to do that.
  const state = stateWith(
    commitment('z-overdue', {
      title: 'Quarterly report',
      priority: { level: 'high', source: 'user_explicit', pressureAllowed: false, pressureLevel: 'none' },
      timeSpec: { kind: 'due_by', dueAt: '2026-08-16T09:00:00.000Z', remindAt: null, timezone: 'UTC' },
    }),
    commitment('a-gym', { title: 'Gym session' }),
  );
  const candidates = armCandidatesFromDomainState(state);

  const generic = selectNextStepForArm('generic', candidates, armContext);
  assert.equal(generic.selectedCommitmentId, 'z-overdue', 'baseline: overdue + high priority beats a merely-due task');

  const softPreference = makePreference({
    scope: 'gym', polarity: 'prefer', strength: 'soft', statement: 'I prefer training in the evening',
  });
  const stated = selectNextStepForArm('stated-preference', candidates, armContext, undefined, {
    preferences: [softPreference], facts: [],
  });
  assert.equal(
    stated.selectedCommitmentId,
    'z-overdue',
    'a soft preference nudges ordering inside an urgency tier, never across one',
  );

  // Same fixture, same scope, but stated as a hard constraint: that IS allowed to override.
  const hard = selectNextStepForArm('stated-preference', candidates, armContext, undefined, {
    preferences: [makePreference({ ...softPreference, strength: 'hard' })], facts: [],
  });
  assert.equal(hard.selectedCommitmentId, 'a-gym', 'a hard preference remains a real override');
});

test('bonus magnitude scales with the statement confidence rather than being a fixed constant', () => {
  const candidates = armCandidatesFromDomainState(stateWith(commitment('gym-session', { title: 'Gym session' })));
  const traceAt = (confidence: number, strength: 'soft' | 'hard' = 'soft') => selectNextStepForArm(
    'stated-preference', candidates, armContext, undefined,
    { preferences: [makePreference({ scope: 'gym', polarity: 'prefer', strength, confidence })], facts: [] },
  ).preferenceTrace || [];

  assert.equal(traceAt(0.9)[0].magnitude, 2 * 0.9);
  assert.equal(traceAt(0.6)[0].magnitude, 2 * 0.6);
  assert.ok(traceAt(0.9)[0].magnitude > traceAt(0.6)[0].magnitude, 'more confidence, more effect');
  assert.equal(traceAt(0.9, 'hard')[0].magnitude, 4 * 0.9);
  assert.ok(traceAt(0.9, 'hard')[0].magnitude > traceAt(0.9)[0].magnitude, 'hard still outweighs soft at equal confidence');
  // The 0.5 floor stays an on/off gate: below it the statement is inert, not just weak.
  assert.equal(traceAt(0.4).length, 0);
});

test('penalty magnitude scales with confidence too, and the trace records the scaled value', () => {
  const candidates = armCandidatesFromDomainState(stateWith(commitment('gym-session', { title: 'Gym session' })));
  const selection = selectNextStepForArm('stated-preference', candidates, armContext, undefined, {
    preferences: [makePreference({ scope: 'gym', polarity: 'avoid', strength: 'soft', confidence: 0.8 })], facts: [],
  });
  assert.equal(selection.preferenceTrace?.[0].effect, 'penalty');
  assert.equal(selection.preferenceTrace?.[0].magnitude, -2 * 0.8);
});

test('an unconfirmed (confirm-band) statement has no effect on scoring even though its status is active', () => {
  const state = stateWith(commitment('gym-session', { title: 'Gym session' }), commitment('other-task', { title: 'Unrelated task' }));
  const candidates = armCandidatesFromDomainState(state);
  // A hard avoid would normally veto 'gym-session' outright. Pending confirmation it does nothing.
  const selection = selectNextStepForArm('stated-preference', candidates, armContext, undefined, {
    preferences: [makePreference({ scope: 'gym', polarity: 'avoid', strength: 'hard', requiresConfirmation: true })],
    facts: [makeFact({ scope: 'gym', requiresConfirmation: true })],
  });
  assert.equal(selection.preferenceTrace?.length, 0);
  assert.equal(selection.selectedCommitmentId, 'gym-session');
});

test('ADR scenario: two conflicting statements land in the confirm band instead of silently overwriting', () => {
  withIngestion((deps) => {
    const first = ingestMessage({
      text: 'I prefer going to the gym in the evening', userId: 'user_1', timestamp: '2026-08-17T09:00:00.000Z',
    }, deps);
    const second = ingestMessage({
      text: "I don't like the gym on Monday mornings", userId: 'user_1', timestamp: '2026-08-17T10:00:00.000Z',
    }, deps);

    assert.equal(second.decisions[0].resolution.action, 'confirm_link');
    assert.equal(first.preferences[0].requiresConfirmation, false);
    assert.equal(second.preferences[0].requiresConfirmation, true);

    const active = deps.preferenceStore.getActiveByUserId('user_1');
    assert.equal(active.length, 2, 'the second statement is recorded, not silently written over the first');

    const candidates = armCandidatesFromDomainState(tiedPairState('Gym session'));
    const selection = selectNextStepForArm('stated-preference', candidates, armContext, undefined, {
      preferences: active, facts: [],
    });

    // Only the confirmed statement scores. If the pending one also counted, its soft avoid
    // penalty would cancel the confirmed prefer bonus and 'a-errand' would win the tiebreak.
    assert.equal(selection.preferenceTrace?.length, 1);
    assert.equal(selection.preferenceTrace?.[0].id, first.preferences[0].id);
    assert.equal(selection.selectedCommitmentId, 'b-match');
  });
});

test('ADR scenario: an explicit correction supersedes cleanly with an audit event', () => {
  withIngestion((deps) => {
    const original = ingestMessage({
      text: 'I prefer going to the gym in the evening', userId: 'user_1', timestamp: '2026-08-17T09:00:00.000Z',
    }, deps);
    const candidates = armCandidatesFromDomainState(tiedPairState('Gym session'));
    const before = selectNextStepForArm('stated-preference', candidates, armContext, undefined, {
      preferences: deps.preferenceStore.getActiveByUserId('user_1'), facts: [],
    });
    assert.equal(before.selectedCommitmentId, 'b-match', 'the original "prefer" statement pulls the gym session up');

    const correction = ingestMessage({
      text: "I don't like going to the gym in the evening", userId: 'user_1', timestamp: '2026-08-18T09:00:00.000Z',
    }, deps);

    assert.equal(correction.decisions[0].resolution.action, 'link');
    assert.equal(correction.preferences[0].id, original.preferences[0].id, 'corrected in place, not duplicated');
    assert.equal(correction.preferences[0].polarity, 'avoid');

    const corrected = deps.preferenceStore.getEvents(original.preferences[0].id).filter((event) => event.type === 'corrected');
    assert.equal(corrected.length, 1, 'the polarity flip is recorded exactly once, not silently applied');
    assert.ok(corrected[0].reason.length > 0);

    const activeAfter = deps.preferenceStore.getActiveByUserId('user_1');
    const after = selectNextStepForArm('stated-preference', candidates, armContext, undefined, {
      preferences: activeAfter, facts: [],
    });
    assert.equal(after.selectedCommitmentId, 'a-errand', 'the arm now follows the corrected statement, not the original one');

    // Confirm the flip is a penalty on the gym session specifically, not just a lost bonus.
    const gymOnly = selectNextStepForArm(
      'stated-preference',
      armCandidatesFromDomainState(stateWith(commitment('gym-session', { title: 'Gym session' }))),
      armContext,
      undefined,
      { preferences: activeAfter, facts: [] },
    );
    assert.equal(gymOnly.preferenceTrace?.[0].effect, 'penalty');
  });
});

test('a Hebrew preference derives a real scope and changes what the arm selects', () => {
  withIngestion((deps) => {
    const result = ingestMessage({
      text: 'אני מעדיף ללכת לחדר כושר בערב', userId: 'user_1', timestamp: '2026-08-17T09:00:00.000Z',
    }, deps);
    assert.equal(result.preferences.length, 1);
    assert.equal(result.preferences[0].scope, 'gym', 'Hebrew must not fall through to the never-matching full-text scope');

    const candidates = armCandidatesFromDomainState(tiedPairState('Gym session'));
    const generic = selectNextStepForArm('generic', candidates, armContext);
    const stated = selectNextStepForArm('stated-preference', candidates, armContext, undefined, {
      preferences: result.preferences, facts: [],
    });
    assert.equal(generic.selectedCommitmentId, 'a-errand');
    assert.equal(stated.selectedCommitmentId, 'b-match');
    assert.equal(stated.preferenceTrace?.length, 1);
  });
});

test('a Hebrew fact derives a real scope and changes what the arm selects', () => {
  withIngestion((deps) => {
    const result = ingestMessage({
      text: 'אני עובד ביום שלישי', userId: 'user_1', timestamp: '2026-08-17T09:00:00.000Z',
    }, deps);
    assert.equal(result.facts.length, 1);
    assert.equal(result.facts[0].scope, 'work');

    const candidates = armCandidatesFromDomainState(tiedPairState('Work shift'));
    const generic = selectNextStepForArm('generic', candidates, armContext);
    const stated = selectNextStepForArm('stated-preference', candidates, armContext, undefined, {
      preferences: [], facts: result.facts,
    });
    assert.equal(generic.selectedCommitmentId, 'a-errand');
    assert.equal(stated.selectedCommitmentId, 'b-match');
  });
});

test('a user statement that trips the tone guard is screened out of the surfaced evidence labels', () => {
  const candidates = armCandidatesFromDomainState(stateWith(commitment('gym-session', { title: 'Gym session' })));
  const statement = 'I must go to the gym every evening';
  const selection = selectNextStepForArm('stated-preference', candidates, armContext, undefined, {
    preferences: [makePreference({ scope: 'gym', polarity: 'prefer', strength: 'hard', statement })], facts: [],
  });

  assert.equal(selection.recommendation.state, 'ready');
  const labels = selection.recommendation.explanation?.evidenceLabels || [];
  assert.ok(labels.length > 0);
  assert.ok(!labels.some((label) => /must/i.test(label)), 'raw user text goes through the same tone screen as the reason');
  assert.ok(!/must/i.test(selection.recommendation.explanation?.summary || ''));
  assert.equal(selection.selectedCommitmentId, 'gym-session');
  // The statement is still in the internal audit trace — screened from display, not lost.
  assert.equal(selection.preferenceTrace?.[0].statement, statement);
});

test('when the proposal does not survive review, the arm reports no pick instead of a phantom one', () => {
  const candidates = armCandidatesFromDomainState(stateWith(commitment('gym-session', { title: 'Gym session I must not skip' })));
  const selection = selectNextStepForArm('stated-preference', candidates, armContext, undefined, {
    preferences: [makePreference({ scope: 'gym', polarity: 'prefer', strength: 'hard', statement: 'I must go to the gym every evening' })],
    facts: [],
  });

  assert.notEqual(selection.recommendation.state, 'ready');
  assert.equal(selection.recommendation.primaryStep, null);
  assert.equal(selection.selectedCommitmentId, null, 'nothing was surfaced, so nothing may be reported as selected');
});
