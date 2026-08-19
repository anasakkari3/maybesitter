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

test('DEADLINE_BEYOND_HORIZON: this plan does not reach that far, in either direction', () => {
  const later = schedulePlan(
    constraints({ items: [item('a', { deadlineAt: '2026-08-25T09:00:00.000Z' })] }),
    config(),
  );
  assert.equal(reasonFor(later, 'a'), 'DEADLINE_BEYOND_HORIZON');

  const earlier = schedulePlan(
    constraints({ items: [item('a', { deadlineAt: '2026-08-10T09:00:00.000Z' })] }),
    config(),
  );
  assert.equal(reasonFor(earlier, 'a'), 'DEADLINE_BEYOND_HORIZON');
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

  const leaf = plan.unscheduled.find((row) => row.itemId === 'leaf');
  assert.ok(leaf);
  assert.match(leaf.reason.detail, /leaf -> mid -> root/, 'the reason must say what it is waiting on');
  assert.match(leaf.reason.detail, /EFFORT_UNKNOWN/, 'and where the chain bottoms out');
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

test('no reason detail repeats a title, because details are for humans and not from them', () => {
  const shape = constraints({
    items: [item('a', { title: 'CONFIDENTIAL-USER-TEXT', effort: { kind: 'unknown' } })],
  });
  const plan = schedulePlan(shape, config());
  const rendered = JSON.stringify(plan);
  assert.equal(
    rendered.includes('CONFIDENTIAL-USER-TEXT'),
    false,
    'a plan must not carry the user\'s own words, matching PLANNING_PERSISTENCE_POLICY.rawInputInAudit',
  );
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
