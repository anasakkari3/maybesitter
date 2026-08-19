/**
 * Locked scenarios never enter tuning (Sprint 07, issue #31).
 *
 * ── Why a label check would not be enough ───────────────────────────
 *
 * The acceptance criterion is "locked cases never enter tuning". A test that
 * read `lockState` off each row and asserted it said `locked` would prove that
 * a string is a string. What has to be true is stronger and structural:
 *
 *  1. The **selection path** cannot return a locked row. Not "does not today" —
 *     cannot, because it re-derives the partition from the rows themselves and
 *     refuses rather than filters when a caller hands it a corpus whose tunable
 *     list has been tampered with.
 *  2. Lock state is **carried in the data**. Sprint 05 wrote the reason down:
 *     a corpus that has to be *trusted* to be described correctly will
 *     eventually be described incorrectly. So flipping one row's `lockState`
 *     must move that row between the partitions, with its id, its file and its
 *     position all unchanged — which is the assertion that proves nothing is
 *     inferring lock state from where a row happens to sit.
 *  3. The **generator** cannot mint a locked row. A hold-out that a seed can
 *     regenerate is not held out; it is a value that will change the next time
 *     someone edits the generator, and every score measured against it would
 *     move with it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CURATED_PLANNING_SCENARIOS,
  LOCKED_SCENARIO_POLICY,
  assemblePlanningCorpus,
  defaultPlanningScenarioCorpus,
  generatePlanningScenarios,
  selectLockedScenarios,
  selectTunableScenarios,
  type PlanningScenarioCorpus,
} from '../../lib/planning/evaluation/scenarios.ts';
import type { PlanningScenario } from '../../src/contracts/v1/planningContracts.ts';

const CORPUS = defaultPlanningScenarioCorpus();

/* ── The partition ───────────────────────────────────────────────── */

test('the corpus holds locked rows and tunable rows, and both are non-empty', () => {
  assert.ok(CORPUS.locked.length > 0, 'a corpus with nothing locked has no hold-out at all');
  assert.ok(CORPUS.tunable.length > 0);
  assert.equal(CORPUS.locked.length + CORPUS.tunable.length, CORPUS.scenarios.length);
});

test('the tuning path returns no locked scenario', () => {
  const lockedIds = new Set(CORPUS.locked.map((scenario) => scenario.scenarioId));

  for (const scenario of selectTunableScenarios(CORPUS)) {
    assert.equal(scenario.lockState, 'tunable');
    assert.equal(lockedIds.has(scenario.scenarioId), false, `${scenario.scenarioId} leaked into tuning`);
  }
});

test('every locked scenario is absent from the tuning path', () => {
  const tunableIds = new Set(selectTunableScenarios(CORPUS).map((scenario) => scenario.scenarioId));

  for (const scenario of selectLockedScenarios(CORPUS)) {
    assert.equal(scenario.lockState, 'locked');
    assert.equal(tunableIds.has(scenario.scenarioId), false);
  }
});

/* ── The selection path refuses, it does not silently filter ─────── */

test('a corpus whose tunable list has been tampered with is refused, not quietly cleaned', () => {
  const lockedRow = CORPUS.locked[0];
  // The cast is the point: `TunableScenario` makes this unrepresentable in
  // TypeScript, so the only way a locked row reaches the tuning list is through
  // a boundary where the type was lost — a JSON file, a cast, a merge. The
  // runtime re-derivation is what covers that path.
  const tampered = {
    ...CORPUS,
    tunable: CORPUS.tunable.concat([lockedRow as unknown as (typeof CORPUS.tunable)[number]]),
  } as PlanningScenarioCorpus;

  assert.throws(() => selectTunableScenarios(tampered), /locked/);
});

test('silently dropping the row would be the wrong repair, so the message names it', () => {
  const lockedRow = CORPUS.locked[0];
  const tampered = {
    ...CORPUS,
    tunable: CORPUS.tunable.concat([lockedRow as unknown as (typeof CORPUS.tunable)[number]]),
  } as PlanningScenarioCorpus;

  assert.throws(() => selectTunableScenarios(tampered), new RegExp(lockedRow.scenarioId));
});

test('the tunable list is frozen, so a caller cannot push a locked row into it', () => {
  assert.equal(Object.isFrozen(CORPUS.tunable), true);
  assert.equal(Object.isFrozen(CORPUS.locked), true);
  assert.equal(Object.isFrozen(CORPUS.scenarios), true);
});

/* ── Lock state lives in the data ────────────────────────────────── */

test('flipping one row’s lockState moves it between the partitions, id unchanged', () => {
  const lockedRow = CORPUS.locked[0];
  const unlocked: PlanningScenario = { ...lockedRow, lockState: 'tunable' };
  const rebuilt = assemblePlanningCorpus(
    CORPUS.scenarios.map((scenario) => (scenario.scenarioId === lockedRow.scenarioId ? unlocked : scenario)),
  );

  // Same id, same module, same position in the array. If anything anywhere
  // inferred lock state from an id prefix or from which list a row was declared
  // in, this row would not have moved.
  assert.ok(rebuilt.tunable.some((scenario) => scenario.scenarioId === lockedRow.scenarioId));
  assert.equal(rebuilt.locked.some((scenario) => scenario.scenarioId === lockedRow.scenarioId), false);
});

test('the reverse also holds: locking a tunable row removes it from tuning', () => {
  const tunableRow = CORPUS.tunable[0];
  const locked: PlanningScenario = { ...tunableRow, lockState: 'locked' };
  const rebuilt = assemblePlanningCorpus(
    CORPUS.scenarios.map((scenario) => (scenario.scenarioId === tunableRow.scenarioId ? locked : scenario)),
  );

  assert.equal(
    selectTunableScenarios(rebuilt).some((scenario) => scenario.scenarioId === tunableRow.scenarioId),
    false,
  );
});

test('a row carrying an unrecognised lockState refuses assembly rather than defaulting', () => {
  const forged = { ...CURATED_PLANNING_SCENARIOS[0], lockState: 'probably-locked' } as unknown as PlanningScenario;
  const rows = CORPUS.scenarios.map((scenario) =>
    scenario.scenarioId === forged.scenarioId ? forged : scenario,
  );

  // Defaulting to `tunable` would put an unreadable row into the fitting set,
  // and defaulting to `locked` would quietly shrink it. Neither is a decision a
  // corpus loader gets to make on a row it cannot read.
  assert.throws(() => assemblePlanningCorpus(rows), /lockState/);
});

/* ── The generator ───────────────────────────────────────────────── */

test('the generator never mints a locked scenario, for any seed', () => {
  for (const seed of ['sprint-07', 'sprint-08', 'a', 'zzz-9']) {
    for (const scenario of generatePlanningScenarios({ seed, count: 10 })) {
      assert.equal(
        scenario.lockState,
        'tunable',
        `${scenario.scenarioId}: a hold-out a seed can regenerate is not held out`,
      );
    }
  }
});

/* ── The policy is stated as data ────────────────────────────────── */

test('the lock policy is exported as a value a caller can assert against', () => {
  assert.equal(LOCKED_SCENARIO_POLICY.lockedScenariosEnterTuning, false);
  assert.equal(LOCKED_SCENARIO_POLICY.lockStateCarriedInRow, true);
  assert.equal(LOCKED_SCENARIO_POLICY.generatorMayMintLocked, false);
  assert.equal(Object.isFrozen(LOCKED_SCENARIO_POLICY), true);
});
