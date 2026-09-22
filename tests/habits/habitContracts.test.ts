/**
 * The habit contract, and the one thing it refuses to represent (#520).
 *
 * The invariant this file is really about is "goal text alone never creates a
 * Habit". Everything else here — the counts, the windows, the patch surface —
 * is ordinary validation; the confirmation tests are the ones whose failure
 * would mean the product started asking for somebody's evenings because a
 * model read a sentence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HABIT_SCHEMA_VERSION,
  applyHabitPatch,
  buildHabitDefinition,
  cadenceOccurrencesPerPeriod,
  isHabitDefinition,
  parseHabitCadence,
  parseHabitDefinitionInput,
  parseHabitPatchInput,
} from '../../src/contracts/v1/habitContracts.ts';
import { buildHabitProposal, confirmHabitProposal } from '../../lib/habits/proposal.ts';
import { NOW, SCOPE, habit, habitInput } from './habitSupport.ts';

const LATER = '2026-03-10T09:00:00.000Z';

test('a body with no confirmation is refused outright', () => {
  const { confirmation: _dropped, ...withoutConfirmation } = habitInput();
  assert.throws(
    () => parseHabitDefinitionInput(withoutConfirmation),
    /confirmation is required: a habit exists only once a person confirmed it/,
  );
  // And not by being stamped with the server's clock instead, which would make
  // the receipt a formality rather than evidence somebody pressed something.
  for (const bad of [null, {}, { confirmedByUserAt: 'soon', acceptedSuggestedValues: true }]) {
    assert.throws(() => parseHabitDefinitionInput(habitInput({ confirmation: bad as never })));
  }
});

test('a patch cannot rewrite the source, the confirmation or the timestamps', () => {
  const patch = parseHabitPatchInput({
    title: 'Gym, but Tuesdays',
    source: 'user_created',
    confirmation: { confirmedByUserAt: LATER, sourceRef: null, acceptedSuggestedValues: true },
    createdAt: LATER,
    habitId: 'somebody-elses',
    scopeId: 'somebody-else',
  });
  assert.deepEqual(Object.keys(patch), ['title']);

  const updated = applyHabitPatch(habit(), patch, LATER);
  assert.equal(updated.title, 'Gym, but Tuesdays');
  assert.equal(updated.confirmation.confirmedByUserAt, NOW);
  assert.equal(updated.createdAt, NOW);
  assert.equal(updated.updatedAt, LATER);
  assert.equal(updated.scopeId, SCOPE);
});

test('a proposal is not a habit and carries nothing that could become one', () => {
  const proposal = buildHabitProposal({
    proposalId: 'proposal-1',
    scopeId: SCOPE,
    title: 'Exercise',
    suggestedCadence: { kind: 'weekly_count', count: 3 },
    suggestedDurationMinutes: 45,
    sourceRef: 'goal-7',
    source: 'onboarding_confirmed',
  }, NOW);

  // The fields that make something schedulable are absent, so there is no cast
  // or spread that turns this into a HabitDefinition.
  for (const field of ['habitId', 'status', 'confirmation', 'updatedAt']) {
    assert.ok(!(field in proposal), `a proposal must not carry ${field}`);
  }
  // Nor is it storable: the store's own validator refuses it.
  assert.throws(() => parseHabitDefinitionInput(proposal as never));
});

test('confirming takes the cadence and duration from the confirmation, not the suggestion', () => {
  const proposal = buildHabitProposal({
    proposalId: 'proposal-1',
    scopeId: SCOPE,
    title: 'Exercise',
    suggestedCadence: { kind: 'weekly_count', count: 5 },
    suggestedDurationMinutes: 90,
    sourceRef: 'goal-7',
    source: 'goal_confirmed',
  }, NOW);

  // The person halved it. What is stored is what they said.
  const input = confirmHabitProposal(
    proposal,
    { cadence: { kind: 'weekly_count', count: 2 }, durationMinutes: 30 },
    LATER,
  );
  assert.deepEqual(input.cadence, { kind: 'weekly_count', count: 2 });
  assert.equal(input.durationMinutes, 30);
  assert.equal(input.source, 'goal_confirmed');
  assert.equal(input.confirmation.confirmedByUserAt, LATER);
  assert.equal(input.confirmation.sourceRef, 'proposal-1');
  assert.equal(input.confirmation.acceptedSuggestedValues, false);

  // Taking the suggestion unchanged is recorded as that, and as nothing else.
  const accepted = confirmHabitProposal(
    proposal,
    { cadence: { kind: 'weekly_count', count: 5 }, durationMinutes: 90 },
    LATER,
  );
  assert.equal(accepted.confirmation.acceptedSuggestedValues, true);

  // And a confirmation that states neither is refused rather than defaulted.
  assert.throws(
    () => confirmHabitProposal(proposal, {} as never, LATER),
    /the confirmation must state a cadence and a duration/,
  );
  assert.throws(
    () => confirmHabitProposal(proposal, { durationMinutes: 30 } as never, LATER),
    /the confirmation must state a cadence and a duration/,
  );
});

test('a confirmed goal habit is flexible by default, never protected', () => {
  const proposal = buildHabitProposal({
    proposalId: 'proposal-1',
    scopeId: SCOPE,
    title: 'Exercise',
    suggestedCadence: { kind: 'weekly_count', count: 3 },
    suggestedDurationMinutes: 60,
    sourceRef: 'goal-7',
    source: 'goal_confirmed',
  }, NOW);
  const input = confirmHabitProposal(
    proposal,
    { cadence: { kind: 'weekly_count', count: 3 }, durationMinutes: 60 },
    LATER,
  );
  assert.equal(input.flexibility, 'flexible');
  assert.equal(input.recoveryPolicy, 'skip');
  // The person can still ask for the stronger one; it is a choice, not a default.
  assert.equal(
    confirmHabitProposal(
      proposal,
      { cadence: { kind: 'weekly_count', count: 3 }, durationMinutes: 60, flexibility: 'protected_flexible' },
      LATER,
    ).flexibility,
    'protected_flexible',
  );
});

test('the counts must be able to coexist', () => {
  assert.throws(
    () => parseHabitDefinitionInput(habitInput({ minimumOccurrences: 4, maximumOccurrences: 3 })),
    /minimumOccurrences must not exceed maximumOccurrences/,
  );
  assert.throws(
    () => parseHabitDefinitionInput(habitInput({
      cadence: { kind: 'weekly_count', count: 5 },
      minimumOccurrences: 0,
      maximumOccurrences: 3,
    })),
    /the cadence asks for 5 a week, above maximumOccurrences 3/,
  );
  // And a patch cannot walk a stored habit into the same state.
  assert.throws(
    () => applyHabitPatch(habit(), parseHabitPatchInput({ minimumOccurrences: 0, maximumOccurrences: 1 }), LATER),
    /the cadence asks for 3 a week, above maximumOccurrences 1/,
  );
});

test('a cadence is one of exactly two shapes, and weekdays do not repeat', () => {
  assert.deepEqual(parseHabitCadence({ kind: 'weekdays', weekdays: [5, 1, 3] }), {
    kind: 'weekdays',
    weekdays: [1, 3, 5],
  });
  assert.equal(cadenceOccurrencesPerPeriod({ kind: 'weekdays', weekdays: [1, 3, 5] }), 3);
  assert.throws(() => parseHabitCadence({ kind: 'weekdays', weekdays: [1, 1] }), /must not repeat a day/);
  assert.throws(() => parseHabitCadence({ kind: 'weekdays', weekdays: [] }), /non-empty array/);
  assert.throws(() => parseHabitCadence({ kind: 'weekdays', weekdays: [7] }), /between 0 and 6/);
  assert.throws(() => parseHabitCadence({ kind: 'weekly_count', count: 8 }), /between 1 and 7/);
  assert.throws(() => parseHabitCadence({ kind: 'monthly', count: 2 }), /weekly_count or weekdays/);
});

test('a built habit is born active, versioned, and readable back', () => {
  const definition = buildHabitDefinition('habit-9', parseHabitDefinitionInput(habitInput()), NOW);
  assert.equal(definition.status, 'active');
  assert.equal(definition.schemaVersion, HABIT_SCHEMA_VERSION);
  assert.equal(definition.createdAt, NOW);
  assert.ok(isHabitDefinition(definition));
  // A document from an older schema, or one somebody edited by hand, is not.
  assert.equal(isHabitDefinition({ ...definition, schemaVersion: 0 }), false);
  assert.equal(isHabitDefinition({ ...definition, cadence: { kind: 'weekly_count', count: 99 } }), false);
  assert.equal(isHabitDefinition({ ...definition, confirmation: undefined }), false);
});

test('a preferred window is a wall-clock window, not an instant', () => {
  assert.throws(
    () => parseHabitDefinitionInput(habitInput({
      preferredWindows: [{ start: '2026-03-02T18:00:00Z', end: '21:00' }] as never,
    })),
    /preferredWindows\[0\]\.start must be HH:MM/,
  );
  assert.throws(
    () => parseHabitDefinitionInput(habitInput({
      preferredWindows: [{ start: '18:00', end: '18:00' }],
    })),
    /starts and ends at the same minute/,
  );
  // Wrapping midnight is the normal case for an evening or an early morning.
  assert.equal(
    parseHabitDefinitionInput(habitInput({ preferredWindows: [{ start: '22:00', end: '06:00' }] }))
      .preferredWindows.length,
    1,
  );
});
