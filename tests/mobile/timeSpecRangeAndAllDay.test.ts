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
import {
  applyCommand,
  createEmptyDomainState,
  normalizeStoredTimeSpec,
  type Command,
} from '../../src/domain/stateMachine.ts';
import { patchTimeSpecForTest } from '../../lib/services/mobile/commitmentService.ts';
import { localDaysBetween, localMidnightOf } from '../../lib/services/mobile/time.ts';
import type { TimeSpec } from '../../src/domain/stateMachine.ts';

const ZONE = 'Asia/Jerusalem';

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
  // On a commitment whose hour already *is* midnight. Asking for all-day on one
  // that names 15:00 is a contradiction the domain refuses; see below.
  const midnight = localMidnightOf('2026-09-20', ZONE);
  const patched = patchTimeSpecForTest(current({ endAt: null, dueAt: midnight }), { allDay: true }, CLOCK);
  assert.equal(patched?.allDay, true);
  assert.equal(patched?.dueAt, midnight);
});

/* ── The midnight invariant, enforced rather than described ───────── */

/**
 * `allDay` means "`dueAt` is that day's local midnight and nobody chose the
 * hour". That was written in the type's own doc comment and checked nowhere, so
 * every shape it forbids was storable: an all-day commitment at 15:00, and an
 * all-day commitment carrying a thirty-minute range. The second was the worse
 * one — the mapper draws a day, so the range was invisible on the phone *and*
 * absent from the content hash, which meant the stored fact and the written
 * event disagreed with nothing able to notice.
 */
test('an all-day commitment whose hour somebody did choose is refused', () => {
  assert.throws(
    () => timeSpecOf(draft({ kind: 'due_by', dueAt: '2026-09-20T12:00:00.000Z', allDay: true, timezone: ZONE })),
    /allDay requires .*midnight/,
  );
});

test('an all-day commitment ending at half past something is refused', () => {
  const midnight = localMidnightOf('2026-09-20', ZONE);
  assert.throws(
    () => timeSpecOf(draft({
      kind: 'due_by',
      dueAt: midnight,
      endAt: new Date(Date.parse(midnight) + 30 * 60 * 1000).toISOString(),
      allDay: true,
      timezone: ZONE,
    })),
    /allDay requires .*midnight/,
  );
});

test('an all-day span of whole days is stored as it was given', () => {
  const spec = timeSpecOf(draft({
    kind: 'due_by',
    dueAt: localMidnightOf('2026-09-20', ZONE),
    endAt: localMidnightOf('2026-09-22', ZONE),
    allDay: true,
    timezone: ZONE,
  }));
  assert.equal(spec.allDay, true);
  assert.equal(spec.endAt, localMidnightOf('2026-09-22', ZONE));
});

test('a stored flag that is not the boolean true is not an all-day commitment', () => {
  // Not reachable through the domain, which types it — reachable through a
  // document somebody edited by hand, and the direction of the mistake matters:
  // a truthy string must not become a day-long entry on a shared calendar.
  const spec = normalizeStoredTimeSpec({
    kind: 'due_by', dueAt: '2026-09-20T12:00:00.000Z', allDay: 'yes' as unknown as boolean, timezone: ZONE,
  });
  assert.equal(spec.allDay, false);
});

test('an end that is not a date at all is refused rather than stored', () => {
  // `Date.parse('nonsense')` is `NaN`, and every comparison against `NaN` is
  // false — so without this the "after its start" guard below waves it through
  // and the garbage reaches storage.
  assert.throws(
    () => timeSpecOf(draft({ kind: 'due_by', dueAt: '2026-09-20T12:00:00.000Z', endAt: 'next tuesday' })),
    /endAt must be a valid ISO date/,
  );
});

/* ── An hour chosen through the only door that can choose one ─────── */

/**
 * `optionalInstant` refuses a bare `YYYY-MM-DD` for `dueDate` (#352), so every
 * due date that reaches here names a time of day. The question is therefore not
 * whether the client sent a date or a time — it is whether the instant it sent
 * is still the midnight the flag is a claim about.
 */
test('moving an all-day commitment to an hour of the day ends its all-day-ness', () => {
  const allDay = current({ dueAt: localMidnightOf('2026-09-20', ZONE), endAt: null, allDay: true });
  const patched = patchTimeSpecForTest(allDay, { dueDate: '2026-09-22T15:30:00.000Z' }, CLOCK);
  assert.equal(patched?.dueAt, '2026-09-22T15:30:00.000Z');
  assert.equal(patched?.allDay, false, 'the user chose an hour; the flag says nobody did');
});

test('moving an all-day commitment to another whole day keeps it all-day', () => {
  const allDay = current({ dueAt: localMidnightOf('2026-09-20', ZONE), endAt: null, allDay: true });
  const patched = patchTimeSpecForTest(allDay, { dueDate: localMidnightOf('2026-09-26', ZONE) }, CLOCK);
  assert.equal(patched?.allDay, true);
  assert.equal(patched?.dueAt, localMidnightOf('2026-09-26', ZONE));
});

test('a timed commitment moved to midnight does not become all-day by accident', () => {
  const patched = patchTimeSpecForTest(current({ endAt: null }), { dueDate: localMidnightOf('2026-09-26', ZONE) }, CLOCK);
  assert.equal(patched?.allDay, false);
});

/* ── A span of days is a count of days, not of milliseconds ───────── */

/**
 * Asia/Jerusalem puts its clocks back on 2026-10-25, so the two days from the
 * 24th to the 26th are 49 hours and not 48. Carrying the length in
 * milliseconds moved the end to 23:00 on the 25th — no longer a midnight, so no
 * longer a day boundary at all — and the entry lost a day.
 */
const DST_END_DAY = '2026-10-25';

function localWallClock(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: ZONE, dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23',
  }).format(new Date(iso));
}

test('an all-day span keeps its number of days across a clock change, not its hours', () => {
  const span = current({
    dueAt: localMidnightOf('2026-09-20', ZONE),
    endAt: localMidnightOf('2026-09-22', ZONE),
    allDay: true,
  });
  const moved = patchTimeSpecForTest(span, { dueDate: localMidnightOf('2026-10-24', ZONE) }, CLOCK);
  assert.equal(moved?.endAt, localMidnightOf('2026-10-26', ZONE), 'two days after the 24th is the 26th');
  assert.equal(localWallClock(moved!.endAt as string), `26/10/2026, 00:00`);
  assert.equal(localDaysBetween(moved!.dueAt as string, moved!.endAt as string, ZONE), 2);
  // And the clocks really did change inside the span, so this is the case and
  // not a day that happens to be ordinary.
  assert.notEqual(
    Date.parse(moved!.endAt as string) - Date.parse(moved!.dueAt as string),
    Date.parse(span.endAt!) - Date.parse(span.dueAt!),
    `nothing to test unless ${DST_END_DAY} falls inside the moved span`,
  );
});

test('a timed meeting keeps its hours across the same clock change', () => {
  // The control, and the reason the branch is on `allDay` rather than applied
  // to everything: a two-hour meeting is two hours on any day of the year.
  const meeting = current({ dueAt: '2026-09-20T11:00:00.000Z', endAt: '2026-09-20T13:00:00.000Z' });
  const moved = patchTimeSpecForTest(meeting, { dueDate: '2026-10-26T12:00:00.000Z' }, CLOCK);
  assert.equal(localWallClock(moved!.dueAt as string), '26/10/2026, 14:00');
  assert.equal(localWallClock(moved!.endAt as string), '26/10/2026, 16:00');
});

/* ── The edges of the patch boundary itself ───────────────────────── */

test('an end exactly on the start is refused by the patch, not left to the domain', () => {
  // `<` rather than `<=` here leaves a zero-length range for `defaultTimeSpec`
  // to refuse further down with a different message about a different field.
  // The boundary that was handed the value is the one that should answer.
  assert.throws(
    () => patchTimeSpecForTest(current(), { endDate: '2026-09-20T12:00:00.000Z' }, CLOCK),
    /endDate must be after the due date/,
  );
});

test('an end on a record that never had a start is dropped rather than carried', () => {
  // Not reachable through `defaultTimeSpec`, which refuses to store it. It is
  // reachable through this function, whose parameter is any `TimeSpec` at all,
  // and the answer must not be a range assembled out of half a record.
  const malformed = current({ dueAt: null, endAt: '2026-09-20T14:00:00.000Z' });
  const patched = patchTimeSpecForTest(malformed, { dueDate: '2026-09-22T09:00:00.000Z' }, CLOCK);
  assert.equal(patched?.endAt, null);
});
