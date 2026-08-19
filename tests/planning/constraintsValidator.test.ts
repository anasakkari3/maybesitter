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

/**
 * Embedded in every user-chosen string this file builds — window ids, event ids,
 * titles, the scope id, commitment ids. The privacy sweep at the bottom asserts
 * no `detail` ever contains it. A distinctive marker rather than the real values
 * so one substring test covers every field with no risk of a coincidental match
 * against a number or an index that a finding legitimately carries.
 */
const RAW_TEXT_MARKER = 'RAWTEXT';

const CONFIG: PlanningConfig = { slotMinutes: 15, foldPolicy: 'earliest', resourceDependenciesOrder: false };

function item(overrides: Partial<PlanningItem> = {}): PlanningItem {
  return {
    itemId: 'i1',
    title: 'Draft the RAWTEXT report',
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
  windowId: `w-RAWTEXT-${weekday}`,
  weekday: weekday as WorkingWindow['weekday'],
  startMinute: 9 * 60,
  endMinute: 17 * 60,
  timezone: 'Asia/Kolkata',
}));

function constraints(overrides: Partial<PlanningConstraints> = {}): PlanningConstraints {
  return {
    scopeId: 'scope-RAWTEXT',
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
  // *borrow* a bound from the horizon, and nothing else. "Borrow" is decided per
  // item and per bound, not per request — see the two tests below, where an item
  // that states both of its own bounds is judged on them whatever the horizon
  // says. An unknown effort and a self-edge are wrong whatever the horizon says
  // too, and losing them would make one bad field hide every other one.
  const inverted = constraints({
    horizon: { startsAt: '2026-03-16T00:00:00.000Z', endsAt: '2026-03-02T00:00:00.000Z' },
    items: [
      item({ itemId: 'i1', effort: { kind: 'unknown' } }),
      item({ itemId: 'i2', dependsOn: [{ dependsOnItemId: 'i2', kind: 'temporal' }] }),
    ],
  });
  assert.deepEqual(codes(validate(inverted)), ['EFFORT_UNKNOWN', 'INVALID_INTERVAL', 'SELF_DEPENDENCY']);
});

test('an item that states both of its own bounds is judged on them, inverted horizon or not', () => {
  // The horizon suppression was written as a single flag over the whole check,
  // and that is broader than its justification. An item carrying both an
  // `earliestStartAt` and a `deadlineAt` borrows nothing from the horizon, so a
  // bad horizon tells us nothing about whether its effort fits — and staying
  // silent is a false *feasible*, which #30 would then report as
  // `NO_FEASIBLE_SLOT` contention for what was a contradiction.
  const selfSpecified = item({
    effort: { kind: 'known', minutes: 600 },
    earliestStartAt: '2026-03-05T00:00:00.000Z',
    deadlineAt: '2026-03-05T00:10:00.000Z',
  });

  const inverted = constraints({
    horizon: { startsAt: '2026-03-16T00:00:00.000Z', endsAt: '2026-03-02T00:00:00.000Z' },
    items: [selfSpecified],
  });
  assert.deepEqual(codes(validate(inverted)), ['EFFORT_EXCEEDS_ITEM_WINDOW', 'INVALID_INTERVAL']);

  // The same item under a sound horizon must reach the same verdict about
  // itself, or the finding depended on a field it does not read.
  assert.deepEqual(codes(validate(constraints({ items: [selfSpecified] }))), ['EFFORT_EXCEEDS_ITEM_WINDOW']);
});

test('DEADLINE_BEFORE_EARLIEST_START speaks only about the two bounds the item states', () => {
  // I had briefly made a null `earliestStartAt` substitute the horizon start
  // here, to match what the window check does. The contract ruling on
  // DEADLINE_BEYOND_HORIZON removes the need and the temptation: that code now
  // owns "the deadline is before the plan begins", so this one is left saying
  // exactly one thing — the item's own two bounds are inverted — with no
  // substitution to have an opinion about.
  const past = item({ earliestStartAt: null, deadlineAt: '2026-03-01T00:00:00.000Z' });
  assert.deepEqual(codes(validate(constraints({ items: [past] }))), ['DEADLINE_BEYOND_HORIZON']);

  const stated = item({ earliestStartAt: '2026-03-05T00:00:00.000Z', deadlineAt: '2026-03-04T00:00:00.000Z' });
  assert.deepEqual(codes(validate(constraints({ items: [stated] }))), ['DEADLINE_BEFORE_EARLIEST_START']);
});

test('an item can be both self-contradictory and out of the plan\'s reach, and is told both', () => {
  // Two independent facts about two different pairs of fields: its own bounds
  // are inverted, and its deadline predates the plan. Neither judgement borrows
  // a bound from anything reported invalid, so neither is suppressed — the
  // suppression principle is narrow on purpose, and "one defect earns one code"
  // does not mean "one item earns one code".
  const both = item({ earliestStartAt: '2026-03-05T00:00:00.000Z', deadlineAt: '2026-03-01T00:00:00.000Z' });
  assert.deepEqual(codes(validate(constraints({ items: [both] }))), [
    'DEADLINE_BEFORE_EARLIEST_START',
    'DEADLINE_BEYOND_HORIZON',
  ]);
});

test('EFFORT_NOT_POSITIVE: a buffer that is not a finite, non-negative number of minutes', () => {
  // `required = effort + bufferBefore + bufferAfter` is NaN when a buffer is,
  // and `NaN > available` is false — so the window check fell through and the
  // item was reported as perfectly feasible. A negative buffer did the same by
  // shrinking `required` below the effort the item actually needs. Effort was
  // guarded for exactly this and the buffers were not; false-feasible is the
  // worse direction of the two, because nothing downstream can tell that the
  // question was never really asked.
  const window = { earliestStartAt: '2026-03-02T04:00:00.000Z', deadlineAt: '2026-03-02T04:10:00.000Z' };
  for (const buffers of [
    { bufferBeforeMinutes: Number.NaN, bufferAfterMinutes: 0 },
    { bufferBeforeMinutes: 0, bufferAfterMinutes: Number.NaN },
    { bufferBeforeMinutes: -10_000, bufferAfterMinutes: 0 },
    { bufferBeforeMinutes: 0, bufferAfterMinutes: Number.POSITIVE_INFINITY },
  ]) {
    assert.deepEqual(
      codes(validate(constraints({ items: [item({ ...window, ...buffers })] }))),
      ['EFFORT_NOT_POSITIVE'],
      JSON.stringify(buffers),
    );
  }
});

test('a zero buffer is not a defect; only a negative or non-finite one is', () => {
  // The boundary the guard has to get right. Buffers default to zero all over
  // the request, and a guard that demanded a positive number would report every
  // ordinary item.
  const roomy = item({ bufferBeforeMinutes: 0, bufferAfterMinutes: 0 });
  assert.deepEqual(validate(constraints({ items: [roomy] })), []);
});

test('a bad buffer suppresses the window check rather than being scored through it', () => {
  // One defect earns one code. The window check cannot be answered with an
  // unusable buffer, so it is skipped rather than answered wrongly.
  const bad = item({
    effort: { kind: 'known', minutes: 600 },
    earliestStartAt: '2026-03-02T04:00:00.000Z',
    deadlineAt: '2026-03-02T04:10:00.000Z',
    bufferBeforeMinutes: Number.NaN,
  });
  assert.deepEqual(validate(constraints({ items: [bad] })).map((reason) => reason.code), ['EFFORT_NOT_POSITIVE']);
});

test('every window being malformed reports both facts, because they are two facts', () => {
  // I had suppressed NO_WORKING_WINDOW here on a one-defect-one-code reading.
  // The integration ruling states the suppression principle explicitly and it is
  // narrower: a judgement is suppressed only when it *borrows a bound* from
  // something already reported invalid. NO_WORKING_WINDOW borrows nothing from
  // the windows — it is an independent statement about the horizon holding no
  // availability — so both stand. "Fix these two windows" and "you now have no
  // availability at all" are two things a reader needs.
  //
  // Contrast the inverted horizon two tests below, where the suppression *is*
  // correct: NO_WORKING_WINDOW asks whether any window falls inside the horizon,
  // and the horizon is the thing just reported invalid.
  const broken = constraints({
    workingWindows: [
      { windowId: 'w-RAWTEXT-a', weekday: 1, startMinute: 600, endMinute: 60, timezone: 'Asia/Kolkata' },
      { windowId: 'w-RAWTEXT-b', weekday: 2, startMinute: 600, endMinute: 1441, timezone: 'Asia/Kolkata' },
    ],
    items: [],
  });
  assert.deepEqual(
    validate(broken).map((reason) => reason.code),
    ['INVALID_INTERVAL', 'INVALID_INTERVAL', 'NO_WORKING_WINDOW'],
  );
});

test('NO_WORKING_WINDOW is still raised when a sound window simply yields no time', () => {
  // The other side of that suppression, so it cannot quietly widen: one bad
  // window alongside a well-formed one that lands outside the horizon must
  // still report both facts, because they are two different things to fix.
  const mixed = constraints({
    horizon: { startsAt: '2026-03-02T00:00:00.000Z', endsAt: '2026-03-06T00:00:00.000Z' },
    workingWindows: [
      { windowId: 'w-RAWTEXT-a', weekday: 1, startMinute: 600, endMinute: 60, timezone: 'Asia/Kolkata' },
      { windowId: 'w-RAWTEXT-b', weekday: 0, startMinute: 540, endMinute: 1020, timezone: 'Asia/Kolkata' },
    ],
    items: [],
  });
  assert.deepEqual(validate(mixed).map((reason) => reason.code), ['INVALID_INTERVAL', 'NO_WORKING_WINDOW']);
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
    windowId: 'w-RAWTEXT-overnight',
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
    windowId: 'w-RAWTEXT-broken',
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
  const elsewhere: WorkingWindow = { ...WEEKDAY_WINDOWS[0], windowId: 'w-RAWTEXT-mars', timezone: 'Mars/Olympus_Mons' };
  assert.deepEqual(codes(validate(constraints({ workingWindows: [...WEEKDAY_WINDOWS, elsewhere] }))), [
    'INVALID_INTERVAL',
  ]);
});

test('INVALID_INTERVAL: the complete list of window defects that are not interval defects', () => {
  // The contract defines INVALID_INTERVAL as "an interval with `endsAt <=
  // startsAt`, or a working window with `endMinute <= startMinute`". Four window
  // defects are routed to it that are *neither* of those, because the frozen
  // taxonomy has no better code and inventing a private one is what a shared
  // vocabulary exists to prevent. They are enumerated here rather than scattered
  // so the reading can be licensed in one place and #31's oracle can reach the
  // same conclusion instead of guessing at it.
  //
  // Note that the two minute-domain cases are genuinely separate conditions and
  // not belt-and-braces: `NaN <= 540` is false and `1441 <= 540` is false, so
  // the contract's stated `endMinute <= startMinute` rule does not catch either.
  // Without the domain guard a NaN minute reaches `resolveLocalTime` and
  // materialises garbage.
  const nonIntervalDefects: [string, Partial<WorkingWindow>][] = [
    ['weekday outside 0..6', { weekday: 9 as WorkingWindow['weekday'] }],
    ['startMinute outside 0..1440 or not whole', { startMinute: -30 }],
    ['endMinute outside 0..1440 or not whole', { endMinute: Number.NaN }],
    ['a time zone this runtime does not know', { timezone: 'Mars/Olympus_Mons' }],
  ];

  for (const [what, overrides] of nonIntervalDefects) {
    const broken: WorkingWindow = {
      windowId: 'w-RAWTEXT-defect',
      weekday: 1,
      startMinute: 9 * 60,
      endMinute: 17 * 60,
      timezone: 'Asia/Kolkata',
      ...overrides,
    };
    assert.deepEqual(
      codes(validate(constraints({ workingWindows: [...WEEKDAY_WINDOWS, broken] }))),
      ['INVALID_INTERVAL'],
      what,
    );
  }
});

test('INVALID_INTERVAL: a zero-length fixed event', () => {
  const degenerate = {
    eventId: 'e-RAWTEXT-degenerate',
    interval: { startsAt: '2026-03-02T06:00:00.000Z', endsAt: '2026-03-02T06:00:00.000Z' },
    sourceCommitmentId: 'commitment-RAWTEXT',
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

test('DEADLINE_BEYOND_HORIZON: the deadline fell before the plan even begins', () => {
  // The contract ruling, decided at integration after #31's oracle and this
  // validator produced *disjoint* sets on the same input — the worst shape a
  // disagreement can take, because neither side looks partially right. The code
  // belongs to the half where the item cannot be finished within this plan's
  // reach at all: a deadline at or before `horizon.startsAt`.
  //
  // This is an ordinary daily input rather than an edge case — a stale or missed
  // commitment — which is why it is the one that most matters to get right.
  const missed = item({ deadlineAt: '2026-03-01T00:00:00.000Z' });
  assert.deepEqual(codes(validate(constraints({ items: [missed] }))), ['DEADLINE_BEYOND_HORIZON']);
});

test('DEADLINE_BEYOND_HORIZON: the reviewer\'s exact disjoint-sets input', () => {
  // Reproduced verbatim from the cross-track report so the case that found the
  // disagreement is the case that guards it.
  const input = constraints({
    horizon: { startsAt: '2026-11-09T00:00:00.000Z', endsAt: '2026-11-14T00:00:00.000Z' },
    workingWindows: WEEKDAY_WINDOWS,
    items: [item({ deadlineAt: '2026-11-01T00:00:00.000Z' })],
  });
  assert.deepEqual(codes(validate(input)), ['DEADLINE_BEYOND_HORIZON']);
});

test('a deadline at exactly the horizon start is beyond it, since a deadline is exclusive', () => {
  const atStart = item({ deadlineAt: '2026-03-02T00:00:00.000Z' });
  assert.deepEqual(codes(validate(constraints({ items: [atStart] }))), ['DEADLINE_BEYOND_HORIZON']);
});

test('a stale deadline does not silence the window check on an item that states both bounds', () => {
  // The fuzzer hit this 2,665 times with no DST and no exotic zone: an ordinary
  // item with an old deadline. The item states `earliestStartAt` *and*
  // `deadlineAt`, so it borrows nothing from the horizon, and 10,000 minutes not
  // fitting in a single day is true whatever the horizon says.
  //
  // My suppression read `deadlineOutsideHorizon` without asking whether the
  // window was self-specified — the ruling is per item and per *bound*, not per
  // request, and this was the same mistake one level down from where I first
  // made it.
  const stale = item({
    effort: { kind: 'known', minutes: 10_000 },
    earliestStartAt: '2026-11-01T00:00:00.000Z',
    deadlineAt: '2026-11-02T00:00:00.000Z',
  });
  const input = constraints({
    horizon: { startsAt: '2026-11-09T00:00:00.000Z', endsAt: '2026-11-20T00:00:00.000Z' },
    items: [stale],
  });
  assert.deepEqual(codes(validate(input)), ['DEADLINE_BEYOND_HORIZON', 'EFFORT_EXCEEDS_ITEM_WINDOW']);
});

test('a stale deadline still silences the window check when the window borrows a bound', () => {
  // The suppression that survives, kept next to the one that did not. With no
  // stated `earliestStartAt` the window really is [horizon start, deadline], and
  // that relation is exactly what DEADLINE_BEYOND_HORIZON just reported — so the
  // window check would be measuring the finding rather than the item.
  const stale = item({
    effort: { kind: 'known', minutes: 10_000 },
    earliestStartAt: null,
    deadlineAt: '2026-11-02T00:00:00.000Z',
  });
  const input = constraints({
    horizon: { startsAt: '2026-11-09T00:00:00.000Z', endsAt: '2026-11-20T00:00:00.000Z' },
    items: [stale],
  });
  assert.deepEqual(codes(validate(input)), ['DEADLINE_BEYOND_HORIZON']);
});

test('a deadline after the horizon end is not reported at all: the horizon is the binding constraint', () => {
  // The other half of the ruling, and the more surprising one. An item due in a
  // month, planned over a fortnight, is the *least* constrained thing in the
  // request. Reporting it as infeasible is a manufactured failure: nothing about
  // the item is contradictory, the plan simply stops earlier than the deadline,
  // and #30 places it like anything else.
  const distant = item({ deadlineAt: '2026-04-01T00:00:00.000Z' });
  assert.deepEqual(validate(constraints({ items: [distant] })), []);
});

test('the item window is not clamped to the horizon, so a distant deadline stays roomy', () => {
  // I first wrote this expecting `EFFORT_EXCEEDS_ITEM_WINDOW` here — 30 minutes
  // of horizon, 600 minutes of effort — and the code disagreed. The code is
  // right and the expectation was the ruling's mistake in miniature.
  //
  // The contract defines this code as effort not fitting "between
  // `earliestStartAt` and `deadlineAt`", and this item's own window is a month
  // wide. Clamping it to the horizon would report the item's *own window* as too
  // small when it is nothing of the kind — a manufactured failure of exactly the
  // shape the DEADLINE_BEYOND_HORIZON ruling exists to stop.
  //
  // Nothing is lost. That the plan holds no usable time is already said, once, at
  // constraint level by NO_WORKING_WINDOW, and an item that then cannot be placed
  // is #30's `HORIZON_EXHAUSTED` — contention, reported by the track that tried.
  const narrow = constraints({
    horizon: { startsAt: '2026-03-02T00:00:00.000Z', endsAt: '2026-03-02T00:30:00.000Z' },
    items: [item({ effort: { kind: 'known', minutes: 600 }, deadlineAt: '2026-04-01T00:00:00.000Z' })],
  });
  assert.deepEqual(codes(validate(narrow)), ['NO_WORKING_WINDOW']);
});

test('a null deadline borrows the horizon end, and that bound does bind', () => {
  // The contrast that keeps the test above from reading as "the window check is
  // toothless". With no stated deadline the item's upper bound *is* the
  // horizon's, so the same 600 minutes against the same 30-minute horizon is
  // reported — the item really has nowhere to put itself inside its own window.
  const narrow = constraints({
    horizon: { startsAt: '2026-03-02T00:00:00.000Z', endsAt: '2026-03-02T00:30:00.000Z' },
    items: [item({ effort: { kind: 'known', minutes: 600 }, deadlineAt: null })],
  });
  assert.deepEqual(codes(validate(narrow)), ['EFFORT_EXCEEDS_ITEM_WINDOW', 'NO_WORKING_WINDOW']);
});

test('DEADLINE_BEYOND_HORIZON suppresses the window check it would otherwise also trigger', () => {
  // A deadline before the plan begins leaves the item window empty, so the
  // window check is true as a consequence. It borrows the very bound just
  // reported unusable, which is exactly the condition the suppression principle
  // names.
  const missed = item({ effort: { kind: 'known', minutes: 600 }, deadlineAt: '2026-03-01T00:00:00.000Z' });
  assert.deepEqual(validate(constraints({ items: [missed] })).map((r) => r.code), ['DEADLINE_BEYOND_HORIZON']);
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
        eventId: 'e-RAWTEXT-all-day',
        interval: { startsAt: '2026-03-02T00:00:00.000Z', endsAt: '2026-03-03T00:00:00.000Z' },
        sourceCommitmentId: 'commitment-RAWTEXT',
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

test('CYCLIC_DEPENDENCY: an item reaching a cycle through a cross edge is on it', () => {
  // Found by the integration fuzzer, and a false *feasible*: the caller was told
  // `i3` was fine when `i3` can never start.
  //
  // `i3` sits on the cycle i1 -> i3 -> i2 -> i1. A depth-first walk that marks
  // the gray path only when it finds a *back* edge never sees it: by the time
  // `i3` is visited, `i2` is already finished, so the edge i3 -> i2 is a cross
  // edge and neither branch fires. Reachability, not back edges, is what decides
  // membership — which is how #31's oracle got it right.
  const a = item({ itemId: 'i1', dependsOn: [
    { dependsOnItemId: 'i2', kind: 'temporal' },
    { dependsOnItemId: 'i3', kind: 'temporal' },
  ] });
  const b = item({ itemId: 'i2', dependsOn: [{ dependsOnItemId: 'i1', kind: 'temporal' }] });
  const c = item({ itemId: 'i3', dependsOn: [{ dependsOnItemId: 'i2', kind: 'temporal' }] });

  const reasons = validate(constraints({ items: [a, b, c] }));
  assert.deepEqual(
    reasons.map((reason) => [reason.itemId, reason.code]),
    [['i1', 'CYCLIC_DEPENDENCY'], ['i2', 'CYCLIC_DEPENDENCY'], ['i3', 'CYCLIC_DEPENDENCY']],
  );
});

test('CYCLIC_DEPENDENCY: a chain feeding a cycle names the cycle only, not the chain', () => {
  // The other side of the fix, and the one that stops "report everything
  // reachable" from being the cure. `i1` leads into the cycle i2 -> i3 -> i4 ->
  // i2 without being on it: it is *blocked*, which is #30's transitive
  // BLOCKED_BY_DEPENDENCY — a different message to a user and a different bug to
  // an engineer.
  const items = [
    item({ itemId: 'i1', dependsOn: [{ dependsOnItemId: 'i2', kind: 'temporal' }] }),
    item({ itemId: 'i2', dependsOn: [{ dependsOnItemId: 'i3', kind: 'temporal' }] }),
    item({ itemId: 'i3', dependsOn: [{ dependsOnItemId: 'i4', kind: 'temporal' }] }),
    item({ itemId: 'i4', dependsOn: [{ dependsOnItemId: 'i2', kind: 'temporal' }] }),
  ];
  const reasons = validate(constraints({ items }));
  assert.deepEqual(reasons.map((reason) => reason.itemId), ['i2', 'i3', 'i4']);
});

test('CYCLIC_DEPENDENCY: two disjoint cycles are both found, whichever is walked first', () => {
  // A walk that stops at the first component it completes, or that carries state
  // between roots, would report one and not the other.
  const items = [
    item({ itemId: 'i1', dependsOn: [{ dependsOnItemId: 'i2', kind: 'temporal' }] }),
    item({ itemId: 'i2', dependsOn: [{ dependsOnItemId: 'i1', kind: 'temporal' }] }),
    item({ itemId: 'i3', dependsOn: [{ dependsOnItemId: 'i4', kind: 'temporal' }] }),
    item({ itemId: 'i4', dependsOn: [{ dependsOnItemId: 'i3', kind: 'temporal' }] }),
  ];
  const reasons = validate(constraints({ items }));
  assert.deepEqual(reasons.map((reason) => reason.itemId), ['i1', 'i2', 'i3', 'i4']);
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

test('cycle membership agrees with brute-force reachability over 2,000 random graphs', () => {
  // The check that would have caught the cross-edge defect on the day it was
  // written, and the reason it is here rather than in a scratch file: a table of
  // hand-written graphs tests the shapes its author already thought of, and this
  // defect lived in a shape nobody drew. The integration fuzzer found it in 13
  // of 40,000 cases.
  //
  // The reference is deliberately the *stupid* definition — an item is on a
  // cycle exactly when it can reach itself in one hop or more, computed by
  // breadth-first search from every node. It is far too slow to ship and it is
  // obviously correct, which is the whole point of a reference implementation.
  //
  // Seeded rather than random: a fuzz test that fails once every hundred runs
  // and passes on retry teaches a team to press retry.
  let seed = 12_345;
  const random = (): number => {
    seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
    return seed / 4_294_967_296;
  };

  const reachesItself = (ids: readonly string[], edges: ReadonlyMap<string, readonly string[]>): Set<string> => {
    const onCycle = new Set<string>();
    for (const start of ids) {
      const seen = new Set<string>();
      const queue = Array.from(edges.get(start) ?? []);
      while (queue.length > 0) {
        const next = queue.shift() as string;
        if (next === start) {
          onCycle.add(start);
          break;
        }
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(...(edges.get(next) ?? []));
      }
    }
    return onCycle;
  };

  let graphsWithACycle = 0;
  for (let trial = 0; trial < 2_000; trial += 1) {
    const size = 1 + Math.floor(random() * 7);
    const ids = Array.from({ length: size }, (_unused, index) => `i${index}`);
    const edges = new Map<string, string[]>();
    for (const id of ids) {
      edges.set(id, Array.from(new Set(ids.filter(() => random() < 0.3).filter((target) => target !== id))));
    }

    const items = ids.map((id) => item({
      itemId: id,
      dependsOn: (edges.get(id) as string[]).map((target) => ({ dependsOnItemId: target, kind: 'temporal' as const })),
    }));

    const reported = validateConstraints(constraints({ items }), CONFIG)
      .filter((reason) => reason.code === 'CYCLIC_DEPENDENCY')
      .map((reason) => reason.itemId)
      .sort();
    const expected = Array.from(reachesItself(ids, edges)).sort();
    if (expected.length > 0) graphsWithACycle += 1;

    assert.deepEqual(reported, expected, `graph ${trial}: ${JSON.stringify(Array.from(edges))}`);
  }

  // Without this the test would pass just as loudly against a generator that
  // only ever produced acyclic graphs.
  assert.ok(graphsWithACycle > 500, `expected many cyclic graphs, saw ${graphsWithACycle}`);
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
        eventId: 'e-RAWTEXT-1',
        interval: { startsAt: '2026-03-02T04:00:00.000Z', endsAt: '2026-03-02T06:00:00.000Z' },
        sourceCommitmentId: 'commitment-RAWTEXT',
        blocking: true,
      },
      {
        eventId: 'e-RAWTEXT-2',
        interval: { startsAt: '2026-03-02T05:00:00.000Z', endsAt: '2026-03-02T07:00:00.000Z' },
        sourceCommitmentId: 'commitment-RAWTEXT',
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
        eventId: 'e-RAWTEXT-1',
        interval: { startsAt: '2026-03-02T04:00:00.000Z', endsAt: '2026-03-02T05:00:00.000Z' },
        sourceCommitmentId: 'commitment-RAWTEXT',
        blocking: true,
      },
      {
        eventId: 'e-RAWTEXT-2',
        interval: { startsAt: '2026-03-02T05:00:00.000Z', endsAt: '2026-03-02T06:00:00.000Z' },
        sourceCommitmentId: 'commitment-RAWTEXT',
        blocking: true,
      },
    ],
  })), []);
});

test('FIXED_EVENT_CONFLICT ignores non-blocking events, which the user said work may sit inside', () => {
  assert.deepEqual(validate(constraints({
    fixedEvents: [
      {
        eventId: 'e-RAWTEXT-1',
        interval: { startsAt: '2026-03-02T04:00:00.000Z', endsAt: '2026-03-02T06:00:00.000Z' },
        sourceCommitmentId: 'commitment-RAWTEXT',
        blocking: true,
      },
      {
        eventId: 'e-RAWTEXT-2',
        interval: { startsAt: '2026-03-02T05:00:00.000Z', endsAt: '2026-03-02T07:00:00.000Z' },
        sourceCommitmentId: 'commitment-RAWTEXT',
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
        eventId: 'e-RAWTEXT-1',
        interval: { startsAt: '2026-03-02T21:00:00.000Z', endsAt: '2026-03-02T22:00:00.000Z' },
        sourceCommitmentId: 'commitment-RAWTEXT',
        blocking: true,
      },
      {
        eventId: 'e-RAWTEXT-2',
        interval: { startsAt: '2026-03-02T21:30:00.000Z', endsAt: '2026-03-02T23:00:00.000Z' },
        sourceCommitmentId: 'commitment-RAWTEXT',
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
    eventId: `e-RAWTEXT-${index}`,
    interval: { startsAt: '2026-03-02T04:00:00.000Z', endsAt: '2026-03-02T23:00:00.000Z' },
    sourceCommitmentId: 'commitment-RAWTEXT',
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
      { windowId: 'w-RAWTEXT-early', weekday: 0, startMinute: 150, endMinute: 360, timezone: 'America/New_York' },
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
      { windowId: 'w-RAWTEXT-ny', weekday: 0, startMinute: 150, endMinute: 360, timezone: 'America/New_York' },
      { windowId: 'w-RAWTEXT-jlm', weekday: 5, startMinute: 150, endMinute: 480, timezone: 'Asia/Jerusalem' },
    ],
  }));
  assert.deepEqual(codes(reasons), ['NONEXISTENT_LOCAL_TIME']);
  assert.equal(reasons.length, 2);
});

test('NONEXISTENT_LOCAL_TIME is not raised for a gap the horizon never reaches', () => {
  // The merge-owned cross-track test's exact input, kept here at the level the
  // comparison is actually made at: this validator against #31's oracle. They
  // returned [NONEXISTENT_LOCAL_TIME, NO_WORKING_WINDOW] and [NO_WORKING_WINDOW]
  // on it, and the oracle was right — the gap is Sunday the 8th and the plan
  // opens on the 9th, so the anomalous occurrence has no bearing on it.
  //
  // The judgement lives in the normalizer, which is the only place that sees the
  // horizon and the window's nominal extent together. This validator reports
  // what it is handed, so this test guards the wiring as much as the rule.
  const reasons = validate(constraints({
    timezone: 'America/New_York',
    horizon: { startsAt: '2026-03-09T00:00:00.000Z', endsAt: '2026-03-10T00:00:00.000Z' },
    workingWindows: [
      { windowId: 'w-RAWTEXT-early', weekday: 0, startMinute: 120, endMinute: 360, timezone: 'America/New_York' },
    ],
  }));
  assert.deepEqual(codes(reasons), ['NO_WORKING_WINDOW']);
});

test('a window that merely spans a transition is not anomalous, only shorter', () => {
  assert.deepEqual(validate(constraints({
    horizon: { startsAt: '2026-03-07T00:00:00.000Z', endsAt: '2026-03-10T00:00:00.000Z' },
    workingWindows: [
      { windowId: 'w-RAWTEXT-early', weekday: 0, startMinute: 60, endMinute: 300, timezone: 'America/New_York' },
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
      { windowId: 'w-RAWTEXT-early', weekday: 0, startMinute: 60, endMinute: 180, timezone: 'America/New_York' },
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
        { windowId: 'w-RAWTEXT-early', weekday: 0, startMinute: 60, endMinute: 180, timezone: 'America/New_York' },
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

test('no detail anywhere in this file repeats user-chosen text', () => {
  // Swept over every fixture the file validated, not over one. The earlier
  // version built a single fixture and inspected its findings — which yielded
  // three codes out of thirteen, so a leak added to FIXED_EVENT_CONFLICT,
  // NO_WORKING_WINDOW, NONEXISTENT_LOCAL_TIME, CYCLIC_DEPENDENCY or any of the
  // DEADLINE_* and EFFORT_* codes would have shipped green. A guard that covers
  // a quarter of the surface it names reports success exactly as loudly as one
  // that covers all of it.
  //
  // Every windowId, eventId, title, scopeId and sourceCommitmentId in this file
  // carries the marker, so one substring test covers all of them with no risk of
  // a coincidental match. `itemId` is deliberately not marked: the contract
  // carries it in its own field, and this rule is about the prose.
  //
  // `detail` never carrying raw user text matches the policy Sprint 06 set for
  // `DecompositionViolation.detail`. Reasons travel with a plan and into audit
  // records, so the rule has to hold from the direction nobody inspects.
  const produced = new Set(validated.flatMap((reasons) => reasons.map((reason) => reason.code)));
  assert.deepEqual(
    STATIC_INFEASIBILITY_CODES.filter((code) => !produced.has(code)),
    [],
    'the sweep is only worth running if it has seen every code',
  );

  let inspected = 0;
  for (const reasons of validated) {
    for (const reason of reasons) {
      inspected += 1;
      assert.equal(
        reason.detail.includes(RAW_TEXT_MARKER),
        false,
        `${reason.code} detail repeats user-chosen text: ${reason.detail}`,
      );
    }
  }
  assert.ok(inspected > 100, `expected a substantial sweep, inspected ${inspected}`);
});
