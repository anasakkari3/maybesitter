/**
 * Habit occurrences → planning items (#520), at the adapter and at the solver.
 *
 * The sentence this file exists to keep true is the issue's: the scheduler is
 * never taught what a habit is. So the tests are written against what the
 * *planner* receives and does, not against the adapter's internals:
 *
 *  - the protected case is proved by running the real `schedulePlan` and
 *    watching a protected habit keep its window while an ordinary item is
 *    moved around it — which is the behaviour, rather than the shape that is
 *    supposed to cause it;
 *  - the flexible case is proved by asserting the `protection` key is *absent*,
 *    and then by running the carry-forward projection over it, because an
 *    inert `{ ownership: 'flexible' }` would satisfy every other assertion here
 *    and silently erase a user's dragged placement on the next regeneration;
 *  - the filters are proved one at a time against an otherwise schedulable
 *    occurrence, so "it produced nothing" cannot pass for the wrong reason.
 *
 * ── Every occurrence here comes from the real materializer ──────
 *
 * Since the two lanes of #520 met, this file hand-builds no occurrence. The
 * rows it plans are `materializeHabitOccurrences`'s own output over the domain
 * lane's own fixtures, so the ids, the ordinals and the dates are the ones
 * production would produce. That is deliberate: the previous version of this
 * file built occurrences from a transcribed contract, and a transcription is
 * exactly what stops agreeing the week after it is written.
 *
 * `tests/planning/protectedPlacement.test.ts` owns the protection mechanism
 * itself, and `tests/habits/habitMaterialization.test.ts` owns the cadence
 * arithmetic. Nothing is re-proved here except that this adapter reaches both.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildHabitPlanningRequest,
  habitProtection,
  materializePreferredWindow,
  preferredPlacementWindow,
  HABIT_PRIORITY,
} from '../../lib/services/habits/habitPlanningAdapter.ts';
import { materializeHabitOccurrences } from '../../lib/habits/materialize.ts';
import { habit as buildHabit, withStatus } from './habitSupport.ts';
import type {
  HabitDefinition,
  HabitOccurrence,
  HabitTimeWindow,
} from '../../src/contracts/v1/habitContracts.ts';
import { schedulePlan } from '../../lib/planning/scheduler/index.ts';
import {
  isProtected,
  projectBlockProtectionIntoPlanningConstraints,
  retainedStartMs,
} from '../../lib/planning/scheduler/protection.ts';
import type {
  PlanningConfig,
  PlanningConstraints,
  PlanningItem,
} from '../../src/contracts/v1/planningContracts.ts';
import type { ScheduleBlock } from '../../src/contracts/v1/scheduleBlockContracts.ts';

/** A Monday, and the only date the one-a-week fixture below asks for. */
const DATE = '2026-03-02';
const DAY_START = '2026-03-02T00:00:00.000Z';
const DAY_END = '2026-03-03T00:00:00.000Z';
const SCOPE = 'habitOwner';
const HABIT_ID = 'habit-1';
/** `materializeHabitOccurrences` mints this; it is not a string this file chose. */
const OCCURRENCE_ID = `${HABIT_ID}.${DATE}.0`;

const MORNING: HabitTimeWindow = { start: '07:00', end: '08:00' };
const EVENING: HabitTimeWindow = { start: '18:00', end: '20:00' };

/** Mondays only, 45 minutes, so one horizon day carries exactly one occurrence. */
function habit(overrides: Partial<Parameters<typeof buildHabit>[0]> = {}): HabitDefinition {
  return buildHabit({
    cadence: { kind: 'weekdays', weekdays: [1] },
    durationMinutes: 45,
    minimumOccurrences: 1,
    maximumOccurrences: 1,
    preferredWindows: [MORNING],
    title: 'Morning run',
    ...overrides,
  }, HABIT_ID);
}

/** The habit's real occurrences for the one day under test. */
function occurrencesOf(definition: HabitDefinition): readonly HabitOccurrence[] {
  return materializeHabitOccurrences(definition, { fromLocalDate: DATE, toLocalDate: DATE }).occurrences;
}

function request(
  definitions: readonly HabitDefinition[],
  occurrences: readonly HabitOccurrence[],
  retainedStarts?: ReadonlyMap<string, string>,
) {
  return buildHabitPlanningRequest({
    definitions,
    occurrences,
    localDate: DATE,
    timezone: 'UTC',
    earliestStartAt: null,
    retainedStarts,
  });
}

/** The ordinary case: one active habit, its own real occurrences. */
function planFor(definition: HabitDefinition, retainedStarts?: ReadonlyMap<string, string>) {
  return request([definition], occurrencesOf(definition), retainedStarts);
}

const CONFIG: PlanningConfig = { slotMinutes: 15, foldPolicy: 'earliest', resourceDependenciesOrder: false };

/** A whole working day, so nothing below fails for want of a window. */
function constraintsFor(items: readonly PlanningItem[]): PlanningConstraints {
  return {
    scopeId: SCOPE,
    timezone: 'UTC',
    horizon: { startsAt: DAY_START, endsAt: DAY_END },
    workingWindows: [{ windowId: 'w0', weekday: 1, startMinute: 6 * 60, endMinute: 22 * 60, timezone: 'UTC' }],
    fixedEvents: [],
    items,
  };
}

/* ── The fixture is the real thing ───────────────────────────────── */

test('the occurrences under test are the materializer\'s own, at its own ids', () => {
  const rows = occurrencesOf(habit());
  assert.equal(rows.length, 1, 'the one-a-week fixture is not what this file thinks it is');
  assert.equal(rows[0].occurrenceId, OCCURRENCE_ID);
  assert.equal(rows[0].ordinal, 0);
  assert.equal(rows[0].state, 'pending');
  assert.equal(rows[0].recoveredFromOccurrenceId, null);
});

/* ── The mapping ─────────────────────────────────────────────────── */

test('an open occurrence becomes one ordinary planning item', () => {
  const { items, sources } = planFor(habit());

  assert.equal(items.length, 1);
  const [item] = items;
  // The occurrence id is the item id: #521's rule, and what lets a plan edit
  // name an item and land on exactly one block.
  assert.equal(item.itemId, OCCURRENCE_ID);
  assert.equal(item.title, 'Morning run');
  assert.deepEqual(item.effort, { kind: 'known', minutes: 45 });
  assert.equal(item.deadlineAt, DAY_END);
  assert.equal(item.priority, HABIT_PRIORITY);
  assert.deepEqual(item.dependsOn, []);
  assert.equal(item.bufferBeforeMinutes, 0);
  assert.equal(item.bufferAfterMinutes, 0);
  assert.deepEqual(sources.get(OCCURRENCE_ID), { kind: 'habit_occurrence', id: OCCURRENCE_ID });
});

test("the occurrence's own duration is used, not the definition's current one", () => {
  // Materialize at 45, then shorten the rule. The stored occurrence keeps the
  // duration it was created with, and that is the one being scheduled — a
  // recovered or shortened occurrence is not re-measured from the rule.
  const original = habit({ durationMinutes: 45 });
  const rows = occurrencesOf(original);
  const shortened = habit({ durationMinutes: 20 });
  assert.deepEqual(request([shortened], rows).items[0].effort, { kind: 'known', minutes: 45 });
});

test('the caller-supplied floor is the only lower bound the adapter sets', () => {
  const definition = habit();
  const floored = buildHabitPlanningRequest({
    definitions: [definition],
    occurrences: occurrencesOf(definition),
    localDate: DATE,
    timezone: 'UTC',
    earliestStartAt: '2026-03-02T13:00:00.000Z',
  });
  assert.equal(floored.items[0].earliestStartAt, '2026-03-02T13:00:00.000Z');
  // And a preferred window never becomes one: it is a preference, and turning
  // it into a bound makes a habit unschedulable on a busy morning.
  assert.equal(planFor(definition).items[0].earliestStartAt, null);
});

/* ── Flexibility ─────────────────────────────────────────────────── */

test('a flexible habit produces an item with no protection key at all', () => {
  const { items } = planFor(habit({ flexibility: 'flexible' }));
  assert.equal(
    Object.hasOwn(items[0], 'protection'),
    false,
    'a flexible habit must not state a protection, inert or otherwise',
  );
  assert.equal(isProtected(items[0]), false);
});

test("a flexible habit still lets the user's own dragged protection carry forward", () => {
  // The defect this catches: an adapter that writes `{ ownership: 'flexible' }`
  // is inert at the solver and passes every other test here, but
  // `projectBlockProtectionIntoPlanningConstraints` leaves an item alone once
  // it states any protection — so the placement the *user* chose by dragging
  // this block would be silently dropped on the next regeneration, and every
  // one after.
  const { items } = planFor(habit({ flexibility: 'flexible' }));
  const dragged: ScheduleBlock = {
    blockId: 'blk_1',
    scopeId: SCOPE,
    source: { kind: 'habit_occurrence', id: OCCURRENCE_ID },
    mobility: 'flexible',
    durationMinutes: 45,
    placement: { earliestStartAt: null, latestEndAt: null, preferredWindows: [] },
    currentInterval: { startsAt: '2026-03-02T19:00:00.000Z', endsAt: '2026-03-02T19:45:00.000Z' },
    lastPlacedBy: 'user',
    lastPlanGeneration: 1,
    protection: {
      ownership: 'protected_flexible',
      origin: 'user',
      preferredInterval: { startsAt: '2026-03-02T19:00:00.000Z', endsAt: '2026-03-02T19:45:00.000Z' },
      maxShiftMinutes: 30,
    },
  };

  const projected = projectBlockProtectionIntoPlanningConstraints(constraintsFor(items), [dragged]);
  assert.equal(
    retainedStartMs(projected.items[0]),
    Date.parse('2026-03-02T19:00:00.000Z'),
    "the user's dragged placement must survive the adapter",
  );
});

test('a protected habit carries a habit_policy protection preferring its earliest window', () => {
  const { items } = planFor(habit({ flexibility: 'protected_flexible' }));
  assert.deepEqual(items[0].protection, {
    ownership: 'protected_flexible',
    origin: 'habit_policy',
    preferredInterval: { startsAt: '2026-03-02T07:00:00.000Z', endsAt: '2026-03-02T08:00:00.000Z' },
    // The definition states no bound, so neither does the adapter: inventing
    // one would refuse a busy day with `PROTECTED_SHIFT_EXCEEDED` over a limit
    // the user never set.
    maxShiftMinutes: null,
  });
});

test('a protected habit with no preferred window is protected with nothing yet to retain', () => {
  const { items } = planFor(habit({ flexibility: 'protected_flexible', preferredWindows: [] }));
  assert.equal(isProtected(items[0]), true);
  assert.equal(items[0].protection?.preferredInterval, null);
  assert.equal(retainedStartMs(items[0]), null);
});

test('where the user kept a protected habit beats the policy window', () => {
  // #522's rule: "a habit policy's protection that the user then dragged is
  // still the habit's protection, now preferring where the person put it".
  const { items } = planFor(
    habit({ flexibility: 'protected_flexible' }),
    new Map([[OCCURRENCE_ID, '2026-03-02T19:30:00.000Z']]),
  );
  assert.deepEqual(items[0].protection?.preferredInterval, {
    startsAt: '2026-03-02T19:30:00.000Z',
    // As long as the occurrence is, not as long as the window it replaced.
    endsAt: '2026-03-02T20:15:00.000Z',
  });
});

/* ── Preferred windows ───────────────────────────────────────────── */

test('preferred windows are materialized on the day beside the items, never on them', () => {
  const { items, preferredWindows } = planFor(
    habit({ flexibility: 'flexible', preferredWindows: [EVENING, MORNING] }),
  );
  assert.deepEqual(preferredWindows.get(OCCURRENCE_ID), [
    { startsAt: '2026-03-02T18:00:00.000Z', endsAt: '2026-03-02T20:00:00.000Z' },
    { startsAt: '2026-03-02T07:00:00.000Z', endsAt: '2026-03-02T08:00:00.000Z' },
  ]);
  // Nothing about a window reaches the solver's item: `PlanningItem` has no
  // preference field, and giving it one is the change this issue forbids.
  assert.equal('preferredWindows' in items[0], false);
});

test('the earliest window is the preferred placement, and a wrapping one states nothing', () => {
  assert.deepEqual(preferredPlacementWindow([EVENING, MORNING], DAY_START), {
    startsAt: '2026-03-02T07:00:00.000Z',
    endsAt: '2026-03-02T08:00:00.000Z',
  });
  // `RoutineTimeWindow` reads an end not after its start as wrapping midnight.
  // A wrapping window is not a position inside this day, so it states nothing
  // here rather than being silently clipped to the evening half.
  assert.equal(materializePreferredWindow({ start: '22:00', end: '06:00' }, DAY_START), null);
  assert.equal(materializePreferredWindow({ start: '10:00', end: '10:00' }, DAY_START), null);

  const wrapping = habit({
    flexibility: 'protected_flexible',
    preferredWindows: [{ start: '22:00', end: '06:00' }],
  });
  assert.equal(habitProtection(wrapping, occurrencesOf(wrapping)[0], DAY_START, undefined)?.preferredInterval, null);
});

test('a window is measured from the day the horizon actually starts on', () => {
  // Asia/Jerusalem is UTC+2 on this March date, so local 07:00 is 05:00Z. A
  // window resolved against a nominal UTC midnight would sit two hours out of
  // step with the plan it is a preference inside.
  const definition = habit({ flexibility: 'protected_flexible' });
  const { items } = buildHabitPlanningRequest({
    definitions: [definition],
    occurrences: occurrencesOf(definition),
    localDate: DATE,
    timezone: 'Asia/Jerusalem',
    earliestStartAt: null,
  });
  assert.equal(items[0].protection?.preferredInterval?.startsAt, '2026-03-02T05:00:00.000Z');
});

/* ── The three filters ───────────────────────────────────────────── */

test('an occurrence for another date is not placed in this day', () => {
  const definition = habit();
  // A real occurrence, from the week after the day under test.
  const nextWeek = materializeHabitOccurrences(definition, {
    fromLocalDate: '2026-03-09', toLocalDate: '2026-03-09',
  }).occurrences;
  assert.equal(nextWeek.length, 1);
  assert.deepEqual(request([definition], nextWeek).items, []);
});

for (const state of ['completed', 'skipped', 'recovered'] as const) {
  test(`a ${state} occurrence is not offered to the planner again`, () => {
    const definition = habit();
    const answered = occurrencesOf(definition).map((row) => ({ ...row, state }));
    assert.deepEqual(request([definition], answered).items, []);
  });
}

test('a scheduled occurrence is still work and is still offered', () => {
  const definition = habit();
  const placed = occurrencesOf(definition).map((row) => ({ ...row, state: 'scheduled' as const }));
  assert.equal(request([definition], placed).items.length, 1);
});

for (const status of ['paused', 'archived'] as const) {
  test(`a ${status} habit's occurrences are not scheduled`, () => {
    const active = habit();
    // Paused through the real patch path, and the rows it already produced.
    assert.deepEqual(request([withStatus(active, status)], occurrencesOf(active)).items, []);
  });
}

test('an occurrence whose habit is missing has nothing to be placed as', () => {
  assert.deepEqual(request([], occurrencesOf(habit())).items, []);
});

/* ── Determinism ─────────────────────────────────────────────────── */

test('the request is a function of its content, not of the row order', () => {
  // Three real habits, each with its own real Monday occurrence.
  const definitions = ['habit-a', 'habit-b', 'habit-c'].map((id) => buildHabit({
    cadence: { kind: 'weekdays', weekdays: [1] },
    durationMinutes: 45,
    minimumOccurrences: 1,
    maximumOccurrences: 1,
    title: id,
  }, id));
  const rows = definitions.flatMap((definition) => occurrencesOf(definition));
  assert.equal(rows.length, 3);

  const forward = request(definitions, rows);
  const reversed = request(definitions, [...rows].reverse());
  assert.deepEqual(forward.items, reversed.items);
  assert.deepEqual(
    forward.items.map((item) => item.itemId),
    [`habit-a.${DATE}.0`, `habit-b.${DATE}.0`, `habit-c.${DATE}.0`],
  );
});

/* ── At the solver ───────────────────────────────────────────────── */

test('the planner keeps a protected habit in its window and fills work in around it', () => {
  // The behaviour, not the shape that causes it. A `Must` task that has never
  // been placed is moved before the protected 07:00 habit is, which is
  // "protection is not priority" seen from the plan.
  const { items } = planFor(habit({ flexibility: 'protected_flexible' }));
  const rival: PlanningItem = {
    itemId: 'task-important',
    title: 'Important task',
    effort: { kind: 'known', minutes: 60 },
    earliestStartAt: null,
    deadlineAt: DAY_END,
    priority: 3,
    dependsOn: [],
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
  };

  const plan = schedulePlan(constraintsFor([rival, ...items]), CONFIG);
  const habitPlacement = plan.scheduled.find((entry) => entry.itemId === OCCURRENCE_ID);
  assert.ok(habitPlacement, `the habit was not scheduled: ${JSON.stringify(plan.unscheduled)}`);
  assert.equal(habitPlacement.interval.startsAt, '2026-03-02T07:00:00.000Z');
  const rivalPlacement = plan.scheduled.find((entry) => entry.itemId === 'task-important');
  assert.ok(rivalPlacement, 'the rival task was not scheduled');
  assert.notEqual(rivalPlacement.interval.startsAt, '2026-03-02T07:00:00.000Z');
});

test('a habit that cannot fit is reported, not slid into tomorrow', () => {
  // The deadline is the end of the day the occurrence is dated to. A habit
  // that did not fit today has to be reported as not having fitted today —
  // next Monday already has its own occurrence waiting.
  const { items } = planFor(habit());
  const full: PlanningConstraints = {
    ...constraintsFor(items),
    workingWindows: [{ windowId: 'w0', weekday: 1, startMinute: 9 * 60, endMinute: 9 * 60 + 30, timezone: 'UTC' }],
  };
  const plan = schedulePlan(full, CONFIG);
  assert.deepEqual(plan.scheduled, []);
  assert.equal(plan.unscheduled.length, 1);
  assert.equal(plan.unscheduled[0].itemId, OCCURRENCE_ID);
});
