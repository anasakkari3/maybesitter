/**
 * The two answers `TimeSpec` could not give before UC-3.1 (#185): when a
 * commitment ends, and whether anybody chose its hour.
 *
 * #185's sketch asked for a three-way mapping — a point becomes a short event, a
 * range becomes start–end, a date-only commitment becomes an all-day entry — on
 * top of a type that had one instant and no flag. Two of those three could not
 * be *said*, so the mapping would have been three branches over a value that
 * only ever took one shape, and the tests for it would have been tests of the
 * mapper's imagination. These cases are the other half: the domain can say all
 * three, and it refuses the shapes that are not any of them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, createEmptyDomainState, type Command } from '../../src/domain/stateMachine.ts';
import { patchTimeSpecForTest } from '../../lib/services/mobile/commitmentService.ts';
import type { TimeSpec } from '../../src/domain/stateMachine.ts';

const NOW = '2026-09-15T09:00:00.000Z';
/** The clock the patch cases are judged by, supplied rather than read (#352, #382). */
const CLOCK = new Date(NOW);

function draft(timeSpec: Partial<TimeSpec>): Command {
  return {
    type: 'CreateDraft',
    now: NOW,
    commitment: { id: 'cmt', kind: 'task', title: 'Dentist', timeSpec },
  };
}

function timeSpecOf(command: Command): TimeSpec {
  const result = applyCommand(createEmptyDomainState(), command);
  return result.newState.commitments.cmt!.timeSpec;
}

/* ── What the domain stores ───────────────────────────────────────── */

test('a commitment that says nothing about an end or a day gets the shape it always had', () => {
  const spec = timeSpecOf(draft({ kind: 'due_by', dueAt: '2026-09-16T12:00:00.000Z' }));
  assert.equal(spec.endAt, null, 'no end is null, not a default block');
  assert.equal(spec.allDay, false);
});

test('a range is stored as a range', () => {
  const spec = timeSpecOf(draft({
    kind: 'scheduled_event',
    dueAt: '2026-09-16T12:00:00.000Z',
    endAt: '2026-09-16T14:00:00.000Z',
  }));
  assert.equal(spec.dueAt, '2026-09-16T12:00:00.000Z');
  assert.equal(spec.endAt, '2026-09-16T14:00:00.000Z');
});

test('a day is stored as a day, with the hour marked as nobody’s choice', () => {
  const spec = timeSpecOf(draft({
    kind: 'due_by',
    dueAt: '2026-09-16T21:00:00.000Z', // local midnight in Asia/Jerusalem
    allDay: true,
    timezone: 'Asia/Jerusalem',
  }));
  assert.equal(spec.allDay, true);
  assert.equal(spec.timezone, 'Asia/Jerusalem');
});

test('an end with no start is refused', () => {
  assert.throws(
    () => timeSpecOf(draft({ kind: 'due_by', endAt: '2026-09-16T14:00:00.000Z' })),
    /endAt requires/,
  );
});

test('an end that is not after its start is refused, including a zero-length one', () => {
  for (const endAt of ['2026-09-16T12:00:00.000Z', '2026-09-16T11:00:00.000Z']) {
    assert.throws(
      () => timeSpecOf(draft({ kind: 'scheduled_event', dueAt: '2026-09-16T12:00:00.000Z', endAt })),
      /endAt must be after/,
      `accepted an end at ${endAt}`,
    );
  }
});

test('an all-day commitment on no day is refused', () => {
  assert.throws(() => timeSpecOf(draft({ kind: 'unscheduled', allDay: true })), /allDay requires/);
});

/* ── What an edit does to them ────────────────────────────────────── */

function current(overrides: Partial<TimeSpec> = {}): TimeSpec {
  return {
    kind: 'scheduled_event',
    dueAt: '2026-09-20T12:00:00.000Z',
    endAt: '2026-09-20T14:00:00.000Z',
    remindAt: null,
    allDay: false,
    timezone: 'Asia/Jerusalem',
    ...overrides,
  };
}

test('moving a commitment carries its length, the way it carries the reminder lead', () => {
  const patched = patchTimeSpecForTest(current(), { dueDate: '2026-09-22T16:00:00.000Z' }, CLOCK);
  assert.equal(patched?.dueAt, '2026-09-22T16:00:00.000Z');
  assert.equal(patched?.endAt, '2026-09-22T18:00:00.000Z', 'a two-hour meeting became something else');
});

test('an end the user sent wins over the length that would have been carried', () => {
  const patched = patchTimeSpecForTest(
    current(),
    { dueDate: '2026-09-22T16:00:00.000Z', endDate: '2026-09-22T16:30:00.000Z' },
    CLOCK,
  );
  assert.equal(patched?.endAt, '2026-09-22T16:30:00.000Z');
});

test('an end can be removed on its own, and the start stays put', () => {
  const patched = patchTimeSpecForTest(current(), { endDate: null }, CLOCK);
  assert.equal(patched?.endAt, null);
  assert.equal(patched?.dueAt, '2026-09-20T12:00:00.000Z');
});

test('removing the time removes the end and the all-day flag with it', () => {
  const patched = patchTimeSpecForTest(
    current({ allDay: true }),
    { dueDate: null, reminderTime: null },
    CLOCK,
  );
  assert.equal(patched?.dueAt, null);
  assert.equal(patched?.endAt, null, 'an end survived the start it was measured from');
  assert.equal(patched?.allDay, false, 'a commitment is all-day on no day');
  assert.equal(patched?.kind, 'unscheduled');
});

test('an end before the start it would have is refused, and the whole patch with it', () => {
  assert.throws(
    () => patchTimeSpecForTest(current(), { dueDate: '2026-09-22T16:00:00.000Z', endDate: '2026-09-22T15:00:00.000Z' }, CLOCK),
    /endDate must be after/,
  );
});

test('an end on a commitment with no time is refused rather than stored as half a range', () => {
  assert.throws(
    () => patchTimeSpecForTest(
      current({ dueAt: null, endAt: null, kind: 'unscheduled' }),
      { endDate: '2026-09-22T15:00:00.000Z' },
      CLOCK,
    ),
    /endDate requires a due date/,
  );
});

test('an end is judged for being after its start, never for being behind the clock', () => {
  // A meeting that started an hour ago and runs for another hour. The end is in
  // the future; a range that already finished is a true record either way, and
  // `pastTimeMessage` would refuse both.
  const patched = patchTimeSpecForTest(
    current({ dueAt: '2026-09-15T08:00:00.000Z', endAt: null, remindAt: null }),
    { endDate: '2026-09-15T08:30:00.000Z' },
    CLOCK,
  );
  assert.equal(patched?.endAt, '2026-09-15T08:30:00.000Z');
});

test('an end with no time of day is refused for being a date', () => {
  assert.throws(() => patchTimeSpecForTest(current(), { endDate: '2026-09-22' }, CLOCK), /not only a date/);
});

test('the all-day flag is a boolean and nothing else', () => {
  assert.throws(() => patchTimeSpecForTest(current(), { allDay: 'yes' }, CLOCK), /allDay must be a boolean/);
});

test('an edit that names neither the time, the end nor the day leaves the spec alone', () => {
  assert.equal(patchTimeSpecForTest(current(), { title: 'Fixed a typo' }, CLOCK), undefined);
});

test('setting the all-day flag alone keeps the day the commitment already had', () => {
  const patched = patchTimeSpecForTest(current({ endAt: null }), { allDay: true }, CLOCK);
  assert.equal(patched?.allDay, true);
  assert.equal(patched?.dueAt, '2026-09-20T12:00:00.000Z');
});
