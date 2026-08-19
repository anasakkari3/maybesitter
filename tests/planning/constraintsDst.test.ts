/**
 * Working windows across the two days a year the offset moves.
 *
 * Separated from `constraintsNormalize.test.ts` deliberately. A DST defect
 * shows up in one zone on one date and looks like a rounding error everywhere
 * else, so it is the failure most easily lost inside a large general suite —
 * and the sprint design names it as the thing that would otherwise be read
 * three different ways by three tracks.
 *
 * Every instant asserted below was read off this runtime's own tzdata before
 * being written down, and the first test re-derives the two transitions from
 * the shared primitive. A tzdata update that moves a transition therefore fails
 * here loudly, rather than moving a plan quietly.
 *
 * The four zones are chosen, not arbitrary:
 *
 *   America/New_York  a spring gap and a fall fold an hour long, on Sundays
 *   Asia/Jerusalem     transitions on different weekdays, and a fall-back whose
 *                      *local* date is the day after the UTC instant — the case
 *                      that catches a date computed in UTC
 *   Asia/Kolkata       +05:30 all year: the control. Any difference between its
 *                      March and November windows is a bug, not a transition.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type {
  PlanningConfig,
  PlanningHorizon,
  WorkingWindow,
} from '../../src/contracts/v1/planningContracts.ts';
import { intervalMinutes, resolveLocalTime } from '../../lib/planning/shared/time.ts';
import { normalizeWorkingWindows } from '../../lib/planning/constraints/index.ts';

const EARLIEST: PlanningConfig = { slotMinutes: 15, foldPolicy: 'earliest', resourceDependenciesOrder: false };
const LATEST: PlanningConfig = { ...EARLIEST, foldPolicy: 'latest' };

/** Contains exactly one Sunday: 2026-03-08, the US spring-forward date. */
const SPRING: PlanningHorizon = {
  startsAt: '2026-03-07T00:00:00.000Z',
  endsAt: '2026-03-10T00:00:00.000Z',
};
/** Contains exactly one Sunday: 2026-11-01, the US fall-back date. */
const FALL: PlanningHorizon = {
  startsAt: '2026-10-31T00:00:00.000Z',
  endsAt: '2026-11-03T00:00:00.000Z',
};

function window(overrides: Partial<WorkingWindow> = {}): WorkingWindow {
  return {
    windowId: 'w1',
    weekday: 0,
    startMinute: 60,
    endMinute: 300,
    timezone: 'America/New_York',
    ...overrides,
  };
}

function only(
  windows: readonly WorkingWindow[],
  horizon: PlanningHorizon,
  config: PlanningConfig = EARLIEST,
) {
  const normalized = normalizeWorkingWindows(windows, horizon, config);
  assert.equal(normalized.windows.length, 1, 'test setup: expected exactly one occurrence');
  return { occurrence: normalized.windows[0], anomalies: normalized.anomalies };
}

/* ── The transitions themselves ──────────────────────────────────── */

test('the transition instants these tests are built on are what the runtime believes', () => {
  // Re-derived rather than assumed. Every expectation below is a consequence of
  // these four facts, so if tzdata moves one, this fails first and says so
  // instead of a dozen duration assertions failing for no stated reason.
  assert.deepEqual(
    resolveLocalTime({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, 'America/New_York'),
    { kind: 'gap', resumesAt: '2026-03-08T07:00:00.000Z' },
  );
  assert.deepEqual(
    resolveLocalTime({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, 'America/New_York'),
    { kind: 'fold', firstInstant: '2026-11-01T05:30:00.000Z', secondInstant: '2026-11-01T06:30:00.000Z' },
  );
  assert.deepEqual(
    resolveLocalTime({ year: 2026, month: 3, day: 27, hour: 2, minute: 30 }, 'Asia/Jerusalem'),
    { kind: 'gap', resumesAt: '2026-03-27T00:00:00.000Z' },
  );
  assert.deepEqual(
    resolveLocalTime({ year: 2026, month: 10, day: 25, hour: 1, minute: 30 }, 'Asia/Jerusalem'),
    { kind: 'fold', firstInstant: '2026-10-24T22:30:00.000Z', secondInstant: '2026-10-24T23:30:00.000Z' },
  );
});

/* ── Spring forward: the day is shorter ──────────────────────────── */

test('a window spanning the spring transition is one hour shorter, with no anomaly', () => {
  // 01:00-05:00 is four hours on a wall clock and three on the timeline. Both
  // ends exist, so nothing is anomalous — the window is simply shorter, and an
  // implementation doing `start + (endMinute - startMinute)` would hand the
  // scheduler an hour that did not happen.
  const { occurrence, anomalies } = only([window({ startMinute: 60, endMinute: 300 })], SPRING);

  assert.deepEqual(occurrence.interval, {
    startsAt: '2026-03-08T06:00:00.000Z',
    endsAt: '2026-03-08T09:00:00.000Z',
  });
  assert.equal(intervalMinutes(occurrence.interval), 180);
  assert.deepEqual(anomalies, []);
});

test('a window starting inside the gap resumes at the transition and is reported', () => {
  // 02:30 is skipped. The user is available from the moment the clock resumes,
  // so the window starts at 03:00 local and is that much shorter. Dropping it
  // would remove availability the user has; keeping naive arithmetic would
  // place work at an instant that never occurred.
  const { occurrence, anomalies } = only([window({ startMinute: 150, endMinute: 360 })], SPRING);

  assert.deepEqual(occurrence.interval, {
    startsAt: '2026-03-08T07:00:00.000Z',
    endsAt: '2026-03-08T10:00:00.000Z',
  });
  assert.equal(occurrence.startKind, 'gap');
  assert.deepEqual(anomalies, [
    { windowId: 'w1', windowIndex: 0, localDate: '2026-03-08', boundary: 'start', kind: 'gap' },
  ]);
});

test('a window lying entirely inside the gap yields no time, and still says it was asked for', () => {
  // 02:00-02:59 names an hour that did not happen. Both ends resolve to the
  // transition, so the occurrence is empty and is dropped rather than kept as a
  // zero-length interval — which would satisfy every overlap check while
  // representing no time at all. The anomalies are what keeps the disappearance
  // visible instead of silent.
  const normalized = normalizeWorkingWindows([window({ startMinute: 120, endMinute: 179 })], SPRING, EARLIEST);

  assert.deepEqual(normalized.windows, []);
  assert.deepEqual(normalized.anomalies, [
    { windowId: 'w1', windowIndex: 0, localDate: '2026-03-08', boundary: 'start', kind: 'gap' },
    { windowId: 'w1', windowIndex: 0, localDate: '2026-03-08', boundary: 'end', kind: 'gap' },
  ]);
});

test('the whole of the spring-forward local day is 23 hours, not 24', () => {
  const { occurrence } = only([window({ startMinute: 0, endMinute: 1440 })], SPRING);

  assert.deepEqual(occurrence.interval, {
    startsAt: '2026-03-08T05:00:00.000Z',
    endsAt: '2026-03-09T04:00:00.000Z',
  });
  assert.equal(intervalMinutes(occurrence.interval), 23 * 60);
});

/* ── Fall back: the day is longer, and ambiguous ─────────────────── */

test('a fold at the start is resolved by the policy, and the two policies disagree by an hour', () => {
  const spec = window({ startMinute: 60, endMinute: 180 });

  const earliest = only([spec], FALL, EARLIEST);
  const latest = only([spec], FALL, LATEST);

  assert.deepEqual(earliest.occurrence.interval, {
    startsAt: '2026-11-01T05:00:00.000Z',
    endsAt: '2026-11-01T08:00:00.000Z',
  });
  assert.deepEqual(latest.occurrence.interval, {
    startsAt: '2026-11-01T06:00:00.000Z',
    endsAt: '2026-11-01T08:00:00.000Z',
  });
  // Three hours against two, from the same window and the same date. This is
  // why the policy lives in the config: two candidate answers 3.6 million
  // milliseconds apart, and a first-match-wins accident would pick one of them
  // per run without recording which.
  assert.equal(intervalMinutes(earliest.occurrence.interval), 180);
  assert.equal(intervalMinutes(latest.occurrence.interval), 120);
  assert.equal(earliest.occurrence.startKind, 'fold');
  assert.deepEqual(earliest.anomalies, [
    { windowId: 'w1', windowIndex: 0, localDate: '2026-11-01', boundary: 'start', kind: 'fold' },
  ]);
});

test('the fold policy applies to the end of a window too, not only the start', () => {
  // The deliberate consequence: `earliest` *lengthens* a window that starts in
  // a fold and *shortens* one that ends in a fold. Choosing per end so as to
  // always maximise the window was the tempting alternative, and it would make
  // one config value mean two different things depending on which end asked —
  // so no test of one end would constrain the other.
  const spec = window({ startMinute: 0, endMinute: 90 });

  assert.deepEqual(only([spec], FALL, EARLIEST).occurrence.interval, {
    startsAt: '2026-11-01T04:00:00.000Z',
    endsAt: '2026-11-01T05:30:00.000Z',
  });
  assert.deepEqual(only([spec], FALL, LATEST).occurrence.interval, {
    startsAt: '2026-11-01T04:00:00.000Z',
    endsAt: '2026-11-01T06:30:00.000Z',
  });
  assert.deepEqual(only([spec], FALL, EARLIEST).anomalies, [
    { windowId: 'w1', windowIndex: 0, localDate: '2026-11-01', boundary: 'end', kind: 'fold' },
  ]);
});

test('the whole of the fall-back local day is 25 hours, and neither end is ambiguous', () => {
  // Midnight is not folded, so a window from midnight to midnight names two
  // unambiguous instants and simply contains an extra hour between them.
  const { occurrence, anomalies } = only([window({ startMinute: 0, endMinute: 1440 })], FALL);

  assert.deepEqual(occurrence.interval, {
    startsAt: '2026-11-01T04:00:00.000Z',
    endsAt: '2026-11-02T05:00:00.000Z',
  });
  assert.equal(intervalMinutes(occurrence.interval), 25 * 60);
  assert.deepEqual(anomalies, []);
});

/* ── Asia/Jerusalem: a different weekday, and a local date UTC disagrees with ── */

test('Jerusalem spring forward: the gap is on a Friday and resumes at midnight UTC', () => {
  const jerusalem: PlanningHorizon = {
    startsAt: '2026-03-26T00:00:00.000Z',
    endsAt: '2026-03-29T00:00:00.000Z',
  };
  const { occurrence } = only(
    [window({ weekday: 5, startMinute: 150, endMinute: 480, timezone: 'Asia/Jerusalem' })],
    jerusalem,
  );

  assert.deepEqual(occurrence.interval, {
    startsAt: '2026-03-27T00:00:00.000Z',
    endsAt: '2026-03-27T05:00:00.000Z',
  });
  assert.equal(occurrence.startKind, 'gap');
  assert.equal(occurrence.localDate, '2026-03-27');
});

test('Jerusalem fall back: the occurrence begins on the UTC day before its own local date', () => {
  // The transition is at 2026-10-24T23:00Z and the folded local hour belongs to
  // Sunday 2026-10-25. With `earliest`, the window starts at 22:30Z on
  // *Saturday* the 24th. An implementation that read the local date off the
  // resulting instant in UTC would file this occurrence under Saturday and then
  // fail to match a window declared for Sunday at all.
  const jerusalem: PlanningHorizon = {
    startsAt: '2026-10-23T00:00:00.000Z',
    endsAt: '2026-10-27T00:00:00.000Z',
  };
  const spec = window({ weekday: 0, startMinute: 90, endMinute: 240, timezone: 'Asia/Jerusalem' });

  const earliest = only([spec], jerusalem, EARLIEST);
  assert.deepEqual(earliest.occurrence.interval, {
    startsAt: '2026-10-24T22:30:00.000Z',
    endsAt: '2026-10-25T02:00:00.000Z',
  });
  assert.equal(earliest.occurrence.localDate, '2026-10-25');
  assert.equal(earliest.occurrence.startKind, 'fold');

  assert.deepEqual(only([spec], jerusalem, LATEST).occurrence.interval, {
    startsAt: '2026-10-24T23:30:00.000Z',
    endsAt: '2026-10-25T02:00:00.000Z',
  });
});

/* ── An anomaly is only this plan's problem if it lands in this plan ── */

test('a transition anomaly on a date the horizon never reaches is not reported', () => {
  // The cross-track disagreement, reproduced. The spring gap is Sunday
  // 2026-03-08 and the horizon opens on the 9th, so the anomalous occurrence
  // falls wholly outside the plan. Reporting it sends the user to fix a window
  // that has no bearing on anything being planned — noise, not information, and
  // #31's oracle said so first.
  const horizon: PlanningHorizon = {
    startsAt: '2026-03-09T00:00:00.000Z',
    endsAt: '2026-03-10T00:00:00.000Z',
  };
  const normalized = normalizeWorkingWindows([window({ startMinute: 120, endMinute: 360 })], horizon, EARLIEST);

  assert.deepEqual(normalized.windows, []);
  assert.deepEqual(normalized.anomalies, []);
});

test('an occurrence the gap swallowed *inside* the horizon is still reported', () => {
  // The case the filter above must not swallow with it, and the reason the test
  // for it is written next to the test that motivated the filter.
  //
  // Both cases produce no materialised window, so "did anything survive?" cannot
  // separate them. What separates them is the *nominal* extent — where the
  // window would have sat had the offset not moved that day. Here that extent
  // is 02:00-02:59 local on a date the horizon covers, so the user really has
  // lost an hour they asked for and is told. Above, the nominal extent sits a
  // day before the plan opens.
  const horizon: PlanningHorizon = {
    startsAt: '2026-03-07T00:00:00.000Z',
    endsAt: '2026-03-10T00:00:00.000Z',
  };
  const normalized = normalizeWorkingWindows([window({ startMinute: 120, endMinute: 179 })], horizon, EARLIEST);

  assert.deepEqual(normalized.windows, []);
  assert.deepEqual(normalized.anomalies, [
    { windowId: 'w1', windowIndex: 0, localDate: '2026-03-08', boundary: 'start', kind: 'gap' },
    { windowId: 'w1', windowIndex: 0, localDate: '2026-03-08', boundary: 'end', kind: 'gap' },
  ]);
});

test('the horizon edge decides, not the surviving remnant: a shortened window still reports', () => {
  // A third case that would fall to a naive "did anything survive the clip"
  // filter from the other side. The occurrence starts in the gap and *does*
  // survive, but only a sliver of it is inside the horizon. The anomaly is real
  // and inside the plan, so it is reported — the filter asks where the window
  // was asked for, not how much of it is left.
  const horizon: PlanningHorizon = {
    startsAt: '2026-03-08T09:30:00.000Z',
    endsAt: '2026-03-10T00:00:00.000Z',
  };
  const normalized = normalizeWorkingWindows([window({ startMinute: 150, endMinute: 360 })], horizon, EARLIEST);

  assert.deepEqual(normalized.windows.map((materialized) => materialized.interval), [
    { startsAt: '2026-03-08T09:30:00.000Z', endsAt: '2026-03-08T10:00:00.000Z' },
  ]);
  assert.equal(normalized.anomalies.length, 1);
  assert.equal(normalized.anomalies[0].kind, 'gap');
});

/* ── An occurrence that outlives its own local date ──────────────── */

test('an occurrence running past local midnight is found when the horizon starts inside it', () => {
  // America/Havana ends DST at 01:00 local, so local *midnight* is the folded
  // hour — 2026-11-01T00:00 local is both 04:00Z and 05:00Z. A Saturday window
  // running to `endMinute: 1440` under `latest` therefore ends at 05:00Z on
  // Sunday, an hour into the following local date.
  //
  // The scan enumerates local dates from the one containing `horizon.startsAt`,
  // and a horizon opening at 04:30Z on Sunday sits *inside* that Saturday
  // occurrence while its own local date is already Sunday. Anchoring the scan on
  // the horizon's local date alone missed the occurrence entirely and reported
  // no availability at all. Scanning from one calendar day earlier and letting
  // the clip decide is what makes the two agree.
  const horizon: PlanningHorizon = {
    startsAt: '2026-11-01T04:30:00.000Z',
    endsAt: '2026-11-03T00:00:00.000Z',
  };
  const saturday = window({ weekday: 6, startMinute: 0, endMinute: 1440, timezone: 'America/Havana' });

  const normalized = normalizeWorkingWindows([saturday], horizon, LATEST);
  assert.deepEqual(normalized.windows.map((materialized) => materialized.interval), [
    { startsAt: '2026-11-01T04:30:00.000Z', endsAt: '2026-11-01T05:00:00.000Z' },
  ]);
  // Filed under the local date the window was declared for, not the one its
  // surviving half happens to fall in.
  assert.equal(normalized.windows[0].localDate, '2026-10-31');
  assert.equal(normalized.windows[0].clippedToHorizon, true);
});

test('scanning a day earlier does not invent an occurrence that ends before the horizon', () => {
  // The other half of the fix. Reaching back one local date must not admit a
  // window that finished before the plan begins — the clip is what decides, and
  // a clip that let an earlier day through would hand #30 time already past.
  const horizon: PlanningHorizon = {
    startsAt: '2026-11-01T06:00:00.000Z',
    endsAt: '2026-11-03T00:00:00.000Z',
  };
  const saturday = window({ weekday: 6, startMinute: 0, endMinute: 1440, timezone: 'America/Havana' });
  assert.deepEqual(normalizeWorkingWindows([saturday], horizon, LATEST).windows, []);
});

/* ── The control ─────────────────────────────────────────────────── */

test('Asia/Kolkata has no transition, so the same window is 480 minutes in March and November', () => {
  // The control for every assertion above. A normalizer that mishandled offsets
  // in general — rather than at transitions — would move this window too, and
  // there would be nothing in the DST fixtures to say the difference was not a
  // transition.
  const spec = window({ startMinute: 540, endMinute: 1020, timezone: 'Asia/Kolkata' });

  const march = only([spec], SPRING);
  const november = only([spec], FALL);

  assert.deepEqual(march.occurrence.interval, {
    startsAt: '2026-03-08T03:30:00.000Z',
    endsAt: '2026-03-08T11:30:00.000Z',
  });
  assert.deepEqual(november.occurrence.interval, {
    startsAt: '2026-11-01T03:30:00.000Z',
    endsAt: '2026-11-01T11:30:00.000Z',
  });
  assert.equal(intervalMinutes(march.occurrence.interval), 480);
  assert.equal(intervalMinutes(november.occurrence.interval), 480);
  assert.deepEqual(march.anomalies, []);
  assert.deepEqual(november.anomalies, []);
});

test('the fold policy changes nothing in a zone that has no fold', () => {
  const spec = window({ startMinute: 540, endMinute: 1020, timezone: 'Asia/Kolkata' });
  assert.deepEqual(
    normalizeWorkingWindows([spec], FALL, EARLIEST),
    normalizeWorkingWindows([spec], FALL, LATEST),
  );
});
