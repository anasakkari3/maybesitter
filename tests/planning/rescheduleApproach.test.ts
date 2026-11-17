/**
 * Lane E4: the approach a missed piece of work is retried with is chosen from
 * its miss history, deterministically (owner answer of 2026-11-13, item 4).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseApproach,
  dayPartOf,
  pickSessions,
  type MissRecord,
} from '../../lib/planning/rescheduleApproach.ts';

const TZ = 'Asia/Jerusalem';
const NOW = '2026-10-07T07:00:00.000Z'; // Wed 10:00 Jerusalem

function miss(startsAt: string, durationMinutes = 60): MissRecord {
  return { startsAt, durationMinutes, dayPart: dayPartOf(startsAt, TZ) };
}
function slot(startsAt: string, minutes: number) {
  return { startsAt, endsAt: new Date(Date.parse(startsAt) + minutes * 60_000).toISOString() };
}

test('day parts: before noon, noon to five, five onwards, in the local zone', () => {
  assert.equal(dayPartOf('2026-10-07T08:59:00.000Z', TZ), 'morning'); // 11:59
  assert.equal(dayPartOf('2026-10-07T09:00:00.000Z', TZ), 'afternoon'); // 12:00
  assert.equal(dayPartOf('2026-10-07T13:59:00.000Z', TZ), 'afternoon'); // 16:59
  assert.equal(dayPartOf('2026-10-07T14:00:00.000Z', TZ), 'evening'); // 17:00
});

test('a first miss keeps its time of day and only moves', () => {
  const approach = chooseApproach({ current: miss('2026-10-06T14:00:00.000Z'), history: [], deadlineAt: null, now: NOW });
  assert.equal(approach.reason, 'first_miss');
  assert.deepEqual(approach.changes, ['new_time']);
  assert.equal(approach.sessions, 1);
  assert.equal(approach.minutesEach, 60);
  assert.equal(approach.preferDayPart, 'evening');
  assert.deepEqual(approach.avoidDayParts, []);
});

test('a second miss in the same part of the day means a different part of the day', () => {
  const approach = chooseApproach({
    current: miss('2026-10-06T14:00:00.000Z', 20),
    history: [miss('2026-10-05T15:00:00.000Z', 20)],
    deadlineAt: null, now: NOW,
  });
  assert.equal(approach.reason, 'same_time_again');
  assert.deepEqual(approach.avoidDayParts, ['evening']);
  assert.ok(approach.changes.includes('other_time_of_day'));
  assert.equal(approach.preferDayPart, null);
  assert.equal(approach.missCount, 2);
});

test('a repeated miss at different times splits work into two smaller pieces', () => {
  const approach = chooseApproach({
    current: miss('2026-10-06T14:00:00.000Z', 90),
    history: [miss('2026-10-05T06:00:00.000Z', 90)],
    deadlineAt: null, now: NOW,
  });
  assert.equal(approach.reason, 'missed_again');
  assert.deepEqual(approach.changes, ['smaller_pieces']);
  assert.equal(approach.sessions, 2);
  assert.equal(approach.minutesEach, 45);
  assert.deepEqual(approach.avoidDayParts, []);
});

test('work too short to split changes its time of day instead', () => {
  const approach = chooseApproach({
    current: miss('2026-10-06T14:00:00.000Z', 20),
    history: [miss('2026-10-05T06:00:00.000Z', 20)],
    deadlineAt: null, now: NOW,
  });
  assert.equal(approach.sessions, 1);
  assert.deepEqual(approach.changes, ['other_time_of_day']);
  assert.deepEqual(approach.avoidDayParts, ['evening']);
});

test('the same miss recorded and current counts once', () => {
  const current = miss('2026-10-06T14:00:00.000Z');
  const approach = chooseApproach({ current, history: [current], deadlineAt: null, now: NOW });
  assert.equal(approach.missCount, 1);
  assert.equal(approach.reason, 'first_miss');
});

test('a deadline within 72 hours starts earlier and bounds every session', () => {
  const deadlineAt = '2026-10-08T15:00:00.000Z';
  const approach = chooseApproach({ current: miss('2026-10-06T14:00:00.000Z'), history: [], deadlineAt, now: NOW });
  assert.equal(approach.reason, 'deadline_near');
  assert.deepEqual(approach.changes, ['earlier_start']);
  assert.equal(approach.preferDayPart, null);
  const sessions = pickSessions([
    slot('2026-10-07T08:00:00.000Z', 60), // Wed 11:00, the earliest
    slot('2026-10-07T15:00:00.000Z', 60), // Wed 18:00, the old part of the day
  ], approach, { timezone: TZ, deadlineAt });
  assert.deepEqual(sessions, [slot('2026-10-07T08:00:00.000Z', 60)]);
  assert.equal(pickSessions([slot('2026-10-08T15:00:00.000Z', 60)], approach, { timezone: TZ, deadlineAt }), null);
});

test('pickSessions prefers the kept part of the day and falls back to the earliest', () => {
  const approach = chooseApproach({ current: miss('2026-10-06T14:00:00.000Z'), history: [], deadlineAt: null, now: NOW });
  const morning = slot('2026-10-07T08:00:00.000Z', 60);
  const evening = slot('2026-10-07T15:00:00.000Z', 60);
  assert.deepEqual(pickSessions([morning, evening], approach, { timezone: TZ, deadlineAt: null }), [evening]);
  assert.deepEqual(pickSessions([morning], approach, { timezone: TZ, deadlineAt: null }), [morning]);
  assert.equal(pickSessions([], approach, { timezone: TZ, deadlineAt: null }), null);
});

test('pickSessions never offers an avoided part of the day', () => {
  const approach = chooseApproach({
    current: miss('2026-10-06T14:00:00.000Z', 20),
    history: [miss('2026-10-05T15:00:00.000Z', 20)],
    deadlineAt: null, now: NOW,
  });
  const evening = slot('2026-10-07T15:00:00.000Z', 20);
  const morning = slot('2026-10-08T06:00:00.000Z', 20);
  assert.deepEqual(pickSessions([evening, morning], approach, { timezone: TZ, deadlineAt: null }), [morning]);
  assert.equal(pickSessions([evening], approach, { timezone: TZ, deadlineAt: null }), null);
});

test('two pieces go on two different days, the second in the first one\'s part of the day', () => {
  const approach = chooseApproach({
    current: miss('2026-10-06T14:00:00.000Z', 90),
    history: [miss('2026-10-05T06:00:00.000Z', 90)],
    deadlineAt: null, now: NOW,
  });
  const wedMorning = slot('2026-10-07T08:00:00.000Z', 45);
  const wedEvening = slot('2026-10-07T15:00:00.000Z', 45);
  const thuMorningEarly = slot('2026-10-08T05:00:00.000Z', 45);
  const thuAfternoon = slot('2026-10-08T10:00:00.000Z', 45);
  const thuMorning = slot('2026-10-08T07:00:00.000Z', 45);
  assert.deepEqual(
    pickSessions([wedMorning, wedEvening, thuMorningEarly, thuMorning, thuAfternoon], approach, { timezone: TZ, deadlineAt: null }),
    [wedMorning, thuMorningEarly],
  );
  assert.deepEqual(
    pickSessions([wedMorning, thuAfternoon], approach, { timezone: TZ, deadlineAt: null }),
    [wedMorning, thuAfternoon],
  );
  assert.equal(pickSessions([wedMorning, wedEvening], approach, { timezone: TZ, deadlineAt: null }), null);
});

test('with a deadline, no session of a split plan ends after it', () => {
  const deadlineAt = '2026-10-08T09:00:00.000Z'; // Thu 12:00
  const approach = chooseApproach({
    current: miss('2026-10-06T14:00:00.000Z', 90),
    history: [miss('2026-10-05T06:00:00.000Z', 90)],
    deadlineAt, now: NOW,
  });
  assert.equal(approach.sessions, 2);
  const wed = slot('2026-10-07T08:00:00.000Z', 45);
  const thuEarly = slot('2026-10-08T07:00:00.000Z', 45); // ends 10:45 local, before noon
  const thuLate = slot('2026-10-08T08:30:00.000Z', 45); // ends 12:15 local, after the deadline
  assert.deepEqual(pickSessions([wed, thuEarly, thuLate], approach, { timezone: TZ, deadlineAt }), [wed, thuEarly]);
  assert.equal(pickSessions([wed, thuLate], approach, { timezone: TZ, deadlineAt }), null);
});

test('work with no stated length is never split; its time of day changes instead', () => {
  const approach = chooseApproach({
    current: miss('2026-10-06T14:00:00.000Z', 90),
    history: [miss('2026-10-05T06:00:00.000Z', 90)],
    deadlineAt: null, now: NOW, splittable: false,
  });
  assert.equal(approach.sessions, 1);
  assert.equal(approach.minutesEach, 90);
  assert.deepEqual(approach.changes, ['other_time_of_day']);
});
