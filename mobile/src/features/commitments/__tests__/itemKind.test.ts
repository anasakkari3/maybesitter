/**
 * Event or task on the phone (lane E1, owner decision 2026-11-13): what
 * capture's model said the item is arrives on `timeSpec.itemKind`, and wins
 * over the title the same way it does on the server
 * (`lib/services/commitments/eventEnded.ts`).
 */
import { describe, expect, it } from '@jest/globals';
import { commitmentSchema, type Commitment } from '../../../api/schemas/common';
import { toViewModel } from '../model';
import { hasEventEnded, isEventView } from '../eventEnded';

const TZ = 'Asia/Jerusalem';
const NOW = new Date('2026-11-12T13:00:00.000Z');

function commitment(title: string, timeSpec: Partial<Commitment['timeSpec']> = {}): Commitment {
  return {
    id: 'c1',
    kind: 'task',
    title,
    description: null,
    person: null,
    status: 'active',
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureLevel: 'none' },
    category: null,
    categorySource: 'inferred',
    timeSpec: { kind: 'scheduled_event', dueAt: '2026-11-12T07:00:00.000Z', endAt: null, remindAt: null, allDay: false, timezone: TZ, ...timeSpec },
    currentAckState: 'not_seen',
    postponedUntil: null,
    createdAt: '2026-11-01T09:00:00.000Z',
    updatedAt: '2026-11-01T09:00:00.000Z',
    confirmedAt: '2026-11-01T09:00:00.000Z',
    completedAt: null,
    droppedAt: null,
  } as Commitment;
}

const view = (c: Commitment) => toViewModel(c, NOW.toISOString());

describe('itemKind', () => {
  it('survives the response schema, and an unknown kind reads as none', () => {
    const parsed = commitmentSchema.parse(commitment('محمد عند الحلاق', { itemKind: 'event' }));
    expect(parsed.timeSpec.itemKind).toBe('event');
    expect(commitmentSchema.parse(commitment('أشتري دوا')).timeSpec.itemKind).toBeUndefined();
    const unknown = commitmentSchema.safeParse(commitment('x', { itemKind: 'meeting' as never }));
    expect(unknown.success).toBe(true);
    expect(unknown.success && unknown.data.timeSpec.itemKind).toBeUndefined();
  });

  it('an item the model called an event is over an hour after it starts, whatever its title', () => {
    const v = view(commitment('محمد عند الحلاق', { itemKind: 'event' }));
    expect(isEventView(v)).toBe(true);
    expect(hasEventEnded(v, NOW)).toBe(true);
    expect(v.timedEvent).toBe(true);
  });

  it('a meeting-titled item the model called a task stays, and is not a timed event', () => {
    const v = view(commitment('اجتماع مع سامي', { itemKind: 'task' }));
    expect(isEventView(v)).toBe(false);
    expect(hasEventEnded(v, NOW)).toBe(false);
    expect(v.timedEvent).toBe(false);
  });

  it('a work block with an end the model called a task is not an event', () => {
    const v = view(commitment('أشتغل على التقرير', { endAt: '2026-11-12T09:00:00.000Z', itemKind: 'task' }));
    expect(isEventView(v)).toBe(false);
  });

  it('an all-day item stays an event whatever the model said', () => {
    const v = view(commitment('موعد دكتور', { dueAt: '2026-11-10T22:00:00.000Z', allDay: true, itemKind: 'task' }));
    expect(isEventView(v)).toBe(true);
  });

  it('with no stored kind the title answers, as before', () => {
    expect(isEventView(view(commitment('اجتماع مع سامي')))).toBe(true);
    expect(isEventView(view(commitment('أشتري دوا')))).toBe(false);
  });
});
