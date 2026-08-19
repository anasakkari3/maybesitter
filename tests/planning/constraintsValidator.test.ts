/**
 * One test per code in `STATIC_INFEASIBILITY_CODES`, each asserting the
 * validator emits *exactly* that code and nothing else.
 *
 * "Exactly" is the point, and it is the same rule
 * `tests/decomposition/validatorViolations.test.ts` set for Sprint 06. Several
 * of these conditions imply each other by construction — a deadline before the
 * earliest start also leaves no room for the effort; an item depending on
 * itself is also in a cycle; an inverted horizon also contains no working time
 * — so a validator that reported every technically-true code would hand a
 * reader four findings for one defect and no signal about which is the cause.
 * Asserting the exact code set is what pins the precedence rules. Asserting
 * membership would let them drift.
 *
 * The second thing this file pins is the *partition*. The sprint's cross-track
 * test compares this validator against #31's independently written oracle on
 * `STATIC_INFEASIBILITY_CODES` alone, and that comparison is only meaningful if
 * this side never strays outside it. One attempt code emitted here — a
 * `NO_FEASIBLE_SLOT` that looked static from where the validator stood — would
 * make the two disagree about a code neither was asked about. There is a test
 * for that below, run over every fixture in the file rather than over one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STATIC_INFEASIBILITY_CODES,
  type PlanningConfig,
  type PlanningConstraints,
  type PlanningItem,
  type PlanningReason,
  type PlanningReasonCode,
  type WorkingWindow,
} from '../../src/contracts/v1/planningContracts.ts';
import { validateConstraints } from '../../lib/planning/constraints/index.ts';

const CONFIG: PlanningConfig = { slotMinutes: 15, foldPolicy: 'earliest', resourceDependenciesOrder: false };

function item(overrides: Partial<PlanningItem> = {}): PlanningItem {
  return {
    itemId: 'i1',
    title: 'Draft the report',
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

/** Weekdays Monday to Friday, 09:00-17:00, in a zone with no transitions. */
const WEEKDAY_WINDOWS: readonly WorkingWindow[] = [1, 2, 3, 4, 5].map((weekday) => ({
  windowId: `w-${weekday}`,
  weekday: weekday as WorkingWindow['weekday'],
  startMinute: 9 * 60,
  endMinute: 17 * 60,
  timezone: 'Asia/Kolkata',
}));

function constraints(overrides: Partial<PlanningConstraints> = {}): PlanningConstraints {
  return {
    scopeId: 'scope-1',
    timezone: 'Asia/Kolkata',
    horizon: { startsAt: '2026-03-02T00:00:00.000Z', endsAt: '2026-03-16T00:00:00.000Z' },
    workingWindows: WEEKDAY_WINDOWS,
    fixedEvents: [],
    items: [item()],
    ...overrides,
  };
}

/** Every fixture this file validates, so the partition test can sweep them all. */
const validated: PlanningReason[][] = [];

function validate(
  input: PlanningConstraints,
  config: PlanningConfig = CONFIG,
  options: Parameters<typeof validateConstraints>[2] = {},
): PlanningReason[] {
  const reasons = validateConstraints(input, config, options);
  validated.push(reasons);
  return reasons;
}

function codes(reasons: readonly PlanningReason[]): PlanningReasonCode[] {
  return Array.from(new Set(reasons.map((reason) => reason.code))).sort();
}

/* ── The clean case ──────────────────────────────────────────────── */

test('well-formed constraints produce no reasons at all', () => {
  assert.deepEqual(validate(constraints()), []);
});

test('validation is a pure function of its arguments: two runs agree exactly', () => {
  const input = constraints({ items: [item(), item({ itemId: 'i2', effort: { kind: 'unknown' } })] });
  assert.deepEqual(validate(input), validate(input));
});

/* ── INVALID_INTERVAL ────────────────────────────────────────────── */

test('INVALID_INTERVAL: a horizon whose end is not after its start', () => {
  const reasons = validate(
    constraints({ horizon: { startsAt: '2026-03-16T00:00:00.000Z', endsAt: '2026-03-02T00:00:00.000Z' } }),
  );
  // Not also NO_WORKING_WINDOW. An inverted horizon contains no working time by
  // construction, and reporting both would send the reader to the windows,
  // which are fine.
  assert.deepEqual(codes(reasons), ['INVALID_INTERVAL']);
  assert.deepEqual(reasons.map((reason) => reason.itemId), [null]);
});

test('an inverted horizon does not also report every item as too large for its window', () => {
  // Found by writing the test above rather than by design, and worth its own
  // case. An item with no `earliestStartAt` and no `deadlineAt` borrows both
  // bounds from the horizon, so an inverted horizon makes every item's window
  // negative and `EFFORT_EXCEEDS_ITEM_WINDOW` true for all of them. The report
  // would then carry one actionable finding buried under one per item, all of
  // them consequences of it.
  const inverted = constraints({
    horizon: { startsAt: '2026-03-16T00:00:00.000Z', endsAt: '2026-03-02T00:00:00.000Z' },
    items: [item({ itemId: 'i1' }), item({ itemId: 'i2' }), item({ itemId: 'i3' })],
  });
  assert.deepEqual(validate(inverted).map((reason) => reason.code), ['INVALID_INTERVAL']);
});

test('an inverted horizon still reports the defects that are intrinsic to an item', () => {
  // The suppression above is narrow on purpose: it covers the judgements that
  // *borrow* a bound from the horizon, and nothing else. An unknown effort and a
  // self-edge are wrong whatever the horizon says, and losing them would make
  // one bad field hide every other one in the request.
  const inverted = constraints({
    horizon: { startsAt: '2026-03-16T00:00:00.000Z', endsAt: '2026-03-02T00:00:00.000Z' },
    items: [
      item({ itemId: 'i1', effort: { kind: 'unknown' } }),
      item({ itemId: 'i2', dependsOn: [{ dependsOnItemId: 'i2', kind: 'temporal' }] }),
    ],
  });
  assert.deepEqual(codes(validate(inverted)), ['EFFORT_UNKNOWN', 'INVALID_INTERVAL', 'SELF_DEPENDENCY']);
});

test('INVALID_INTERVAL: a zero-length horizon, which claims a position and holds no time', () => {
  const instant = '2026-03-02T00:00:00.000Z';
  assert.deepEqual(
    codes(validate(constraints({ horizon: { startsAt: instant, endsAt: instant } }))),
    ['INVALID_INTERVAL'],
  );
});

test('INVALID_INTERVAL: a working window whose end minute is not after its start minute', () => {
  const overnight: WorkingWindow = {
    windowId: 'w-overnight',
    weekday: 1,
    startMinute: 22 * 60,
    endMinute: 6 * 60,
    timezone: 'Asia/Kolkata',
  };
  const reasons = validate(constraints({ workingWindows: [...WEEKDAY_WINDOWS, overnight] }));
  assert.deepEqual(codes(reasons), ['INVALID_INTERVAL']);
});

test('INVALID_INTERVAL: a working window with minutes outside the 0..1440 domain', () => {
  const broken: WorkingWindow = {
    windowId: 'w-broken',
    weekday: 1,
    startMinute: 9 * 60,
    endMinute: 1441,
    timezone: 'Asia/Kolkata',
  };
  assert.deepEqual(codes(validate(constraints({ workingWindows: [...WEEKDAY_WINDOWS, broken] }))), [
    'INVALID_INTERVAL',
  ]);
});

test('INVALID_INTERVAL: a working window naming a zone the runtime does not know', () => {
  const elsewhere: WorkingWindow = { ...WEEKDAY_WINDOWS[0], windowId: 'w-mars', timezone: 'Mars/Olympus_Mons' };
  assert.deepEqual(codes(validate(constraints({ workingWindows: [...WEEKDAY_WINDOWS, elsewhere] }))), [
    'INVALID_INTERVAL',
  ]);
});

test('INVALID_INTERVAL: a zero-length fixed event', () => {
  const degenerate = {
    eventId: 'e-degenerate',
    interval: { startsAt: '2026-03-02T06:00:00.000Z', endsAt: '2026-03-02T06:00:00.000Z' },
    sourceCommitmentId: null,
    blocking: true,
  };
  // The case `TimeInterval` names: it occupies no time while claiming a
  // position, so it conflicts with nothing and nothing conflicts with it. No
  // overlap assertion anywhere could see it.
  assert.deepEqual(codes(validate(constraints({ fixedEvents: [degenerate] }))), ['INVALID_INTERVAL']);
});

/* ── Effort ──────────────────────────────────────────────────────── */

test('EFFORT_UNKNOWN: an unknown duration is reported, never guessed', () => {
  const reasons = validate(constraints({ items: [item({ effort: { kind: 'unknown' } })] }));
  assert.deepEqual(codes(reasons), ['EFFORT_UNKNOWN']);
  assert.deepEqual(reasons.map((reason) => reason.itemId), ['i1']);
});

test('EFFORT_UNKNOWN suppresses the window check, which has no size to compare against', () => {
  // An unknown effort with a one-minute window is one defect, not two. Sizing a
  // slot is impossible for the same reason in both cases.
  const cramped = item({
    effort: { kind: 'unknown' },
    earliestStartAt: '2026-03-02T04:00:00.000Z',
    deadlineAt: '2026-03-02T04:01:00.000Z',
  });
  assert.deepEqual(codes(validate(constraints({ items: [cramped] }))), ['EFFORT_UNKNOWN']);
});

test('EFFORT_NOT_POSITIVE: a known effort of zero or less', () => {
  for (const minutes of [0, -30]) {
    assert.deepEqual(
      codes(validate(constraints({ items: [item({ effort: { kind: 'known', minutes } })] }))),
      ['EFFORT_NOT_POSITIVE'],
      `minutes: ${minutes}`,
    );
  }
});

test('EFFORT_NOT_POSITIVE: a known effort that is not a finite number', () => {
  for (const minutes of [Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(
      codes(validate(constraints({ items: [item({ effort: { kind: 'known', minutes } })] }))),
      ['EFFORT_NOT_POSITIVE'],
      `minutes: ${String(minutes)}`,
    );
  }
});

/* ── The item's own window ───────────────────────────────────────── */

test('DEADLINE_BEFORE_EARLIEST_START: the item window is empty before anything else is consulted', () => {
  const inverted = item({
    earliestStartAt: '2026-03-05T04:00:00.000Z',
    deadlineAt: '2026-03-03T04:00:00.000Z',
  });
  // Not also EFFORT_EXCEEDS_ITEM_WINDOW. Sixty minutes does not fit in a
  // negative window either, but the window being empty is the cause and the
  // effort not fitting is a consequence.
  assert.deepEqual(codes(validate(constraints({ items: [inverted] }))), ['DEADLINE_BEFORE_EARLIEST_START']);
});

test('DEADLINE_BEFORE_EARLIEST_START: a deadline equal to the earliest start, since it is exclusive', () => {
  const instant = '2026-03-05T04:00:00.000Z';
  assert.deepEqual(
    codes(validate(constraints({ items: [item({ earliestStartAt: instant, deadlineAt: instant })] }))),
    ['DEADLINE_BEFORE_EARLIEST_START'],
  );
});

test('DEADLINE_BEYOND_HORIZON: the plan simply does not reach that far', () => {
  const late = item({ deadlineAt: '2026-04-01T00:00:00.000Z' });
  // Distinct from having no time: extending the horizon would change the
  // answer, and no other code says that.
  assert.deepEqual(codes(validate(constraints({ items: [late] }))), ['DEADLINE_BEYOND_HORIZON']);
});

test('a deadline exactly at the horizon end is inside it, because the end is exclusive', () => {
  const atEdge = item({ deadlineAt: '2026-03-16T00:00:00.000Z' });
  // The item must be *finished* by its deadline and the horizon ends at that
  // same instant, so every minute the item could use is inside the horizon.
  assert.deepEqual(validate(constraints({ items: [atEdge] })), []);
});

test('EFFORT_EXCEEDS_ITEM_WINDOW: the effort alone does not fit between the two bounds', () => {
  const cramped = item({
    effort: { kind: 'known', minutes: 120 },
    earliestStartAt: '2026-03-02T04:00:00.000Z',
    deadlineAt: '2026-03-02T05:00:00.000Z',
  });
  assert.deepEqual(codes(validate(constraints({ items: [cramped] }))), ['EFFORT_EXCEEDS_ITEM_WINDOW']);
});

test('EFFORT_EXCEEDS_ITEM_WINDOW counts the buffers, which are not part of the effort', () => {
  // Sixty minutes of effort inside a ninety-minute window fits. The same effort
  // with fifteen minutes of protected time on each side needs ninety-one and
  // does not. Buffers are deliberately not folded into `Effort` — the contract
  // keeps them separate so a plan can report both numbers — so a check that
  // compared effort alone would call this feasible and #30 would then fail to
  // place it, reporting contention for what was a contradiction.
  const window = { earliestStartAt: '2026-03-02T04:00:00.000Z', deadlineAt: '2026-03-02T05:30:00.000Z' };

  assert.deepEqual(validate(constraints({ items: [item({ ...window })] })), []);

  const buffered = item({ ...window, bufferBeforeMinutes: 15, bufferAfterMinutes: 16 });
  assert.deepEqual(codes(validate(constraints({ items: [buffered] }))), ['EFFORT_EXCEEDS_ITEM_WINDOW']);
});

test('EFFORT_EXCEEDS_ITEM_WINDOW: effort exactly filling the window fits, since the deadline is exclusive', () => {
  const exact = item({
    effort: { kind: 'known', minutes: 60 },
    earliestStartAt: '2026-03-02T04:00:00.000Z',
    deadlineAt: '2026-03-02T05:00:00.000Z',
  });
  assert.deepEqual(validate(constraints({ items: [exact] })), []);
});

test('EFFORT_EXCEEDS_ITEM_WINDOW: an absent bound falls back to the horizon, not to infinity', () => {
  // With no `earliestStartAt` the item may start when the plan does, so the
  // usable window is bounded by the horizon. Treating a null bound as unbounded
  // would call a ten-minute-deep horizon roomy enough for a day of work.
  const narrow = constraints({
    horizon: { startsAt: '2026-03-02T00:00:00.000Z', endsAt: '2026-03-02T00:30:00.000Z' },
    items: [item({ effort: { kind: 'known', minutes: 60 } })],
  });
  assert.deepEqual(codes(validate(narrow)), ['EFFORT_EXCEEDS_ITEM_WINDOW', 'NO_WORKING_WINDOW'].sort());
});

/* ── NO_WORKING_WINDOW ───────────────────────────────────────────── */

test('NO_WORKING_WINDOW: no windows were supplied at all', () => {
  const reasons = validate(constraints({ workingWindows: [] }));
  assert.deepEqual(codes(reasons), ['NO_WORKING_WINDOW']);
  assert.deepEqual(reasons.map((reason) => reason.itemId), [null]);
});

test('NO_WORKING_WINDOW: windows exist but none of them falls inside the horizon', () => {
  // A Saturday-and-Sunday worker with a Monday-to-Friday horizon has nowhere
  // legal to put anything, and the windows themselves are perfectly valid — so
  // this is not `INVALID_INTERVAL`, and nothing else would say it.
  const weekend = constraints({
    horizon: { startsAt: '2026-03-02T00:00:00.000Z', endsAt: '2026-03-06T00:00:00.000Z' },
    workingWindows: WEEKDAY_WINDOWS.map((window) => ({ ...window, weekday: 0 as WorkingWindow['weekday'] })),
  });
  assert.deepEqual(codes(validate(weekend)), ['NO_WORKING_WINDOW']);
});

test('NO_WORKING_WINDOW is not raised merely because every window is fully booked', () => {
  // Availability that exists and is entirely occupied is contention, which is
  // #30's `NO_FEASIBLE_SLOT`. Reporting it here would put an attempt judgement
  // in the static half of the taxonomy, and the cross-track comparison would
  // then be run against an oracle that had never been asked the question.
  const booked = constraints({
    horizon: { startsAt: '2026-03-02T00:00:00.000Z', endsAt: '2026-03-03T00:00:00.000Z' },
    fixedEvents: [
      {
        eventId: 'e-all-day',
        interval: { startsAt: '2026-03-02T00:00:00.000Z', endsAt: '2026-03-03T00:00:00.000Z' },
        sourceCommitmentId: null,
        blocking: true,
      },
    ],
  });
  assert.deepEqual(validate(booked), []);
});

/* ── Dependencies ────────────────────────────────────────────────── */

test('SELF_DEPENDENCY: an item depending on itself', () => {
  const looping = item({ dependsOn: [{ dependsOnItemId: 'i1', kind: 'temporal' }] });
  const reasons = validate(constraints({ items: [looping] }));
  assert.deepEqual(codes(reasons), ['SELF_DEPENDENCY']);
  assert.deepEqual(reasons.map((reason) => reason.itemId), ['i1']);
});

test('SELF_DEPENDENCY takes precedence over the cycle it also is', () => {
  // The contract states this ruling and `decompositionContracts` set it first:
  // one defect earns one code. A self-edge is a cycle of length one, and
  // reporting both would double-count a single mistake.
  const looping = item({ dependsOn: [{ dependsOnItemId: 'i1', kind: 'temporal' }] });
  assert.deepEqual(codes(validate(constraints({ items: [looping] }))), ['SELF_DEPENDENCY']);
});

test('SELF_DEPENDENCY is reported once however many times the item names itself', () => {
  const looping = item({
    dependsOn: [
      { dependsOnItemId: 'i1', kind: 'temporal' },
      { dependsOnItemId: 'i1', kind: 'resource' },
    ],
  });
  assert.equal(validate(constraints({ items: [looping] })).length, 1);
});

test('CYCLIC_DEPENDENCY: every item in the cycle is told, because every one of them is unplaceable', () => {
  // Attributed per item rather than once to the constraints, so #30 can put the
  // reason on the `UnscheduledItem` it belongs to. A single null-itemId finding
  // could not be attached to anything, and the contract's ruling that
  // SELF_DEPENDENCY *takes precedence over* CYCLIC_DEPENDENCY only makes sense
  // if the two are attributed the same way.
  const a = item({ itemId: 'i1', dependsOn: [{ dependsOnItemId: 'i2', kind: 'temporal' }] });
  const b = item({ itemId: 'i2', dependsOn: [{ dependsOnItemId: 'i1', kind: 'temporal' }] });

  const reasons = validate(constraints({ items: [a, b] }));
  assert.deepEqual(codes(reasons), ['CYCLIC_DEPENDENCY']);
  assert.deepEqual(reasons.map((reason) => reason.itemId), ['i1', 'i2']);
});

test('CYCLIC_DEPENDENCY names only the items in the cycle, not the ones hanging off it', () => {
  const a = item({ itemId: 'i1', dependsOn: [{ dependsOnItemId: 'i2', kind: 'temporal' }] });
  const b = item({ itemId: 'i2', dependsOn: [{ dependsOnItemId: 'i1', kind: 'temporal' }] });
  // Depends on the cycle without being in it. It is blocked, which is #30's
  // transitive `BLOCKED_BY_DEPENDENCY` — a different message to a user and a
  // different bug to an engineer.
  const c = item({ itemId: 'i3', dependsOn: [{ dependsOnItemId: 'i1', kind: 'temporal' }] });

  const reasons = validate(constraints({ items: [a, b, c] }));
  assert.deepEqual(reasons.map((reason) => reason.itemId), ['i1', 'i2']);
});

test('an item with a self-edge inside a longer cycle earns one code, and its neighbours still earn theirs', () => {
  const a = item({
    itemId: 'i1',
    dependsOn: [
      { dependsOnItemId: 'i1', kind: 'temporal' },
      { dependsOnItemId: 'i2', kind: 'temporal' },
    ],
  });
  const b = item({ itemId: 'i2', dependsOn: [{ dependsOnItemId: 'i1', kind: 'temporal' }] });

  const reasons = validate(constraints({ items: [a, b] }));
  assert.deepEqual(
    reasons.map((reason) => [reason.itemId, reason.code]),
    [['i1', 'SELF_DEPENDENCY'], ['i2', 'CYCLIC_DEPENDENCY']],
  );
});

test('a cycle of informational edges is not a scheduling contradiction and is not reported', () => {
  // The contract says `resource` and `informational` are recorded but do not,
  // on their own, force ordering in v1. An edge that forces no order cannot
  // make a cycle unschedulable, and reporting one would mark a perfectly
  // placeable pair of items impossible.
  const a = item({ itemId: 'i1', dependsOn: [{ dependsOnItemId: 'i2', kind: 'informational' }] });
  const b = item({ itemId: 'i2', dependsOn: [{ dependsOnItemId: 'i1', kind: 'informational' }] });
  assert.deepEqual(validate(constraints({ items: [a, b] })), []);
});

test('a cycle of resource edges is reported only when the config says resource edges order', () => {
  const a = item({ itemId: 'i1', dependsOn: [{ dependsOnItemId: 'i2', kind: 'resource' }] });
  const b = item({ itemId: 'i2', dependsOn: [{ dependsOnItemId: 'i1', kind: 'resource' }] });
  const input = constraints({ items: [a, b] });

  assert.deepEqual(validate(input, { ...CONFIG, resourceDependenciesOrder: false }), []);
  assert.deepEqual(
    codes(validate(input, { ...CONFIG, resourceDependenciesOrder: true })),
    ['CYCLIC_DEPENDENCY'],
  );
});

test('UNKNOWN_DEPENDENCY: an edge pointing at no item in this request', () => {
  const dangling = item({ dependsOn: [{ dependsOnItemId: 'i-absent', kind: 'temporal' }] });
  const reasons = validate(constraints({ items: [dangling] }));
  assert.deepEqual(codes(reasons), ['UNKNOWN_DEPENDENCY']);
  assert.deepEqual(reasons.map((reason) => reason.itemId), ['i1']);
});

test('UNKNOWN_DEPENDENCY is reported whatever the edge kind, because a dangling edge is malformed input', () => {
  // Unlike a cycle, this is not a question about ordering. An edge naming
  // nothing is a defect in the request regardless of what it would have meant.
  for (const kind of ['temporal', 'resource', 'informational'] as const) {
    const dangling = item({ dependsOn: [{ dependsOnItemId: 'i-absent', kind }] });
    assert.deepEqual(codes(validate(constraints({ items: [dangling] }))), ['UNKNOWN_DEPENDENCY'], kind);
  }
});

test('a dangling edge is excluded from cycle detection rather than crashing it or inventing one', () => {
  const a = item({
    itemId: 'i1',
    dependsOn: [
      { dependsOnItemId: 'i-absent', kind: 'temporal' },
      { dependsOnItemId: 'i2', kind: 'temporal' },
    ],
  });
  const b = item({ itemId: 'i2', dependsOn: [] });
  assert.deepEqual(codes(validate(constraints({ items: [a, b] }))), ['UNKNOWN_DEPENDENCY']);
});

test('a long dependency chain is not a cycle, and is walked without exhausting the stack', () => {
  // Sprint 06 shipped a recursive walker that threw a RangeError out past the
  // only try/catch on the path, so a deep graph produced no verdict at all
  // rather than a wrong one. The iterative walker is the fix; this is the case
  // that would find it regressing.
  const chain = Array.from({ length: 5_000 }, (_unused, index) =>
    item({
      itemId: `i${index}`,
      dependsOn: index === 0 ? [] : [{ dependsOnItemId: `i${index - 1}`, kind: 'temporal' }],
    }));
  assert.deepEqual(validate(constraints({ items: chain })), []);
});

/* ── Fixed events ────────────────────────────────────────────────── */

test('FIXED_EVENT_CONFLICT: two blocking events claiming the same time', () => {
  const reasons = validate(constraints({
    fixedEvents: [
      {
        eventId: 'e1',
        interval: { startsAt: '2026-03-02T04:00:00.000Z', endsAt: '2026-03-02T06:00:00.000Z' },
        sourceCommitmentId: null,
        blocking: true,
      },
      {
        eventId: 'e2',
        interval: { startsAt: '2026-03-02T05:00:00.000Z', endsAt: '2026-03-02T07:00:00.000Z' },
        sourceCommitmentId: null,
        blocking: true,
      },
    ],
  }));
  // A contradiction in the input, not a scheduling outcome: the user is claimed
  // to be in two places at once before planning begins. It belongs to the
  // constraints rather than to any item.
  assert.deepEqual(codes(reasons), ['FIXED_EVENT_CONFLICT']);
  assert.deepEqual(reasons.map((reason) => reason.itemId), [null]);
});

test('FIXED_EVENT_CONFLICT is not raised for back-to-back events, because end instants are excluded', () => {
  assert.deepEqual(validate(constraints({
    fixedEvents: [
      {
        eventId: 'e1',
        interval: { startsAt: '2026-03-02T04:00:00.000Z', endsAt: '2026-03-02T05:00:00.000Z' },
        sourceCommitmentId: null,
        blocking: true,
      },
      {
        eventId: 'e2',
        interval: { startsAt: '2026-03-02T05:00:00.000Z', endsAt: '2026-03-02T06:00:00.000Z' },
        sourceCommitmentId: null,
        blocking: true,
      },
    ],
  })), []);
});

test('FIXED_EVENT_CONFLICT ignores non-blocking events, which the user said work may sit inside', () => {
  assert.deepEqual(validate(constraints({
    fixedEvents: [
      {
        eventId: 'e1',
        interval: { startsAt: '2026-03-02T04:00:00.000Z', endsAt: '2026-03-02T06:00:00.000Z' },
        sourceCommitmentId: null,
        blocking: true,
      },
      {
        eventId: 'e2',
        interval: { startsAt: '2026-03-02T05:00:00.000Z', endsAt: '2026-03-02T07:00:00.000Z' },
        sourceCommitmentId: null,
        blocking: false,
      },
    ],
  })), []);
});

test('an overlap outside every working window is still a conflict', () => {
  // Two meetings at 3 a.m. are a contradiction in the calendar whether or not
  // anyone planned to work then. Filtering conflicts by availability would make
  // the finding depend on a window the events have nothing to do with.
  const reasons = validate(constraints({
    fixedEvents: [
      {
        eventId: 'e1',
        interval: { startsAt: '2026-03-02T21:00:00.000Z', endsAt: '2026-03-02T22:00:00.000Z' },
        sourceCommitmentId: null,
        blocking: true,
      },
      {
        eventId: 'e2',
        interval: { startsAt: '2026-03-02T21:30:00.000Z', endsAt: '2026-03-02T23:00:00.000Z' },
        sourceCommitmentId: null,
        blocking: true,
      },
    ],
  }));
  assert.deepEqual(codes(reasons), ['FIXED_EVENT_CONFLICT']);
});

test('many mutually overlapping events produce a bounded report, not a quadratic one', () => {
  // A calendar export of two hundred overlapping events has 19,900 colliding
  // pairs. A reason list travels with the plan and into audit records, so an
  // unbounded report is an unbounded payload on a path nobody inspects — the
  // exact failure Sprint 06's validator was capped for. One finding per event
  // that collides with something earlier is enough to say the input is
  // contradictory, which is what the verdict turns on.
  const overlapping = Array.from({ length: 200 }, (_unused, index) => ({
    eventId: `e${index}`,
    interval: { startsAt: '2026-03-02T04:00:00.000Z', endsAt: '2026-03-02T23:00:00.000Z' },
    sourceCommitmentId: null,
    blocking: true,
  }));
  const reasons = validate(constraints({ fixedEvents: overlapping }));
  assert.deepEqual(codes(reasons), ['FIXED_EVENT_CONFLICT']);
  assert.equal(reasons.length, 199);
});

/* ── DST ─────────────────────────────────────────────────────────── */

test('NONEXISTENT_LOCAL_TIME: a working window starting in a spring-forward gap', () => {
  const reasons = validate(constraints({
    timezone: 'America/New_York',
    horizon: { startsAt: '2026-03-07T00:00:00.000Z', endsAt: '2026-03-10T00:00:00.000Z' },
    workingWindows: [
      { windowId: 'w-early', weekday: 0, startMinute: 150, endMinute: 360, timezone: 'America/New_York' },
    ],
  }));
  // Reported, and the window is still materialised from the moment the clock
  // resumes — so this is a finding about the input, not a reason nothing can be
  // planned. NO_WORKING_WINDOW is deliberately absent.
  assert.deepEqual(codes(reasons), ['NONEXISTENT_LOCAL_TIME']);
  assert.deepEqual(reasons.map((reason) => reason.itemId), [null]);
});

test('NONEXISTENT_LOCAL_TIME is raised once per occurrence, not once per window definition', () => {
  // One window recurring over two spring-forward dates in different zones is
  // two skipped mornings. Collapsing them would make a report of "which days
  // were short" impossible to write.
  const reasons = validate(constraints({
    horizon: { startsAt: '2026-03-01T00:00:00.000Z', endsAt: '2026-04-01T00:00:00.000Z' },
    workingWindows: [
      { windowId: 'w-ny', weekday: 0, startMinute: 150, endMinute: 360, timezone: 'America/New_York' },
      { windowId: 'w-jlm', weekday: 5, startMinute: 150, endMinute: 480, timezone: 'Asia/Jerusalem' },
    ],
  }));
  assert.deepEqual(codes(reasons), ['NONEXISTENT_LOCAL_TIME']);
  assert.equal(reasons.length, 2);
});

test('a window that merely spans a transition is not anomalous, only shorter', () => {
  assert.deepEqual(validate(constraints({
    horizon: { startsAt: '2026-03-07T00:00:00.000Z', endsAt: '2026-03-10T00:00:00.000Z' },
    workingWindows: [
      { windowId: 'w-early', weekday: 0, startMinute: 60, endMinute: 300, timezone: 'America/New_York' },
    ],
  })), []);
});

test('AMBIGUOUS_LOCAL_TIME is resolved by the fold policy and not reported by default', () => {
  // The contract is explicit: with a `foldPolicy` set this is resolved, not
  // reported. `PlanningConfig.foldPolicy` is not optional, so it is always set,
  // and a validator that reported it anyway would mark every fall-back Sunday
  // infeasible for a user whose policy had already decided the question.
  assert.deepEqual(validate(constraints({
    horizon: { startsAt: '2026-10-31T00:00:00.000Z', endsAt: '2026-11-03T00:00:00.000Z' },
    workingWindows: [
      { windowId: 'w-early', weekday: 0, startMinute: 60, endMinute: 180, timezone: 'America/New_York' },
    ],
  })), []);
});

test('AMBIGUOUS_LOCAL_TIME: surfaced only when the caller asks to see the ambiguity', () => {
  // "It exists for callers that choose to surface the ambiguity instead" — the
  // contract's own words. An opt-in is the only shape that fits: the policy has
  // already answered the question, so this is a caller electing to be told the
  // question was asked.
  const reasons = validate(
    constraints({
      horizon: { startsAt: '2026-10-31T00:00:00.000Z', endsAt: '2026-11-03T00:00:00.000Z' },
      workingWindows: [
        { windowId: 'w-early', weekday: 0, startMinute: 60, endMinute: 180, timezone: 'America/New_York' },
      ],
    }),
    CONFIG,
    { surfaceFoldAmbiguity: true },
  );
  assert.deepEqual(codes(reasons), ['AMBIGUOUS_LOCAL_TIME']);
  assert.deepEqual(reasons.map((reason) => reason.itemId), [null]);
});

/* ── Ordering, partition, and what a detail may carry ────────────── */

test('reasons about the constraints come before reasons about items, in item order', () => {
  const reasons = validate(constraints({
    workingWindows: [],
    items: [
      item({ itemId: 'i1', effort: { kind: 'unknown' } }),
      item({ itemId: 'i2', effort: { kind: 'known', minutes: 0 } }),
    ],
  }));
  assert.deepEqual(
    reasons.map((reason) => [reason.itemId, reason.code]),
    [[null, 'NO_WORKING_WINDOW'], ['i1', 'EFFORT_UNKNOWN'], ['i2', 'EFFORT_NOT_POSITIVE']],
  );
});

test('an unparseable instant throws rather than being scored as a verdict', () => {
  // The shared primitive throws on purpose: NaN propagates through every
  // comparison as false, which would turn "this item conflicts" into "this item
  // does not conflict" and make a parse error look like a scheduling decision.
  // The alternative here would be to swallow it and invent a code the shared
  // vocabulary does not contain — which is precisely what a shared taxonomy
  // exists to prevent. Producing a well-formed `Instant` is the boundary's job.
  assert.throws(
    () => validateConstraints(constraints({ items: [item({ deadlineAt: 'next Tuesday' })] }), CONFIG),
    TypeError,
  );
});

test('every reason this file produced is a static code; not one is an attempt code', () => {
  // The partition is what makes the cross-track comparison meaningful, and it
  // is checked over every fixture in the file rather than over one, because a
  // stray attempt code would appear in whichever case nobody thought to assert
  // exactly.
  const staticCodes = new Set<string>(STATIC_INFEASIBILITY_CODES);
  assert.ok(validated.length > 30, 'test setup: expected this sweep to cover the whole file');
  for (const reasons of validated) {
    for (const reason of reasons) {
      assert.ok(staticCodes.has(reason.code), `${reason.code} is not a static infeasibility code`);
    }
  }
});

test('every static code in the contract has a test in this file that produces it', () => {
  // The guard against the partition drifting the other way: a code added to the
  // contract and never emitted here would leave #31's oracle deciding it alone,
  // and the cross-track test would compare one reading against none.
  const produced = new Set(validated.flatMap((reasons) => reasons.map((reason) => reason.code)));
  assert.deepEqual(
    STATIC_INFEASIBILITY_CODES.filter((code) => !produced.has(code)),
    [],
  );
});

test('no detail repeats a windowId, an eventId or a title, which are all user-chosen', () => {
  // `PlanningReason.detail` never carries raw user text, matching the policy
  // Sprint 06 set for `DecompositionViolation.detail`. An `itemId` is carried
  // in its own field by the contract, so naming things by *position* in the
  // detail costs nothing and keeps the rule true from every direction — including
  // the one nobody inspects, where a violation is logged.
  const secrets = ['w-secret-window', 'e-secret-event', 'Tell my therapist I relapsed'];
  const reasons = validate(constraints({
    workingWindows: [
      { windowId: secrets[0], weekday: 1, startMinute: 600, endMinute: 60, timezone: 'Asia/Kolkata' },
    ],
    fixedEvents: [
      {
        eventId: secrets[1],
        interval: { startsAt: '2026-03-02T06:00:00.000Z', endsAt: '2026-03-02T06:00:00.000Z' },
        sourceCommitmentId: null,
        blocking: true,
      },
    ],
    items: [item({ title: secrets[2], effort: { kind: 'unknown' } })],
  }));

  assert.ok(reasons.length > 0, 'test setup: expected findings to inspect');
  for (const reason of reasons) {
    for (const secret of secrets) {
      assert.equal(reason.detail.includes(secret), false, `${reason.code} detail repeats user-chosen text`);
    }
  }
});
