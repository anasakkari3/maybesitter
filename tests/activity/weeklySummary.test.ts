/**
 * The calm weekly summary (UC-3.15, #201).
 *
 * Three claims here are the ones that can quietly stop being true: the week
 * starts on the right local day for the language, the boundary survives a DST
 * change, and a Moment outlives the item it came from.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addLocalDays,
  currentWeekStart,
  KEPT_GRACE_MS,
  localDayStartInstant,
  localWallClock,
  momentsFrom,
  summariseWeek,
  weekStartDayFor,
  weekWindow,
  type SummaryCommitment,
} from '../../lib/services/activity/weeklySummary.ts';
import { advanceActivityStats, emptyActivityStats } from '../../lib/services/activity/activityStats.ts';
import type { DomainEventRecord } from '../../lib/services/mobile/eventLog.ts';

const ZONE = 'Asia/Jerusalem';

function event(type: string, at: string, aggregateId = 'c1', id = `${type}-${at}`): DomainEventRecord {
  return { id, type, at, aggregateId, payload: {} };
}

function commitment(level: string, dueAt: string | null): SummaryCommitment {
  return { priority: { level }, timeSpec: { dueAt, remindAt: null } };
}

const NO_STATS = emptyActivityStats();

test('the week starts on Sunday for Arabic and Hebrew and on Monday for English', () => {
  assert.equal(weekStartDayFor('ar'), 0);
  assert.equal(weekStartDayFor('he'), 0);
  assert.equal(weekStartDayFor('en'), 1);
  // No locale recorded yet: Arabic is the product's default language.
  assert.equal(weekStartDayFor(null), 0);

  // Wednesday 16 September 2026, local.
  const wednesday = new Date('2026-09-16T09:00:00.000Z');
  assert.equal(currentWeekStart(wednesday, ZONE, 'ar'), '2026-09-13');
  assert.equal(currentWeekStart(wednesday, ZONE, 'he'), '2026-09-13');
  assert.equal(currentWeekStart(wednesday, ZONE, 'en'), '2026-09-14');
});

test('a day that has already begun locally is still in its own week', () => {
  // 22:30 UTC on Saturday is already Sunday in Asia/Jerusalem, so an Arabic
  // user is in the *new* week. Computing this from a UTC weekday would put
  // them a week behind for three hours every Saturday night.
  const lateSaturday = new Date('2026-09-12T22:30:00.000Z');
  assert.equal(currentWeekStart(lateSaturday, ZONE, 'ar'), '2026-09-13');
});

test('the week window is seven local days, not 168 fixed hours, across a DST change', () => {
  // Israel leaves daylight time on Sunday 25 October 2026: the week that
  // starts that day is 169 hours long. A window built by adding 7 * 24 h would
  // end an hour early and drop whatever the user did in that hour.
  const window = weekWindow('2026-10-25', ZONE);
  const hours = (Date.parse(window.toExclusive) - Date.parse(window.fromInclusive)) / 3_600_000;
  assert.equal(hours, 169);

  // Both ends are local midnight, which is the property that actually matters.
  for (const edge of [window.fromInclusive, window.toExclusive]) {
    const local = localWallClock(edge, ZONE);
    assert.deepEqual({ hour: local.hour, minute: local.minute }, { hour: 0, minute: 0 });
  }
});

test('adding local days lands on the same wall clock either side of a spring-forward', () => {
  // Israel enters daylight time on Friday 27 March 2026.
  assert.equal(addLocalDays('2026-03-26', 1, ZONE), '2026-03-27');
  assert.equal(addLocalDays('2026-03-27', 1, ZONE), '2026-03-28');
  const local = localWallClock(localDayStartInstant('2026-03-27', ZONE), ZONE);
  assert.deepEqual({ day: local.day, hour: local.hour }, { day: 27, hour: 0 });
});

test('the summary matches the fixture #201 names: 4 completed, 2 plan days, 3 kept', () => {
  const window = weekWindow('2026-09-13', ZONE);
  const commitments = new Map<string, SummaryCommitment>([
    ['c1', commitment('high', '2026-09-14T09:00:00.000Z')],
    ['c2', commitment('normal', '2026-09-15T09:00:00.000Z')],
    ['c3', commitment('high', '2026-09-16T09:00:00.000Z')],
    // Finished, but "Nice": never something the product asked anyone to keep.
    ['c4', commitment('low', '2026-09-17T09:00:00.000Z')],
  ]);

  const summary = summariseWeek({
    window,
    timezone: ZONE,
    commitmentsById: commitments,
    stats: NO_STATS,
    events: [
      event('commitment_completed', '2026-09-14T08:00:00.000Z', 'c1'),
      event('commitment_completed', '2026-09-15T08:30:00.000Z', 'c2'),
      event('commitment_completed', '2026-09-16T10:00:00.000Z', 'c3'),
      event('commitment_completed', '2026-09-17T08:00:00.000Z', 'c4'),
      // Two accepted plans on one day and one on another: two *days*, not
      // three plans. Nothing emits these yet (#194) — the rule is proven now
      // so that issue is additive.
      event('plan_accepted', '2026-09-14T06:00:00.000Z', 'p1', 'p1'),
      event('plan_accepted', '2026-09-14T18:00:00.000Z', 'p2', 'p2'),
      event('plan_accepted', '2026-09-16T06:00:00.000Z', 'p3', 'p3'),
    ],
  });

  assert.deepEqual(
    { completedCount: summary.completedCount, plannedDaysCount: summary.plannedDaysCount, keptCount: summary.keptCount },
    { completedCount: 4, plannedDaysCount: 2, keptCount: 3 },
  );
  assert.equal(summary.weekStart, '2026-09-13');
});

test('the kept rule allows a day of grace and nothing more', () => {
  const window = weekWindow('2026-09-13', ZONE);
  const due = '2026-09-14T09:00:00.000Z';
  const commitments = new Map<string, SummaryCommitment>([['c1', commitment('high', due)]]);
  const keptAt = (at: string) => summariseWeek({
    window, timezone: ZONE, commitmentsById: commitments, stats: NO_STATS,
    events: [event('commitment_completed', at)],
  }).keptCount;

  assert.equal(keptAt(new Date(Date.parse(due) + KEPT_GRACE_MS).toISOString()), 1);
  assert.equal(keptAt(new Date(Date.parse(due) + KEPT_GRACE_MS + 1).toISOString()), 0);
});

test('an item with no time of its own is completed, but is not "kept"', () => {
  const window = weekWindow('2026-09-13', ZONE);
  const commitments = new Map<string, SummaryCommitment>([['c1', commitment('high', null)]]);
  const summary = summariseWeek({
    window, timezone: ZONE, commitmentsById: commitments, stats: NO_STATS,
    events: [event('commitment_completed', '2026-09-14T08:00:00.000Z')],
  });
  assert.deepEqual([summary.completedCount, summary.keptCount], [1, 0]);
});

test('events outside the window are not counted, however close', () => {
  const window = weekWindow('2026-09-13', ZONE);
  const summary = summariseWeek({
    window, timezone: ZONE, commitmentsById: new Map(), stats: NO_STATS,
    events: [
      event('commitment_completed', new Date(Date.parse(window.fromInclusive) - 1).toISOString(), 'c0', 'before'),
      event('commitment_completed', window.fromInclusive, 'c1', 'first'),
      event('commitment_completed', new Date(Date.parse(window.toExclusive) - 1).toISOString(), 'c2', 'last'),
      event('commitment_completed', window.toExclusive, 'c3', 'after'),
    ],
  });
  assert.equal(summary.completedCount, 2);
});

test('an all-zero week is a summary, not an error', () => {
  const summary = summariseWeek({
    window: weekWindow('2026-09-13', ZONE),
    timezone: ZONE,
    commitmentsById: new Map(),
    stats: NO_STATS,
    events: [],
  });
  assert.deepEqual(summary, {
    weekStart: '2026-09-13',
    completedCount: 0,
    plannedDaysCount: 0,
    keptCount: 0,
    moments: [],
  });
});

test('the summary never contains a judgement the client could render', () => {
  // A structural guard, not a copy check: no field here may be a count of what
  // did not happen, a streak, a percentage or a ratio. Adding one would be a
  // product decision #201 already made in the other direction.
  const summary = summariseWeek({
    window: weekWindow('2026-09-13', ZONE), timezone: ZONE,
    commitmentsById: new Map(), stats: NO_STATS, events: [],
  });
  assert.deepEqual(
    Object.keys(summary).sort(),
    ['completedCount', 'keptCount', 'moments', 'plannedDaysCount', 'weekStart'],
  );
});

test('Moments survive deleting every completed item they came from', () => {
  // The acceptance criterion, exactly: reach ten completions, then delete the
  // commitments. The counter is what answers, so nothing is withdrawn.
  let stats = emptyActivityStats();
  for (let index = 1; index <= 10; index += 1) {
    stats = advanceActivityStats(stats, [{
      id: `e${index}`, type: 'commitment_completed',
      at: `2026-09-${String(index + 10).padStart(2, '0')}T09:00:00.000Z`,
      aggregateId: `c${index}`, payload: {},
    }]);
  }

  // Every commitment gone, and not one event in this week's window.
  const summary = summariseWeek({
    window: weekWindow('2026-10-04', ZONE), timezone: ZONE,
    commitmentsById: new Map(), stats, events: [],
  });

  assert.deepEqual(summary.moments.map((moment) => moment.id), ['first_done', 'done_10']);
  assert.equal(summary.moments[1]!.reachedAt, '2026-09-20T09:00:00.000Z');
  assert.equal(summary.completedCount, 0);
});

test('Moments are cumulative, one-time, and ordered by when they were reached', () => {
  const moments = momentsFrom({
    doneTotal: 100,
    firstCaptureAt: '2026-01-01T00:00:00.000Z',
    firstDoneAt: '2026-01-02T00:00:00.000Z',
    firstPlanAcceptedAt: '2026-01-03T00:00:00.000Z',
    doneMilestonesAt: {
      '10': '2026-02-01T00:00:00.000Z',
      '25': '2026-03-01T00:00:00.000Z',
      '50': '2026-04-01T00:00:00.000Z',
      '100': '2026-05-01T00:00:00.000Z',
    },
  });
  assert.deepEqual(moments.map((moment) => moment.id), [
    'first_capture', 'first_done', 'first_plan_accepted', 'done_10', 'done_25', 'done_50', 'done_100',
  ]);
});

test('the counter only ever moves forward, and a first date never moves later', () => {
  const completed = (at: string, id: string): DomainEventRecord =>
    ({ id, type: 'commitment_completed', at, aggregateId: 'c1', payload: {} });

  let stats = advanceActivityStats(emptyActivityStats(), [completed('2026-09-14T09:00:00.000Z', 'a')]);
  assert.deepEqual([stats.doneTotal, stats.firstDoneAt], [1, '2026-09-14T09:00:00.000Z']);

  // An event that arrives late but happened earlier — a replay, a backfill.
  stats = advanceActivityStats(stats, [completed('2026-09-13T09:00:00.000Z', 'b')]);
  assert.deepEqual([stats.doneTotal, stats.firstDoneAt], [2, '2026-09-13T09:00:00.000Z']);

  // Nothing that counts: the same object comes back, so nothing is written.
  const unchanged = advanceActivityStats(stats, [
    { id: 'c', type: 'escalation_delivered', at: '2026-09-15T09:00:00.000Z', aggregateId: 'c1', payload: {} },
  ]);
  assert.equal(unchanged, stats);
});
