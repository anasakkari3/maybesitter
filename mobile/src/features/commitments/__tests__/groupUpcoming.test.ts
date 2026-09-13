/**
 * The days ahead (UC-2.R3 #173).
 *
 * The grouping is by calendar day *in the user's timezone*, which is the one
 * thing here that can be wrong in a way nobody notices until a user in the
 * wrong hemisphere reports it.
 */
import { describe, expect, it } from '@jest/globals';
import { groupUpcoming } from '../model';
import type { Commitment } from '../../../api/schemas/common';

const NOW = '2026-09-13T09:00:00.000Z';

function at(id: string, dueAt: string | null, extra: Partial<Commitment> = {}): Commitment {
  return {
    id,
    kind: 'task',
    title: id,
    description: null,
    person: null,
    status: 'active',
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureLevel: 'none' },
    timeSpec: { kind: dueAt ? 'due_by' : 'unscheduled', dueAt, remindAt: null, timezone: 'UTC' },
    currentAckState: 'not_seen',
    postponedUntil: null,
    createdAt: NOW,
    updatedAt: NOW,
    confirmedAt: NOW,
    completedAt: null,
    droppedAt: null,
    ...extra,
  } as Commitment;
}

describe('grouping into days', () => {
  it('puts each item on its own local day, in order', () => {
    const days = groupUpcoming([
      at('friday', '2026-09-18T10:00:00.000Z'),
      at('thursday-late', '2026-09-17T20:00:00.000Z'),
      at('thursday-early', '2026-09-17T06:00:00.000Z'),
    ], NOW, 'UTC');

    expect(days.map((day) => day.key)).toEqual(['2026-09-17', '2026-09-18']);
    expect(days[0]!.items.map((item) => item.id)).toEqual(['thursday-early', 'thursday-late']);
  });

  it('reads the clock, not the ranking', () => {
    // #169's rank answers "what next", which is a question about now. Thursday
    // is not now, so a 17:00 must not be listed above a 09:00.
    const days = groupUpcoming([
      { ...at('evening', '2026-09-17T17:00:00.000Z'), rank: 0 } as Commitment,
      { ...at('morning', '2026-09-17T09:00:00.000Z'), rank: 9 } as Commitment,
    ], NOW, 'UTC');
    expect(days[0]!.items.map((item) => item.id)).toEqual(['morning', 'evening']);
  });

  it('breaks a same-minute tie by rank, then by id', () => {
    const days = groupUpcoming([
      { ...at('b-unranked', '2026-09-17T09:00:00.000Z') } as Commitment,
      { ...at('a-unranked', '2026-09-17T09:00:00.000Z') } as Commitment,
      { ...at('ranked', '2026-09-17T09:00:00.000Z'), rank: 1 } as Commitment,
    ], NOW, 'UTC');
    expect(days[0]!.items.map((item) => item.id)).toEqual(['ranked', 'a-unranked', 'b-unranked']);
  });
});

describe('the timezone decides the day', () => {
  it('splits one instant onto different days in different zones', () => {
    // 21:30 UTC on the 17th is 00:30 on the 18th in Jerusalem (+03).
    const instant = '2026-09-17T21:30:00.000Z';
    expect(groupUpcoming([at('x', instant)], NOW, 'UTC')[0]!.key).toBe('2026-09-17');
    expect(groupUpcoming([at('x', instant)], NOW, 'Asia/Jerusalem')[0]!.key).toBe('2026-09-18');
  });

  it('keeps two items on one local day even when they straddle UTC midnight', () => {
    const days = groupUpcoming([
      at('evening', '2026-09-17T20:00:00.000Z'),   // 23:00 local
      at('night', '2026-09-17T22:00:00.000Z'),     // 01:00 local, the 18th
    ], NOW, 'Asia/Jerusalem');
    expect(days.map((day) => day.key)).toEqual(['2026-09-17', '2026-09-18']);
  });

  it('gives each day a heading instant that lands on that day, even past +12', () => {
    // The bug this test exists for: a synthesised "midday UTC" heading instant
    // is already the next day in Kiritimati (+14), so every heading read off
    // by one there. The heading uses a real item's time instead.
    const zone = 'Pacific/Kiritimati';
    const days = groupUpcoming([
      at('a', '2026-09-17T20:00:00.000Z'),
      at('b', '2026-09-18T20:00:00.000Z'),
    ], NOW, zone);
    for (const day of days) {
      const rendered = new Intl.DateTimeFormat('en-CA', {
        timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date(day.at));
      expect(rendered).toBe(day.key);
    }
  });
});

describe('what never appears', () => {
  it('drops an undated item, which has no later day to be on', () => {
    expect(groupUpcoming([at('someday', null)], NOW, 'UTC')).toEqual([]);
  });

  it('drops a finished item rather than letting it hold a future slot', () => {
    const days = groupUpcoming([
      at('done', '2026-09-17T09:00:00.000Z', { status: 'completed' }),
      at('dropped', '2026-09-17T10:00:00.000Z', { status: 'dropped' }),
      at('live', '2026-09-17T11:00:00.000Z'),
    ], NOW, 'UTC');
    expect(days[0]!.items.map((item) => item.id)).toEqual(['live']);
  });

  it('returns nothing at all for an empty list, rather than an empty day', () => {
    expect(groupUpcoming([], NOW, 'UTC')).toEqual([]);
  });
});
