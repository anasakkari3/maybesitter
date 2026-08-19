/**
 * Materialising wall-clock working windows into absolute intervals.
 *
 * This file covers the ordinary arithmetic — recurrence, clipping, midnight,
 * malformed input, free runs. The two days a year the arithmetic changes shape
 * live in `constraintsDst.test.ts`, which is a separate file because a DST bug
 * that only shows up in one zone on one date is exactly the kind of failure
 * that gets lost inside a large general suite.
 *
 * Every zone used here is `Asia/Kolkata` unless a test says otherwise. It is
 * +05:30 year-round, so a difference between two runs in this file is never a
 * transition and always the code under test. It is also a half-hour offset,
 * which catches an implementation that assumes whole hours — the assumption is
 * invisible in a UTC or a New York fixture.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type {
  FixedEvent,
  PlanningConfig,
  PlanningHorizon,
  WorkingWindow,
} from '../../src/contracts/v1/planningContracts.ts';
import {
  freeRunsWithin,
  isKnownTimeZone,
  isMaterialisableWindow,
  mergeIntervals,
  normalizeWorkingWindows,
} from '../../lib/planning/constraints/index.ts';

const CONFIG: PlanningConfig = {
  slotMinutes: 15,
  foldPolicy: 'earliest',
  resourceDependenciesOrder: false,
};

/** A fortnight of March 2026. Contains three Mondays: 02, 09 and 16. */
const HORIZON: PlanningHorizon = {
  startsAt: '2026-03-02T00:00:00.000Z',
  endsAt: '2026-03-16T00:00:00.000Z',
};

/**
 * The same fortnight, widened by a day at each end.
 *
 * Used by the tests below that are about *where a local day begins*, so that
 * nothing they assert is also being clipped. A Kolkata local day starts at
 * 18:30Z the previous UTC day, so a window near local midnight straddles the
 * edge of `HORIZON` and the clip would mask the very thing under test.
 */
const WIDE_HORIZON: PlanningHorizon = {
  startsAt: '2026-02-28T00:00:00.000Z',
  endsAt: '2026-03-15T00:00:00.000Z',
};

function window(overrides: Partial<WorkingWindow> = {}): WorkingWindow {
  return {
    windowId: 'w1',
    weekday: 1,
    startMinute: 9 * 60,
    endMinute: 17 * 60,
    timezone: 'Asia/Kolkata',
    ...overrides,
  };
}

function fixedEvent(overrides: Partial<FixedEvent> = {}): FixedEvent {
  return {
    eventId: 'e1',
    interval: { startsAt: '2026-03-02T05:30:00.000Z', endsAt: '2026-03-02T06:30:00.000Z' },
    sourceCommitmentId: null,
    blocking: true,
    ...overrides,
  };
}

const intervals = (normalized: { windows: readonly { interval: unknown }[] }) =>
  normalized.windows.map((materialized) => materialized.interval);

/* ── Recurrence ──────────────────────────────────────────────────── */

test('a weekly window recurs once per matching local date inside the horizon', () => {
  const normalized = normalizeWorkingWindows([window()], HORIZON, CONFIG);

  // 09:00-17:00 in +05:30 is 03:30Z-11:30Z. The third Monday, 2026-03-16, is
  // outside the half-open horizon: its window starts after `endsAt`.
  assert.deepEqual(intervals(normalized), [
    { startsAt: '2026-03-02T03:30:00.000Z', endsAt: '2026-03-02T11:30:00.000Z' },
    { startsAt: '2026-03-09T03:30:00.000Z', endsAt: '2026-03-09T11:30:00.000Z' },
  ]);
  assert.deepEqual(normalized.anomalies, []);
  assert.deepEqual(normalized.malformedWindowIndices, []);
});

test('each occurrence carries the local date it belongs to, not the UTC one', () => {
  // 21:00-23:00 in +05:30 is 15:30Z-17:30Z the same UTC day, but a window that
  // straddles UTC midnight would report the wrong day if the local date were
  // read off the instant in UTC. Monday 23:00 IST is Monday 17:30Z; Monday
  // 05:00 IST is *Sunday* 23:30Z, which is the case that separates the two.
  const early = window({ startMinute: 5 * 60, endMinute: 7 * 60 });
  const normalized = normalizeWorkingWindows([early], WIDE_HORIZON, CONFIG);

  assert.deepEqual(
    normalized.windows.map((materialized) => [materialized.localDate, materialized.interval.startsAt]),
    [
      ['2026-03-02', '2026-03-01T23:30:00.000Z'],
      ['2026-03-09', '2026-03-08T23:30:00.000Z'],
    ],
  );
});

test('a weekday that never occurs in the horizon materialises nothing', () => {
  const narrow: PlanningHorizon = {
    startsAt: '2026-03-02T00:00:00.000Z',
    endsAt: '2026-03-04T00:00:00.000Z',
  };
  // Saturday, in a horizon covering Monday and Tuesday.
  assert.deepEqual(normalizeWorkingWindows([window({ weekday: 6 })], narrow, CONFIG).windows, []);
});

test('occurrences are ordered by start instant, then by windowId, whatever the input order', () => {
  const later = window({ windowId: 'w-late', startMinute: 14 * 60, endMinute: 16 * 60 });
  const sameStart = window({ windowId: 'a-window' });

  const normalized = normalizeWorkingWindows([later, window(), sameStart], HORIZON, CONFIG);
  assert.deepEqual(
    normalized.windows.map((materialized) => [materialized.windowId, materialized.interval.startsAt]),
    [
      ['a-window', '2026-03-02T03:30:00.000Z'],
      ['w1', '2026-03-02T03:30:00.000Z'],
      ['w-late', '2026-03-02T08:30:00.000Z'],
      ['a-window', '2026-03-09T03:30:00.000Z'],
      ['w1', '2026-03-09T03:30:00.000Z'],
      ['w-late', '2026-03-09T08:30:00.000Z'],
    ],
  );
});

/* ── Midnight ────────────────────────────────────────────────────── */

test('endMinute 1440 ends at local midnight of the following day, not of the same one', () => {
  const evening = window({ startMinute: 20 * 60, endMinute: 1440 });
  const normalized = normalizeWorkingWindows([evening], HORIZON, CONFIG);

  // Monday 20:00 IST is 14:30Z; midnight ending Monday is Tuesday 00:00 IST,
  // which is 18:30Z. Reading 1440 as minute 0 of the same day would produce a
  // window ending before it began — and `INVALID_INTERVAL` would then be
  // reported about a window the user stated perfectly correctly.
  assert.deepEqual(intervals(normalized)[0], {
    startsAt: '2026-03-02T14:30:00.000Z',
    endsAt: '2026-03-02T18:30:00.000Z',
  });
});

test('a window covering the whole local day is 1440 minutes, from midnight to midnight', () => {
  const wholeDay = window({ startMinute: 0, endMinute: 1440 });
  const normalized = normalizeWorkingWindows([wholeDay], WIDE_HORIZON, CONFIG);

  assert.deepEqual(intervals(normalized), [
    { startsAt: '2026-03-01T18:30:00.000Z', endsAt: '2026-03-02T18:30:00.000Z' },
    { startsAt: '2026-03-08T18:30:00.000Z', endsAt: '2026-03-09T18:30:00.000Z' },
  ]);
});

/* ── Horizon clipping ────────────────────────────────────────────── */

test('the horizon clips both edges and never extends a window past them', () => {
  const clipped: PlanningHorizon = {
    startsAt: '2026-03-02T06:00:00.000Z',
    endsAt: '2026-03-09T06:00:00.000Z',
  };
  const normalized = normalizeWorkingWindows([window()], clipped, CONFIG);

  assert.deepEqual(intervals(normalized), [
    { startsAt: '2026-03-02T06:00:00.000Z', endsAt: '2026-03-02T11:30:00.000Z' },
    { startsAt: '2026-03-09T03:30:00.000Z', endsAt: '2026-03-09T06:00:00.000Z' },
  ]);
  assert.deepEqual(normalized.windows.map((materialized) => materialized.clippedToHorizon), [true, true]);
});

test('a window abutting the horizon end is dropped, because the end instant is excluded', () => {
  // The Monday window is 03:30Z-11:30Z; a horizon ending at exactly 03:30Z
  // shares one instant with it and contains none of it.
  const abutting: PlanningHorizon = {
    startsAt: '2026-03-01T00:00:00.000Z',
    endsAt: '2026-03-02T03:30:00.000Z',
  };
  assert.deepEqual(normalizeWorkingWindows([window()], abutting, CONFIG).windows, []);
});

test('a horizon that is not a positive interval materialises nothing rather than throwing', () => {
  // Reporting the bad horizon is `INVALID_INTERVAL`'s job, done once by the
  // validator. A normalizer that also threw would give two answers to "is this
  // input usable" depending on which caller asked first.
  const inverted: PlanningHorizon = {
    startsAt: '2026-03-09T00:00:00.000Z',
    endsAt: '2026-03-02T00:00:00.000Z',
  };
  assert.deepEqual(normalizeWorkingWindows([window()], inverted, CONFIG).windows, []);
});

/* ── Malformed windows ───────────────────────────────────────────── */

test('a window with endMinute <= startMinute is skipped and reported by index', () => {
  const wrapping = window({ windowId: 'w-overnight', startMinute: 22 * 60, endMinute: 6 * 60 });
  const normalized = normalizeWorkingWindows([window(), wrapping], HORIZON, CONFIG);

  // It does not wrap to the next day: the contract says overnight availability
  // is two windows. Materialising it as a wrap would silently invent a window
  // on a weekday the user did not name.
  assert.deepEqual(normalized.malformedWindowIndices, [1]);
  assert.deepEqual(
    normalized.windows.map((materialized) => materialized.windowId),
    ['w1', 'w1'],
  );
});

test('a zero-length window is malformed, not an empty success', () => {
  const zero = window({ startMinute: 540, endMinute: 540 });
  assert.deepEqual(normalizeWorkingWindows([zero], HORIZON, CONFIG).malformedWindowIndices, [0]);
});

test('minutes outside 0..1440, or not whole, are malformed', () => {
  const cases: Partial<WorkingWindow>[] = [
    { startMinute: -30, endMinute: 600 },
    { startMinute: 600, endMinute: 1441 },
    { startMinute: 9.5, endMinute: 600 },
    { startMinute: 600, endMinute: Number.NaN },
  ];
  for (const overrides of cases) {
    const normalized = normalizeWorkingWindows([window(overrides)], HORIZON, CONFIG);
    assert.deepEqual(normalized.malformedWindowIndices, [0], JSON.stringify(overrides));
    assert.deepEqual(normalized.windows, [], JSON.stringify(overrides));
  }
});

test('a weekday outside 0..6 is malformed rather than silently matching nothing', () => {
  // Silently matching nothing is indistinguishable from "the horizon contained
  // no such day", so a typo would read as a legitimately empty week.
  const normalized = normalizeWorkingWindows([window({ weekday: 9 as WorkingWindow['weekday'] })], HORIZON, CONFIG);
  assert.deepEqual(normalized.malformedWindowIndices, [0]);
});

test('an unknown IANA zone is malformed rather than resolving as UTC', () => {
  // `Intl` throws on an unknown zone, and the shared offset reader would have
  // to swallow it. Falling back to UTC would place a Kolkata user's morning
  // five and a half hours from where they said it was, and nothing downstream
  // could tell that had happened.
  const normalized = normalizeWorkingWindows([window({ timezone: 'Mars/Olympus_Mons' })], HORIZON, CONFIG);
  assert.deepEqual(normalized.malformedWindowIndices, [0]);
  assert.deepEqual(normalized.windows, []);
});

/* ── Free runs ───────────────────────────────────────────────────── */

test('blocking fixed events are subtracted from the materialised windows', () => {
  const normalized = normalizeWorkingWindows([window()], HORIZON, CONFIG);
  const meeting = fixedEvent({
    interval: { startsAt: '2026-03-02T06:00:00.000Z', endsAt: '2026-03-02T07:00:00.000Z' },
  });

  assert.deepEqual(freeRunsWithin(normalized.windows, [meeting]), [
    { startsAt: '2026-03-02T03:30:00.000Z', endsAt: '2026-03-02T06:00:00.000Z' },
    { startsAt: '2026-03-02T07:00:00.000Z', endsAt: '2026-03-02T11:30:00.000Z' },
    { startsAt: '2026-03-09T03:30:00.000Z', endsAt: '2026-03-09T11:30:00.000Z' },
  ]);
});

test('a non-blocking fixed event is not subtracted', () => {
  const normalized = normalizeWorkingWindows([window()], HORIZON, CONFIG);
  const soft = fixedEvent({
    blocking: false,
    interval: { startsAt: '2026-03-02T06:00:00.000Z', endsAt: '2026-03-02T07:00:00.000Z' },
  });

  assert.deepEqual(freeRunsWithin(normalized.windows, [soft]), [
    { startsAt: '2026-03-02T03:30:00.000Z', endsAt: '2026-03-02T11:30:00.000Z' },
    { startsAt: '2026-03-09T03:30:00.000Z', endsAt: '2026-03-09T11:30:00.000Z' },
  ]);
});

test('an event abutting a window removes nothing, because end instants are excluded', () => {
  const normalized = normalizeWorkingWindows([window()], HORIZON, CONFIG);
  const abutting = fixedEvent({
    interval: { startsAt: '2026-03-02T02:30:00.000Z', endsAt: '2026-03-02T03:30:00.000Z' },
  });

  assert.deepEqual(freeRunsWithin(normalized.windows, [abutting])[0], {
    startsAt: '2026-03-02T03:30:00.000Z',
    endsAt: '2026-03-02T11:30:00.000Z',
  });
});

test('overlapping windows are counted once, not twice', () => {
  // Two windows describing the same availability are one stretch of time. A
  // free-run list that returned it twice would let a capacity count claim
  // hours the user does not have — and every interval in it would still be
  // individually correct, so no per-interval assertion would notice.
  const early = window({ windowId: 'w-early', startMinute: 9 * 60, endMinute: 13 * 60 });
  const late = window({ windowId: 'w-late', startMinute: 11 * 60, endMinute: 17 * 60 });
  const normalized = normalizeWorkingWindows([early, late], HORIZON, CONFIG);

  assert.deepEqual(freeRunsWithin(normalized.windows, [])[0], {
    startsAt: '2026-03-02T03:30:00.000Z',
    endsAt: '2026-03-02T11:30:00.000Z',
  });
});

test('a fixed event outside every window leaves the free runs untouched', () => {
  const normalized = normalizeWorkingWindows([window()], HORIZON, CONFIG);
  const overnight = fixedEvent({
    interval: { startsAt: '2026-03-02T20:00:00.000Z', endsAt: '2026-03-02T21:00:00.000Z' },
  });
  assert.deepEqual(freeRunsWithin(normalized.windows, [overnight]), intervals(normalized));
});

test('a degenerate fixed event subtracts nothing, rather than splitting a window in two', () => {
  const normalized = normalizeWorkingWindows([window()], HORIZON, CONFIG);
  const degenerate = fixedEvent({
    interval: { startsAt: '2026-03-02T06:00:00.000Z', endsAt: '2026-03-02T06:00:00.000Z' },
  });
  assert.deepEqual(freeRunsWithin(normalized.windows, [degenerate])[0], {
    startsAt: '2026-03-02T03:30:00.000Z',
    endsAt: '2026-03-02T11:30:00.000Z',
  });
});

test('mergeIntervals joins overlapping and abutting runs and orders the result', () => {
  // Abutting runs are merged even though they do not *overlap*: [09,10) and
  // [10,11) are one continuous stretch of available time, and leaving them
  // apart would make a 90-minute task unplaceable inside two free hours.
  assert.deepEqual(
    mergeIntervals([
      { startsAt: '2026-03-02T10:00:00.000Z', endsAt: '2026-03-02T11:00:00.000Z' },
      { startsAt: '2026-03-02T09:00:00.000Z', endsAt: '2026-03-02T10:00:00.000Z' },
      { startsAt: '2026-03-02T13:00:00.000Z', endsAt: '2026-03-02T14:00:00.000Z' },
      { startsAt: '2026-03-02T09:30:00.000Z', endsAt: '2026-03-02T09:45:00.000Z' },
    ]),
    [
      { startsAt: '2026-03-02T09:00:00.000Z', endsAt: '2026-03-02T11:00:00.000Z' },
      { startsAt: '2026-03-02T13:00:00.000Z', endsAt: '2026-03-02T14:00:00.000Z' },
    ],
  );
});

test('normalizing is a pure function of its arguments: two runs agree exactly', () => {
  const first = normalizeWorkingWindows([window(), window({ windowId: 'w2', weekday: 3 })], HORIZON, CONFIG);
  const second = normalizeWorkingWindows([window(), window({ windowId: 'w2', weekday: 3 })], HORIZON, CONFIG);
  assert.deepEqual(first, second);
});

/* ── The exported validity predicate ─────────────────────────────── */

test('isMaterialisableWindow is the same rule the normalizer applies, not a second one', () => {
  // Exported so #31 imports it instead of keeping its own copy: a predicate is
  // data, and two copies of data drift. This test pins the two to each other, so
  // the export cannot quietly diverge from what the normalizer actually does —
  // which is the only way the shared-predicate arrangement could fail while both
  // sides stayed green.
  const cases: Partial<WorkingWindow>[] = [
    {},
    { weekday: 9 as WorkingWindow['weekday'] },
    { weekday: -1 as WorkingWindow['weekday'] },
    { startMinute: -30 },
    { endMinute: 1441 },
    { startMinute: 9.5 },
    { endMinute: Number.NaN },
    { startMinute: 600, endMinute: 60 },
    { startMinute: 540, endMinute: 540 },
    { timezone: 'Mars/Olympus_Mons' },
    { startMinute: 0, endMinute: 1440 },
  ];

  for (const overrides of cases) {
    const candidate = window(overrides);
    const normalized = normalizeWorkingWindows([candidate], HORIZON, CONFIG);
    const rejectedByNormalizer = normalized.malformedWindowIndices.includes(0);
    assert.equal(
      isMaterialisableWindow(candidate),
      !rejectedByNormalizer,
      `predicate and normalizer disagree on ${JSON.stringify(overrides)}`,
    );
  }
});

test('isKnownTimeZone answers the same way twice, memo or no memo', () => {
  // The memo is keyed on a caller-supplied string, so it is worth one assertion
  // that it caches the answer rather than the question.
  for (const zone of ['Asia/Kolkata', 'America/New_York', 'UTC']) {
    assert.equal(isKnownTimeZone(zone), true, zone);
    assert.equal(isKnownTimeZone(zone), true, `${zone} on the second call`);
  }
  for (const zone of ['Mars/Olympus_Mons', '', 'Not/A/Zone']) {
    assert.equal(isKnownTimeZone(zone), false, zone);
    assert.equal(isKnownTimeZone(zone), false, `${zone} on the second call`);
  }
});
