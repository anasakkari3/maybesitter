/**
 * Plan diff and replay support (Sprint 07, issue #30).
 *
 * A diff is how a replan becomes explainable: "here is what moved" is the only
 * form in which a user can consent to a new plan without re-reading the whole
 * thing. All five `PlanItemChange` kinds are exercised here, each produced by a
 * real pair of plans from the real scheduler rather than by hand-built `Plan`
 * literals — a diff tested against fixtures nobody scheduled is a test of the
 * fixtures.
 *
 * `sameInputDigest` gets its own attention because it is the field that says
 * whether the rest of the diff is churn or noise. Two plans from two different
 * requests will happily produce a long list of moves, and a replanning policy
 * that measured stability from such a list would be measuring how much its own
 * inputs changed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { diffPlans, schedulePlan } from '../../lib/planning/scheduler/index.ts';
import type {
  FixedEvent,
  PlanItemChange,
  PlanningConfig,
  PlanningConstraints,
  PlanningItem,
  WorkingWindow,
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

function fixedEvent(eventId: string, startsAt: string, endsAt: string): FixedEvent {
  return { eventId, interval: { startsAt, endsAt }, sourceCommitmentId: null, blocking: true };
}

function constraints(overrides: Partial<PlanningConstraints> = {}): PlanningConstraints {
  return {
    scopeId: 'scope-diff',
    timezone: 'UTC',
    horizon: { startsAt: HORIZON_START, endsAt: HORIZON_END },
    workingWindows: [workingWindow('w-monday')],
    fixedEvents: [],
    items: [],
    ...overrides,
  };
}

function changeFor(changes: readonly PlanItemChange[], itemId: string): PlanItemChange {
  const found = changes.find((change) => change.itemId === itemId);
  assert.ok(found, `expected a change entry for ${itemId}; there was none`);
  return found;
}

/* ── The five kinds ─────────────────────────────────────────────── */

test('unchanged: an item that stayed exactly where it was', () => {
  const shape = constraints({ items: [item('a'), item('b', { priority: -1 })] });
  const diff = diffPlans(schedulePlan(shape, config()), schedulePlan(shape, config()));

  assert.deepEqual(diff.changes.map((change) => change.kind), ['unchanged', 'unchanged']);
  const change = changeFor(diff.changes, 'a');
  assert.equal(change.kind, 'unchanged');
  if (change.kind === 'unchanged') {
    assert.deepEqual(change.at, {
      startsAt: '2026-08-17T09:00:00.000Z',
      endsAt: '2026-08-17T10:00:00.000Z',
    });
  }
});

test('moved: an item pushed later by a meeting that was not there before, with its shift', () => {
  const before = schedulePlan(constraints({ items: [item('a')] }), config());
  const after = schedulePlan(
    constraints({
      items: [item('a')],
      fixedEvents: [fixedEvent('m-1', '2026-08-17T09:00:00.000Z', '2026-08-17T11:30:00.000Z')],
    }),
    config(),
  );

  const change = changeFor(diffPlans(before, after).changes, 'a');
  assert.equal(change.kind, 'moved');
  if (change.kind === 'moved') {
    assert.equal(change.from.startsAt, '2026-08-17T09:00:00.000Z');
    assert.equal(change.to.startsAt, '2026-08-17T11:30:00.000Z');
    assert.equal(change.shiftMinutes, 150);
  }
});

test('moved carries a signed shift, so work pulled forward is distinguishable', () => {
  const crowded = schedulePlan(
    constraints({
      items: [item('a')],
      fixedEvents: [fixedEvent('m-1', '2026-08-17T09:00:00.000Z', '2026-08-17T11:30:00.000Z')],
    }),
    config(),
  );
  const cleared = schedulePlan(constraints({ items: [item('a')] }), config());

  const change = changeFor(diffPlans(crowded, cleared).changes, 'a');
  assert.equal(change.kind, 'moved');
  if (change.kind === 'moved') assert.equal(change.shiftMinutes, -150);
});

test('added: an item that has a placement now and did not before', () => {
  // In the first plan the day is full; in the second the meeting is gone.
  const blocked = schedulePlan(
    constraints({
      items: [item('a')],
      fixedEvents: [fixedEvent('m-1', '2026-08-17T09:00:00.000Z', '2026-08-17T17:00:00.000Z')],
    }),
    config(),
  );
  const freed = schedulePlan(constraints({ items: [item('a')] }), config());

  assert.equal(blocked.scheduled.length, 0);
  const change = changeFor(diffPlans(blocked, freed).changes, 'a');
  assert.equal(change.kind, 'added');
  if (change.kind === 'added') assert.equal(change.to.startsAt, '2026-08-17T09:00:00.000Z');
});

test('removed: an item that had a placement and lost it', () => {
  const freed = schedulePlan(constraints({ items: [item('a')] }), config());
  const blocked = schedulePlan(
    constraints({
      items: [item('a')],
      fixedEvents: [fixedEvent('m-1', '2026-08-17T09:00:00.000Z', '2026-08-17T17:00:00.000Z')],
    }),
    config(),
  );

  const change = changeFor(diffPlans(freed, blocked).changes, 'a');
  assert.equal(change.kind, 'removed');
  if (change.kind === 'removed') assert.equal(change.from.startsAt, '2026-08-17T09:00:00.000Z');
});

test('reason_changed: still unscheduled, but for a different reason than before', () => {
  // First it had no duration; then it got one and lost the day to a meeting.
  // "Still not scheduled" is the same headline and a completely different ask.
  const unknownEffort = schedulePlan(
    constraints({ items: [item('a', { effort: { kind: 'unknown' } })] }),
    config(),
  );
  const noRoom = schedulePlan(
    constraints({
      items: [item('a')],
      fixedEvents: [fixedEvent('m-1', '2026-08-17T09:00:00.000Z', '2026-08-17T17:00:00.000Z')],
    }),
    config(),
  );

  const change = changeFor(diffPlans(unknownEffort, noRoom).changes, 'a');
  assert.equal(change.kind, 'reason_changed');
  if (change.kind === 'reason_changed') {
    assert.equal(change.from, 'EFFORT_UNKNOWN');
    assert.equal(change.to, 'NO_FEASIBLE_SLOT');
  }
});

test('all five kinds can appear in one diff', () => {
  const busy = fixedEvent('m-1', '2026-08-17T09:00:00.000Z', '2026-08-17T17:00:00.000Z');
  const before = schedulePlan(
    constraints({
      items: [
        item('stays', { priority: 9 }),
        item('shifts', { priority: 8 }),
        item('drops', { priority: 7 }),
        item('reworded', { effort: { kind: 'unknown' } }),
      ],
    }),
    config(),
  );
  const after = schedulePlan(
    constraints({
      fixedEvents: [fixedEvent('m-2', '2026-08-17T10:00:00.000Z', '2026-08-17T11:00:00.000Z')],
      items: [
        item('stays', { priority: 9 }),
        item('shifts', { priority: 8 }),
        item('drops', { priority: 7, deadlineAt: '2026-08-17T09:30:00.000Z' }),
        item('reworded', { effort: { kind: 'known', minutes: 700 }, deadlineAt: '2026-08-17T10:00:00.000Z' }),
        item('appears', { priority: 1 }),
      ],
    }),
    config(),
  );

  const kinds = new Set(diffPlans(before, after).changes.map((change) => change.kind));
  assert.deepEqual(
    Array.from(kinds).sort(),
    ['added', 'moved', 'reason_changed', 'removed', 'unchanged'],
  );
});

/* ── Absences ───────────────────────────────────────────────────── */

test('an item unscheduled in both plans for the same reason produces no entry', () => {
  // `unchanged` carries a `TimeInterval`, so reporting "still not scheduled"
  // would mean fabricating a placement the item never had.
  const shape = constraints({ items: [item('a', { effort: { kind: 'unknown' } })] });
  const diff = diffPlans(schedulePlan(shape, config()), schedulePlan(shape, config()));
  assert.deepEqual(diff.changes, []);
});

test('an item that only ever had a reason and then vanished produces no entry', () => {
  const before = schedulePlan(
    constraints({ items: [item('a', { effort: { kind: 'unknown' } })] }),
    config(),
  );
  const after = schedulePlan(constraints({ items: [] }), config());
  assert.deepEqual(diffPlans(before, after).changes, []);
});

/* ── Replay ─────────────────────────────────────────────────────── */

test('sameInputDigest is true exactly when the two plans answered the same request', () => {
  const shape = constraints({ items: [item('a'), item('b', { priority: 4 })] });
  const replay = diffPlans(schedulePlan(shape, config()), schedulePlan(shape, config()));

  assert.equal(replay.sameInputDigest, true);
  assert.deepEqual(
    replay.changes.map((change) => change.kind),
    ['unchanged', 'unchanged'],
    'a replay of the same request must report no movement at all',
  );

  const different = diffPlans(
    schedulePlan(shape, config()),
    schedulePlan({ ...shape, items: [...shape.items, item('c')] }, config()),
  );
  assert.equal(different.sameInputDigest, false);
});

test('a config change alone is enough to make two plans not a replay of each other', () => {
  const shape = constraints({ items: [item('a')] });
  const diff = diffPlans(schedulePlan(shape, config()), schedulePlan(shape, config({ slotMinutes: 60 })));

  assert.equal(
    diff.sameInputDigest,
    false,
    'the config is an input; a diff across two configs is not churn',
  );
});

test('the diff is ordered by item id, so two runs produce the same list', () => {
  const before = schedulePlan(
    constraints({ items: [item('zulu'), item('alpha', { priority: 5 }), item('mike', { priority: 3 })] }),
    config(),
  );
  const after = schedulePlan(
    constraints({
      fixedEvents: [fixedEvent('m-1', '2026-08-17T09:00:00.000Z', '2026-08-17T10:00:00.000Z')],
      items: [item('mike', { priority: 3 }), item('zulu'), item('alpha', { priority: 5 })],
    }),
    config(),
  );

  const diff = diffPlans(before, after);
  assert.deepEqual(diff.changes.map((change) => change.itemId), ['alpha', 'mike', 'zulu']);
  assert.equal(JSON.stringify(diff), JSON.stringify(diffPlans(before, after)));
});

test('two instants that denote the same moment are not a move', () => {
  // A plan that had been round-tripped through a serialiser writing
  // `...T09:00:00Z` rather than `...T09:00:00.000Z` must not read as churn.
  const plan = schedulePlan(constraints({ items: [item('a')] }), config());
  const restated = {
    ...plan,
    scheduled: plan.scheduled.map((entry) => ({
      ...entry,
      interval: { startsAt: '2026-08-17T09:00:00Z', endsAt: '2026-08-17T10:00:00Z' },
    })),
  };

  assert.deepEqual(diffPlans(plan, restated).changes.map((change) => change.kind), ['unchanged']);
});
