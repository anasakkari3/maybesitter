/**
 * The routine survey, turned into facts (UC-2.7a, #167).
 *
 * The property that matters most here is that the mapping is a *function*: the
 * same profile always produces the same facts, in the same order, with the same
 * content strings. Reconciliation depends on it — an answer that re-derived
 * differently on each save would supersede itself forever and fill the memory
 * screen with a chain of identical records.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROUTINE_FACT_KEYS,
  routineFactContent,
  routineFactKeyOf,
  routineProfileToFacts,
} from '../../lib/memory/routineFacts.ts';
import {
  ROUTINE_SURVEY_VERSION,
  buildRoutineProfile,
  type RoutineProfileInput,
} from '../../src/contracts/v1/routineContracts.ts';
import { USER_STATED_MEMORY_TTL_MS } from '../../src/contracts/v1/memoryContracts.ts';

const AT = '2026-09-13T09:00:00.000Z';
const SCOPE = 'RoutineFactsUser';

/** The five answers the Flutter survey produced, as its windows. */
function fullInput(overrides: Partial<RoutineProfileInput> = {}): RoutineProfileInput {
  return {
    timezone: 'Asia/Jerusalem',
    sleepWindow: { start: '23:30', end: '07:30' },
    focusWindows: [{ start: '09:00', end: '17:00', label: 'work_study' }],
    fixedCommitmentWindows: [{ start: '07:00', end: '09:00', label: 'fixed_commitments' }],
    preferredReminderIntensity: 'followUp',
    quietHours: { start: '22:30', end: '07:30' },
    surveySkipped: false,
    ...overrides,
  };
}

function facts(overrides: Partial<RoutineProfileInput> = {}) {
  return routineProfileToFacts(buildRoutineProfile(fullInput(overrides), AT), SCOPE);
}

test('a completed survey becomes one fact per answered question', () => {
  const produced = facts();
  assert.deepEqual(produced.map((fact) => fact.content), [
    'sleep_window:23:30-07:30',
    'focus_window:09:00-17:00',
    'fixed_commitments:07:00-09:00',
    'reminder_intensity:followUp',
    'quiet_hours:22:30-07:30',
  ]);
});

test('every routine fact is the user speaking, at full confidence, from the survey', () => {
  for (const fact of facts()) {
    assert.equal(fact.source, 'user_stated', `${fact.content} is not attributed to the user`);
    assert.equal(fact.confidence, 1, `${fact.content} is stored as less than certain`);
    assert.equal(fact.kind, 'preference');
    assert.equal(fact.scopeId, SCOPE);
    assert.equal(fact.provenance?.origin, 'routine_survey');
    assert.equal(fact.provenance?.originRef, ROUTINE_SURVEY_VERSION);
    // Nothing a person said about themselves goes stale on a 90-day timer.
    assert.equal(fact.ttlMs, USER_STATED_MEMORY_TTL_MS, `${fact.content} would expire on its own`);
    assert.equal(fact.provenance?.model, undefined, 'a survey answer names a model');
  }
});

test('the mapping is deterministic: the same profile twice produces identical facts', () => {
  assert.deepEqual(facts(), facts());
});

test('an unanswered question produces no fact rather than a placeholder', () => {
  const produced = facts({ sleepWindow: null, quietHours: null, focusWindows: [] });
  assert.deepEqual(produced.map((fact) => fact.content), [
    'fixed_commitments:07:00-09:00',
    'reminder_intensity:followUp',
  ]);
});

test('each focus window is its own fact, so removing one does not rewrite the others', () => {
  const produced = facts({
    focusWindows: [
      { start: '09:00', end: '12:00', label: 'work_study' },
      { start: '14:00', end: '17:00', label: 'work_study' },
    ],
  });
  assert.deepEqual(
    produced.filter((fact) => routineFactKeyOf(fact.content) === 'focus_window').map((f) => f.content),
    ['focus_window:09:00-12:00', 'focus_window:14:00-17:00'],
  );
});

test('a skipped survey produces no facts at all', () => {
  // Skipping says something about the survey, not about the person. A fact
  // reading "declined to say" would appear on the memory screen as though the
  // user had stated it.
  assert.deepEqual(facts({ surveySkipped: true }), []);
});

test('routineFactKeyOf recognises exactly the keys the contract names', () => {
  for (const key of ROUTINE_FACT_KEYS) {
    assert.equal(routineFactKeyOf(routineFactContent(key, '09:00-17:00')), key);
  }
  assert.equal(routineFactKeyOf('something_else:value'), null);
  assert.equal(routineFactKeyOf('no separator'), null);
  assert.equal(routineFactKeyOf(':leading'), null);
});
