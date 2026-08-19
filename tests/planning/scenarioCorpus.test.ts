/**
 * The planning scenario corpus and its generator (Sprint 07, issue #31).
 *
 * ── What "machine-checkable" is being enforced as ───────────────────
 *
 * `ScenarioExpectation` has no free-text field on purpose, and the corpus is
 * assembled through a gate rather than exported as an array. The gate is the
 * acceptance criterion: a scenario whose stated outcome nothing can evaluate,
 * or whose stated outcome disagrees with the oracle sitting next to it in the
 * same package, must stop the corpus from assembling at all.
 *
 * ── Coverage is a refusal, not a report ─────────────────────────────
 *
 * "A suite with no DST scenario should fail to assemble, not quietly pass" is
 * the contract's own sentence about `PlanningScenarioKind`. The test below
 * therefore removes the DST rows and asserts a throw. A corpus that only
 * *counted* its kinds would let a merge that dropped them ship green.
 *
 * ── Nothing here is reviewed ────────────────────────────────────────
 *
 * Every row is synthetic. Sprint 07 ships no human-reviewed planning scenario
 * and the corpus says so in its `provenance` field, which the tests assert
 * rather than trust.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CURATED_PLANNING_SCENARIOS,
  PLANNING_SCENARIO_KINDS,
  assemblePlanningCorpus,
  defaultPlanningScenarioCorpus,
  generatePlanningScenarios,
  scenarioCorpusIssues,
} from '../../lib/planning/evaluation/scenarios.ts';
import { assessFeasibility } from '../../lib/planning/evaluation/oracle.ts';
import { zoneOffsetMs } from '../../lib/planning/shared/time.ts';
import {
  ATTEMPT_INFEASIBILITY_CODES,
  STATIC_INFEASIBILITY_CODES,
  type PlanningScenario,
  type PlanningScenarioKind,
} from '../../src/contracts/v1/planningContracts.ts';

const CORPUS = defaultPlanningScenarioCorpus();

function scenariosOfKind(kind: PlanningScenarioKind): readonly PlanningScenario[] {
  return CORPUS.scenarios.filter((scenario) => scenario.kind === kind);
}

/* ── Coverage ────────────────────────────────────────────────────── */

test('every PlanningScenarioKind is covered by at least one scenario', () => {
  for (const kind of PLANNING_SCENARIO_KINDS) {
    assert.ok(
      CORPUS.coverageByKind[kind] > 0,
      `no scenario covers the '${kind}' kind`,
    );
  }
});

test('PLANNING_SCENARIO_KINDS matches the contract union exactly', () => {
  // Declared through a `Record<PlanningScenarioKind, ...>` in the module, so a
  // kind added to the contract is a compile error here rather than a silently
  // uncovered case.
  assert.deepEqual(
    PLANNING_SCENARIO_KINDS.slice().sort(),
    ['boundary', 'change', 'conflict', 'dependency', 'dst', 'feasible', 'multilingual', 'overload'],
  );
});

test('a corpus missing the DST kind fails to assemble rather than passing quietly', () => {
  const withoutDst = CORPUS.scenarios.filter((scenario) => scenario.kind !== 'dst');

  assert.throws(() => assemblePlanningCorpus(withoutDst), /dst/);
});

test('each kind is refused individually, so coverage cannot rot one row at a time', () => {
  for (const kind of PLANNING_SCENARIO_KINDS) {
    const without = CORPUS.scenarios.filter((scenario) => scenario.kind !== kind);
    assert.throws(
      () => assemblePlanningCorpus(without),
      new RegExp(kind),
      `dropping every '${kind}' scenario must refuse assembly`,
    );
  }
});

/* ── Identity ────────────────────────────────────────────────────── */

test('scenario ids are unique across curated and generated rows alike', () => {
  const ids = CORPUS.scenarios.map((scenario) => scenario.scenarioId);
  assert.equal(new Set(ids).size, ids.length);
});

test('a duplicated scenario id refuses assembly', () => {
  const first = CURATED_PLANNING_SCENARIOS[0];
  assert.throws(
    () => assemblePlanningCorpus(CORPUS.scenarios.concat([{ ...first }])),
    /duplicate/i,
  );
});

test('the corpus is ordered by scenario id, so input order cannot leak into a digest', () => {
  const ids = CORPUS.scenarios.map((scenario) => scenario.scenarioId);
  const sorted = ids.slice().sort();
  assert.deepEqual(ids, sorted);

  const reversed = assemblePlanningCorpus(CORPUS.scenarios.slice().reverse());
  assert.equal(reversed.digest, CORPUS.digest);
});

/* ── Provenance ──────────────────────────────────────────────────── */

test('the corpus is recorded as synthetic; nothing here claims human review', () => {
  assert.equal(CORPUS.provenance, 'synthetic');
  for (const scenario of CORPUS.scenarios) {
    assert.ok(scenario.note.length > 0, `${scenario.scenarioId} carries no note`);
    assert.ok(
      !/reviewed|annotator|approved by/i.test(scenario.note),
      `${scenario.scenarioId} claims review that did not happen`,
    );
  }
});

/* ── Every expectation is machine-checkable ──────────────────────── */

test('every expectation partitions the scenario items exactly once', () => {
  for (const scenario of CORPUS.scenarios) {
    const itemIds = scenario.constraints.items.map((item) => item.itemId).slice().sort();
    const claimed = scenario.expectation.expectedScheduledItemIds
      .concat(Object.keys(scenario.expectation.expectedUnscheduledReasons))
      .slice()
      .sort();

    // The same promise `Plan` makes: scheduled and unscheduled together cover
    // every input item exactly once. An expectation that skipped an item would
    // assert nothing about it while looking complete.
    assert.deepEqual(claimed, itemIds, `${scenario.scenarioId} does not account for every item`);
  }
});

test('every expected reason code is a code the contract names', () => {
  const known = (STATIC_INFEASIBILITY_CODES as readonly string[])
    .concat(ATTEMPT_INFEASIBILITY_CODES as readonly string[]);

  for (const scenario of CORPUS.scenarios) {
    for (const code of Object.values(scenario.expectation.expectedUnscheduledReasons)) {
      assert.ok(known.includes(code), `${scenario.scenarioId} expects unknown code ${code}`);
    }
    for (const code of scenario.expectation.expectedConstraintCodes) {
      assert.ok(
        (STATIC_INFEASIBILITY_CODES as readonly string[]).includes(code),
        `${scenario.scenarioId} expects ${code} at constraint level; only static codes live there`,
      );
    }
  }
});

test('every static expectation agrees with the oracle, in both directions', () => {
  for (const scenario of CORPUS.scenarios) {
    const verdict = assessFeasibility(scenario.constraints, scenario.config);

    const constraintCodes = verdict.reasons
      .filter((reason) => reason.itemId === null)
      .map((reason) => reason.code)
      .slice()
      .sort();
    assert.deepEqual(
      constraintCodes,
      scenario.expectation.expectedConstraintCodes.slice().sort(),
      `${scenario.scenarioId}: constraint-level codes disagree with the oracle`,
    );

    for (const item of scenario.constraints.items) {
      const emitted = verdict.reasons.filter((reason) => reason.itemId === item.itemId).map((reason) => reason.code);
      const expected = scenario.expectation.expectedUnscheduledReasons[item.itemId];

      if (emitted.length === 0) {
        assert.ok(
          expected === undefined
            || (ATTEMPT_INFEASIBILITY_CODES as readonly string[]).includes(expected),
          `${scenario.scenarioId}/${item.itemId}: expected ${String(expected)} but the oracle finds no static defect`,
        );
        continue;
      }

      // A curated case that trips two static codes at once cannot be used to
      // compare two implementations: the comparison would pass while each side
      // was reading a different one of them.
      assert.equal(
        emitted.length,
        1,
        `${scenario.scenarioId}/${item.itemId}: a scenario must isolate one defect, found ${emitted.join(', ')}`,
      );
      assert.equal(
        expected,
        emitted[0],
        `${scenario.scenarioId}/${item.itemId}: expectation disagrees with the oracle`,
      );
    }
  }
});

test('scenarioCorpusIssues reports nothing for the shipped corpus', () => {
  assert.deepEqual(scenarioCorpusIssues(CORPUS.scenarios), []);
});

/* ── Kind-specific invariants ────────────────────────────────────── */

test('every overload scenario really is overloaded: demand exceeds capacity', () => {
  const overload = scenariosOfKind('overload');
  assert.ok(overload.length > 0);

  for (const scenario of overload) {
    const verdict = assessFeasibility(scenario.constraints, scenario.config);
    // The name is not the evidence. A scenario labelled `overload` whose demand
    // fits in its capacity is testing something else under a misleading label,
    // which is the failure mode a named kind was introduced to prevent.
    assert.ok(
      verdict.demandMinutes > verdict.availableMinutes,
      `${scenario.scenarioId}: demand ${verdict.demandMinutes} does not exceed capacity ${verdict.availableMinutes}`,
    );
  }
});

test('every feasible scenario is feasible according to the oracle', () => {
  for (const scenario of scenariosOfKind('feasible')) {
    const verdict = assessFeasibility(scenario.constraints, scenario.config);
    assert.equal(verdict.feasible, true, `${scenario.scenarioId} is labelled feasible but is not`);
    assert.deepEqual(scenario.expectation.expectedUnscheduledReasons, {});
  }
});

test('every DST scenario straddles a real transition in one of its own zones', () => {
  const dst = scenariosOfKind('dst');
  assert.ok(dst.length >= 4, 'both directions in at least two zones');

  for (const scenario of dst) {
    // Read off the runtime's tzdata rather than asserted from a table: a
    // scenario named `dst` whose horizon sits entirely inside one offset tests
    // nothing, and a tzdata update that moved a transition would turn every DST
    // case into that silently rather than failing here.
    const straddles = scenario.constraints.workingWindows.some(
      (window) =>
        zoneOffsetMs(Date.parse(scenario.constraints.horizon.startsAt), window.timezone)
        !== zoneOffsetMs(Date.parse(scenario.constraints.horizon.endsAt), window.timezone),
    );
    assert.ok(straddles, `${scenario.scenarioId}: no window zone changes offset inside the horizon`);
  }

  const zones = new Set(dst.map((scenario) => scenario.constraints.timezone));
  assert.ok(zones.size >= 2, `expected more than one zone, saw ${Array.from(zones).join(', ')}`);
});

test('multilingual scenarios cover Arabic, Hebrew and English in their real zones', () => {
  const multilingual = scenariosOfKind('multilingual');
  const languages = new Set(multilingual.map((scenario) => scenario.locale.split('-')[0]));
  const zones = new Set(multilingual.map((scenario) => scenario.constraints.timezone));

  assert.deepEqual(Array.from(languages).sort(), ['ar', 'en', 'he']);
  assert.deepEqual(
    Array.from(zones).sort(),
    ['America/New_York', 'Asia/Jerusalem', 'Asia/Riyadh'],
  );
});

test('multilingual scenarios carry real RTL titles, not transliterations', () => {
  const rtl = scenariosOfKind('multilingual').filter((scenario) => /^(ar|he)/.test(scenario.locale));
  assert.ok(rtl.length >= 2);

  for (const scenario of rtl) {
    for (const item of scenario.constraints.items) {
      assert.ok(
        /[֐-׿؀-ۿ]/.test(item.title),
        `${scenario.scenarioId}/${item.itemId}: an RTL locale with a Latin-only title tests nothing`,
      );
    }
  }
});

test('change scenarios come in before/after pairs over one scope', () => {
  const change = scenariosOfKind('change');
  assert.ok(change.length >= 2);

  for (const scenario of change) {
    const match = /^(.*)-(before|after)$/.exec(scenario.scenarioId);
    assert.ok(match !== null, `${scenario.scenarioId} is a change scenario with no before/after suffix`);
    const stem = (match as RegExpExecArray)[1];
    const other = (match as RegExpExecArray)[2] === 'before' ? 'after' : 'before';
    const counterpart = change.find((candidate) => candidate.scenarioId === `${stem}-${other}`);

    // Churn is measured between two plans. A change scenario with no
    // counterpart cannot produce the second plan, so the metric it exists for
    // would be measured against nothing.
    assert.ok(counterpart !== undefined, `${scenario.scenarioId} has no counterpart`);
    assert.equal(
      (counterpart as PlanningScenario).constraints.scopeId,
      scenario.constraints.scopeId,
      'a before/after pair must describe the same scope',
    );
  }
});

/* ── The generator ───────────────────────────────────────────────── */

test('the generator is deterministic: one seed, byte-identical output', () => {
  const first = generatePlanningScenarios({ seed: 'sprint-07', count: 8 });
  const second = generatePlanningScenarios({ seed: 'sprint-07', count: 8 });

  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test('a different seed produces different scenarios', () => {
  const a = generatePlanningScenarios({ seed: 'sprint-07', count: 8 });
  const b = generatePlanningScenarios({ seed: 'sprint-08', count: 8 });

  assert.notEqual(JSON.stringify(a), JSON.stringify(b));
});

test('a scenario at index n does not depend on how many were asked for', () => {
  const few = generatePlanningScenarios({ seed: 'sprint-07', count: 3 });
  const many = generatePlanningScenarios({ seed: 'sprint-07', count: 12 });

  // Each row is addressed by its own digest rather than drawn from a running
  // stream, so growing the corpus cannot re-point the rows already in it — the
  // property `lib/decomposition/evaluation/splits.ts` makes for split
  // assignment, for the same reason.
  assert.deepEqual(many.slice(0, 3), few);
});

test('generated scenarios pass the same gate the curated ones do', () => {
  const generated = generatePlanningScenarios({ seed: 'sprint-07', count: 12 });

  for (const scenario of generated) {
    const verdict = assessFeasibility(scenario.constraints, scenario.config);
    const constraintCodes = verdict.reasons.filter((reason) => reason.itemId === null).map((reason) => reason.code);
    assert.deepEqual(
      constraintCodes.slice().sort(),
      scenario.expectation.expectedConstraintCodes.slice().sort(),
      `${scenario.scenarioId}: constraint codes disagree with the oracle`,
    );

    for (const item of scenario.constraints.items) {
      const emitted = verdict.reasons.filter((reason) => reason.itemId === item.itemId).map((reason) => reason.code);
      const expected = scenario.expectation.expectedUnscheduledReasons[item.itemId];
      if (emitted.length === 0) {
        assert.equal(expected, undefined, `${scenario.scenarioId}/${item.itemId}`);
      } else {
        assert.deepEqual(emitted, [expected], `${scenario.scenarioId}/${item.itemId}`);
      }
    }
  }
});

test('the generator uses no ambient randomness: no two runs can differ', () => {
  const runs = [0, 1, 2, 3].map(() => JSON.stringify(generatePlanningScenarios({ seed: 'repeat', count: 6 })));
  assert.equal(new Set(runs).size, 1);
});

test('the generator refuses a seed it cannot put in a stable id', () => {
  assert.throws(() => generatePlanningScenarios({ seed: 'Sprint 07!', count: 2 }), /seed/);
  assert.throws(() => generatePlanningScenarios({ seed: '', count: 2 }), /seed/);
});

test('the generator refuses a count it cannot honour', () => {
  assert.throws(() => generatePlanningScenarios({ seed: 'sprint-07', count: -1 }), /count/);
  assert.throws(() => generatePlanningScenarios({ seed: 'sprint-07', count: 1.5 }), /count/);
});

test('generated scenarios spread across the locales the sprint names', () => {
  const generated = generatePlanningScenarios({ seed: 'sprint-07', count: 12 });
  const locales = new Set(generated.map((scenario) => scenario.locale));

  assert.ok(locales.size >= 3, `expected several locales, saw ${Array.from(locales).join(', ')}`);
});

/* ── The digest ──────────────────────────────────────────────────── */

test('the digest changes when a scenario changes and not when it is reordered', () => {
  const edited = CORPUS.scenarios.map((scenario, index) =>
    index === 0 ? { ...scenario, note: `${scenario.note} (edited)` } : scenario,
  );

  assert.notEqual(assemblePlanningCorpus(edited).digest, CORPUS.digest);
  assert.equal(assemblePlanningCorpus(CORPUS.scenarios.slice().reverse()).digest, CORPUS.digest);
});
