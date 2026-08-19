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

  assert.ok(codesFor(verdict, null).includes('INVALID_INTERVAL'));
  assert.equal(verdict.availableMinutes, 0, 'an ill-formed window contributes no capacity');
});

test('INVALID_INTERVAL: a window minute outside 0..1440 denotes no interval on any clock face', () => {
  const verdict = assessFeasibility(
    constraints({ workingWindows: [{ ...MONDAY_NINE_TO_FIVE_UTC, endMinute: 2000 }] }),
    CONFIG,
  );

  // The point of the code is capacity, not tidiness: counted naively this window
  // would contribute 1460 minutes of availability that no clock ever showed.
  assert.ok(codesFor(verdict, null).includes('INVALID_INTERVAL'));
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

test('DEADLINE_BEYOND_HORIZON: a deadline past the horizon end, but not one exactly on it', () => {
  const beyond = assessFeasibility(
    constraints({ items: [item({ itemId: 'i-late', deadlineAt: '2026-11-16T00:00:01.000Z' })] }),
    CONFIG,
  );
  const onTheEdge = assessFeasibility(
    constraints({ items: [item({ itemId: 'i-edge', deadlineAt: UTC_HORIZON.endsAt })] }),
    CONFIG,
  );

  assert.deepEqual(codesFor(beyond, 'i-late'), ['DEADLINE_BEYOND_HORIZON']);
  // The deadline is exclusive and the horizon is half-open, so an item finished
  // at the horizon's last instant is finished inside the horizon.
  assert.deepEqual(codesFor(onTheEdge, 'i-edge'), []);
});

test('DEADLINE_BEYOND_HORIZON also covers a deadline the horizon starts after', () => {
  const verdict = assessFeasibility(
    constraints({ items: [item({ itemId: 'i-past', deadlineAt: '2026-11-08T00:00:00.000Z' })] }),
    CONFIG,
  );

  // "The plan simply does not reach that far" is symmetric: extending the
  // horizon backwards would change the answer, which is the property that
  // separates this code from having no time at all.
  assert.deepEqual(codesFor(verdict, 'i-past'), ['DEADLINE_BEYOND_HORIZON']);
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
        event({ eventId: 'e-a' }),
        event({ eventId: 'e-b', blocking: false }),
      ],
    }),
    CONFIG,
  );

  assert.deepEqual(verdict.reasons, [], 'overlapping a non-blocking event is not being in two places');
  assert.equal(verdict.availableMinutes, 420);
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

  assert.ok(codesFor(verdict, null).includes('AMBIGUOUS_LOCAL_TIME'));
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
