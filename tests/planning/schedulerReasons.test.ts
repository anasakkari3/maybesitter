/**
 * The unscheduled-reason taxonomy (Sprint 07, issue #30).
 *
 * Issue #30's second deliverable is a taxonomy, and a taxonomy is only worth
 * having if each code is reachable and no code is used for another's job. Two
 * things are asserted here that a per-case test would miss:
 *
 *  1. **Coverage.** Every code this module can emit is emitted by a case in
 *     this file, checked against the contract's own frozen lists rather than
 *     against a list retyped here. A code nobody produces is a promise to a
 *     user that never arrives; a code produced by nothing anyone tested is a
 *     message no one has read.
 *
 *  2. **The partition.** Every input item lands in exactly one of `scheduled`
 *     and `unscheduled`. An item in neither is the failure no per-item
 *     assertion catches — the suite passes, the plan looks complete, and one
 *     commitment has silently ceased to exist.
 *
 * The static/attempt split is the contract's, and it is checked in both
 * directions: an attempt code emitted for an item nobody tried to place would
 * tell a user "this lost the last free hour" about an item that had no duration
 * to begin with.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { schedulePlan } from '../../lib/planning/scheduler/index.ts';
// Reached directly rather than through the public surface: `itemsOnCycles` is
// an internal the exhaustive sweep below drives 4096 times, and widening the
// module's exported surface for a test would be the wrong trade.
import { itemsOnCycles } from '../../lib/planning/scheduler/scheduler.ts';
import {
  ATTEMPT_INFEASIBILITY_CODES,
  STATIC_INFEASIBILITY_CODES,
  type FixedEvent,
  type Plan,
  type PlanningConfig,
  type PlanningConstraints,
  type PlanningItem,
  type PlanningReasonCode,
  type WorkingWindow,
} from '../../src/contracts/v1/planningContracts.ts';

const HORIZON_START = '2026-08-17T00:00:00.000Z';
const HORIZON_END = '2026-08-18T00:00:00.000Z';

function config(overrides: Partial<PlanningConfig> = {}): PlanningConfig {
  return { slotMinutes: 15, foldPolicy: 'earliest', resourceDependenciesOrder: false, ...overrides };
}

function workingWindow(windowId: string, overrides: Partial<WorkingWindow> = {}): WorkingWindow {
  return { windowId, weekday: 1, startMinute: 540, endMinute: 1020, timezone: 'UTC', ...overrides };
}

function item(itemId: string, overrides: Partial<PlanningItem> = {}): PlanningItem {
  return {
    itemId,
    title: `title of ${itemId}`,
    effort: { kind: 'known', minutes: 60 },
    earliestStartAt: null,
    deadlineAt: null,
    priority: 0,
    dependsOn: [],
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    ...overrides,
  };
}

function fixedEvent(eventId: string, startsAt: string, endsAt: string, blocking = true): FixedEvent {
  return { eventId, interval: { startsAt, endsAt }, sourceCommitmentId: null, blocking };
}

function constraints(overrides: Partial<PlanningConstraints> = {}): PlanningConstraints {
  return {
    scopeId: 'scope-reasons',
    timezone: 'UTC',
    horizon: { startsAt: HORIZON_START, endsAt: HORIZON_END },
    workingWindows: [workingWindow('w-monday')],
    fixedEvents: [],
    items: [],
    ...overrides,
  };
}

/** Every code seen anywhere in this file, so coverage can be asserted at the end. */
const observedItemCodes = new Set<PlanningReasonCode>();
const observedConstraintCodes = new Set<PlanningReasonCode>();

function reasonFor(plan: Plan, itemId: string): PlanningReasonCode {
  const entry = plan.unscheduled.find((row) => row.itemId === itemId);
  assert.ok(entry, `expected ${itemId} to be unscheduled; it was not`);
  for (const row of plan.unscheduled) observedItemCodes.add(row.reason.code);
  for (const row of plan.constraintReasons) observedConstraintCodes.add(row.code);
  return entry.reason.code;
}

function constraintCodes(plan: Plan): PlanningReasonCode[] {
  for (const row of plan.constraintReasons) observedConstraintCodes.add(row.code);
  for (const row of plan.unscheduled) observedItemCodes.add(row.reason.code);
  return plan.constraintReasons.map((row) => row.code);
}

/* ── Static codes: impossible before anything was tried ─────────── */

test('EFFORT_UNKNOWN: a duration the planner does not know is reported, never guessed', () => {
  const plan = schedulePlan(constraints({ items: [item('a', { effort: { kind: 'unknown' } })] }), config());
  assert.equal(reasonFor(plan, 'a'), 'EFFORT_UNKNOWN');
});

test('EFFORT_NOT_POSITIVE: a zero-length task would satisfy every overlap check and say nothing', () => {
  const plan = schedulePlan(constraints({ items: [item('a', { effort: { kind: 'known', minutes: 0 } })] }), config());
  assert.equal(reasonFor(plan, 'a'), 'EFFORT_NOT_POSITIVE');
});

test('DEADLINE_BEFORE_EARLIEST_START: the item window is empty before any other constraint', () => {
  const plan = schedulePlan(
    constraints({
      items: [item('a', {
        earliestStartAt: '2026-08-17T12:00:00.000Z',
        deadlineAt: '2026-08-17T10:00:00.000Z',
      })],
    }),
    config(),
  );
  assert.equal(reasonFor(plan, 'a'), 'DEADLINE_BEFORE_EARLIEST_START');
});

test('DEADLINE_BEYOND_HORIZON: the deadline is at or before the horizon opens', () => {
  // There is no minute this plan could use: every instant it may place work in
  // is already past the deadline.
  const earlier = schedulePlan(
    constraints({ items: [item('a', { deadlineAt: '2026-08-10T09:00:00.000Z' })] }),
    config(),
  );
  assert.equal(reasonFor(earlier, 'a'), 'DEADLINE_BEYOND_HORIZON');

  const exactlyAtTheStart = schedulePlan(
    constraints({ items: [item('a', { deadlineAt: HORIZON_START })] }),
    config(),
  );
  assert.equal(reasonFor(exactlyAtTheStart, 'a'), 'DEADLINE_BEYOND_HORIZON');
});

test('an item due after the horizon ends is the least constrained item, and is placed', () => {
  // It used to be refused. An item due in December, planned over one Monday, is
  // not infeasible — it is the *easiest* thing in the request, and the horizon
  // binds long before the deadline does.
  const plan = schedulePlan(
    constraints({ items: [item('a', { deadlineAt: '2026-12-01T00:00:00.000Z' })] }),
    config(),
  );

  assert.equal(plan.unscheduled.length, 0);
  assert.equal(plan.scheduled[0].interval.startsAt, '2026-08-17T09:00:00.000Z');
  assert.ok(
    plan.scheduled[0].reservedInterval.endsAt <= HORIZON_END,
    'the horizon still binds, even though the deadline does not',
  );
});

test('EFFORT_EXCEEDS_ITEM_WINDOW: it would not fit even if every minute were free', () => {
  const plan = schedulePlan(
    constraints({
      items: [item('a', {
        effort: { kind: 'known', minutes: 700 },
        deadlineAt: '2026-08-17T10:00:00.000Z',
      })],
    }),
    config(),
  );
  assert.equal(reasonFor(plan, 'a'), 'EFFORT_EXCEEDS_ITEM_WINDOW');
});

test('NO_WORKING_WINDOW: reported once about the request and once per item', () => {
  const plan = schedulePlan(constraints({ workingWindows: [], items: [item('a')] }), config());
  assert.equal(reasonFor(plan, 'a'), 'NO_WORKING_WINDOW');
  assert.ok(constraintCodes(plan).includes('NO_WORKING_WINDOW'));
  assert.deepEqual(
    plan.constraintReasons.filter((row) => row.code === 'NO_WORKING_WINDOW').map((row) => row.itemId),
    [null],
    'a finding about the request as a whole is not attributable to one item',
  );
});

test('a working window that never intersects the horizon is the same as having none', () => {
  // Saturday windows over a Monday horizon: the windows exist, and there is
  // still nowhere legal to put anything.
  const plan = schedulePlan(
    constraints({ workingWindows: [workingWindow('w-sat', { weekday: 6 })], items: [item('a')] }),
    config(),
  );
  assert.equal(reasonFor(plan, 'a'), 'NO_WORKING_WINDOW');
});

test('SELF_DEPENDENCY takes precedence over CYCLIC_DEPENDENCY: one defect earns one code', () => {
  const plan = schedulePlan(
    constraints({ items: [item('a', { dependsOn: [{ dependsOnItemId: 'a', kind: 'temporal' }] })] }),
    config(),
  );
  assert.equal(reasonFor(plan, 'a'), 'SELF_DEPENDENCY');
});

test('CYCLIC_DEPENDENCY: both items on a two-cycle are reported, and neither is placed', () => {
  const plan = schedulePlan(
    constraints({
      items: [
        item('a', { dependsOn: [{ dependsOnItemId: 'b', kind: 'temporal' }] }),
        item('b', { dependsOn: [{ dependsOnItemId: 'a', kind: 'temporal' }] }),
      ],
    }),
    config(),
  );
  assert.equal(reasonFor(plan, 'a'), 'CYCLIC_DEPENDENCY');
  assert.equal(reasonFor(plan, 'b'), 'CYCLIC_DEPENDENCY');
  assert.equal(plan.scheduled.length, 0);
});

test('a cycle of edges this config does not order is not a cycle worth refusing', () => {
  // `informational` never forces ordering, so a loop of informational links
  // constrains nothing. Refusing it would send the user to break a link that
  // was never going to move anything, and would leave a feasible request
  // unplanned.
  const plan = schedulePlan(
    constraints({
      items: [
        item('a', { dependsOn: [{ dependsOnItemId: 'b', kind: 'informational' }] }),
        item('b', { dependsOn: [{ dependsOnItemId: 'a', kind: 'informational' }] }),
      ],
    }),
    config(),
  );
  assert.equal(plan.unscheduled.length, 0);
  assert.equal(plan.scheduled.length, 2);
});

test('UNKNOWN_DEPENDENCY: an edge pointing at no item in this request', () => {
  const plan = schedulePlan(
    constraints({ items: [item('a', { dependsOn: [{ dependsOnItemId: 'ghost', kind: 'temporal' }] })] }),
    config(),
  );
  assert.equal(reasonFor(plan, 'a'), 'UNKNOWN_DEPENDENCY');
});

test('SELF_DEPENDENCY and UNKNOWN_DEPENDENCY do not depend on the config', () => {
  // These two are input-integrity defects: an item naming itself, or naming
  // something that is not in the request. They are decidable from the
  // constraints alone, which is what `STATIC_INFEASIBILITY_CODES` *means* — and
  // #29's validator and #31's oracle are compared against exactly that claim.
  //
  // Computing them over ordering edges only made a static verdict depend on
  // `PlanningConfig.resourceDependenciesOrder`: the same constraints reported
  // UNKNOWN_DEPENDENCY under one flag and scheduled cleanly under the other,
  // and no change on either sibling track could have made the comparison agree.
  for (const kind of ['temporal', 'resource', 'informational'] as const) {
    for (const resourceDependenciesOrder of [false, true]) {
      const unknown = schedulePlan(
        constraints({ items: [item('a', { dependsOn: [{ dependsOnItemId: 'ghost', kind }] })] }),
        config({ resourceDependenciesOrder }),
      );
      assert.equal(
        reasonFor(unknown, 'a'),
        'UNKNOWN_DEPENDENCY',
        `a dangling ${kind} edge is a defect in the request under either config`,
      );

      const self = schedulePlan(
        constraints({ items: [item('a', { dependsOn: [{ dependsOnItemId: 'a', kind }] })] }),
        config({ resourceDependenciesOrder }),
      );
      assert.equal(reasonFor(self, 'a'), 'SELF_DEPENDENCY', `a ${kind} self-edge is always a defect`);
    }
  }
});

test('CYCLIC_DEPENDENCY, by contrast, is a statement about whether an ordering exists', () => {
  // A cycle asks "can these be sequenced", and edges the config does not
  // consult impose no sequence — so unlike the two above, this one is read over
  // the ordering edges. `resource` edges therefore cycle only when the config
  // says they order, which is the same rule #29 applies.
  const resourceCycle = constraints({
    items: [
      item('a', { dependsOn: [{ dependsOnItemId: 'b', kind: 'resource' }] }),
      item('b', { dependsOn: [{ dependsOnItemId: 'a', kind: 'resource' }] }),
    ],
  });

  const unordered = schedulePlan(resourceCycle, config({ resourceDependenciesOrder: false }));
  assert.equal(unordered.unscheduled.length, 0, 'a loop nobody sequences is not a loop worth refusing');

  const ordered = schedulePlan(resourceCycle, config({ resourceDependenciesOrder: true }));
  assert.equal(reasonFor(ordered, 'a'), 'CYCLIC_DEPENDENCY');
  assert.equal(reasonFor(ordered, 'b'), 'CYCLIC_DEPENDENCY');
});

/**
 * Whether each node can reach itself in one or more steps, computed directly
 * from the definition of "sits on a cycle".
 *
 * Deliberately the slowest, most obvious formulation available — one search per
 * node, no bookkeeping shared between them. It is the oracle, so it must be
 * readable rather than fast: the scheduler computes the same set a different
 * way, and a test that reimplemented the scheduler's method would agree with it
 * about a shared mistake.
 */
function nodesOnCycles(
  nodes: readonly string[],
  edges: ReadonlyMap<string, readonly string[]>,
): Set<string> {
  const found = new Set<string>();
  for (const start of nodes) {
    const seen = new Set<string>();
    const queue: string[] = (edges.get(start) ?? []).slice();
    while (queue.length > 0) {
      const node = queue.shift() as string;
      if (node === start) {
        found.add(start);
        break;
      }
      if (seen.has(node)) continue;
      seen.add(node);
      for (const next of edges.get(node) ?? []) queue.push(next);
    }
  }
  return found;
}

test('an item reaching a cycle through a cross edge is still on the cycle', () => {
  // a -> b, a -> c, b -> a, c -> b. The cycle a -> c -> b -> a runs through c,
  // but a depth-first walk that only marks the grey path on a *back* edge never
  // sees it: by the time c is explored, b is already finished, so the edge
  // c -> b is a cross edge and neither branch fires.
  //
  // The consequence was worse than a missing code. Falling through to the
  // placement pass reported c as BLOCKED_BY_DEPENDENCY — an *attempt* code, for
  // an item that can never start under any schedule. That crosses the partition
  // the whole sprint is built around: it tells the user "this lost to
  // contention" about a contradiction in their own request.
  const plan = schedulePlan(
    constraints({
      items: [
        item('a', { dependsOn: [{ dependsOnItemId: 'b', kind: 'temporal' }, { dependsOnItemId: 'c', kind: 'temporal' }] }),
        item('b', { dependsOn: [{ dependsOnItemId: 'a', kind: 'temporal' }] }),
        item('c', { dependsOn: [{ dependsOnItemId: 'b', kind: 'temporal' }] }),
      ],
    }),
    config(),
  );

  assert.deepEqual(
    plan.unscheduled.map((entry) => `${entry.itemId}:${entry.reason.code}`),
    ['a:CYCLIC_DEPENDENCY', 'b:CYCLIC_DEPENDENCY', 'c:CYCLIC_DEPENDENCY'],
  );
  for (const entry of plan.unscheduled) {
    assert.equal(
      (ATTEMPT_INFEASIBILITY_CODES as readonly string[]).includes(entry.reason.code),
      false,
      `${entry.itemId} got an attempt code for a static contradiction`,
    );
  }
});

/** All directed graphs on `nodes` with no self-edges, as adjacency maps. */
function everyGraph(nodes: readonly string[]): Map<string, string[]>[] {
  const pairs: (readonly [string, string])[] = [];
  for (const from of nodes) {
    for (const to of nodes) {
      if (from !== to) pairs.push([from, to] as const);
    }
  }

  const graphs: Map<string, string[]>[] = [];
  for (let mask = 0; mask < (1 << pairs.length); mask += 1) {
    const edges = new Map<string, string[]>(nodes.map((node) => [node, [] as string[]]));
    for (let bit = 0; bit < pairs.length; bit += 1) {
      if ((mask & (1 << bit)) !== 0) {
        const [from, to] = pairs[bit];
        (edges.get(from) as string[]).push(to);
      }
    }
    graphs.push(edges);
  }
  return graphs;
}

test('cycle membership matches the definition on every four-node graph', () => {
  // All 4096 directed graphs on four nodes with no self-edges — self-edges are
  // SELF_DEPENDENCY and take precedence, so they are a different question.
  // Exhaustive rather than sampled: a fuzzer found the case above, and a
  // property checkable in full at this size should be checked in full.
  //
  // Against the pure function, because 4096 whole planning runs cost a second
  // and a half and would be paying that to re-test window materialisation. The
  // sweep below covers the wiring end to end.
  const nodes = ['n0', 'n1', 'n2', 'n3'] as const;
  for (const edges of everyGraph(nodes)) {
    assert.deepEqual(
      Array.from(itemsOnCycles(edges)).sort(),
      Array.from(nodesOnCycles(nodes, edges)).sort(),
      `edges ${JSON.stringify(Array.from(edges.entries()))}`,
    );
  }
});

test('and the scheduler reports exactly those items, on every three-node graph', () => {
  // End to end this time: the pure function above can be right while the code
  // that consults it reports the wrong half of the taxonomy, which is what the
  // cross-edge case actually did.
  const nodes = ['n0', 'n1', 'n2'] as const;
  for (const edges of everyGraph(nodes)) {
    const plan = schedulePlan(
      constraints({
        items: nodes.map((node) => item(node, {
          effort: { kind: 'known', minutes: 30 },
          dependsOn: (edges.get(node) as string[]).map((to) => ({ dependsOnItemId: to, kind: 'temporal' as const })),
        })),
      }),
      config(),
    );

    const expected = Array.from(nodesOnCycles(nodes, edges)).sort();
    assert.deepEqual(
      plan.unscheduled
        .filter((entry) => entry.reason.code === 'CYCLIC_DEPENDENCY')
        .map((entry) => entry.itemId)
        .sort(),
      expected,
      `edges ${JSON.stringify(Array.from(edges.entries()))}`,
    );

    // And nothing on a cycle may be described with an attempt code.
    for (const entry of plan.unscheduled) {
      if (expected.indexOf(entry.itemId) === -1) continue;
      assert.equal(
        (ATTEMPT_INFEASIBILITY_CODES as readonly string[]).includes(entry.reason.code),
        false,
        `${entry.itemId} sits on a cycle and was given the attempt code ${entry.reason.code}`,
      );
    }
  }
});

/* ── Attempt codes: tried, and lost ─────────────────────────────── */

test('NO_FEASIBLE_SLOT: free time existed, but never a long enough contiguous run', () => {
  // The day is chopped into 45-minute gaps by meetings, and the item needs 60.
  const meetings = [
    fixedEvent('m-1', '2026-08-17T09:45:00.000Z', '2026-08-17T11:00:00.000Z'),
    fixedEvent('m-2', '2026-08-17T11:45:00.000Z', '2026-08-17T13:00:00.000Z'),
    fixedEvent('m-3', '2026-08-17T13:45:00.000Z', '2026-08-17T17:00:00.000Z'),
  ];
  const plan = schedulePlan(constraints({ fixedEvents: meetings, items: [item('a')] }), config());
  assert.equal(reasonFor(plan, 'a'), 'NO_FEASIBLE_SLOT');
});

test('BLOCKED_BY_DEPENDENCY is transitive and names the chain, not the root cause as its own', () => {
  const plan = schedulePlan(
    constraints({
      items: [
        item('root', { effort: { kind: 'unknown' } }),
        item('mid', { dependsOn: [{ dependsOnItemId: 'root', kind: 'temporal' }] }),
        item('leaf', { dependsOn: [{ dependsOnItemId: 'mid', kind: 'temporal' }] }),
      ],
    }),
    config(),
  );

  assert.equal(reasonFor(plan, 'root'), 'EFFORT_UNKNOWN');
  assert.equal(reasonFor(plan, 'mid'), 'BLOCKED_BY_DEPENDENCY');
  assert.equal(
    reasonFor(plan, 'leaf'),
    'BLOCKED_BY_DEPENDENCY',
    'the far end of the chain must not inherit the root defect as if it were its own',
  );

  // What the detail may say is pinned by 'a blocked chain reports its depth and
  // root cause without naming the chain' below; the identifier ruling forbids
  // listing the intervening item ids here.
});

test('DEPENDENCY_TOO_LATE: every prerequisite was placed, and there is no room after them', () => {
  const plan = schedulePlan(
    constraints({
      items: [
        item('prep', { priority: 100 }),
        item('a', {
          priority: 1,
          deadlineAt: '2026-08-17T10:30:00.000Z',
          dependsOn: [{ dependsOnItemId: 'prep', kind: 'temporal' }],
        }),
      ],
    }),
    config(),
  );

  assert.equal(plan.scheduled.map((entry) => entry.itemId).includes('prep'), true);
  assert.equal(
    reasonFor(plan, 'a'),
    'DEPENDENCY_TOO_LATE',
    'the prerequisite was placed, so this is contention with the deadline, not a broken graph',
  );
});

test('HORIZON_EXHAUSTED: the horizon ended before this item could take its turn', () => {
  const plan = schedulePlan(
    constraints({
      horizon: { startsAt: HORIZON_START, endsAt: '2026-08-17T17:00:00.000Z' },
      items: [
        item('all-day', { effort: { kind: 'known', minutes: 480 } }),
        item('a', { dependsOn: [{ dependsOnItemId: 'all-day', kind: 'temporal' }] }),
      ],
    }),
    config(),
  );

  assert.deepEqual(plan.scheduled.map((entry) => entry.itemId), ['all-day']);
  assert.equal(
    reasonFor(plan, 'a'),
    'HORIZON_EXHAUSTED',
    'the prerequisite consumed the horizon, so there was no turn left rather than no room',
  );
});

/* ── Constraint-level findings ──────────────────────────────────── */

test('INVALID_INTERVAL is reported for the horizon, a window, and a fixed event alike', () => {
  const badHorizon = schedulePlan(
    constraints({ horizon: { startsAt: HORIZON_END, endsAt: HORIZON_START }, items: [item('a')] }),
    config(),
  );
  assert.ok(constraintCodes(badHorizon).includes('INVALID_INTERVAL'));

  const badWindow = schedulePlan(
    constraints({ workingWindows: [workingWindow('w-bad', { startMinute: 600, endMinute: 600 })] }),
    config(),
  );
  assert.ok(constraintCodes(badWindow).includes('INVALID_INTERVAL'));

  const badEvent = schedulePlan(
    constraints({ fixedEvents: [fixedEvent('m-1', '2026-08-17T10:00:00.000Z', '2026-08-17T10:00:00.000Z')] }),
    config(),
  );
  assert.ok(constraintCodes(badEvent).includes('INVALID_INTERVAL'));
});

test('FIXED_EVENT_CONFLICT: the user was claimed to be in two places before planning began', () => {
  const plan = schedulePlan(
    constraints({
      fixedEvents: [
        fixedEvent('m-1', '2026-08-17T09:00:00.000Z', '2026-08-17T11:00:00.000Z'),
        fixedEvent('m-2', '2026-08-17T10:00:00.000Z', '2026-08-17T12:00:00.000Z'),
      ],
      items: [item('a')],
    }),
    config(),
  );
  assert.ok(constraintCodes(plan).includes('FIXED_EVENT_CONFLICT'));
  // Reported, not fatal: both are still subtracted, so the item lands after them.
  assert.equal(plan.scheduled.length, 1);
});

test('two non-blocking events on top of each other are not a conflict', () => {
  const plan = schedulePlan(
    constraints({
      fixedEvents: [
        fixedEvent('m-1', '2026-08-17T09:00:00.000Z', '2026-08-17T11:00:00.000Z', false),
        fixedEvent('m-2', '2026-08-17T10:00:00.000Z', '2026-08-17T12:00:00.000Z', false),
      ],
    }),
    config(),
  );
  assert.equal(constraintCodes(plan).includes('FIXED_EVENT_CONFLICT'), false);
});

test('NONEXISTENT_LOCAL_TIME: a window that starts inside a daylight-saving gap', () => {
  // 2026-03-08 is the spring-forward Sunday in America/New_York: 02:00 local
  // becomes 03:00, so a window starting at 02:30 starts at a time no clock in
  // that zone ever shows.
  const plan = schedulePlan(
    constraints({
      timezone: 'America/New_York',
      horizon: { startsAt: '2026-03-08T00:00:00.000Z', endsAt: '2026-03-09T12:00:00.000Z' },
      workingWindows: [{
        windowId: 'w-gap',
        weekday: 0,
        startMinute: 150,
        endMinute: 300,
        timezone: 'America/New_York',
      }],
      items: [item('a', { effort: { kind: 'known', minutes: 30 } })],
    }),
    config(),
  );

  assert.ok(constraintCodes(plan).includes('NONEXISTENT_LOCAL_TIME'));
  // The window is shorter that day, not absent: work still lands in what is
  // left of it, which is the whole reason `resumesAt` exists.
  assert.equal(plan.scheduled.length, 1);
});

test('AMBIGUOUS_LOCAL_TIME is never emitted, because the config always resolves the fold', () => {
  // 2026-11-01 is the fall-back Sunday in America/New_York: 01:30 happens
  // twice. `PlanningConfig.foldPolicy` is not optional, so there is always an
  // answer, and the contract says this is "resolved, not reported". A scheduler
  // that emitted it anyway would be asking a caller to decide something the
  // config had already decided.
  for (const foldPolicy of ['earliest', 'latest'] as const) {
    const plan = schedulePlan(
      constraints({
        timezone: 'America/New_York',
        horizon: { startsAt: '2026-11-01T00:00:00.000Z', endsAt: '2026-11-02T12:00:00.000Z' },
        workingWindows: [{
          windowId: 'w-fold',
          weekday: 0,
          startMinute: 90,
          endMinute: 300,
          timezone: 'America/New_York',
        }],
        items: [item('a', { effort: { kind: 'known', minutes: 30 } })],
      }),
      config({ foldPolicy }),
    );
    assert.equal(constraintCodes(plan).includes('AMBIGUOUS_LOCAL_TIME'), false);
  }
});

/* ── Values the taxonomy can describe are reported, not thrown ──── */

/**
 * If the taxonomy names it, report it; throwing is reserved for input the
 * taxonomy cannot describe.
 *
 * The digest used to be the first thing `schedulePlan` did, and it refused any
 * non-finite number — so a `NaN` minute count came back as a `TypeError`
 * instead of as the `INVALID_INTERVAL` the contract names *by hand* for exactly
 * that case. Both static readers report these; a third that throws is invisible
 * to a typed caller and immediate at the untyped boundary, which is where these
 * values come from in the first place.
 */
test('a non-finite window minute is INVALID_INTERVAL, not an exception', () => {
  const plan = schedulePlan(
    constraints({
      workingWindows: [workingWindow('w-nan', { startMinute: Number.NaN })],
      items: [item('a')],
    }),
    config(),
  );

  const codes = constraintCodes(plan);
  assert.ok(codes.includes('INVALID_INTERVAL'), JSON.stringify(codes));
  assert.ok(codes.includes('NO_WORKING_WINDOW'), JSON.stringify(codes));
  assert.equal(reasonFor(plan, 'a'), 'NO_WORKING_WINDOW');
});

test('a non-finite effort is EFFORT_NOT_POSITIVE, not an exception', () => {
  for (const minutes of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const plan = schedulePlan(
      constraints({ items: [item('a', { effort: { kind: 'known', minutes } })] }),
      config(),
    );
    assert.equal(reasonFor(plan, 'a'), 'EFFORT_NOT_POSITIVE', `effort ${String(minutes)}`);
  }
});

test('every unusable buffer is EFFORT_NOT_POSITIVE, and zero is not one', () => {
  // All five shapes in one table, deliberately. The non-finite half was fixed
  // one round before the negative half, and the negative half survived because
  // the guard read `!Number.isFinite(...)` with no `< 0` — a table split across
  // two tests is exactly how a rule gets half-applied and stays that way.
  //
  // A negative buffer is the shape that matters most: it does not blow the
  // arithmetic up, it quietly widens the reservation the wrong way, so both
  // static readers called the item impossible while this scheduler placed it.
  const unusable = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -5, -0.5];
  for (const field of ['bufferBeforeMinutes', 'bufferAfterMinutes'] as const) {
    for (const value of unusable) {
      const plan = schedulePlan(constraints({ items: [item('a', { [field]: value })] }), config());
      assert.equal(
        reasonFor(plan, 'a'),
        'EFFORT_NOT_POSITIVE',
        `${field}=${String(value)} must be reported, not repaired`,
      );
      assert.equal(plan.scheduled.length, 0, `${field}=${String(value)} was placed anyway`);
    }

    // Zero stays legitimate: "no protected time around this" is a normal
    // request, and a rule that swept it up would make every unbuffered item
    // unschedulable.
    const fine = schedulePlan(constraints({ items: [item('a', { [field]: 0 })] }), config());
    assert.equal(fine.unscheduled.length, 0, `${field}=0 is a perfectly ordinary request`);
    assert.equal(fine.scheduled.length, 1);
  }
});

test('a non-finite buffer is EFFORT_NOT_POSITIVE, not an exception', () => {
  // The taxonomy has no buffer-specific code, and #29 reads this as
  // EFFORT_NOT_POSITIVE. Agreeing with the other static reader matters more
  // than the code being the one this track would have picked alone: a
  // disagreement here is precisely what the cross-track comparison exists to
  // surface, and it would be a disagreement about nothing.
  for (const field of ['bufferBeforeMinutes', 'bufferAfterMinutes'] as const) {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const plan = schedulePlan(
        constraints({ items: [item('a', { [field]: value })] }),
        config(),
      );
      assert.equal(reasonFor(plan, 'a'), 'EFFORT_NOT_POSITIVE', `${field}=${String(value)}`);
    }
  }
});

test('a non-finite priority is not a defect at all, and does not destabilise the order', () => {
  // Nothing in the taxonomy describes a priority, so there is nothing to
  // report: the item schedules. The hazard is the comparator — `NaN - 0` is
  // `NaN`, and a comparator returning `NaN` puts the sort into
  // implementation-defined behaviour, which is exactly the kind of drift
  // `PLAN_ORDERING_KEYS` exists to rule out.
  const shape = constraints({
    items: [item('a', { priority: Number.NaN }), item('b'), item('c', { priority: Number.POSITIVE_INFINITY })],
  });
  const plan = schedulePlan(shape, config());

  assert.equal(plan.unscheduled.length, 0);
  assert.equal(
    JSON.stringify(plan),
    JSON.stringify(schedulePlan({ ...shape, items: shape.items.slice().reverse() }, config())),
    'the order must stay total when a priority cannot be compared',
  );
});

/* ── Findings stay bounded ──────────────────────────────────────── */

test('overlapping fixed events produce a linear number of findings, not a quadratic one', () => {
  // A duplicated calendar feed is an ordinary shape, not an adversarial one.
  // Enumerating every pair of 200 identical events produced 19,900 findings and
  // three quarters of a megabyte of prose inside an object that travels into
  // audit records — the Sprint 06 draft-size failure, in a new place.
  const duplicated = Array.from({ length: 200 }, (_unused, index) => fixedEvent(
    `evt-${index}`,
    '2026-08-17T10:00:00.000Z',
    '2026-08-17T11:00:00.000Z',
  ));
  const plan = schedulePlan(constraints({ fixedEvents: duplicated, items: [item('a')] }), config());

  const conflicts = plan.constraintReasons.filter((row) => row.code === 'FIXED_EVENT_CONFLICT');
  assert.ok(conflicts.length > 0, 'the conflict must still be reported');
  assert.ok(
    conflicts.length < duplicated.length,
    `expected at most one finding per event, got ${conflicts.length} for ${duplicated.length} events`,
  );
  const bytes = conflicts.reduce((total, row) => total + row.detail.length, 0);
  assert.ok(bytes < 20_000, `${bytes} bytes of conflict prose in a plan that travels into audit records`);
});

test('a genuine chain of distinct overlaps is still reported, one finding per event', () => {
  const staircase = Array.from({ length: 4 }, (_unused, index) => fixedEvent(
    `evt-${index}`,
    `2026-08-17T1${index}:00:00.000Z`,
    `2026-08-17T1${index + 2}:00:00.000Z`,
  ));
  const plan = schedulePlan(constraints({ fixedEvents: staircase }), config());
  assert.equal(plan.constraintReasons.filter((row) => row.code === 'FIXED_EVENT_CONFLICT').length, 3);
});

test('fixed events that merely abut produce no conflict', () => {
  const plan = schedulePlan(
    constraints({
      fixedEvents: [
        fixedEvent('m-1', '2026-08-17T09:00:00.000Z', '2026-08-17T10:00:00.000Z'),
        fixedEvent('m-2', '2026-08-17T10:00:00.000Z', '2026-08-17T11:00:00.000Z'),
      ],
    }),
    config(),
  );
  assert.equal(constraintCodes(plan).includes('FIXED_EVENT_CONFLICT'), false);
});

/* ── The partition, and the static/attempt split ────────────────── */

const PARTITION_FIXTURES: readonly PlanningConstraints[] = [
  constraints({ items: [item('a'), item('b'), item('c')] }),
  constraints({ workingWindows: [], items: [item('a'), item('b')] }),
  constraints({
    items: [
      item('root', { effort: { kind: 'unknown' } }),
      item('mid', { dependsOn: [{ dependsOnItemId: 'root', kind: 'temporal' }] }),
      item('leaf', { dependsOn: [{ dependsOnItemId: 'mid', kind: 'temporal' }] }),
      item('free', { priority: 3 }),
    ],
  }),
  constraints({
    items: Array.from({ length: 12 }, (_unused, index) => item(`bulk-${index}`, {
      effort: { kind: 'known', minutes: 90 },
      priority: index % 4,
    })),
  }),
  constraints({
    horizon: { startsAt: HORIZON_END, endsAt: HORIZON_START },
    items: [item('a'), item('b')],
  }),
];

test('every input item lands in exactly one of scheduled and unscheduled', () => {
  for (const shape of PARTITION_FIXTURES) {
    const plan = schedulePlan(shape, config());
    const seen = new Map<string, string>();
    for (const entry of plan.scheduled) {
      assert.equal(seen.has(entry.itemId), false, `${entry.itemId} appears twice in scheduled`);
      seen.set(entry.itemId, 'scheduled');
    }
    for (const entry of plan.unscheduled) {
      assert.equal(
        seen.has(entry.itemId),
        false,
        `${entry.itemId} is both scheduled and unscheduled; the plan double-books while looking complete`,
      );
      seen.set(entry.itemId, 'unscheduled');
    }
    assert.deepEqual(
      Array.from(seen.keys()).sort(),
      shape.items.map((entry) => entry.itemId).sort(),
      'an item in neither list has silently ceased to exist',
    );
  }
});

test('constraint-level findings never carry an attempt code', () => {
  for (const shape of PARTITION_FIXTURES) {
    const plan = schedulePlan(shape, config());
    for (const reason of plan.constraintReasons) {
      assert.equal(
        (ATTEMPT_INFEASIBILITY_CODES as readonly string[]).includes(reason.code),
        false,
        `${reason.code} describes contention between items and cannot be a property of the request`,
      );
    }
  }
});

test('every unscheduled reason names the item it is about', () => {
  for (const shape of PARTITION_FIXTURES) {
    const plan = schedulePlan(shape, config());
    for (const entry of plan.unscheduled) {
      assert.equal(entry.reason.itemId, entry.itemId);
    }
  }
});

test('no reason detail carries a caller-chosen identifier or any user text', () => {
  // `detail` is for humans and is never *from* them. The ruling is that "raw
  // user text" covers identifiers too — a commitment id is as revealing as a
  // title, and often is one — and that `itemId` is exempt only because it has
  // its own field on `PlanningReason`, so it must not be repeated in the prose.
  //
  // Every id-bearing field gets a distinctive probe, including ids that belong
  // to *other* items: listing an item's dangling prerequisites by name leaked
  // identifiers the reason was not even about.
  const probes = [
    'PROBE-ITEM-QUITTING', 'PROBE-ITEM-OTHER', 'PROBE-GHOST-A', 'PROBE-GHOST-B',
    'PROBE-WINDOW', 'PROBE-EVENT', 'PROBE-COMMITMENT', 'PROBE-TITLE', 'PROBE-SCOPE',
  ];
  const shape: PlanningConstraints = {
    scopeId: 'PROBE-SCOPE',
    timezone: 'UTC',
    horizon: { startsAt: HORIZON_START, endsAt: HORIZON_END },
    workingWindows: [workingWindow('PROBE-WINDOW', { startMinute: 600, endMinute: 600 })],
    fixedEvents: [{
      eventId: 'PROBE-EVENT',
      interval: { startsAt: '2026-08-17T10:00:00.000Z', endsAt: '2026-08-17T10:00:00.000Z' },
      sourceCommitmentId: 'PROBE-COMMITMENT',
      blocking: true,
    }],
    items: [
      item('PROBE-ITEM-QUITTING', { title: 'PROBE-TITLE', effort: { kind: 'unknown' } }),
      item('PROBE-ITEM-OTHER', {
        dependsOn: [
          { dependsOnItemId: 'PROBE-GHOST-A', kind: 'temporal' },
          { dependsOnItemId: 'PROBE-GHOST-B', kind: 'temporal' },
        ],
      }),
    ],
  };

  const plan = schedulePlan(shape, config());
  const prose = plan.constraintReasons.map((row) => row.detail)
    .concat(plan.unscheduled.map((row) => row.reason.detail))
    .join('\n');

  assert.ok(prose.length > 0, 'the probe must actually produce findings, or it proves nothing');
  for (const probe of probes) {
    assert.equal(
      prose.includes(probe),
      false,
      `a reason detail names ${probe}; identifiers travel in their own fields, never in prose:\n${prose}`,
    );
  }
});

test('a blocked chain reports its depth and root cause without naming the chain', () => {
  const plan = schedulePlan(
    constraints({
      items: [
        item('root', { effort: { kind: 'unknown' } }),
        item('mid', { dependsOn: [{ dependsOnItemId: 'root', kind: 'temporal' }] }),
        item('leaf', { dependsOn: [{ dependsOnItemId: 'mid', kind: 'temporal' }] }),
      ],
    }),
    config(),
  );

  const leaf = plan.unscheduled.find((row) => row.itemId === 'leaf');
  assert.ok(leaf);
  assert.equal(leaf.reason.code, 'BLOCKED_BY_DEPENDENCY');
  // Still transitive, and still says so — the chain is described by its length
  // and where it bottoms out rather than by listing other items' ids.
  assert.match(leaf.reason.detail, /EFFORT_UNKNOWN/, 'the reason must say where the chain ends');
  assert.equal(leaf.reason.detail.includes('mid'), false, 'and must not name the items along it');
  assert.equal(leaf.reason.detail.includes('root'), false);
});

/* ── Coverage ───────────────────────────────────────────────────── */

test('every code this module can emit is exercised by a case above', () => {
  // Read from the contract's frozen lists, so a code added there fails here
  // until someone decides whether the scheduler emits it.
  const emitted = new Set<string>(
    Array.from(observedItemCodes).concat(Array.from(observedConstraintCodes)),
  );
  const notEmitted = STATIC_INFEASIBILITY_CODES.concat(ATTEMPT_INFEASIBILITY_CODES as never)
    .filter((code) => !emitted.has(code));

  assert.deepEqual(
    notEmitted,
    ['AMBIGUOUS_LOCAL_TIME'],
    'AMBIGUOUS_LOCAL_TIME is the one code this module deliberately never emits; anything else '
      + 'in this list is a code no case in this file reaches',
  );
});

test('the codes emitted for items respect the contract partition', () => {
  const known = new Set<string>(
    STATIC_INFEASIBILITY_CODES.concat(ATTEMPT_INFEASIBILITY_CODES as never),
  );
  for (const code of Array.from(observedItemCodes)) {
    assert.equal(known.has(code), true, `${code} is not in the shared vocabulary`);
  }
});
