/**
 * A weekly block as ONE recurring event in the phone's calendar — the plan.
 *
 * Every decision is a pure function of (blocks, stored links, write target,
 * chosen calendar), like the commitment sync's `decide`: create, update,
 * delete, forget. The native writes are behind `DeviceCalendar` and cannot be
 * observed without a device; which of them is chosen can be, and is, here.
 */
import { describe, expect, it } from '@jest/globals';
import type { WeeklyBlock } from '../../../api/schemas/weeklyBlocks';
import {
  hideWeeklyDuplicates,
  planWeeklyEvents,
  weeklyDrafts,
  weeklyHash,
  type WeeklyEventLink,
} from '../weeklyDeviceEvents';

const ZONE = 'Asia/Jerusalem';

function block(over: Partial<WeeklyBlock> = {}): WeeklyBlock {
  const base = {
    id: 'b1',
    title: 'تدريب',
    weekdays: [6],
    start: '10:00',
    end: '16:00',
    timezone: ZONE,
    status: 'active' as const,
    source: 'capture' as const,
    createdAt: '2026-09-29T09:00:00.000Z',
    updatedAt: '2026-09-29T09:00:00.000Z',
    confirmedAt: '2026-09-29T09:00:00.000Z',
    startsOn: '2026-10-01',
  };
  const merged = { ...base, ...over };
  return {
    ...merged,
    deviceEvent: over.deviceEvent !== undefined ? over.deviceEvent : merged.status === 'active'
      ? { title: merged.title, weekdays: merged.weekdays, start: merged.start, end: merged.end, timezone: merged.timezone, startsOn: merged.startsOn }
      : null,
  };
}

function linkFor(b: WeeklyBlock, over: Partial<WeeklyEventLink> = {}): WeeklyEventLink {
  return { blockId: b.id, calendarId: 'cal-1', eventIds: ['evt-1'], contentHash: weeklyHash(b.deviceEvent!, true), ...over };
}

const base = { writeTarget: 'device' as const, calendarId: 'cal-1', multiDayRule: true };

describe('weeklyDrafts', () => {
  it('starts on the first of its days on or after startsOn, at its hour in its own zone', () => {
    // 2026-10-01 is a Thursday; the first Saturday is the 3rd, 10:00 in Jerusalem = 07:00Z.
    const [draft, ...rest] = weeklyDrafts('b1', block().deviceEvent!, true);
    expect(rest).toEqual([]);
    expect(draft!.startDate.toISOString()).toBe('2026-10-03T07:00:00.000Z');
    expect(draft!.endDate.toISOString()).toBe('2026-10-03T13:00:00.000Z');
    expect(draft!.timeZone).toBe(ZONE);
    expect(draft!.allDay).toBe(false);
    expect(draft!.title).toBe('تدريب');
    expect(draft!.recurrence).toEqual({ weekdays: [6] });
  });

  it('is one event for several days where the platform can say BYDAY', () => {
    const drafts = weeklyDrafts('b1', block({ weekdays: [0, 1, 2, 3, 4] }).deviceEvent!, true);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.recurrence.weekdays).toEqual([0, 1, 2, 3, 4]);
    // The Thursday of startsOn is itself a day of the block.
    expect(drafts[0]!.startDate.toISOString()).toBe('2026-10-01T07:00:00.000Z');
  });

  it('is one weekly series per day where it cannot (expo-calendar on Android writes FREQ=WEEKLY only)', () => {
    const drafts = weeklyDrafts('b1', block({ weekdays: [4, 0] }).deviceEvent!, false);
    expect(drafts.map((draft) => [draft.recurrence.weekdays, draft.startDate.toISOString()])).toEqual([
      [[0], '2026-10-04T07:00:00.000Z'],
      [[4], '2026-10-01T07:00:00.000Z'],
    ]);
  });

  it('keeps the wall clock across the clock change: a winter start is 08:00Z', () => {
    const [draft] = weeklyDrafts('b1', block({ startsOn: '2026-11-01' }).deviceEvent!, true);
    expect(draft!.startDate.toISOString()).toBe('2026-11-07T08:00:00.000Z');
  });

  it('hashes what the calendar shows, so an unchanged block is never rewritten', () => {
    const one = weeklyHash(block().deviceEvent!, true);
    expect(weeklyHash(block({ updatedAt: '2026-09-30T00:00:00.000Z' }).deviceEvent!, true)).toBe(one);
    for (const changed of [{ title: 'x' }, { weekdays: [5] }, { start: '09:00' }, { end: '17:00' }, { startsOn: '2026-10-08' }]) {
      expect(weeklyHash(block(changed).deviceEvent!, true)).not.toBe(one);
    }
    // The same block written as per-day series is a different set of events.
    expect(weeklyHash(block().deviceEvent!, false)).not.toBe(one);
  });
});

describe('planWeeklyEvents', () => {
  it('creates one event for an active block with no link', () => {
    const plans = planWeeklyEvents({ ...base, blocks: [block()], links: [] });
    expect(plans.map((plan) => plan.kind)).toEqual(['create']);
  });

  it('writes nothing when the target is not this phone\'s calendar', () => {
    for (const writeTarget of ['off', 'google'] as const) {
      expect(planWeeklyEvents({ ...base, writeTarget, blocks: [block()], links: [] })).toEqual([]);
      // …and chases no change to one already written.
      expect(planWeeklyEvents({ ...base, writeTarget, blocks: [block({ title: 'new' })], links: [linkFor(block())] })).toEqual([]);
    }
  });

  it('writes nothing with no calendar chosen', () => {
    expect(planWeeklyEvents({ ...base, calendarId: null, blocks: [block()], links: [] })).toEqual([]);
  });

  it('does nothing for a block whose event already says this', () => {
    expect(planWeeklyEvents({ ...base, blocks: [block()], links: [linkFor(block())] })).toEqual([]);
  });

  it('updates the event when the block changed', () => {
    const plans = planWeeklyEvents({ ...base, blocks: [block({ start: '09:00' })], links: [linkFor(block())] });
    expect(plans.map((plan) => plan.kind)).toEqual(['update']);
    expect(plans[0]).toMatchObject({ blockId: 'b1', link: { eventIds: ['evt-1'] } });
  });

  it('deletes the event of a paused block, whatever the target', () => {
    const paused = block({ status: 'paused' });
    for (const writeTarget of ['device', 'off'] as const) {
      const plans = planWeeklyEvents({ ...base, writeTarget, blocks: [paused], links: [linkFor(block())] });
      expect(plans).toEqual([{ kind: 'delete', blockId: 'b1', link: linkFor(block()) }]);
    }
  });

  it('deletes the event of a block the account no longer has', () => {
    const plans = planWeeklyEvents({ ...base, blocks: [], links: [linkFor(block())] });
    expect(plans).toEqual([{ kind: 'delete', blockId: 'b1', link: linkFor(block()) }]);
  });

  it('never recreates an event the person deleted by hand, and forgets it with the block', () => {
    const detached = linkFor(block(), { detached: true });
    expect(planWeeklyEvents({ ...base, blocks: [block({ title: 'changed' })], links: [detached] })).toEqual([]);
    expect(planWeeklyEvents({ ...base, blocks: [block({ status: 'paused' })], links: [detached] })).toEqual([]);
    expect(planWeeklyEvents({ ...base, blocks: [], links: [detached] })).toEqual([{ kind: 'forget', blockId: 'b1' }]);
  });

  it('treats a list that has not loaded as unknown, not as empty — it deletes nothing', () => {
    expect(planWeeklyEvents({ ...base, blocks: undefined, links: [linkFor(block())] })).toEqual([]);
  });
});

describe('hideWeeklyDuplicates', () => {
  const occurrence = { startAt: '2026-10-03T07:00:00.000Z', endAt: '2026-10-03T13:00:00.000Z' };
  const busy = (nativeId: string, startAt: string, endAt: string) => ({ nativeId, startAt, endAt, allDay: false });

  it('hides the device event this app wrote for a block', () => {
    const shown = hideWeeklyDuplicates([busy('evt-1', '2026-10-10T07:00:00.000Z', '2026-10-10T13:00:00.000Z')], new Set(['evt-1']), []);
    expect(shown).toEqual([]);
  });

  it('hides busy time that is exactly a block occurrence, even with no id (another phone, Google)', () => {
    const shown = hideWeeklyDuplicates([busy('google-x', occurrence.startAt, occurrence.endAt)], new Set(), [occurrence]);
    expect(shown).toEqual([]);
  });

  it('keeps anything else, including an overlap that is not the same interval', () => {
    const other = busy('evt-9', '2026-10-03T08:00:00.000Z', '2026-10-03T09:00:00.000Z');
    expect(hideWeeklyDuplicates([other], new Set(['evt-1']), [occurrence])).toEqual([other]);
  });
});
