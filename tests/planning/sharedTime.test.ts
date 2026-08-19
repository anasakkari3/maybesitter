/**
 * The Sprint 07 time primitives, tested at the boundaries the sprint turns on.
 *
 * This file is owned by the sprint base rather than by a track, for the same
 * reason Sprint 05 gave the policy-freeze test to the merge: these functions
 * are the one thing all three tracks share, so a track that owned their tests
 * could relax them to suit itself and the other two would inherit the change
 * without review.
 *
 * The DST instants asserted below are not hand-computed. They were read off the
 * runtime's own tzdata before being written down, and the transition-bracket
 * tests re-derive them, so a tzdata update that moves a transition fails here
 * loudly rather than moving a plan quietly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addMinutes,
  instantFromResolution,
  intersectIntervals,
  intervalMinutes,
  intervalsOverlap,
  isPositiveInterval,
  minutesBetween,
  nominalInstantBracket,
  resolveLocalTime,
  subtractIntervals,
  toEpochMs,
  toInstant,
  wallClockAt,
  weekdayAt,
  zoneOffsetMs,
} from '../../lib/planning/shared/time.ts';

/* ── Half-open intervals: the sprint's central convention ────────── */

test('abutting intervals do not overlap, because end instants are excluded', () => {
  const morning = { startsAt: '2026-11-09T09:00:00.000Z', endsAt: '2026-11-09T10:00:00.000Z' };
  const next = { startsAt: '2026-11-09T10:00:00.000Z', endsAt: '2026-11-09T11:00:00.000Z' };

  assert.equal(intervalsOverlap(morning, next), false);
  assert.equal(intervalsOverlap(next, morning), false, 'overlap must be symmetric');
});

test('intervals sharing any interior instant overlap, in both argument orders', () => {
  const a = { startsAt: '2026-11-09T09:00:00.000Z', endsAt: '2026-11-09T10:00:00.000Z' };
  const b = { startsAt: '2026-11-09T09:59:00.000Z', endsAt: '2026-11-09T11:00:00.000Z' };

  assert.equal(intervalsOverlap(a, b), true);
  assert.equal(intervalsOverlap(b, a), true);
});

test('a zero-length interval is not positive and overlaps nothing, including itself', () => {
  const degenerate = { startsAt: '2026-11-09T09:00:00.000Z', endsAt: '2026-11-09T09:00:00.000Z' };
  const containing = { startsAt: '2026-11-09T08:00:00.000Z', endsAt: '2026-11-09T10:00:00.000Z' };

  assert.equal(isPositiveInterval(degenerate), false);
  // The reason INVALID_INTERVAL exists: a zero-length interval sits inside a
  // window and still collides with nothing, so no conflict assertion can see it.
  assert.equal(intervalsOverlap(degenerate, containing), false);
  assert.equal(intervalsOverlap(degenerate, degenerate), false);
});

test('intersect returns null for abutting intervals rather than a zero-length one', () => {
  const a = { startsAt: '2026-11-09T09:00:00.000Z', endsAt: '2026-11-09T10:00:00.000Z' };
  const b = { startsAt: '2026-11-09T10:00:00.000Z', endsAt: '2026-11-09T11:00:00.000Z' };
  assert.equal(intersectIntervals(a, b), null);
});

test('subtracting meetings from a window leaves the free runs, disjoint and ordered', () => {
  const window = { startsAt: '2026-11-09T09:00:00.000Z', endsAt: '2026-11-09T17:00:00.000Z' };
  const cuts = [
    { startsAt: '2026-11-09T13:00:00.000Z', endsAt: '2026-11-09T14:00:00.000Z' },
    { startsAt: '2026-11-09T10:00:00.000Z', endsAt: '2026-11-09T11:00:00.000Z' },
  ];

  assert.deepEqual(subtractIntervals(window, cuts), [
    { startsAt: '2026-11-09T09:00:00.000Z', endsAt: '2026-11-09T10:00:00.000Z' },
    { startsAt: '2026-11-09T11:00:00.000Z', endsAt: '2026-11-09T13:00:00.000Z' },
    { startsAt: '2026-11-09T14:00:00.000Z', endsAt: '2026-11-09T17:00:00.000Z' },
  ]);
});

test('overlapping and adjacent cuts collapse instead of producing slivers', () => {
  const window = { startsAt: '2026-11-09T09:00:00.000Z', endsAt: '2026-11-09T17:00:00.000Z' };
  const cuts = [
    { startsAt: '2026-11-09T10:00:00.000Z', endsAt: '2026-11-09T12:00:00.000Z' },
    { startsAt: '2026-11-09T11:00:00.000Z', endsAt: '2026-11-09T13:00:00.000Z' },
    { startsAt: '2026-11-09T13:00:00.000Z', endsAt: '2026-11-09T14:00:00.000Z' },
  ];

  const free = subtractIntervals(window, cuts);
  assert.deepEqual(free, [
    { startsAt: '2026-11-09T09:00:00.000Z', endsAt: '2026-11-09T10:00:00.000Z' },
    { startsAt: '2026-11-09T14:00:00.000Z', endsAt: '2026-11-09T17:00:00.000Z' },
  ]);
  assert.ok(free.every(isPositiveInterval), 'no zero-length remnants may be returned');
});

test('a cut covering the whole window leaves nothing', () => {
  const window = { startsAt: '2026-11-09T09:00:00.000Z', endsAt: '2026-11-09T17:00:00.000Z' };
  assert.deepEqual(subtractIntervals(window, [window]), []);
});

test('cuts outside the window do not extend or shorten it', () => {
  const window = { startsAt: '2026-11-09T09:00:00.000Z', endsAt: '2026-11-09T17:00:00.000Z' };
  const cuts = [
    { startsAt: '2026-11-09T06:00:00.000Z', endsAt: '2026-11-09T08:00:00.000Z' },
    { startsAt: '2026-11-09T18:00:00.000Z', endsAt: '2026-11-09T20:00:00.000Z' },
  ];
  assert.deepEqual(subtractIntervals(window, cuts), [window]);
});

/* ── Instants ────────────────────────────────────────────────────── */

test('an unparseable instant throws instead of becoming NaN', () => {
  // NaN compares false against everything, so a bad instant would read as
  // "does not conflict" rather than as an error.
  assert.throws(() => toEpochMs('next tuesday'), TypeError);
  assert.throws(() => toInstant(Number.NaN), TypeError);
});

test('instant round-trips are exact and arithmetic is in minutes', () => {
  const start = '2026-11-09T09:00:00.000Z';
  assert.equal(toInstant(toEpochMs(start)), start);
  assert.equal(addMinutes(start, 90), '2026-11-09T10:30:00.000Z');
  assert.equal(minutesBetween(start, '2026-11-09T10:30:00.000Z'), 90);
  assert.equal(intervalMinutes({ startsAt: start, endsAt: '2026-11-09T17:00:00.000Z' }), 480);
});

/* ── Zone offsets ────────────────────────────────────────────────── */

test('a bare "GMT" offset reads as zero rather than failing to parse', () => {
  assert.equal(zoneOffsetMs(Date.UTC(2026, 5, 1), 'UTC'), 0);
});

test('a half-hour zone is read to the minute, not rounded to an hour', () => {
  // Asia/Kolkata is +05:30 year-round. An hours-only parse would report +05:00
  // and every window in the zone would be placed thirty minutes early.
  assert.equal(zoneOffsetMs(Date.UTC(2026, 5, 1), 'Asia/Kolkata'), 5.5 * 3_600_000);
});

test('wall-clock and weekday readings follow the zone, not the host', () => {
  const instant = Date.UTC(2026, 10, 9, 2, 30); // 2026-11-09T02:30Z, a Monday in UTC
  assert.deepEqual(wallClockAt(instant, 'UTC'), { year: 2026, month: 11, day: 9, hour: 2, minute: 30 });
  // 02:30Z is 21:30 the previous day in New York — a different date and weekday.
  assert.deepEqual(wallClockAt(instant, 'America/New_York'), { year: 2026, month: 11, day: 8, hour: 21, minute: 30 });
  assert.equal(weekdayAt(instant, 'UTC'), 1, 'Monday');
  assert.equal(weekdayAt(instant, 'America/New_York'), 0, 'still Sunday in New York');
});

/* ── DST: the two days a year a local time is not a time ─────────── */

test('an ordinary local time resolves to exactly one instant', () => {
  const resolved = resolveLocalTime({ year: 2026, month: 11, day: 9, hour: 9, minute: 0 }, 'America/New_York');
  assert.equal(resolved.kind, 'exact');
  assert.equal(resolved.kind === 'exact' && resolved.instant, '2026-11-09T14:00:00.000Z');
});

test('spring forward: a skipped local time is a gap, and names where the clock resumes', () => {
  // New York moves 02:00 EST to 03:00 EDT at 2026-03-08T07:00Z. 02:30 never occurs.
  const resolved = resolveLocalTime({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, 'America/New_York');
  assert.equal(resolved.kind, 'gap');
  assert.equal(resolved.kind === 'gap' && resolved.resumesAt, '2026-03-08T07:00:00.000Z');
  assert.equal(instantFromResolution(resolved, 'earliest'), null, 'a gap has no instant to pick');
});

test('the gap boundary is exact: 01:59 exists, 02:00 does not, 03:00 does', () => {
  const day = { year: 2026, month: 3, day: 8 };
  assert.equal(resolveLocalTime({ ...day, hour: 1, minute: 59 }, 'America/New_York').kind, 'exact');
  assert.equal(resolveLocalTime({ ...day, hour: 2, minute: 0 }, 'America/New_York').kind, 'gap');
  assert.equal(resolveLocalTime({ ...day, hour: 2, minute: 59 }, 'America/New_York').kind, 'gap');
  assert.equal(resolveLocalTime({ ...day, hour: 3, minute: 0 }, 'America/New_York').kind, 'exact');
});

test('fall back: a repeated local time is a fold, and both instants are an hour apart', () => {
  // New York moves 02:00 EDT back to 01:00 EST at 2026-11-01T06:00Z. 01:30 happens twice.
  const resolved = resolveLocalTime({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, 'America/New_York');
  assert.equal(resolved.kind, 'fold');
  if (resolved.kind !== 'fold') return;
  assert.equal(resolved.firstInstant, '2026-11-01T05:30:00.000Z');
  assert.equal(resolved.secondInstant, '2026-11-01T06:30:00.000Z');
  assert.equal(minutesBetween(resolved.firstInstant, resolved.secondInstant), 60);
});

test('fold policy chooses a side, and the two sides really differ', () => {
  const resolved = resolveLocalTime({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, 'America/New_York');
  const earliest = instantFromResolution(resolved, 'earliest');
  const latest = instantFromResolution(resolved, 'latest');
  assert.equal(earliest, '2026-11-01T05:30:00.000Z');
  assert.equal(latest, '2026-11-01T06:30:00.000Z');
  assert.notEqual(earliest, latest, 'a fold policy that picks the same instant either way is not a policy');
});

test('Asia/Jerusalem transitions are handled too, not just US ones', () => {
  // AR/HE are first-class locales here, and Israel's transition dates differ
  // from the US ones — a normalizer tuned to America/* would pass every US test
  // and mis-place a Hebrew-locale window by an hour.
  const gap = resolveLocalTime({ year: 2026, month: 3, day: 27, hour: 2, minute: 30 }, 'Asia/Jerusalem');
  assert.equal(gap.kind, 'gap');
  assert.equal(gap.kind === 'gap' && gap.resumesAt, '2026-03-27T00:00:00.000Z');

  const fold = resolveLocalTime({ year: 2026, month: 10, day: 25, hour: 1, minute: 30 }, 'Asia/Jerusalem');
  assert.equal(fold.kind, 'fold');
  if (fold.kind !== 'fold') return;
  assert.equal(fold.firstInstant, '2026-10-24T22:30:00.000Z');
  assert.equal(fold.secondInstant, '2026-10-24T23:30:00.000Z');
});

test('every resolved instant actually reads back as the requested local time', () => {
  // The property behind the algorithm: a candidate counts only if the zone
  // really shows those fields at it. Asserted across a whole transition day at
  // 15-minute steps, in both hemispheres' directions, so a regression in the
  // verification step cannot hide in the hours the named cases skip.
  for (const [timeZone, year, month, day] of [
    ['America/New_York', 2026, 3, 8],
    ['America/New_York', 2026, 11, 1],
    ['Asia/Jerusalem', 2026, 3, 27],
    ['Asia/Jerusalem', 2026, 10, 25],
  ] as const) {
    for (let minuteOfDay = 0; minuteOfDay < 1440; minuteOfDay += 15) {
      const parts = { year, month, day, hour: Math.floor(minuteOfDay / 60), minute: minuteOfDay % 60 };
      const resolved = resolveLocalTime(parts, timeZone);
      const label = `${timeZone} ${year}-${month}-${day} ${parts.hour}:${parts.minute}`;

      if (resolved.kind === 'gap') {
        assert.notDeepEqual(wallClockAt(toEpochMs(resolved.resumesAt), timeZone), parts, `${label}: a gap must not resume at the time it skipped`);
        continue;
      }
      const instants = resolved.kind === 'exact'
        ? [resolved.instant]
        : [resolved.firstInstant, resolved.secondInstant];
      for (const instant of instants) {
        assert.deepEqual(wallClockAt(toEpochMs(instant), timeZone), parts, `${label}: resolved instant does not read back`);
      }
    }
  }
});

test('a transition day has exactly one anomalous hour, and it is the expected direction', () => {
  // Re-derives the shape of each transition from the resolver itself, so a
  // tzdata update that moves or removes a transition fails here rather than
  // silently changing what the sprint's DST scenarios mean.
  for (const [timeZone, year, month, day, expected] of [
    ['America/New_York', 2026, 3, 8, 'gap'],
    ['America/New_York', 2026, 11, 1, 'fold'],
    ['Asia/Jerusalem', 2026, 3, 27, 'gap'],
    ['Asia/Jerusalem', 2026, 10, 25, 'fold'],
  ] as const) {
    let anomalous = 0;
    for (let minuteOfDay = 0; minuteOfDay < 1440; minuteOfDay += 1) {
      const parts = { year, month, day, hour: Math.floor(minuteOfDay / 60), minute: minuteOfDay % 60 };
      if (resolveLocalTime(parts, timeZone).kind === expected) anomalous += 1;
    }
    assert.equal(anomalous, 60, `${timeZone} ${year}-${month}-${day}: expected exactly 60 ${expected} minutes`);
  }
});

test('a zone with no DST has no anomalous times at all', () => {
  for (let minuteOfDay = 0; minuteOfDay < 1440; minuteOfDay += 30) {
    const parts = { year: 2026, month: 3, day: 8, hour: Math.floor(minuteOfDay / 60), minute: minuteOfDay % 60 };
    assert.equal(resolveLocalTime(parts, 'Asia/Kolkata').kind, 'exact');
    assert.equal(resolveLocalTime(parts, 'UTC').kind, 'exact');
  }
});

test('an unrecognised fold policy resolves to nothing rather than silently to "latest"', () => {
  // The obvious spelling — `policy === 'earliest' ? first : second` — makes every
  // value that is not 'earliest' mean 'latest'. That turns a fold nobody resolved
  // into a definite instant, and the caller then counts working minutes that rest
  // on a choice no config made. `FoldPolicy` makes it unreachable through the
  // type; the callers that matter sit on an untyped boundary (a corpus loaded as
  // data, an oracle whose job is to report rather than raise).
  const fold = resolveLocalTime({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, 'America/New_York');
  assert.equal(fold.kind, 'fold');

  assert.equal(instantFromResolution(fold, 'earliest'), '2026-11-01T05:30:00.000Z');
  assert.equal(instantFromResolution(fold, 'latest'), '2026-11-01T06:30:00.000Z');
  for (const bogus of ['ask-the-user', 'LATEST', '', 'first'] as unknown as Array<'earliest' | 'latest'>) {
    assert.equal(
      instantFromResolution(fold, bogus),
      null,
      `policy ${JSON.stringify(bogus)} must not be read as a side of the fold`,
    );
  }
});

test('an unrecognised fold policy does not disturb a time that is not folded', () => {
  // The guard must not turn every resolution null: an unambiguous local time has
  // one instant whatever the policy says, and a caller that lost those would
  // report an empty calendar rather than an unresolved ambiguity.
  const exact = resolveLocalTime({ year: 2026, month: 11, day: 9, hour: 9, minute: 0 }, 'America/New_York');
  assert.equal(
    instantFromResolution(exact, 'nonsense' as unknown as 'earliest'),
    '2026-11-09T14:00:00.000Z',
  );
});

test('the nominal bracket contains the real instant, and is a point when nothing is anomalous', () => {
  // The half of resolveLocalTime a caller needs *before* verification: where
  // would this reading have fallen had it not been skipped. Exported so #29
  // stops recomputing it; asserted here so the two halves cannot drift.
  const ordinary = { year: 2026, month: 11, day: 9, hour: 9, minute: 0 };
  const point = nominalInstantBracket(ordinary, 'America/New_York');
  assert.equal(point.earliestMs, point.latestMs, 'an unanomalous reading brackets to a point');
  assert.equal(toInstant(point.earliestMs), '2026-11-09T14:00:00.000Z');

  // A gap: neither endpoint is real, but the bracket still spans the transition.
  const gap = nominalInstantBracket({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, 'America/New_York');
  assert.ok(gap.earliestMs < gap.latestMs, 'an anomalous reading brackets a range');
  const transition = toEpochMs('2026-03-08T07:00:00.000Z');
  assert.ok(gap.earliestMs < transition && transition <= gap.latestMs, 'the bracket must span the transition');

  // A fold: both candidates are real, and the bracket is exactly the two.
  const foldParts = { year: 2026, month: 11, day: 1, hour: 1, minute: 30 };
  const fold = resolveLocalTime(foldParts, 'America/New_York');
  const bracket = nominalInstantBracket(foldParts, 'America/New_York');
  assert.equal(fold.kind, 'fold');
  if (fold.kind !== 'fold') return;
  assert.equal(toInstant(bracket.earliestMs), fold.firstInstant);
  assert.equal(toInstant(bracket.latestMs), fold.secondInstant);
});
