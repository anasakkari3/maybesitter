/**
 * Placement (Sprint 07, issue #30): where the scheduler puts work, and what it
 * refuses to put work on top of.
 *
 * Three of issue #30's acceptance criteria are asserted here — no overlap with
 * fixed commitments, dependencies respected, and the buffer rule that makes the
 * first of those checkable at all. The fourth (same inputs, same plan) is
 * `schedulerDeterminism.test.ts`.
 *
 * Every conflict assertion below goes through `intervalsOverlap` from
 * `lib/planning/shared/time`, not through a hand-written comparison. A test that
 * re-derived the half-open rule would be free to derive it differently from the
 * scheduler, and then both would be self-consistent and one would be wrong —
 * which is the exact failure `lib/planning/shared/` was written to prevent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { schedulePlan } from '../../lib/planning/scheduler/index.ts';
import { intervalsOverlap, minutesBetween, toEpochMs } from '../../lib/planning/shared/time.ts';
import type {
  FixedEvent,
  PlannedItem,
  PlanningConfig,
  PlanningConstraints,
  PlanningItem,
  WorkingWindow,
} from '../../src/contracts/v1/planningContracts.ts';

/* ── Fixtures ───────────────────────────────────────────────────── */

// 2026-08-17 is a Monday in UTC. Every fixture is anchored to it so a failure
// names a wall-clock time a reader can check by hand.
const HORIZON_START = '2026-08-17T00:00:00.000Z';
const HORIZON_END = '2026-08-18T00:00:00.000Z';

function config(overrides: Partial<PlanningConfig> = {}): PlanningConfig {
  return { slotMinutes: 15, foldPolicy: 'earliest', resourceDependenciesOrder: false, ...overrides };
}

function workingWindow(windowId: string, overrides: Partial<WorkingWindow> = {}): WorkingWindow {
  // Monday 09:00-17:00 UTC. `endMinute` is exclusive, so 1020 is 17:00.
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
    scopeId: 'scope-placement',
    timezone: 'UTC',
    horizon: { startsAt: HORIZON_START, endsAt: HORIZON_END },
    workingWindows: [workingWindow('w-monday')],
    fixedEvents: [],
    items: [],
    ...overrides,
  };
}

function placed(plan: { scheduled: readonly PlannedItem[] }, itemId: string): PlannedItem {
  const found = plan.scheduled.find((entry) => entry.itemId === itemId);
  assert.ok(found, `expected ${itemId} to be scheduled; it was not`);
  return found;
}

/* ── Working windows ────────────────────────────────────────────── */

test('an item lands at the first free minute of the working window, not at the horizon start', () => {
  const plan = schedulePlan(constraints({ items: [item('a')] }), config());

  assert.equal(plan.unscheduled.length, 0);
  assert.deepEqual(placed(plan, 'a').interval, {
    startsAt: '2026-08-17T09:00:00.000Z',
    endsAt: '2026-08-17T10:00:00.000Z',
  });
});

test('nothing is placed outside the horizon, even where a working window continues', () => {
  // The window recurs every Monday; the horizon covers exactly one day. An
  // item that could only fit next week must not be dated next week.
  const plan = schedulePlan(
    constraints({ items: [item('a', { effort: { kind: 'known', minutes: 480 } }), item('b')] }),
    config(),
  );

  for (const entry of plan.scheduled) {
    assert.ok(toEpochMs(entry.reservedInterval.startsAt) >= toEpochMs(HORIZON_START));
    assert.ok(toEpochMs(entry.reservedInterval.endsAt) <= toEpochMs(HORIZON_END));
  }
});

test('placement starts on a slot boundary measured from the horizon start', () => {
  // A 20-minute grid does not divide 09:00 from midnight, so the first legal
  // start inside the window is 09:00 exactly (540 = 27 * 20). A 50-minute grid
  // does not: the first multiple of 50 at or after 540 is 550, i.e. 09:10.
  const plan = schedulePlan(constraints({ items: [item('a')] }), config({ slotMinutes: 50 }));

  assert.equal(placed(plan, 'a').interval.startsAt, '2026-08-17T09:10:00.000Z');
});

/* ── Fixed events ───────────────────────────────────────────────── */

test('placed work never overlaps a blocking fixed event', () => {
  const meeting = fixedEvent('m-1', '2026-08-17T09:00:00.000Z', '2026-08-17T11:00:00.000Z');
  const plan = schedulePlan(
    constraints({ fixedEvents: [meeting], items: [item('a'), item('b')] }),
    config(),
  );

  assert.equal(plan.unscheduled.length, 0);
  for (const entry of plan.scheduled) {
    assert.equal(
      intervalsOverlap(entry.reservedInterval, meeting.interval),
      false,
      `${entry.itemId} was placed on top of a blocking fixed event`,
    );
  }
  assert.equal(placed(plan, 'a').interval.startsAt, '2026-08-17T11:00:00.000Z');
});

test('work may abut a fixed event exactly, because interval ends are exclusive', () => {
  const meeting = fixedEvent('m-1', '2026-08-17T09:00:00.000Z', '2026-08-17T10:00:00.000Z');
  const plan = schedulePlan(constraints({ fixedEvents: [meeting], items: [item('a')] }), config());

  assert.equal(placed(plan, 'a').interval.startsAt, '2026-08-17T10:00:00.000Z');
});

test('a non-blocking fixed event does not reserve the time it covers', () => {
  // `blocking: false` is how a calendar says "this is on your calendar but you
  // are not occupied by it". Treating it as a wall would silently shrink every
  // day that contains an all-day marker.
  const marker = fixedEvent('m-1', '2026-08-17T09:00:00.000Z', '2026-08-17T17:00:00.000Z', false);
  const plan = schedulePlan(constraints({ fixedEvents: [marker], items: [item('a')] }), config());

  assert.equal(placed(plan, 'a').interval.startsAt, '2026-08-17T09:00:00.000Z');
});

/* ── Buffers ────────────────────────────────────────────────────── */

test('reservedInterval widens interval by the buffers and is never narrower', () => {
  const plan = schedulePlan(
    constraints({ items: [item('a', { bufferBeforeMinutes: 15, bufferAfterMinutes: 30 })] }),
    config(),
  );
  const entry = placed(plan, 'a');

  assert.equal(minutesBetween(entry.reservedInterval.startsAt, entry.interval.startsAt), 15);
  assert.equal(minutesBetween(entry.interval.endsAt, entry.reservedInterval.endsAt), 30);
  assert.ok(toEpochMs(entry.reservedInterval.startsAt) <= toEpochMs(entry.interval.startsAt));
  assert.ok(toEpochMs(entry.reservedInterval.endsAt) >= toEpochMs(entry.interval.endsAt));
});

test('two items whose efforts would abut are separated by their buffers', () => {
  // Without the buffer rule b would start at 10:00. `reservedInterval` is what
  // conflict checks compare, so it starts at 10:30 instead: a's 30 minutes of
  // recovery, then b's own 15 minutes of preparation.
  const plan = schedulePlan(
    constraints({
      items: [
        item('a', { priority: 10, bufferAfterMinutes: 30 }),
        item('b', { priority: 5, bufferBeforeMinutes: 15 }),
      ],
    }),
    config(),
  );

  assert.equal(placed(plan, 'a').interval.endsAt, '2026-08-17T10:00:00.000Z');
  assert.equal(placed(plan, 'b').reservedInterval.startsAt, '2026-08-17T10:30:00.000Z');
  assert.equal(placed(plan, 'b').interval.startsAt, '2026-08-17T10:45:00.000Z');
});

test('no two placed items reserve overlapping time', () => {
  const many = Array.from({ length: 6 }, (_unused, index) => item(`item-${index}`, {
    effort: { kind: 'known', minutes: 45 },
    bufferAfterMinutes: 10,
    priority: index,
  }));
  const plan = schedulePlan(constraints({ items: many }), config({ slotMinutes: 5 }));

  assert.ok(plan.scheduled.length >= 5, 'the fixture must actually exercise contention');
  for (const left of plan.scheduled) {
    for (const right of plan.scheduled) {
      if (left.itemId === right.itemId) continue;
      assert.equal(
        intervalsOverlap(left.reservedInterval, right.reservedInterval),
        false,
        `${left.itemId} and ${right.itemId} reserve overlapping time`,
      );
    }
  }
});

/* ── Dependencies ───────────────────────────────────────────────── */

test('a temporal dependency orders the pair even when priority says otherwise', () => {
  // `a` outranks `b` on priority, so an implementation that sorted candidates
  // and never consulted the graph would place `a` at 09:00 and pass every
  // overlap assertion in this file.
  const plan = schedulePlan(
    constraints({
      items: [
        item('a', { priority: 100, dependsOn: [{ dependsOnItemId: 'b', kind: 'temporal' }] }),
        item('b', { priority: 1 }),
      ],
    }),
    config(),
  );

  const first = placed(plan, 'b');
  const second = placed(plan, 'a');
  assert.ok(
    toEpochMs(second.interval.startsAt) >= toEpochMs(first.reservedInterval.endsAt),
    'the dependent item started before its prerequisite had finished being reserved',
  );
  assert.equal(first.interval.startsAt, '2026-08-17T09:00:00.000Z');
});

test('a temporal dependency waits for the prerequisite buffer, not just its effort', () => {
  const plan = schedulePlan(
    constraints({
      items: [
        item('a', { priority: 100, dependsOn: [{ dependsOnItemId: 'b', kind: 'temporal' }] }),
        item('b', { priority: 1, bufferAfterMinutes: 45 }),
      ],
    }),
    config(),
  );

  assert.equal(placed(plan, 'b').interval.endsAt, '2026-08-17T10:00:00.000Z');
  assert.equal(placed(plan, 'a').interval.startsAt, '2026-08-17T10:45:00.000Z');
});

test('temporal ordering is transitive through a chain', () => {
  const plan = schedulePlan(
    constraints({
      items: [
        item('c', { priority: 100, dependsOn: [{ dependsOnItemId: 'b', kind: 'temporal' }] }),
        item('b', { priority: 50, dependsOn: [{ dependsOnItemId: 'a', kind: 'temporal' }] }),
        item('a', { priority: 1 }),
      ],
    }),
    config(),
  );

  assert.deepEqual(
    plan.scheduled.map((entry) => entry.itemId),
    ['a', 'b', 'c'],
    'a chain must be laid out in chain order regardless of priority',
  );
});

test('a resource dependency does not force ordering while the v1 config says it does not', () => {
  const shape = constraints({
    items: [
      item('a', { priority: 100, dependsOn: [{ dependsOnItemId: 'b', kind: 'resource' }] }),
      item('b', { priority: 1 }),
    ],
  });

  const v1 = schedulePlan(shape, config({ resourceDependenciesOrder: false }));
  assert.equal(placed(v1, 'a').interval.startsAt, '2026-08-17T09:00:00.000Z');

  // The same input under the other setting is the reason the flag is part of
  // the digest: it changes the plan, so it changes what "the same inputs" means.
  const ordered = schedulePlan(shape, config({ resourceDependenciesOrder: true }));
  assert.ok(
    toEpochMs(placed(ordered, 'a').interval.startsAt)
      >= toEpochMs(placed(ordered, 'b').reservedInterval.endsAt),
  );
});

test('an informational dependency never forces ordering, under either config', () => {
  const shape = constraints({
    items: [
      item('a', { priority: 100, dependsOn: [{ dependsOnItemId: 'b', kind: 'informational' }] }),
      item('b', { priority: 1 }),
    ],
  });

  for (const resourceDependenciesOrder of [false, true]) {
    const plan = schedulePlan(shape, config({ resourceDependenciesOrder }));
    assert.equal(
      placed(plan, 'a').interval.startsAt,
      '2026-08-17T09:00:00.000Z',
      'informational edges are recorded, never scheduled on',
    );
  }
});

/* ── Item windows ───────────────────────────────────────────────── */

test('an item does not start before its own earliestStartAt', () => {
  const plan = schedulePlan(
    constraints({ items: [item('a', { earliestStartAt: '2026-08-17T13:20:00.000Z' })] }),
    config(),
  );

  assert.equal(placed(plan, 'a').reservedInterval.startsAt, '2026-08-17T13:30:00.000Z');
});

test('it is the reserved interval, not the effort, that must land before the deadline', () => {
  // 60 minutes of effort plus 30 of recovery, due at 10:30: it fits exactly.
  const fits = schedulePlan(
    constraints({ items: [item('a', { deadlineAt: '2026-08-17T10:30:00.000Z', bufferAfterMinutes: 30 })] }),
    config(),
  );
  assert.equal(placed(fits, 'a').reservedInterval.endsAt, '2026-08-17T10:30:00.000Z');
  assert.ok(toEpochMs(placed(fits, 'a').interval.endsAt) < toEpochMs('2026-08-17T10:30:00.000Z'));

  // The same item due fifteen minutes earlier does not. The effort alone would
  // have finished at 10:00 and a scheduler that compared only `interval` would
  // have placed it and quietly eaten the recovery time.
  const doesNot = schedulePlan(
    constraints({ items: [item('a', { deadlineAt: '2026-08-17T10:15:00.000Z', bufferAfterMinutes: 30 })] }),
    config(),
  );
  assert.equal(doesNot.scheduled.length, 0);
  assert.equal(doesNot.unscheduled[0].reason.code, 'NO_FEASIBLE_SLOT');
});

/* ── Plan shape ─────────────────────────────────────────────────── */

test('the scheduled list is sorted by start time, then by descending priority', () => {
  const plan = schedulePlan(
    constraints({
      items: [item('z', { priority: 1 }), item('m', { priority: 9 }), item('a', { priority: 5 })],
    }),
    config(),
  );

  assert.deepEqual(plan.scheduled.map((entry) => entry.itemId), ['m', 'a', 'z']);
  for (let index = 1; index < plan.scheduled.length; index += 1) {
    assert.ok(
      toEpochMs(plan.scheduled[index].interval.startsAt)
        >= toEpochMs(plan.scheduled[index - 1].interval.startsAt),
    );
  }
});

test('the plan reports the scope and horizon it was asked about', () => {
  const shape = constraints({ items: [item('a')] });
  const plan = schedulePlan(shape, config());

  assert.equal(plan.scopeId, shape.scopeId);
  assert.deepEqual(plan.horizon, shape.horizon);
  assert.equal(plan.schema, 'planning-v1');
  assert.equal(plan.version, 'v1');
});
