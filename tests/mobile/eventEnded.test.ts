/**
 * `hasEventEnded`: the one answer to "is this appointment over?" (spec Part 1,
 * "Rules for the build", lane E1).
 *
 *   - an event is a `scheduled_event` — timed or all-day; a football fixture
 *     and a calendar-feed session are both written as one;
 *   - it has ended at `endAt` when it has one; otherwise an hour after `dueAt`
 *     when it has an hour; otherwise, for a day with no hour, when that day ends
 *     in the zone it was named in;
 *   - a task or deadline is never an event, however late: #383 rolls it into
 *     Today until the person acts on it.
 *
 * Every instant is in Jerusalem (UTC+2 in November) unless a test says
 * otherwise; the clock is 2026-11-12 15:00 local.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Commitment } from '../../src/domain/stateMachine.ts';
import { eventEndsAt, hasEventEnded, isEventCommitment } from '../../lib/services/commitments/eventEnded.ts';

const TZ = 'Asia/Jerusalem';
const NOW = new Date('2026-11-12T13:00:00.000Z');

type Spec = Partial<Commitment['timeSpec']> & Pick<Commitment['timeSpec'], 'kind' | 'dueAt'>;

function item(timeSpec: Spec, postponedUntil: string | null = null): Pick<Commitment, 'timeSpec' | 'postponedUntil'> {
  return { timeSpec: { endAt: null, remindAt: null, allDay: false, timezone: TZ, ...timeSpec }, postponedUntil };
}

test('a lecture three weeks ago has ended at its own end', () => {
  const lecture = item({ kind: 'scheduled_event', dueAt: '2026-10-22T08:00:00.000Z', endAt: '2026-10-22T10:00:00.000Z' });
  assert.equal(eventEndsAt(lecture), '2026-10-22T10:00:00.000Z');
  assert.equal(hasEventEnded(lecture, NOW), true);
});

test('yesterday\'s all-day appointment ended at the midnight that closed its day', () => {
  const doctor = item({ kind: 'scheduled_event', dueAt: '2026-11-10T22:00:00.000Z', allDay: true });
  assert.equal(eventEndsAt(doctor), '2026-11-11T22:00:00.000Z');
  assert.equal(hasEventEnded(doctor, NOW), true);
});

test('today\'s all-day appointment is not over until today ends', () => {
  const today = item({ kind: 'scheduled_event', dueAt: '2026-11-11T22:00:00.000Z', allDay: true });
  assert.equal(hasEventEnded(today, NOW), false);
  assert.equal(hasEventEnded(today, new Date('2026-11-12T21:59:59.999Z')), false);
  assert.equal(hasEventEnded(today, new Date('2026-11-12T22:00:00.000Z')), true);
});

test('this morning\'s 09:00–10:00 meeting is over at 10:00, and not a millisecond before', () => {
  const meeting = item({ kind: 'scheduled_event', dueAt: '2026-11-12T07:00:00.000Z', endAt: '2026-11-12T08:00:00.000Z' });
  assert.equal(hasEventEnded(meeting, NOW), true);
  assert.equal(hasEventEnded(meeting, new Date('2026-11-12T07:59:59.999Z')), false);
  assert.equal(hasEventEnded(meeting, new Date('2026-11-12T08:00:00.000Z')), true);
});

test('a timed event with no end is over an hour after it starts', () => {
  const noEnd = item({ kind: 'scheduled_event', dueAt: '2026-11-12T11:30:00.000Z' });
  assert.equal(eventEndsAt(noEnd), '2026-11-12T12:30:00.000Z');
  assert.equal(hasEventEnded(noEnd, NOW), true);
  assert.equal(hasEventEnded(noEnd, new Date('2026-11-12T12:29:00.000Z')), false);
});

test('a meeting later today has not ended', () => {
  const evening = item({ kind: 'scheduled_event', dueAt: '2026-11-12T16:00:00.000Z', endAt: '2026-11-12T17:00:00.000Z' });
  assert.equal(hasEventEnded(evening, NOW), false);
});

test('a task due yesterday is not an event, so it never "ends" (#383 keeps it)', () => {
  const task = item({ kind: 'due_by', dueAt: '2026-11-11T16:00:00.000Z' });
  assert.equal(isEventCommitment(task), false);
  assert.equal(eventEndsAt(task), null);
  assert.equal(hasEventEnded(task, NOW), false);
  // An all-day *deadline* is a task too.
  assert.equal(hasEventEnded(item({ kind: 'due_by', dueAt: '2026-11-09T22:00:00.000Z', allDay: true }), NOW), false);
  // And so is a prep window, whose end is a deadline.
  assert.equal(hasEventEnded(item({ kind: 'due_by', dueAt: '2026-11-11T10:00:00.000Z', endAt: '2026-11-11T11:00:00.000Z' }), NOW), false);
  assert.equal(hasEventEnded(item({ kind: 'unscheduled', dueAt: null }), NOW), false);
});

test('a fixture-shaped event (UTC, kickoff plus two hours) ends at its end', () => {
  const match = item({ kind: 'scheduled_event', dueAt: '2026-11-11T19:00:00.000Z', endAt: '2026-11-11T21:00:00.000Z', timezone: 'UTC' });
  assert.equal(hasEventEnded(match, NOW), true);
  assert.equal(hasEventEnded(match, new Date('2026-11-11T20:59:00.000Z')), false);
});

test('an event the person put off with «لسّا» is not over before the time they put it off to', () => {
  const meeting = item(
    { kind: 'scheduled_event', dueAt: '2026-11-12T07:00:00.000Z', endAt: '2026-11-12T08:00:00.000Z' },
    '2026-11-12T14:00:00.000Z',
  );
  assert.equal(hasEventEnded(meeting, NOW), false);
  // It keeps its own length from there: a one-hour meeting at 16:00 local is over at 17:00.
  assert.equal(eventEndsAt(meeting), '2026-11-12T15:00:00.000Z');
  assert.equal(hasEventEnded(meeting, new Date('2026-11-12T15:00:00.000Z')), true);
});

test('a string clock is read the same as a Date', () => {
  const meeting = item({ kind: 'scheduled_event', dueAt: '2026-11-12T07:00:00.000Z', endAt: '2026-11-12T08:00:00.000Z' });
  assert.equal(hasEventEnded(meeting, NOW.toISOString()), true);
});

test('an unreadable time is never called ended', () => {
  assert.equal(hasEventEnded(item({ kind: 'scheduled_event', dueAt: 'not-a-time' }), NOW), false);
  assert.equal(hasEventEnded(item({ kind: 'scheduled_event', dueAt: null }), NOW), false);
});
