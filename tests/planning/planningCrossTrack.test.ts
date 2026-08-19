/**
 * The three Sprint 07 tracks, joined and run against each other.
 *
 * #29 (constraint model), #30 (scheduler) and #31 (scenarios and oracle) were
 * built in parallel against contracts written first, so each was verified only
 * against its own reading of them. The roadmap records that this is not enough,
 * twice — Sprint 02's "91 tests passed while they disagreed", and Sprint 06's
 * three copies of a lexicon that disagreed on 20 of 31 titles. This sprint had
 * the sharper version again: #29's validator and #31's oracle both decide, from
 * the same contract and without importing each other, which
 * `STATIC_INFEASIBILITY_CODES` a set of constraints earns. Two self-consistent
 * readings leave both suites green and the disagreement invisible.
 *
 * So the checks here are deliberately not "does each track work". They are:
 *
 *  1. Do the two independent implementations of the static vocabulary return
 *     the same answer on the same input — over the shipped corpus *and* over a
 *     table of adversarial inputs built to separate them.
 *  2. Does the path the sprint exists to build hold end to end — #31's
 *     scenarios, run against #30's real scheduler, with #31's expectations as
 *     the assertion.
 *
 * No single track can test either. This file is owned by the merge, for the
 * reason Sprint 05 gave the policy-freeze test to the merge: a check owned by
 * the thing it checks is not a check.
 *
 * A third group guards the suite itself. `node --test` **silently skips a test
 * file that does not exist and exits 0** — measured, not assumed — so a typo in
 * `package.json` would remove a whole track's coverage without any signal. The
 * registration check below is the only thing standing between that and a green
 * run reporting nothing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  STATIC_INFEASIBILITY_CODES,
  ATTEMPT_INFEASIBILITY_CODES,
  type PlanningConfig,
  type PlanningConstraints,
  type PlanningItem,
  type PlanningReasonCode,
  type WorkingWindow,
} from '../../src/contracts/v1/planningContracts.ts';
import { validateConstraints } from '../../lib/planning/constraints/validator.ts';
import { assessFeasibility } from '../../lib/planning/evaluation/oracle.ts';
import { schedulePlan } from '../../lib/planning/scheduler/index.ts';
import { defaultPlanningScenarioCorpus } from '../../lib/planning/evaluation/scenarios.ts';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..', '..');

const STATIC = new Set<string>(STATIC_INFEASIBILITY_CODES);
const ATTEMPT = new Set<string>(ATTEMPT_INFEASIBILITY_CODES);

const CONFIG: PlanningConfig = {
  slotMinutes: 30,
  foldPolicy: 'earliest',
  resourceDependenciesOrder: false,
};

function staticCodesFromValidator(
  constraints: PlanningConstraints,
  config: PlanningConfig,
): string[] {
  return Array.from(new Set(
    validateConstraints(constraints, config)
      .map((reason) => reason.code)
      .filter((code) => STATIC.has(code)),
  )).sort();
}

function staticCodesFromOracle(
  constraints: PlanningConstraints,
  config: PlanningConfig,
): string[] {
  return Array.from(new Set(
    assessFeasibility(constraints, config).reasons
      .map((reason) => reason.code)
      .filter((code) => STATIC.has(code)),
  )).sort();
}

/* ── Fixtures ────────────────────────────────────────────────────── */

const HORIZON = { startsAt: '2026-11-09T00:00:00.000Z', endsAt: '2026-11-16T00:00:00.000Z' };

function window(overrides: Partial<WorkingWindow> = {}): WorkingWindow {
  return {
    windowId: 'w-1',
    weekday: 1,
    startMinute: 540,
    endMinute: 1020,
    timezone: 'America/New_York',
    ...overrides,
  };
}

function item(overrides: Partial<PlanningItem> = {}): PlanningItem {
  return {
    itemId: 'i-1',
    title: 'write the thing',
    effort: { kind: 'known', minutes: 60 },
    earliestStartAt: null,
    deadlineAt: null,
    priority: 1,
    dependsOn: [],
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    ...overrides,
  };
}

function constraints(overrides: Partial<PlanningConstraints> = {}): PlanningConstraints {
  return {
    scopeId: 'scope-1',
    timezone: 'America/New_York',
    horizon: HORIZON,
    workingWindows: [window()],
    fixedEvents: [],
    items: [item()],
    ...overrides,
  };
}

/* ── 1. The vocabulary agreement ─────────────────────────────────── */

/**
 * One case per way the two implementations could read the contract differently.
 *
 * Each is built once and handed to both. The assertion is not that a particular
 * code appears, but that the two independently-written implementations return
 * the *same set* — which is why the expected set is not written down here at
 * all. A table with expectations would be a third reading of the contract, and
 * the point is to compare the two that exist.
 *
 * The list is skewed towards the boundaries that independent review found the
 * tracks splitting on: DST anomalies inside and outside the horizon, malformed
 * window fields, an inverted horizon, dependency edges by kind, and deadlines
 * on either side of the horizon.
 */
const DIVERGENCE_CASES: ReadonlyArray<{
  readonly name: string;
  readonly constraints: PlanningConstraints;
  readonly config?: PlanningConfig;
}> = [
  { name: 'clean and feasible', constraints: constraints() },

  /* Effort */
  { name: 'unknown effort', constraints: constraints({ items: [item({ effort: { kind: 'unknown' } })] }) },
  { name: 'zero effort', constraints: constraints({ items: [item({ effort: { kind: 'known', minutes: 0 } })] }) },
  { name: 'negative effort', constraints: constraints({ items: [item({ effort: { kind: 'known', minutes: -30 } })] }) },

  /* Item window */
  {
    name: 'deadline before earliest start',
    constraints: constraints({ items: [item({
      earliestStartAt: '2026-11-10T15:00:00.000Z',
      deadlineAt: '2026-11-10T14:00:00.000Z',
    })] }),
  },
  {
    name: 'effort exceeds a self-specified item window',
    constraints: constraints({ items: [item({
      earliestStartAt: '2026-11-10T14:00:00.000Z',
      deadlineAt: '2026-11-10T14:10:00.000Z',
      effort: { kind: 'known', minutes: 600 },
    })] }),
  },
  {
    name: 'buffers push a fitting effort past its own deadline',
    constraints: constraints({ items: [item({
      earliestStartAt: '2026-11-10T14:00:00.000Z',
      deadlineAt: '2026-11-10T15:00:00.000Z',
      effort: { kind: 'known', minutes: 55 },
      bufferBeforeMinutes: 30,
      bufferAfterMinutes: 30,
    })] }),
  },

  /* Deadlines against the horizon — one on each side */
  {
    name: 'deadline before the horizon starts',
    constraints: constraints({ items: [item({ deadlineAt: '2026-11-01T00:00:00.000Z' })] }),
  },
  {
    name: 'deadline long after the horizon ends',
    constraints: constraints({ items: [item({ deadlineAt: '2026-12-25T00:00:00.000Z' })] }),
  },

  /* Horizon */
  {
    name: 'inverted horizon',
    constraints: constraints({ horizon: { startsAt: '2026-11-16T00:00:00.000Z', endsAt: '2026-11-09T00:00:00.000Z' } }),
  },
  {
    name: 'inverted horizon plus an item that contradicts itself',
    constraints: constraints({
      horizon: { startsAt: '2026-11-16T00:00:00.000Z', endsAt: '2026-11-09T00:00:00.000Z' },
      items: [item({
        earliestStartAt: '2026-11-10T14:00:00.000Z',
        deadlineAt: '2026-11-10T14:10:00.000Z',
        effort: { kind: 'known', minutes: 600 },
      })],
    }),
  },

  /* Working windows */
  { name: 'no working windows at all', constraints: constraints({ workingWindows: [] }) },
  { name: 'window ends before it starts', constraints: constraints({ workingWindows: [window({ startMinute: 1020, endMinute: 540 })] }) },
  { name: 'window ends exactly where it starts', constraints: constraints({ workingWindows: [window({ startMinute: 540, endMinute: 540 })] }) },
  { name: 'window ending at local midnight', constraints: constraints({ workingWindows: [window({ startMinute: 0, endMinute: 1440 })] }) },
  { name: 'weekday out of range', constraints: constraints({ workingWindows: [window({ weekday: 7 as WorkingWindow['weekday'] })] }) },
  { name: 'weekday non-integral', constraints: constraints({ workingWindows: [window({ weekday: 1.5 as WorkingWindow['weekday'] })] }) },
  { name: 'startMinute out of range', constraints: constraints({ workingWindows: [window({ startMinute: 2000 })] }) },
  { name: 'endMinute out of range', constraints: constraints({ workingWindows: [window({ startMinute: 0, endMinute: 1441 })] }) },
  { name: 'minute is NaN', constraints: constraints({ workingWindows: [window({ startMinute: Number.NaN })] }) },
  { name: 'unknown IANA zone', constraints: constraints({ workingWindows: [window({ timezone: 'Mars/Phobos' })] }) },
  {
    name: 'one malformed window beside three sound ones',
    constraints: constraints({ workingWindows: [
      window({ windowId: 'w-a', weekday: 1 }),
      window({ windowId: 'w-b', weekday: 2 }),
      window({ windowId: 'w-c', weekday: 3, startMinute: 900, endMinute: 600 }),
      window({ windowId: 'w-d', weekday: 4 }),
    ] }),
  },

  /* DST — the sharpest inputs, on both sides of the horizon */
  {
    name: 'window starting inside a spring-forward gap, inside the horizon',
    constraints: constraints({
      horizon: { startsAt: '2026-03-08T00:00:00.000Z', endsAt: '2026-03-09T00:00:00.000Z' },
      workingWindows: [window({ weekday: 0, startMinute: 120, endMinute: 360 })],
    }),
  },
  {
    name: 'window lying entirely inside a spring-forward gap',
    constraints: constraints({
      horizon: { startsAt: '2026-03-08T00:00:00.000Z', endsAt: '2026-03-09T00:00:00.000Z' },
      workingWindows: [window({ weekday: 0, startMinute: 120, endMinute: 150 })],
    }),
  },
  {
    name: 'a gap anomaly on an occurrence the horizon never reaches',
    constraints: constraints({
      horizon: { startsAt: '2026-03-09T00:00:00.000Z', endsAt: '2026-03-10T00:00:00.000Z' },
      workingWindows: [window({ weekday: 0, startMinute: 120, endMinute: 360 })],
    }),
  },
  {
    name: 'window starting inside a fall-back fold',
    constraints: constraints({
      horizon: { startsAt: '2026-11-01T00:00:00.000Z', endsAt: '2026-11-02T00:00:00.000Z' },
      workingWindows: [window({ weekday: 0, startMinute: 60, endMinute: 240 })],
    }),
  },
  {
    name: 'Jerusalem spring forward, an RTL-locale zone with its own dates',
    constraints: constraints({
      timezone: 'Asia/Jerusalem',
      horizon: { startsAt: '2026-03-27T00:00:00.000Z', endsAt: '2026-03-28T00:00:00.000Z' },
      workingWindows: [window({ weekday: 5, startMinute: 120, endMinute: 360, timezone: 'Asia/Jerusalem' })],
    }),
  },

  /* Fixed events */
  {
    name: 'two blocking fixed events overlapping each other',
    constraints: constraints({ fixedEvents: [
      { eventId: 'e-a', interval: { startsAt: '2026-11-09T14:00:00.000Z', endsAt: '2026-11-09T16:00:00.000Z' }, sourceCommitmentId: null, blocking: true },
      { eventId: 'e-b', interval: { startsAt: '2026-11-09T15:00:00.000Z', endsAt: '2026-11-09T17:00:00.000Z' }, sourceCommitmentId: null, blocking: true },
    ] }),
  },
  {
    name: 'blocking events that merely abut',
    constraints: constraints({ fixedEvents: [
      { eventId: 'e-a', interval: { startsAt: '2026-11-09T14:00:00.000Z', endsAt: '2026-11-09T15:00:00.000Z' }, sourceCommitmentId: null, blocking: true },
      { eventId: 'e-b', interval: { startsAt: '2026-11-09T15:00:00.000Z', endsAt: '2026-11-09T16:00:00.000Z' }, sourceCommitmentId: null, blocking: true },
    ] }),
  },
  {
    name: 'overlapping non-blocking events are not a conflict',
    constraints: constraints({ fixedEvents: [
      { eventId: 'e-a', interval: { startsAt: '2026-11-09T14:00:00.000Z', endsAt: '2026-11-09T16:00:00.000Z' }, sourceCommitmentId: null, blocking: false },
      { eventId: 'e-b', interval: { startsAt: '2026-11-09T15:00:00.000Z', endsAt: '2026-11-09T17:00:00.000Z' }, sourceCommitmentId: null, blocking: false },
    ] }),
  },
  {
    name: 'a zero-length fixed event',
    constraints: constraints({ fixedEvents: [
      { eventId: 'e-a', interval: { startsAt: '2026-11-09T14:00:00.000Z', endsAt: '2026-11-09T14:00:00.000Z' }, sourceCommitmentId: null, blocking: true },
    ] }),
  },

  /* Dependencies — the edge-kind split the tracks divided on */
  {
    name: 'temporal self-edge',
    constraints: constraints({ items: [item({ dependsOn: [{ dependsOnItemId: 'i-1', kind: 'temporal' }] })] }),
  },
  {
    name: 'informational self-edge — kind must not matter',
    constraints: constraints({ items: [item({ dependsOn: [{ dependsOnItemId: 'i-1', kind: 'informational' }] })] }),
  },
  {
    name: 'resource self-edge — kind must not matter',
    constraints: constraints({ items: [item({ dependsOn: [{ dependsOnItemId: 'i-1', kind: 'resource' }] })] }),
  },
  {
    name: 'temporal edge to an absent item',
    constraints: constraints({ items: [item({ dependsOn: [{ dependsOnItemId: 'ghost', kind: 'temporal' }] })] }),
  },
  {
    name: 'informational edge to an absent item — kind must not matter',
    constraints: constraints({ items: [item({ dependsOn: [{ dependsOnItemId: 'ghost', kind: 'informational' }] })] }),
  },
  {
    name: 'two-item temporal cycle',
    constraints: constraints({ items: [
      item({ itemId: 'i-1', dependsOn: [{ dependsOnItemId: 'i-2', kind: 'temporal' }] }),
      item({ itemId: 'i-2', dependsOn: [{ dependsOnItemId: 'i-1', kind: 'temporal' }] }),
    ] }),
  },
  {
    name: 'informational cycle — carries no order, so it is not a contradiction',
    constraints: constraints({ items: [
      item({ itemId: 'i-1', dependsOn: [{ dependsOnItemId: 'i-2', kind: 'informational' }] }),
      item({ itemId: 'i-2', dependsOn: [{ dependsOnItemId: 'i-1', kind: 'informational' }] }),
    ] }),
  },
  {
    name: 'a dangling edge beside an over-sized item window — two independent defects',
    constraints: constraints({ items: [item({
      dependsOn: [{ dependsOnItemId: 'ghost', kind: 'temporal' }],
      earliestStartAt: '2026-11-10T14:00:00.000Z',
      deadlineAt: '2026-11-10T14:10:00.000Z',
      effort: { kind: 'known', minutes: 600 },
    })] }),
  },

  /* Config-sensitivity: the same constraints under the other flag */
  {
    name: 'resource cycle with ordering off',
    constraints: constraints({ items: [
      item({ itemId: 'i-1', dependsOn: [{ dependsOnItemId: 'i-2', kind: 'resource' }] }),
      item({ itemId: 'i-2', dependsOn: [{ dependsOnItemId: 'i-1', kind: 'resource' }] }),
    ] }),
  },
  {
    name: 'resource cycle with ordering on',
    constraints: constraints({ items: [
      item({ itemId: 'i-1', dependsOn: [{ dependsOnItemId: 'i-2', kind: 'resource' }] }),
      item({ itemId: 'i-2', dependsOn: [{ dependsOnItemId: 'i-1', kind: 'resource' }] }),
    ] }),
    config: { ...CONFIG, resourceDependenciesOrder: true },
  },
];

test('cross-track: the divergence table separates the two implementations at all', () => {
  // A table on which every case yields the empty set would make the agreement
  // test below pass without comparing anything. This asserts the table actually
  // provokes findings, and names how many distinct codes it reaches.
  const reached = new Set<string>();
  for (const testCase of DIVERGENCE_CASES) {
    for (const code of staticCodesFromValidator(testCase.constraints, testCase.config ?? CONFIG)) {
      reached.add(code);
    }
  }
  assert.ok(
    reached.size >= 10,
    `the table reaches only ${reached.size} static codes (${Array.from(reached).sort().join(', ')}); it is too weak to compare two implementations`,
  );
});

test('cross-track: validator and oracle agree on every case in the divergence table', () => {
  const disagreements: string[] = [];
  for (const testCase of DIVERGENCE_CASES) {
    const config = testCase.config ?? CONFIG;
    let fromValidator: string[];
    let fromOracle: string[];
    // A throw is a disagreement too, and the more dangerous kind: an oracle
    // that raises cannot return the finding list it exists to return.
    try {
      fromValidator = staticCodesFromValidator(testCase.constraints, config);
    } catch (error) {
      fromValidator = [`THREW ${(error as Error).name}`];
    }
    try {
      fromOracle = staticCodesFromOracle(testCase.constraints, config);
    } catch (error) {
      fromOracle = [`THREW ${(error as Error).name}`];
    }
    if (JSON.stringify(fromValidator) !== JSON.stringify(fromOracle)) {
      disagreements.push(`  ${testCase.name}\n    #29 validator: [${fromValidator.join(', ')}]\n    #31 oracle:    [${fromOracle.join(', ')}]`);
    }
  }
  assert.deepEqual(
    disagreements,
    [],
    `the two independent readings of STATIC_INFEASIBILITY_CODES disagree:\n${disagreements.join('\n')}\n`,
  );
});

test('cross-track: validator and oracle agree on every scenario in the shipped corpus', () => {
  const corpus = defaultPlanningScenarioCorpus();
  const all = [...corpus.locked, ...corpus.tunable];
  assert.ok(all.length > 0, 'the corpus is empty, so this comparison proves nothing');

  const disagreements: string[] = [];
  for (const scenario of all) {
    const fromValidator = staticCodesFromValidator(scenario.constraints, scenario.config);
    const fromOracle = staticCodesFromOracle(scenario.constraints, scenario.config);
    if (JSON.stringify(fromValidator) !== JSON.stringify(fromOracle)) {
      disagreements.push(`  ${scenario.scenarioId}: #29 [${fromValidator.join(', ')}] vs #31 [${fromOracle.join(', ')}]`);
    }
  }
  assert.deepEqual(disagreements, [], `corpus disagreements:\n${disagreements.join('\n')}\n`);
});

test('cross-track: neither implementation ever emits an attempt code', () => {
  // The partition is what makes the comparison above well-defined. A static
  // reader that emitted NO_FEASIBLE_SLOT would be guessing at contention.
  for (const testCase of DIVERGENCE_CASES) {
    const config = testCase.config ?? CONFIG;
    let emitted: string[] = [];
    try {
      emitted = [
        ...validateConstraints(testCase.constraints, config).map((r) => r.code),
        ...assessFeasibility(testCase.constraints, config).reasons.map((r) => r.code),
      ];
    } catch {
      continue; // a throw is reported by the agreement test, not here
    }
    for (const code of emitted) {
      assert.equal(ATTEMPT.has(code), false, `${testCase.name}: a static reader emitted the attempt code ${code}`);
    }
  }
});

/* ── 2. The sprint's path, end to end ────────────────────────────── */

test('cross-track: every corpus scenario runs through the real scheduler and meets its expectation', () => {
  const corpus = defaultPlanningScenarioCorpus();
  const all = [...corpus.locked, ...corpus.tunable];
  const failures: string[] = [];

  for (const scenario of all) {
    const plan = schedulePlan(scenario.constraints, scenario.config);

    const scheduled = plan.scheduled.map((entry) => entry.itemId).sort();
    const expectedScheduled = [...scenario.expectation.expectedScheduledItemIds].sort();
    if (JSON.stringify(scheduled) !== JSON.stringify(expectedScheduled)) {
      failures.push(`  ${scenario.scenarioId}: scheduled [${scheduled.join(', ')}], expected [${expectedScheduled.join(', ')}]`);
    }

    for (const entry of plan.unscheduled) {
      const expected = scenario.expectation.expectedUnscheduledReasons[entry.itemId];
      if (expected === undefined) {
        failures.push(`  ${scenario.scenarioId}: ${entry.itemId} unscheduled (${entry.reason.code}) with no expectation`);
      } else if (expected !== entry.reason.code) {
        failures.push(`  ${scenario.scenarioId}: ${entry.itemId} unscheduled as ${entry.reason.code}, expected ${expected}`);
      }
    }
  }

  assert.deepEqual(
    failures,
    [],
    `#31's scenarios do not hold against #30's real scheduler:\n${failures.join('\n')}\n`,
  );
});

test('cross-track: the plan partitions every input item exactly once', () => {
  // The invariant no per-item assertion catches. An item in neither list is a
  // silently dropped commitment; an item in both is a double-booked user.
  const corpus = defaultPlanningScenarioCorpus();
  for (const scenario of [...corpus.locked, ...corpus.tunable]) {
    const plan = schedulePlan(scenario.constraints, scenario.config);
    const seen = [...plan.scheduled.map((e) => e.itemId), ...plan.unscheduled.map((e) => e.itemId)].sort();
    const expected = scenario.constraints.items.map((i) => i.itemId).sort();
    assert.deepEqual(seen, expected, `${scenario.scenarioId}: plan does not partition its items`);
  }
});

test('cross-track: a plan is reproducible from the same scenario', () => {
  const corpus = defaultPlanningScenarioCorpus();
  for (const scenario of [...corpus.locked, ...corpus.tunable]) {
    const first = schedulePlan(scenario.constraints, scenario.config);
    const second = schedulePlan(scenario.constraints, scenario.config);
    assert.equal(first.inputDigest, second.inputDigest, `${scenario.scenarioId}: digest is not stable`);
    assert.deepEqual(second, first, `${scenario.scenarioId}: two runs of one scenario produced different plans`);
  }
});

test('cross-track: a static contradiction the readers agree on is never scheduled away', () => {
  // The three tracks joined: where #29 and #31 both say an item is statically
  // impossible, #30 must not have placed it. This is the one assertion that
  // spans all three, and it is the one that would catch a scheduler quietly
  // disagreeing with a vocabulary both other tracks share.
  for (const testCase of DIVERGENCE_CASES) {
    const config = testCase.config ?? CONFIG;
    let fromValidator: string[];
    try {
      fromValidator = staticCodesFromValidator(testCase.constraints, config);
    } catch {
      continue;
    }
    const itemLevel = validateConstraints(testCase.constraints, config)
      .filter((reason) => reason.itemId !== null && STATIC.has(reason.code));
    if (itemLevel.length === 0 || fromValidator.length === 0) continue;

    const plan = schedulePlan(testCase.constraints, config);
    const placed = new Set(plan.scheduled.map((entry) => entry.itemId));
    for (const reason of itemLevel) {
      assert.equal(
        placed.has(reason.itemId as string),
        false,
        `${testCase.name}: ${reason.itemId} is statically ${reason.code} yet the scheduler placed it`,
      );
    }
  }
});

/* ── 3. The suite guards itself ──────────────────────────────────── */

test('every planning test file registered in package.json actually exists', () => {
  // `node --test` skips a missing file silently and exits 0 — measured on this
  // runner, not assumed. A typo in the script would delete a track's coverage
  // with no signal at all, and every other guard in this sprint sits behind
  // that failure mode.
  const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const registered = new Set<string>();
  for (const [name, script] of Object.entries(packageJson.scripts)) {
    if (name !== 'test' && name !== 'test:sprint07') continue;
    for (const match of Array.from(script.matchAll(/(tests\/planning\/[\w.-]+\.test\.ts)/g))) {
      registered.add(match[1]);
    }
  }

  assert.ok(registered.size >= 16, `expected the sprint's planning files to be registered, found ${registered.size}`);
  const missing = Array.from(registered).filter((file) => !existsSync(join(repoRoot, file))).sort();
  assert.deepEqual(missing, [], `registered but absent, so silently never run:\n  ${missing.join('\n  ')}`);
});

test('the sprint 07 script and the full test script register the same planning files', () => {
  // Two lists that drift apart mean `npm run test:sprint07` reports green over
  // a subset while `npm test` covers something else.
  const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const filesIn = (script: string): string[] => Array.from(
    new Set(Array.from(script.matchAll(/(tests\/planning\/[\w.-]+\.test\.ts)/g)).map((m) => m[1])),
  ).sort();

  assert.deepEqual(
    filesIn(packageJson.scripts['test:sprint07']),
    filesIn(packageJson.scripts.test),
    'test:sprint07 and test cover different planning files',
  );
});
