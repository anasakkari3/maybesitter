/**
 * The server's commitment as the screens read it (UC-2.R3 #173, ranking #169).
 *
 * The claim worth a test is that ranking orders items *inside* a group and
 * never across one. Must, Should and Nice are the user's own answer to "how
 * much does this matter"; a rank that could put a Nice above a Must would be
 * the product overruling them with an estimate.
 */
import { describe, expect, it } from '@jest/globals';
import { clockOf, groupForToday, toViewModel, topItemFor } from '../model';
import type { Commitment } from '../../../api/schemas/common';

const NOW = '2026-09-13T09:00:00.000Z';

function commitment(overrides: Partial<Commitment> & { id: string }): Commitment {
  return {
    kind: 'task',
    title: overrides.title ?? overrides.id,
    description: null,
    person: null,
    status: 'active',
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureLevel: 'none' },
    timeSpec: { kind: 'due_by', dueAt: '2026-09-13T12:00:00.000Z', endAt: null, remindAt: null, allDay: false, timezone: 'UTC' },
    currentAckState: 'not_seen',
    postponedUntil: null,
    createdAt: '2026-09-01T09:00:00.000Z',
    updatedAt: '2026-09-01T09:00:00.000Z',
    confirmedAt: '2026-09-01T09:00:00.000Z',
    completedAt: null,
    droppedAt: null,
    ...overrides,
    // After the spread: `overrides` may legitimately carry `id`, and the
    // default title above needs to have read it first.
    id: overrides.id,
  } as Commitment;
}

function withPriority(id: string, level: 'low' | 'normal' | 'high', source = 'default'): Commitment {
  return commitment({
    id,
    priority: { level, source, pressureAllowed: false, pressureLevel: 'none' } as Commitment['priority'],
  });
}

it('keeps a postponed return separate from the original due time', () => {
  const view = toViewModel(commitment({
    id: 'moved',
    currentAckState: 'postponed',
    postponedUntil: '2026-09-20T09:00:00.000Z',
  }), NOW);
  expect(view.shownAt).toBe('2026-09-13T12:00:00.000Z');
  expect(view.postponedUntil).toBe('2026-09-20T09:00:00.000Z');
});

describe('importance', () => {
  it('maps the three levels to the three the design draws', () => {
    expect(toViewModel(withPriority('a', 'high'), NOW).importance).toBe('must');
    expect(toViewModel(withPriority('b', 'normal'), NOW).importance).toBe('should');
    expect(toViewModel(withPriority('c', 'low'), NOW).importance).toBe('nice');
  });

  it('says whether the user chose it or it was read off their words', () => {
    expect(toViewModel(withPriority('a', 'high', 'user_explicit'), NOW).importanceIsStated).toBe(true);
    expect(toViewModel(withPriority('b', 'high', 'inferred'), NOW).importanceIsStated).toBe(false);
    expect(toViewModel(withPriority('c', 'high', 'default'), NOW).importanceIsStated).toBe(false);
  });
});

describe('status', () => {
  it('maps every status the lists can carry', () => {
    const cases: Array<[string, string]> = [
      ['active', 'active'], ['pending_confirmation', 'active'], ['postponed', 'active'],
      ['missed', 'active'], ['completed', 'done'], ['dropped', 'dropped'],
      ['cancelled', 'dropped'], ['archived', 'dropped'],
    ];
    for (const [domain, view] of cases) {
      expect(toViewModel(commitment({ id: domain, status: domain }), NOW).status).toBe(view);
    }
  });

  it('treats an unknown status as active rather than hiding the item', () => {
    // Hiding is the worse failure: a commitment the user made, absent from the
    // list, with nothing to say it was ever there.
    expect(toViewModel(commitment({ id: 'x', status: 'something_new' }), NOW).status).toBe('active');
  });
});

describe('a time that has passed', () => {
  it('is flagged, but is not a status', () => {
    // There is no "overdue" in this product. A missed thing is still active.
    const past = toViewModel(commitment({
      id: 'past', timeSpec: { kind: 'due_by', dueAt: '2026-09-13T08:00:00.000Z', endAt: null, remindAt: null, allDay: false, timezone: 'UTC' },
    }), NOW);
    expect(past.isPast).toBe(true);
    expect(past.status).toBe('active');
  });

  it('is never flagged for something already finished', () => {
    const done = toViewModel(commitment({
      id: 'done', status: 'completed',
      timeSpec: { kind: 'due_by', dueAt: '2026-09-13T08:00:00.000Z', endAt: null, remindAt: null, allDay: false, timezone: 'UTC' },
    }), NOW);
    expect(done.isPast).toBe(false);
  });

  it('falls back to the reminder when there is no due time', () => {
    const view = toViewModel(commitment({
      id: 'r', timeSpec: { kind: 'due_by', dueAt: null, endAt: null, remindAt: '2026-09-13T08:00:00.000Z', allDay: false, timezone: 'UTC' },
    }), NOW);
    expect(view.shownAt).toBe('2026-09-13T08:00:00.000Z');
    expect(view.isPast).toBe(true);
  });

  it('is never flagged for something with no time at all', () => {
    const view = toViewModel(commitment({
      id: 'n', timeSpec: { kind: 'unscheduled', dueAt: null, endAt: null, remindAt: null, allDay: false, timezone: 'UTC' },
    }), NOW);
    expect(view.shownAt).toBeNull();
    expect(view.isPast).toBe(false);
  });
});

describe('grouping', () => {
  it('puts each item in the group its importance names', () => {
    const groups = groupForToday(
      [withPriority('m', 'high'), withPriority('s', 'normal'), withPriority('n', 'low')],
      NOW,
    );
    expect(groups.must.map((v) => v.id)).toEqual(['m']);
    expect(groups.should.map((v) => v.id)).toEqual(['s']);
    expect(groups.nice.map((v) => v.id)).toEqual(['n']);
  });

  it('collects done and dropped together, out of the live groups', () => {
    const groups = groupForToday([
      commitment({ id: 'done', status: 'completed', priority: { level: 'high', source: 'default', pressureAllowed: false, pressureLevel: 'none' } as Commitment['priority'] }),
      commitment({ id: 'dropped', status: 'dropped' }),
      withPriority('live', 'high'),
    ], NOW);
    expect(groups.must.map((v) => v.id)).toEqual(['live']);
    expect(groups.finished.map((v) => v.id).sort()).toEqual(['done', 'dropped']);
  });

  it('orders by time when nothing is ranked', () => {
    const groups = groupForToday([
      commitment({ id: 'late', timeSpec: { kind: 'due_by', dueAt: '2026-09-13T18:00:00.000Z', endAt: null, remindAt: null, allDay: false, timezone: 'UTC' } }),
      commitment({ id: 'early', timeSpec: { kind: 'due_by', dueAt: '2026-09-13T10:00:00.000Z', endAt: null, remindAt: null, allDay: false, timezone: 'UTC' } }),
    ], NOW);
    expect(groups.should.map((v) => v.id)).toEqual(['early', 'late']);
  });

  it('orders by rank inside a group when every item carries one', () => {
    const groups = groupForToday([
      commitment({ id: 'second', rank: 1, timeSpec: { kind: 'due_by', dueAt: '2026-09-13T10:00:00.000Z', endAt: null, remindAt: null, allDay: false, timezone: 'UTC' } } as Partial<Commitment> & { id: string }),
      commitment({ id: 'first', rank: 0, timeSpec: { kind: 'due_by', dueAt: '2026-09-13T18:00:00.000Z', endAt: null, remindAt: null, allDay: false, timezone: 'UTC' } } as Partial<Commitment> & { id: string }),
    ], NOW);
    // Rank wins over time, which is the whole point of ranking.
    expect(groups.should.map((v) => v.id)).toEqual(['first', 'second']);
  });

  it('never lets a rank move an item out of its group', () => {
    // The claim this file exists for. A Nice ranked 0 stays below every Must.
    const groups = groupForToday([
      { ...withPriority('nice-but-urgent', 'low'), rank: 0 } as Commitment,
      { ...withPriority('must', 'high'), rank: 5 } as Commitment,
    ], NOW);
    expect(groups.must.map((v) => v.id)).toEqual(['must']);
    expect(groups.nice.map((v) => v.id)).toEqual(['nice-but-urgent']);
  });

  it('falls back to time order when only some items carry a rank', () => {
    // A half-ranked list is a bug somewhere upstream; ordering it by a rank
    // some items lack would put the unranked ones in an arbitrary place.
    const groups = groupForToday([
      { ...commitment({ id: 'ranked', timeSpec: { kind: 'due_by', dueAt: '2026-09-13T18:00:00.000Z', endAt: null, remindAt: null, allDay: false, timezone: 'UTC' } }), rank: 0 } as Commitment,
      commitment({ id: 'unranked', timeSpec: { kind: 'due_by', dueAt: '2026-09-13T10:00:00.000Z', endAt: null, remindAt: null, allDay: false, timezone: 'UTC' } }),
    ], NOW);
    expect(groups.should.map((v) => v.id)).toEqual(['unranked', 'ranked']);
  });
});

describe('the "why first" line', () => {
  it('goes to the first open card in the first non-empty group', () => {
    const groups = groupForToday([
      { ...withPriority('m', 'high'), rank: 0, reasonCodes: ['overdue'] } as Commitment,
      { ...withPriority('s', 'normal'), rank: 1, reasonCodes: ['due_today'] } as Commitment,
    ], NOW);
    expect(topItemFor(groups)?.id).toBe('m');
  });

  it('goes to nobody when the top item has nothing to say', () => {
    // An item whose reason is "it is simply next" gets no line, rather than a
    // filler one. Every card explaining itself is no explanation at all.
    const groups = groupForToday([{ ...withPriority('m', 'high'), rank: 0, reasonCodes: [] } as Commitment], NOW);
    expect(topItemFor(groups)).toBeNull();
  });

  it('goes to nobody when there is nothing open', () => {
    const groups = groupForToday([commitment({ id: 'done', status: 'completed' })], NOW);
    expect(topItemFor(groups)).toBeNull();
  });
});

/**
 * An all-day commitment names a day, not an hour (FX3): «أدفع فاتورة الكهربا
 * قبل آخر الشهر» is due by the 30th, stored as that day's local midnight with
 * `allDay`. The midnight is not a time anybody chose, so no screen may show it
 * as «00:00».
 */
describe('an all-day commitment', () => {
  const allDay = commitment({
    id: 'bill',
    timeSpec: { kind: 'due_by', dueAt: '2026-09-29T21:00:00.000Z', endAt: null, remindAt: null, allDay: true, timezone: 'Asia/Jerusalem' },
  });

  it('is marked all-day on the view, and keeps its day', () => {
    const view = toViewModel(allDay, NOW);
    expect(view.allDay).toBe(true);
    expect(view.shownAt).toBe('2026-09-29T21:00:00.000Z');
    expect(toViewModel(commitment({ id: 'timed' }), NOW).allDay).toBe(false);
  });

  it('has no clock to show, while a timed one does', () => {
    const opts = { locale: 'en' as const, timeZone: 'Asia/Jerusalem' };
    expect(clockOf(toViewModel(allDay, NOW), opts)).toBeNull();
    expect(clockOf(toViewModel(commitment({ id: 'timed' }), NOW), opts)).toContain('15:00');
    expect(clockOf({ shownAt: null }, opts)).toBeNull();
  });

  /*
   * FY1 review M2: an all-day appointment on its own day read `isPast` from
   * 00:00, because its stored instant is that day's local midnight. It is
   * today's until the day ends — in the zone the day was named in.
   */
  it('is not past on its own day, and is past once that day has ended in its zone', () => {
    const sunday = commitment({
      id: 'doctor',
      priority: { level: 'high', source: 'default', pressureAllowed: false, pressureLevel: 'none' },
      timeSpec: { kind: 'scheduled_event', dueAt: '2026-09-26T21:00:00.000Z', endAt: null, remindAt: null, allDay: true, timezone: 'Asia/Jerusalem' },
    } as Partial<Commitment> & { id: string });
    // Sunday 27 Sep in Jerusalem: 00:30, noon, 23:59.
    expect(toViewModel(sunday, '2026-09-26T21:30:00.000Z').isPast).toBe(false);
    expect(toViewModel(sunday, '2026-09-27T09:00:00.000Z').isPast).toBe(false);
    expect(toViewModel(sunday, '2026-09-27T20:59:00.000Z').isPast).toBe(false);
    // Monday 00:00 in Jerusalem: Sunday is over.
    expect(toViewModel(sunday, '2026-09-27T21:00:00.000Z').isPast).toBe(true);
  });
});
