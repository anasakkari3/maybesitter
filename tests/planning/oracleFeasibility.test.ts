/**
 * The feasibility oracle (Sprint 07, issue #31).
 *
 * These tests pin the *second* reading of static infeasibility. #29's validator
 * decides the same question from the same constraints and the merge-owned
 * cross-track test compares the two sets of codes. So nothing here may be
 * written by consulting #29: an assertion copied from the implementation it is
 * supposed to disagree with is not a check, and Sprint 02 already recorded what
 * that costs — "91 tests passed while they disagreed".
 *
 * Every expectation below is derived from the *contract's* prose for the code
 * in question, quoted in the test name where the derivation is not obvious.
 *
 * The DST instants are the ones `tests/planning/sharedTime.test.ts` reads off
 * the runtime's tzdata. They are asserted here as *minute counts*, not as
 * instants, because the thing a user loses to a spring-forward is an hour of
 * capacity, and a test that only compared instants would still pass if the
 * capacity arithmetic double-counted the transition.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_FIXED_EVENT_CONFLICT_REASONS,
  assessFeasibility,
  freeWorkingIntervals,
  workingIntervalsInHorizon,
} from '../../lib/planning/evaluation/oracle.ts';
import {
  STATIC_INFEASIBILITY_CODES,
  type FeasibilityVerdict,
  type FixedEvent,
  type PlanningConfig,
  type PlanningConstraints,
  type PlanningItem,
  type WorkingWindow,
} from '../../src/contracts/v1/planningContracts.ts';

/* ── Fixtures ────────────────────────────────────────────────────── */

/** Monday 2026-11-09 00:00Z through Monday 2026-11-16 00:00Z. */
const UTC_HORIZON = { startsAt: '2026-11-09T00:00:00.000Z', endsAt: '2026-11-16T00:00:00.000Z' };

/** One weekday occurrence inside the horizon: 480 minutes, no zone drama. */
const MONDAY_NINE_TO_FIVE_UTC: WorkingWindow = {
  windowId: 'w-mon',
  weekday: 1,
  startMinute: 9 * 60,
  endMinute: 17 * 60,
  timezone: 'UTC',
};

const CONFIG: PlanningConfig = Object.freeze({
  slotMinutes: 15,
  foldPolicy: 'earliest',
  resourceDependenciesOrder: false,
});

function item(overrides: Partial<PlanningItem> = {}): PlanningItem {
  return {
    itemId: 'i-1',
    title: 'draft the brief',
    effort: { kind: 'known', minutes: 60 },
    earliestStartAt: null,
    deadlineAt: null,
    priority: 50,
    dependsOn: [],
    bufferBeforeMinutes: 15,
    bufferAfterMinutes: 15,
    ...overrides,
  };
}

function constraints(overrides: Partial<PlanningConstraints> = {}): PlanningConstraints {
  return {
    scopeId: 'scope-oracle',
    timezone: 'UTC',
    horizon: UTC_HORIZON,
    workingWindows: [MONDAY_NINE_TO_FIVE_UTC],
    fixedEvents: [],
    items: [],
    ...overrides,
  };
}

function event(overrides: Partial<FixedEvent> = {}): FixedEvent {
  return {
    eventId: 'e-1',
    interval: { startsAt: '2026-11-09T12:00:00.000Z', endsAt: '2026-11-09T13:00:00.000Z' },
    sourceCommitmentId: null,
    blocking: true,
    ...overrides,
  };
}

function codesFor(verdict: FeasibilityVerdict, itemId: string | null): readonly string[] {
  return verdict.reasons.filter((reason) => reason.itemId === itemId).map((reason) => reason.code);
}

function allCodes(verdict: FeasibilityVerdict): readonly string[] {
  return verdict.reasons.map((reason) => reason.code);
}

/* ── The shape of a verdict ──────────────────────────────────────── */

test('a well-formed request is feasible, with capacity and demand both stated', () => {
  const verdict = assessFeasibility(constraints({ items: [item()] }), CONFIG);

  assert.equal(verdict.feasible, true);
  assert.deepEqual(verdict.reasons, []);
  assert.equal(verdict.availableMinutes, 480, 'one Monday 09:00-17:00 occurrence inside the horizon');
  assert.equal(verdict.demandMinutes, 90, '60 minutes of effort plus 15 + 15 of buffer');
});

test('the oracle emits static codes only, never an attempt code', () => {
  // A battery wide enough that a scheduler-shaped implementation would be
  // tempted into NO_FEASIBLE_SLOT: demand far exceeds capacity here.
  const verdict = assessFeasibility(
    constraints({
      workingWindows: [{ ...MONDAY_NINE_TO_FIVE_UTC, endMinute: 10 * 60 }],
      fixedEvents: [event(), event({ eventId: 'e-2' })],
      items: [
        item({ itemId: 'i-1', effort: { kind: 'unknown' } }),
        item({ itemId: 'i-2', effort: { kind: 'known', minutes: 0 } }),
        item({ itemId: 'i-3', dependsOn: [{ dependsOnItemId: 'i-3', kind: 'temporal' }] }),
        item({ itemId: 'i-4', dependsOn: [{ dependsOnItemId: 'i-missing', kind: 'temporal' }] }),
        item({ itemId: 'i-5', effort: { kind: 'known', minutes: 6000 } }),
      ],
    }),
    CONFIG,
  );

  assert.ok(verdict.reasons.length > 0, 'the battery must actually produce findings');
  for (const code of allCodes(verdict)) {
    assert.ok(
      (STATIC_INFEASIBILITY_CODES as readonly string[]).includes(code),
      `${code} is not a static code; only #30 may emit attempt codes`,
    );
  }
});

test('the verdict is a pure function of its inputs: two calls are deep-equal', () => {
  const input = constraints({
    items: [item({ itemId: 'i-b' }), item({ itemId: 'i-a', effort: { kind: 'unknown' } })],
    fixedEvents: [event({ eventId: 'e-z' }), event({ eventId: 'e-a' })],
  });

  assert.deepEqual(assessFeasibility(input, CONFIG), assessFeasibility(input, CONFIG));
});

/* ── INVALID_INTERVAL ────────────────────────────────────────────── */

test('INVALID_INTERVAL: a horizon that ends when it starts is a constraint-level finding', () => {
  const verdict = assessFeasibility(
    constraints({ horizon: { startsAt: UTC_HORIZON.startsAt, endsAt: UTC_HORIZON.startsAt } }),
    CONFIG,
  );

  assert.equal(verdict.feasible, false);
  assert.ok(codesFor(verdict, null).includes('INVALID_INTERVAL'));
  assert.equal(verdict.availableMinutes, 0, 'a zero-length horizon contains no working time');
});

test('INVALID_INTERVAL: a window whose end minute does not follow its start does not wrap', () => {
  const verdict = assessFeasibility(
    constraints({
      // 22:00 to 06:00 reads as overnight availability. The contract says it is
      // not: overnight is two windows, because a wrapping window makes "which
      // weekday is this" ambiguous exactly when a transition lands inside it.
      workingWindows: [{ ...MONDAY_NINE_TO_FIVE_UTC, startMinute: 22 * 60, endMinute: 6 * 60 }],
    }),
    CONFIG,
  );

  assert.deepEqual(
    codesFor(verdict, null),
    ['INVALID_INTERVAL', 'NO_WORKING_WINDOW'],
    'the malformed window was the only source of time, so both findings are true',
  );
  assert.equal(verdict.availableMinutes, 0, 'an ill-formed window contributes no capacity');
});

test('INVALID_INTERVAL: a window minute outside 0..1440 denotes no interval on any clock face', () => {
  const verdict = assessFeasibility(
    constraints({ workingWindows: [{ ...MONDAY_NINE_TO_FIVE_UTC, endMinute: 2000 }] }),
    CONFIG,
  );

  // The point of the code is capacity, not tidiness: counted naively this window
  // would contribute 1460 minutes of availability that no clock ever showed.
  assert.deepEqual(codesFor(verdict, null), ['INVALID_INTERVAL', 'NO_WORKING_WINDOW']);
  assert.equal(verdict.availableMinutes, 0);
});

test('INVALID_INTERVAL: a zero-length fixed event is reported rather than tolerated', () => {
  const degenerate = event({
    eventId: 'e-zero',
    interval: { startsAt: '2026-11-09T12:00:00.000Z', endsAt: '2026-11-09T12:00:00.000Z' },
  });
  const verdict = assessFeasibility(constraints({ fixedEvents: [degenerate] }), CONFIG);

  assert.ok(codesFor(verdict, null).includes('INVALID_INTERVAL'));
  // It blocks nothing, which is exactly why it has to be reported: no overlap
  // assertion anywhere could see it.
  assert.equal(verdict.availableMinutes, 480);
});

/* ── Effort ──────────────────────────────────────────────────────── */

test('EFFORT_UNKNOWN is reported against the item and never guessed into demand', () => {
  const verdict = assessFeasibility(
    constraints({ items: [item({ itemId: 'i-1', effort: { kind: 'unknown' } }), item({ itemId: 'i-2' })] }),
    CONFIG,
  );

  assert.deepEqual(codesFor(verdict, 'i-1'), ['EFFORT_UNKNOWN']);
  assert.deepEqual(codesFor(verdict, 'i-2'), []);
  assert.equal(verdict.demandMinutes, 90, 'only the known-effort item contributes');
});

test('EFFORT_NOT_POSITIVE covers zero, which arithmetic would otherwise accept', () => {
  const verdict = assessFeasibility(
    constraints({ items: [item({ itemId: 'i-zero', effort: { kind: 'known', minutes: 0 } })] }),
    CONFIG,
  );

  assert.deepEqual(codesFor(verdict, 'i-zero'), ['EFFORT_NOT_POSITIVE']);
});

test('a negative effort cannot reduce the demand of the items around it', () => {
  const verdict = assessFeasibility(
    constraints({
      items: [
        item({ itemId: 'i-ok' }),
        item({
          itemId: 'i-neg',
          effort: { kind: 'known', minutes: -600 },
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
        }),
      ],
    }),
    CONFIG,
  );

  assert.deepEqual(codesFor(verdict, 'i-neg'), ['EFFORT_NOT_POSITIVE']);
  assert.equal(verdict.demandMinutes, 90, 'a malformed row contributes zero, not a discount');
});

/* ── The item's own window ───────────────────────────────────────── */

test('DEADLINE_BEFORE_EARLIEST_START fires when the two coincide, because deadlines are exclusive', () => {
  const verdict = assessFeasibility(
    constraints({
      items: [
        item({
          itemId: 'i-empty',
          earliestStartAt: '2026-11-09T10:00:00.000Z',
          deadlineAt: '2026-11-09T10:00:00.000Z',
        }),
      ],
    }),
    CONFIG,
  );

  assert.deepEqual(
    codesFor(verdict, 'i-empty'),
    ['DEADLINE_BEFORE_EARLIEST_START'],
    'one defect earns one code: the empty window is not also reported as too small',
  );
});

test('DEADLINE_BEYOND_HORIZON is one-sided: at or before the horizon start, and nowhere else', () => {
  const before = assessFeasibility(
    constraints({ items: [item({ itemId: 'i-overdue', deadlineAt: '2026-11-08T00:00:00.000Z' })] }),
    CONFIG,
  );
  const exactlyAtStart = assessFeasibility(
    constraints({ items: [item({ itemId: 'i-at-start', deadlineAt: UTC_HORIZON.startsAt })] }),
    CONFIG,
  );
  const justAfterStart = assessFeasibility(
    constraints({ items: [item({ itemId: 'i-just-after', deadlineAt: '2026-11-09T12:00:00.000Z' })] }),
    CONFIG,
  );

  assert.deepEqual(codesFor(before, 'i-overdue'), ['DEADLINE_BEYOND_HORIZON']);
  // `<=`, not `<`. Deadlines are exclusive, so a deadline on the horizon's first
  // instant leaves no instant inside the plan that precedes it.
  assert.deepEqual(codesFor(exactlyAtStart, 'i-at-start'), ['DEADLINE_BEYOND_HORIZON']);
  assert.deepEqual(codesFor(justAfterStart, 'i-just-after'), []);
});

test('a deadline after the horizon ends is not a finding at all', () => {
  const wellBeyond = assessFeasibility(
    constraints({ items: [item({ itemId: 'i-long-dated', deadlineAt: '2027-06-01T00:00:00.000Z' })] }),
    CONFIG,
  );
  const oneMillisecondBeyond = assessFeasibility(
    constraints({ items: [item({ itemId: 'i-late', deadlineAt: '2026-11-16T00:00:01.000Z' })] }),
    CONFIG,
  );
  const onTheEdge = assessFeasibility(
    constraints({ items: [item({ itemId: 'i-edge', deadlineAt: UTC_HORIZON.endsAt })] }),
    CONFIG,
  );

  // An earlier draft read the code symmetrically and reported all three. That
  // turned every long-dated commitment into an infeasibility — most of the
  // forward-looking work a planner exists to place. The horizon binds first;
  // an item due next June, in a one-week plan, is the *least* constrained thing
  // in the request. The cross-track test caught it from both sides: #29 emitted
  // nothing here, and #30's scheduler placed the item this file called
  // unplaceable.
  assert.deepEqual(codesFor(wellBeyond, 'i-long-dated'), []);
  assert.deepEqual(codesFor(oneMillisecondBeyond, 'i-late'), []);
  assert.deepEqual(codesFor(onTheEdge, 'i-edge'), []);
});

test('a long-dated deadline does not silence the effort arithmetic either', () => {
  const verdict = assessFeasibility(
    constraints({
      items: [item({
        itemId: 'i-huge-long-dated',
        effort: { kind: 'known', minutes: 60 },
        earliestStartAt: '2026-11-09T09:00:00.000Z',
        deadlineAt: '2026-11-09T09:30:00.000Z',
      })],
    }),
    CONFIG,
  );

  // The item's own window is still its own window. Dropping the "after the end"
  // half of DEADLINE_BEYOND_HORIZON must not take EFFORT_EXCEEDS_ITEM_WINDOW
  // with it: 15 + 60 + 15 does not fit in 30 minutes whatever the horizon says.
  assert.deepEqual(codesFor(verdict, 'i-huge-long-dated'), ['EFFORT_EXCEEDS_ITEM_WINDOW']);
});

test('EFFORT_EXCEEDS_ITEM_WINDOW counts buffers, and is off by exactly one minute at the boundary', () => {
  const window = { earliestStartAt: '2026-11-09T09:00:00.000Z', deadlineAt: '2026-11-09T10:30:00.000Z' };
  const exactFit = assessFeasibility(
    constraints({ items: [item({ itemId: 'i-fits', ...window })] }),
    CONFIG,
  );
  const oneMinuteOver = assessFeasibility(
    constraints({
      items: [item({ itemId: 'i-over', ...window, effort: { kind: 'known', minutes: 61 } })],
    }),
    CONFIG,
  );

  assert.deepEqual(codesFor(exactFit, 'i-fits'), [], '15 + 60 + 15 is exactly 90 minutes');
  assert.deepEqual(codesFor(oneMinuteOver, 'i-over'), ['EFFORT_EXCEEDS_ITEM_WINDOW']);
});

test('EFFORT_EXCEEDS_ITEM_WINDOW falls back to the horizon when a bound is absent', () => {
  const verdict = assessFeasibility(
    constraints({
      horizon: { startsAt: '2026-11-09T00:00:00.000Z', endsAt: '2026-11-09T02:00:00.000Z' },
      items: [item({ itemId: 'i-huge', effort: { kind: 'known', minutes: 300 } })],
    }),
    CONFIG,
  );

  assert.ok(codesFor(verdict, 'i-huge').includes('EFFORT_EXCEEDS_ITEM_WINDOW'));
});

test('an unknown effort is not also reported as not fitting: there is no size to compare', () => {
  const verdict = assessFeasibility(
    constraints({
      items: [
        item({
          itemId: 'i-unknown',
          effort: { kind: 'unknown' },
          earliestStartAt: '2026-11-09T09:00:00.000Z',
          deadlineAt: '2026-11-09T09:05:00.000Z',
        }),
      ],
    }),
    CONFIG,
  );

  assert.deepEqual(codesFor(verdict, 'i-unknown'), ['EFFORT_UNKNOWN']);
});

/* ── NO_WORKING_WINDOW ───────────────────────────────────────────── */

test('NO_WORKING_WINDOW: no windows at all', () => {
  const verdict = assessFeasibility(constraints({ workingWindows: [] }), CONFIG);

  assert.ok(codesFor(verdict, null).includes('NO_WORKING_WINDOW'));
  assert.equal(verdict.availableMinutes, 0);
});

test('NO_WORKING_WINDOW: windows exist but none of their weekdays occurs in the horizon', () => {
  const verdict = assessFeasibility(
    constraints({
      // Tuesday only, over a horizon that covers Monday 2026-11-09 alone.
      horizon: { startsAt: '2026-11-09T00:00:00.000Z', endsAt: '2026-11-10T00:00:00.000Z' },
      workingWindows: [{ ...MONDAY_NINE_TO_FIVE_UTC, windowId: 'w-tue', weekday: 2 }],
    }),
    CONFIG,
  );

  assert.ok(codesFor(verdict, null).includes('NO_WORKING_WINDOW'));
});

test('a window fully covered by blocking events is still a working window', () => {
  const verdict = assessFeasibility(
    constraints({
      fixedEvents: [
        event({
          eventId: 'e-all-day',
          interval: { startsAt: '2026-11-09T09:00:00.000Z', endsAt: '2026-11-09T17:00:00.000Z' },
        }),
      ],
    }),
    CONFIG,
  );

  // NO_WORKING_WINDOW says there is nowhere *legal* to put anything. Having
  // nowhere *free* is contention, which is #30's NO_FEASIBLE_SLOT and not a
  // static contradiction at all.
  assert.deepEqual(codesFor(verdict, null), []);
  assert.equal(verdict.availableMinutes, 0);
});

/* ── Dependencies ────────────────────────────────────────────────── */

test('SELF_DEPENDENCY is reported once and suppresses CYCLIC_DEPENDENCY for that item', () => {
  const verdict = assessFeasibility(
    constraints({
      items: [
        item({
          itemId: 'i-self',
          dependsOn: [
            { dependsOnItemId: 'i-self', kind: 'temporal' },
            { dependsOnItemId: 'i-other', kind: 'temporal' },
          ],
        }),
        item({ itemId: 'i-other', dependsOn: [{ dependsOnItemId: 'i-self', kind: 'temporal' }] }),
      ],
    }),
    CONFIG,
  );

  assert.deepEqual(codesFor(verdict, 'i-self'), ['SELF_DEPENDENCY'], 'one defect earns one code');
  assert.deepEqual(codesFor(verdict, 'i-other'), ['CYCLIC_DEPENDENCY']);
});

test('CYCLIC_DEPENDENCY names every item on the cycle, not just the one the walk entered by', () => {
  const verdict = assessFeasibility(
    constraints({
      items: [
        item({ itemId: 'i-a', dependsOn: [{ dependsOnItemId: 'i-b', kind: 'temporal' }] }),
        item({ itemId: 'i-b', dependsOn: [{ dependsOnItemId: 'i-c', kind: 'temporal' }] }),
        item({ itemId: 'i-c', dependsOn: [{ dependsOnItemId: 'i-a', kind: 'temporal' }] }),
        item({ itemId: 'i-d', dependsOn: [{ dependsOnItemId: 'i-a', kind: 'temporal' }] }),
      ],
    }),
    CONFIG,
  );

  assert.deepEqual(codesFor(verdict, 'i-a'), ['CYCLIC_DEPENDENCY']);
  assert.deepEqual(codesFor(verdict, 'i-b'), ['CYCLIC_DEPENDENCY']);
  assert.deepEqual(codesFor(verdict, 'i-c'), ['CYCLIC_DEPENDENCY']);
  // Depending on a cycle is not being in one; i-d is blocked, which is #30's
  // BLOCKED_BY_DEPENDENCY and not a contradiction in the input.
  assert.deepEqual(codesFor(verdict, 'i-d'), []);
});

test('a cycle made of informational edges is not a cycle: those edges force no ordering', () => {
  const verdict = assessFeasibility(
    constraints({
      items: [
        item({ itemId: 'i-a', dependsOn: [{ dependsOnItemId: 'i-b', kind: 'informational' }] }),
        item({ itemId: 'i-b', dependsOn: [{ dependsOnItemId: 'i-a', kind: 'informational' }] }),
      ],
    }),
    CONFIG,
  );

  assert.deepEqual(verdict.reasons, []);
});

test('a resource cycle is a cycle only when the config says resource edges order', () => {
  const items = [
    item({ itemId: 'i-a', dependsOn: [{ dependsOnItemId: 'i-b', kind: 'resource' }] }),
    item({ itemId: 'i-b', dependsOn: [{ dependsOnItemId: 'i-a', kind: 'resource' }] }),
  ];

  const v1 = assessFeasibility(constraints({ items }), CONFIG);
  const v1Ordering = assessFeasibility(constraints({ items }), { ...CONFIG, resourceDependenciesOrder: true });

  assert.deepEqual(v1.reasons, [], 'resourceDependenciesOrder is false in v1');
  assert.deepEqual(codesFor(v1Ordering, 'i-a'), ['CYCLIC_DEPENDENCY']);
  assert.deepEqual(codesFor(v1Ordering, 'i-b'), ['CYCLIC_DEPENDENCY']);
});

test('UNKNOWN_DEPENDENCY is charged to the item holding the dangling edge', () => {
  const verdict = assessFeasibility(
    constraints({
      items: [item({ itemId: 'i-a', dependsOn: [{ dependsOnItemId: 'i-ghost', kind: 'informational' }] })],
    }),
    CONFIG,
  );

  // Informational edges force no ordering, but an edge pointing at nothing is a
  // broken reference whichever kind it carries.
  assert.deepEqual(codesFor(verdict, 'i-a'), ['UNKNOWN_DEPENDENCY']);
});

/* ── FIXED_EVENT_CONFLICT ────────────────────────────────────────── */

test('FIXED_EVENT_CONFLICT: two blocking events that overlap are a contradiction in the input', () => {
  const verdict = assessFeasibility(
    constraints({
      fixedEvents: [
        event({ eventId: 'e-a', interval: { startsAt: '2026-11-09T12:00:00.000Z', endsAt: '2026-11-09T13:00:00.000Z' } }),
        event({ eventId: 'e-b', interval: { startsAt: '2026-11-09T12:30:00.000Z', endsAt: '2026-11-09T13:30:00.000Z' } }),
      ],
    }),
    CONFIG,
  );

  assert.deepEqual(codesFor(verdict, null), ['FIXED_EVENT_CONFLICT']);
  assert.equal(verdict.availableMinutes, 390, 'the union of the two events is 90 minutes, not 120');
});

test('back-to-back blocking events do not conflict: end instants are excluded', () => {
  const verdict = assessFeasibility(
    constraints({
      fixedEvents: [
        event({ eventId: 'e-a', interval: { startsAt: '2026-11-09T12:00:00.000Z', endsAt: '2026-11-09T13:00:00.000Z' } }),
        event({ eventId: 'e-b', interval: { startsAt: '2026-11-09T13:00:00.000Z', endsAt: '2026-11-09T14:00:00.000Z' } }),
      ],
    }),
    CONFIG,
  );

  assert.deepEqual(verdict.reasons, []);
  assert.equal(verdict.availableMinutes, 360);
});

test('a non-blocking event neither conflicts nor consumes capacity', () => {
  const verdict = assessFeasibility(
    constraints({
      fixedEvents: [
        // Deliberately at *different* hours. An earlier version of this test gave
        // both events the same interval, so their union was 60 minutes whether or
        // not the `blocking` flag was read at all — the assertion held with the
        // filter deleted, which is the definition of a test that is not testing.
        event({ eventId: 'e-a', interval: { startsAt: '2026-11-09T12:00:00.000Z', endsAt: '2026-11-09T13:00:00.000Z' } }),
        event({ eventId: 'e-b', blocking: false, interval: { startsAt: '2026-11-09T14:00:00.000Z', endsAt: '2026-11-09T15:00:00.000Z' } }),
      ],
    }),
    CONFIG,
  );

  assert.deepEqual(verdict.reasons, [], 'a non-blocking event is not being in two places');
  assert.equal(verdict.availableMinutes, 420, 'only the blocking hour is spent; 360 would mean the flag was ignored');
});

test('a blocking event outside every working window costs no capacity', () => {
  const verdict = assessFeasibility(
    constraints({
      fixedEvents: [
        event({
          eventId: 'e-night',
          interval: { startsAt: '2026-11-09T20:00:00.000Z', endsAt: '2026-11-09T21:00:00.000Z' },
        }),
      ],
    }),
    CONFIG,
  );

  assert.equal(verdict.availableMinutes, 480);
});

/* ── Capacity arithmetic ─────────────────────────────────────────── */

test('overlapping working windows are unioned, never summed', () => {
  const verdict = assessFeasibility(
    constraints({
      workingWindows: [
        MONDAY_NINE_TO_FIVE_UTC,
        { ...MONDAY_NINE_TO_FIVE_UTC, windowId: 'w-mon-late', startMinute: 12 * 60, endMinute: 20 * 60 },
      ],
    }),
    CONFIG,
  );

  // 09:00-20:00 is 660 minutes. Summing the two windows gives 960, and the
  // overload judgement built on top would then read as capacity that is not
  // there.
  assert.equal(verdict.availableMinutes, 660);
  assert.equal(workingIntervalsInHorizon(constraints({
    workingWindows: [
      MONDAY_NINE_TO_FIVE_UTC,
      { ...MONDAY_NINE_TO_FIVE_UTC, windowId: 'w-mon-late', startMinute: 12 * 60, endMinute: 20 * 60 },
    ],
  }), CONFIG).length, 1, 'the union is one contiguous run');
});

test('a window is clipped to the horizon rather than counted whole', () => {
  const verdict = assessFeasibility(
    constraints({ horizon: { startsAt: '2026-11-09T12:00:00.000Z', endsAt: '2026-11-09T15:00:00.000Z' } }),
    CONFIG,
  );

  assert.equal(verdict.availableMinutes, 180);
});

test('a window ending at minute 1440 ends at midnight of its own day', () => {
  const verdict = assessFeasibility(
    constraints({
      horizon: { startsAt: '2026-11-09T00:00:00.000Z', endsAt: '2026-11-11T00:00:00.000Z' },
      workingWindows: [{ ...MONDAY_NINE_TO_FIVE_UTC, startMinute: 22 * 60, endMinute: 1440 }],
    }),
    CONFIG,
  );

  assert.deepEqual(verdict.reasons, [], 'minute 1440 is the domain the contract states, not an overflow');
  assert.equal(verdict.availableMinutes, 120);
});

test('free intervals are what remains after blocking events, in order', () => {
  const free = freeWorkingIntervals(
    constraints({
      fixedEvents: [
        event({ eventId: 'e-a', interval: { startsAt: '2026-11-09T12:00:00.000Z', endsAt: '2026-11-09T13:00:00.000Z' } }),
      ],
    }),
    CONFIG,
  );

  assert.deepEqual(free, [
    { startsAt: '2026-11-09T09:00:00.000Z', endsAt: '2026-11-09T12:00:00.000Z' },
    { startsAt: '2026-11-09T13:00:00.000Z', endsAt: '2026-11-09T17:00:00.000Z' },
  ]);
});

/* ── DST ─────────────────────────────────────────────────────────── */

const SPRING_FORWARD_HORIZON = {
  startsAt: '2026-03-08T00:00:00.000Z',
  endsAt: '2026-03-09T00:00:00.000Z',
};
const FALL_BACK_HORIZON = {
  startsAt: '2026-11-01T00:00:00.000Z',
  endsAt: '2026-11-02T00:00:00.000Z',
};

test('spring forward: a four-hour clock face yields three real hours', () => {
  const verdict = assessFeasibility(
    constraints({
      timezone: 'America/New_York',
      horizon: SPRING_FORWARD_HORIZON,
      workingWindows: [
        { windowId: 'w-sun', weekday: 0, startMinute: 60, endMinute: 5 * 60, timezone: 'America/New_York' },
      ],
    }),
    CONFIG,
  );

  assert.deepEqual(verdict.reasons, [], '01:00 and 05:00 both exist on 2026-03-08');
  assert.equal(verdict.availableMinutes, 180, 'the transition at 07:00Z removes an hour of capacity');
  assert.deepEqual(freeWorkingIntervals(
    constraints({
      timezone: 'America/New_York',
      horizon: SPRING_FORWARD_HORIZON,
      workingWindows: [
        { windowId: 'w-sun', weekday: 0, startMinute: 60, endMinute: 5 * 60, timezone: 'America/New_York' },
      ],
    }),
    CONFIG,
  ), [{ startsAt: '2026-03-08T06:00:00.000Z', endsAt: '2026-03-08T09:00:00.000Z' }]);
});

test('NONEXISTENT_LOCAL_TIME: a window starting at 02:00 on the spring-forward date', () => {
  const input = constraints({
    timezone: 'America/New_York',
    horizon: SPRING_FORWARD_HORIZON,
    workingWindows: [
      { windowId: 'w-gap', weekday: 0, startMinute: 2 * 60, endMinute: 6 * 60, timezone: 'America/New_York' },
    ],
  });
  const verdict = assessFeasibility(input, CONFIG);

  assert.ok(codesFor(verdict, null).includes('NONEXISTENT_LOCAL_TIME'));
  // The window is not discarded: it resumes at the instant the clock jumps to,
  // which is 03:00 EDT = 07:00Z, and runs to 06:00 EDT = 10:00Z.
  assert.equal(verdict.availableMinutes, 180);
  assert.deepEqual(freeWorkingIntervals(input, CONFIG), [
    { startsAt: '2026-03-08T07:00:00.000Z', endsAt: '2026-03-08T10:00:00.000Z' },
  ]);
});

test('fall back: the fold policy decides an hour of capacity, and both answers are reachable', () => {
  const input = constraints({
    timezone: 'America/New_York',
    horizon: FALL_BACK_HORIZON,
    workingWindows: [
      { windowId: 'w-fold', weekday: 0, startMinute: 60, endMinute: 4 * 60, timezone: 'America/New_York' },
    ],
  });

  const earliest = assessFeasibility(input, { ...CONFIG, foldPolicy: 'earliest' });
  const latest = assessFeasibility(input, { ...CONFIG, foldPolicy: 'latest' });

  assert.deepEqual(earliest.reasons, [], 'a stated fold policy resolves the ambiguity rather than reporting it');
  assert.equal(earliest.availableMinutes, 240, '01:00 EDT = 05:00Z through 04:00 EST = 09:00Z');
  assert.equal(latest.availableMinutes, 180, '01:00 EST = 06:00Z through 04:00 EST = 09:00Z');
});

test('AMBIGUOUS_LOCAL_TIME: a fold the config declines to resolve costs the whole occurrence', () => {
  const input = constraints({
    timezone: 'America/New_York',
    horizon: FALL_BACK_HORIZON,
    workingWindows: [
      { windowId: 'w-fold', weekday: 0, startMinute: 60, endMinute: 4 * 60, timezone: 'America/New_York' },
    ],
  });
  // The contract keeps this code for callers that choose to surface ambiguity
  // instead of resolving it. `FoldPolicy` makes that unreachable through the
  // type, so the only way in is a config that carries something else — which is
  // exactly what an untyped caller at a trust boundary supplies.
  const undecided = { ...CONFIG, foldPolicy: 'ask-the-user' } as unknown as PlanningConfig;
  const verdict = assessFeasibility(input, undecided);

  assert.deepEqual(codesFor(verdict, null), ['NO_WORKING_WINDOW', 'AMBIGUOUS_LOCAL_TIME']);
  assert.equal(
    verdict.availableMinutes,
    0,
    'picking either candidate would silently choose a side the config declined to choose',
  );
});

test('Jerusalem spring forward is a gap on a Friday, not on a Sunday', () => {
  const verdict = assessFeasibility(
    constraints({
      timezone: 'Asia/Jerusalem',
      horizon: { startsAt: '2026-03-26T22:00:00.000Z', endsAt: '2026-03-27T12:00:00.000Z' },
      workingWindows: [
        { windowId: 'w-fri', weekday: 5, startMinute: 2 * 60, endMinute: 6 * 60, timezone: 'Asia/Jerusalem' },
      ],
    }),
    CONFIG,
  );

  assert.ok(codesFor(verdict, null).includes('NONEXISTENT_LOCAL_TIME'));
  // Resumes at 03:00 IDT = 00:00Z, runs to 06:00 IDT = 03:00Z.
  assert.equal(verdict.availableMinutes, 180);
});

test('Asia/Kolkata has no transition and a half-hour offset, which the arithmetic must survive', () => {
  const verdict = assessFeasibility(
    constraints({
      timezone: 'Asia/Kolkata',
      workingWindows: [{ ...MONDAY_NINE_TO_FIVE_UTC, windowId: 'w-ist', timezone: 'Asia/Kolkata' }],
    }),
    CONFIG,
  );

  assert.deepEqual(verdict.reasons, []);
  assert.equal(verdict.availableMinutes, 480);
  assert.deepEqual(freeWorkingIntervals(
    constraints({
      timezone: 'Asia/Kolkata',
      workingWindows: [{ ...MONDAY_NINE_TO_FIVE_UTC, windowId: 'w-ist', timezone: 'Asia/Kolkata' }],
    }),
    CONFIG,
  ), [{ startsAt: '2026-11-09T03:30:00.000Z', endsAt: '2026-11-09T11:30:00.000Z' }]);
});

/* ── Ordering ────────────────────────────────────────────────────── */

test('reasons come back in a stated order regardless of input order', () => {
  const forwards = assessFeasibility(
    constraints({
      items: [
        item({ itemId: 'i-a', effort: { kind: 'unknown' } }),
        item({ itemId: 'i-b', effort: { kind: 'known', minutes: 0 } }),
      ],
      workingWindows: [],
    }),
    CONFIG,
  );
  const backwards = assessFeasibility(
    constraints({
      items: [
        item({ itemId: 'i-b', effort: { kind: 'known', minutes: 0 } }),
        item({ itemId: 'i-a', effort: { kind: 'unknown' } }),
      ],
      workingWindows: [],
    }),
    CONFIG,
  );

  assert.deepEqual(forwards.reasons, backwards.reasons);
  assert.deepEqual(
    forwards.reasons.map((reason) => [reason.itemId, reason.code]),
    [
      [null, 'NO_WORKING_WINDOW'],
      ['i-a', 'EFFORT_UNKNOWN'],
      ['i-b', 'EFFORT_NOT_POSITIVE'],
    ],
    'constraint-level findings first, then by item id: input order must not leak',
  );
});

test('a reason detail carries ids and numbers, never an item title', () => {
  const verdict = assessFeasibility(
    constraints({
      items: [item({ itemId: 'i-1', title: 'أدفع 9000 شيكل لعيادة الدكتور سمير', effort: { kind: 'unknown' } })],
    }),
    CONFIG,
  );

  for (const reason of verdict.reasons) {
    assert.ok(
      !reason.detail.includes('9000') && !reason.detail.includes('عيادة'),
      `detail leaked user text: ${reason.detail}`,
    );
  }
});

/* ── Regressions from independent review ─────────────────────────── */

test('an unknown time zone is a finding, not a RangeError from three frames down', () => {
  const input = constraints({
    workingWindows: [{ ...MONDAY_NINE_TO_FIVE_UTC, timezone: 'Mars/Phobos' }],
  });

  // `Intl.DateTimeFormat` throws on an unknown zone. Left unchecked, that throw
  // escaped `assessFeasibility` — and took `scenarioCorpusIssues` with it, the
  // one function whose whole job is to *return* a list of problems.
  assert.doesNotThrow(() => assessFeasibility(input, CONFIG));
  assert.deepEqual(codesFor(assessFeasibility(input, CONFIG), null), ['INVALID_INTERVAL', 'NO_WORKING_WINDOW']);
});

test('a weekday outside 0..6 is reported, not silently never scheduled', () => {
  for (const weekday of [7, -1, 1.5]) {
    const verdict = assessFeasibility(
      constraints({ workingWindows: [{ ...MONDAY_NINE_TO_FIVE_UTC, weekday: weekday as 0 }] }),
      CONFIG,
    );

    // The same argument as the minute domain: a window claiming day 7 denotes no
    // day the calendar has, so its availability disappeared instead of being
    // reported as the defect it is.
    assert.deepEqual(
      codesFor(verdict, null),
      ['INVALID_INTERVAL', 'NO_WORKING_WINDOW'],
      `weekday ${weekday} must be reported`,
    );
  }
});

test('a window lying entirely inside a spring-forward gap still reports NONEXISTENT_LOCAL_TIME', () => {
  // 02:00-02:30 on 2026-03-08 in New York: both ends are skipped, so both
  // resolve to the instant the clock jumps to and the occurrence is empty. An
  // emptiness-guarding overlap test then reported the window as irrelevant, and
  // the DST code went silent on the sharpest DST input there is.
  const input = constraints({
    timezone: 'America/New_York',
    horizon: SPRING_FORWARD_HORIZON,
    workingWindows: [
      { windowId: 'w-inside-gap', weekday: 0, startMinute: 2 * 60, endMinute: 2 * 60 + 30, timezone: 'America/New_York' },
    ],
  });
  const verdict = assessFeasibility(input, CONFIG);

  assert.deepEqual(codesFor(verdict, null), ['NO_WORKING_WINDOW', 'NONEXISTENT_LOCAL_TIME']);
  assert.equal(verdict.availableMinutes, 0, 'the whole window fell into the hour that did not happen');
});

test('a transition anomaly outside the horizon is not this plan is problem', () => {
  // Sunday 2026-03-08 carries the gap and is walked, because day iteration
  // reaches a day either side of the horizon for zones east and west of UTC.
  // The horizon starts on the Monday, so the anomaly is not a finding about it.
  const verdict = assessFeasibility(
    constraints({
      timezone: 'America/New_York',
      horizon: { startsAt: '2026-03-09T00:00:00.000Z', endsAt: '2026-03-10T00:00:00.000Z' },
      workingWindows: [
        { windowId: 'w-sun-gap', weekday: 0, startMinute: 2 * 60, endMinute: 6 * 60, timezone: 'America/New_York' },
      ],
    }),
    CONFIG,
  );

  assert.deepEqual(codesFor(verdict, null), ['NO_WORKING_WINDOW']);
});

test('an inverted horizon does not manufacture a finding against every item', () => {
  const verdict = assessFeasibility(
    constraints({
      horizon: { startsAt: '2026-11-16T00:00:00.000Z', endsAt: '2026-11-09T00:00:00.000Z' },
      items: [item({ itemId: 'i-1' }), item({ itemId: 'i-2' }), item({ itemId: 'i-3' })],
    }),
    CONFIG,
  );

  // The horizon is the broken thing and is reported once. Measuring each item's
  // effort against a negative window charged all three of them for it.
  assert.deepEqual(codesFor(verdict, null), ['INVALID_INTERVAL']);
  for (const itemId of ['i-1', 'i-2', 'i-3']) {
    assert.deepEqual(codesFor(verdict, itemId), [], `${itemId} has no defect of its own`);
  }
});

test('a defect that supplies no bound does not silence the effort-window arithmetic', () => {
  const tightWindow = {
    earliestStartAt: '2026-11-09T09:00:00.000Z',
    deadlineAt: '2026-11-09T10:00:00.000Z',
  };
  const dangling = assessFeasibility(
    constraints({
      items: [item({
        itemId: 'i-x',
        ...tightWindow,
        dependsOn: [{ dependsOnItemId: 'i-ghost', kind: 'temporal' }],
      })],
    }),
    CONFIG,
  );
  const selfEdge = assessFeasibility(
    constraints({
      items: [item({ itemId: 'i-y', ...tightWindow, dependsOn: [{ dependsOnItemId: 'i-y', kind: 'temporal' }] })],
    }),
    CONFIG,
  );

  // Two independent defects: 90 minutes of effort plus buffers in a 60-minute
  // window, and a dependency edge naming nothing. The dependency graph supplies
  // neither bound of that arithmetic, so suppressing the second reported one
  // code where the constraints hold two.
  assert.deepEqual(codesFor(dangling, 'i-x'), ['EFFORT_EXCEEDS_ITEM_WINDOW', 'UNKNOWN_DEPENDENCY']);
  assert.deepEqual(codesFor(selfEdge, 'i-y'), ['EFFORT_EXCEEDS_ITEM_WINDOW', 'SELF_DEPENDENCY']);
});

test('NO_WORKING_WINDOW and a malformed window are independent findings', () => {
  const onlyWindowIsBad = assessFeasibility(
    constraints({ workingWindows: [{ ...MONDAY_NINE_TO_FIVE_UTC, endMinute: 0 }] }),
    CONFIG,
  );
  const oneBadAmongGood = assessFeasibility(
    constraints({
      workingWindows: [
        MONDAY_NINE_TO_FIVE_UTC,
        { ...MONDAY_NINE_TO_FIVE_UTC, windowId: 'w-bad', endMinute: 0 },
      ],
    }),
    CONFIG,
  );

  // This pair is why the two codes are not folded into one. They co-occur only
  // when the malformed window was the only source of time; with a good window
  // beside it, one fires and the other does not.
  assert.deepEqual(codesFor(onlyWindowIsBad, null), ['INVALID_INTERVAL', 'NO_WORKING_WINDOW']);
  assert.deepEqual(codesFor(oneBadAmongGood, null), ['INVALID_INTERVAL']);
  assert.equal(oneBadAmongGood.availableMinutes, 480);
});

test('overlapping blocking events are reported by a bounded sweep, not by every pair', () => {
  const duplicatedFeed = Array.from({ length: 200 }, (_, index) => event({
    eventId: `e-${index}`,
    interval: { startsAt: '2026-11-09T12:00:00.000Z', endsAt: '2026-11-09T13:00:00.000Z' },
  }));
  const verdict = assessFeasibility(constraints({ fixedEvents: duplicatedFeed }), CONFIG);
  const detailBytes = verdict.reasons.reduce((total, reason) => total + reason.detail.length, 0);

  // A duplicated calendar feed is an ordinary shape, and pairwise enumeration
  // made it 19,900 reasons and 874 KB of `detail` — which then travels with the
  // plan into audit records. #29 was bounded for exactly this after a Sprint 06
  // draft produced 1.12 MB.
  assert.ok(verdict.reasons.length <= 40, `expected a bounded list, got ${verdict.reasons.length}`);
  assert.ok(detailBytes < 8_000, `expected bounded detail, got ${detailBytes} bytes`);
  assert.ok(allCodes(verdict).includes('FIXED_EVENT_CONFLICT'), 'the code must still be emitted whenever it is true');
  assert.ok(
    verdict.reasons.some((reason) => /further overlapping/.test(reason.detail)),
    'the remainder is reported as a count rather than dropped in silence',
  );
});

test('the sweep still finds a conflict between events that are far apart in the list', () => {
  const spread = [
    event({ eventId: 'e-a', interval: { startsAt: '2026-11-09T09:00:00.000Z', endsAt: '2026-11-09T16:00:00.000Z' } }),
    event({ eventId: 'e-b', interval: { startsAt: '2026-11-09T10:00:00.000Z', endsAt: '2026-11-09T10:30:00.000Z' } }),
    event({ eventId: 'e-c', interval: { startsAt: '2026-11-09T11:00:00.000Z', endsAt: '2026-11-09T11:30:00.000Z' } }),
  ];

  // Sorting by start is what makes the sweep complete: the long event stays open
  // across both short ones, so neither is missed.
  assert.equal(
    codesFor(assessFeasibility(constraints({ fixedEvents: spread }), CONFIG), null)
      .filter((code) => code === 'FIXED_EVENT_CONFLICT').length,
    2,
  );
});

test('no caller-supplied string of any kind reaches a reason detail', () => {
  const sensitive = [
    'call-dr.cohen-about-the-biopsy',
    'anasakkari04-gmail.com',
    'tell-my-manager-i-am-quitting',
    'scope-i-owe-ahmed-40000',
  ];
  const verdict = assessFeasibility(
    {
      scopeId: sensitive[3],
      timezone: 'UTC',
      horizon: UTC_HORIZON,
      workingWindows: [{ ...MONDAY_NINE_TO_FIVE_UTC, windowId: sensitive[0], endMinute: 0 }],
      fixedEvents: [event({
        eventId: sensitive[1],
        interval: { startsAt: '2026-11-09T12:00:00.000Z', endsAt: '2026-11-09T12:00:00.000Z' },
      })],
      items: [item({ itemId: sensitive[2], title: 'أدفع 9000 شيكل لعيادة الدكتور سمير', effort: { kind: 'unknown' } })],
    },
    CONFIG,
  );

  // Every one of these passes a "looks like an identifier" filter, which is why
  // there is no such filter here any more: a caller chooses ids as freely as
  // titles, and `detail` is the field most likely to reach a log.
  assert.ok(verdict.reasons.length >= 3, 'the battery must actually produce findings to inspect');
  for (const reason of verdict.reasons) {
    for (const secret of sensitive) {
      assert.ok(!reason.detail.includes(secret), `detail leaked ${secret}: ${reason.detail}`);
    }
  }
  // The item is still locatable — through the typed field that exists for it.
  assert.ok(verdict.reasons.some((reason) => reason.itemId === sensitive[2]));
});

test('a reason detail does not encode the position of an item in the input array', () => {
  const forwards = assessFeasibility(
    constraints({ items: [item({ itemId: 'i-a', effort: { kind: 'unknown' } }), item({ itemId: 'i-b' })] }),
    CONFIG,
  );
  const backwards = assessFeasibility(
    constraints({ items: [item({ itemId: 'i-b' }), item({ itemId: 'i-a', effort: { kind: 'unknown' } })] }),
    CONFIG,
  );

  // Position was the obvious substitute for a leaked id, and it is wrong for
  // items: a position is a fact about the input array, so two requests that
  // differ only in ordering would serialise to different bytes for one finding.
  // Windows and events use it because they have no id field to fall back on.
  assert.deepEqual(forwards.reasons, backwards.reasons);
});

/* ── Regressions from the sprint-level fuzzer ────────────────────── */

test('a malformed buffer is reported, never floored into a feasible verdict', () => {
  const cases: readonly [string, Partial<PlanningItem>][] = [
    ['a negative buffer before', { bufferBeforeMinutes: -5 }],
    ['a negative buffer after', { bufferAfterMinutes: -5 }],
    ['a NaN buffer', { bufferBeforeMinutes: Number.NaN }],
    ['an infinite buffer', { bufferAfterMinutes: Number.POSITIVE_INFINITY }],
  ];

  for (const [label, overrides] of cases) {
    const verdict = assessFeasibility(
      constraints({ items: [item({ itemId: 'i-bad-buffer', bufferBeforeMinutes: 0, bufferAfterMinutes: 0, ...overrides })] }),
      CONFIG,
    );

    // `Math.max(0, buffer)` looked like defensive arithmetic and was a silent
    // repair in the one direction that must never be silent: a contradiction
    // became a *feasible* verdict. Three readings of this input gave three
    // answers — #29 reported the code, this file reported nothing, #30 placed
    // the item — which broke the only assertion spanning all three, that a
    // static contradiction both readers agree on is never scheduled.
    assert.equal(verdict.feasible, false, label);
    assert.deepEqual(codesFor(verdict, 'i-bad-buffer'), ['EFFORT_NOT_POSITIVE'], label);
    // Not floored into the aggregate either: a duration that is not a duration
    // has no demand to state.
    assert.equal(verdict.demandMinutes, 0, label);
  }
});

test('a zero buffer stays legitimate: no recovery time is an ordinary item', () => {
  const verdict = assessFeasibility(
    constraints({ items: [item({ itemId: 'i-tight', bufferBeforeMinutes: 0, bufferAfterMinutes: 0 })] }),
    CONFIG,
  );

  assert.equal(verdict.feasible, true);
  assert.equal(verdict.demandMinutes, 60);
});

test('a malformed buffer does not discount the demand of the items around it', () => {
  const verdict = assessFeasibility(
    constraints({
      items: [
        item({ itemId: 'i-ok', bufferBeforeMinutes: 0, bufferAfterMinutes: 0 }),
        item({ itemId: 'i-bad', bufferBeforeMinutes: -600, bufferAfterMinutes: 0 }),
      ],
    }),
    CONFIG,
  );

  // Summing the raw value would have made a 60-minute week read as -540.
  assert.equal(verdict.demandMinutes, 60);
  assert.deepEqual(codesFor(verdict, 'i-ok'), []);
  assert.deepEqual(codesFor(verdict, 'i-bad'), ['EFFORT_NOT_POSITIVE']);
});

test('a malformed buffer silences the effort-window arithmetic that would use it', () => {
  const verdict = assessFeasibility(
    constraints({
      items: [item({
        itemId: 'i-both',
        bufferBeforeMinutes: -5,
        bufferAfterMinutes: 0,
        earliestStartAt: '2026-11-09T09:00:00.000Z',
        deadlineAt: '2026-11-09T09:30:00.000Z',
      })],
    }),
    CONFIG,
  );

  // The required-minutes sum borrows the buffer, and the buffer has just been
  // reported as not a duration. An earlier draft floored it here but guarded it
  // with `Number.isFinite` in the demand sum, so an infinite buffer produced
  // EFFORT_EXCEEDS_ITEM_WINDOW in one place and nothing in the other.
  assert.deepEqual(codesFor(verdict, 'i-both'), ['EFFORT_NOT_POSITIVE']);
});

test('assessFeasibility materialises the working windows exactly once', () => {
  let reads = 0;
  const probe = {
    scopeId: 'scope-materialisation',
    timezone: 'America/New_York',
    horizon: { startsAt: '2026-11-09T00:00:00.000Z', endsAt: '2026-12-07T00:00:00.000Z' },
    fixedEvents: [],
    items: [],
  };
  const windows = [1, 2, 3].map((weekday) => ({
    windowId: `w-${weekday}`,
    weekday: weekday as 1,
    startMinute: 9 * 60,
    endMinute: 17 * 60,
    timezone: 'America/New_York',
  }));
  Object.defineProperty(probe, 'workingWindows', {
    get() { reads += 1; return windows; },
    enumerable: true,
  });

  assessFeasibility(probe as unknown as PlanningConstraints, CONFIG);

  // Two reads: the well-formedness loop, and the single materialisation. It was
  // four — anomalies, the working union, and the free-time subtraction walking
  // it all over again — which is a constant factor of three on the hottest path
  // in the package, run once per scenario by the corpus gate.
  //
  // Counted rather than timed, so the guard is deterministic. Anyone re-adding
  // a redundant walk fails here rather than on a stopwatch.
  assert.equal(reads, 2, `expected one materialisation plus one validation pass, saw ${reads} reads`);
});

test('MAX_FIXED_EVENT_CONFLICT_REASONS is the bound the sweep actually honours', () => {
  const overlapping = Array.from({ length: MAX_FIXED_EVENT_CONFLICT_REASONS + 20 }, (_, index) => event({
    eventId: `e-${index}`,
    interval: { startsAt: '2026-11-09T12:00:00.000Z', endsAt: '2026-11-09T13:00:00.000Z' },
  }));
  const verdict = assessFeasibility(constraints({ fixedEvents: overlapping }), CONFIG);
  const conflicts = codesFor(verdict, null).filter((code) => code === 'FIXED_EVENT_CONFLICT');

  // The constant is exported so it can be asserted rather than assumed. n events
  // that all overlap yield n-1 sweep conflicts, of which the bound names
  // MAX individually and the rest arrive as one counted summary.
  assert.equal(conflicts.length, MAX_FIXED_EVENT_CONFLICT_REASONS + 1);
  const summary = verdict.reasons.filter((reason) => /further overlapping/.test(reason.detail));
  assert.equal(summary.length, 1);
  assert.ok(
    summary[0].detail.startsWith(String(overlapping.length - 1 - MAX_FIXED_EVENT_CONFLICT_REASONS)),
    `the summary must state how many were not enumerated: ${summary[0].detail}`,
  );
});
