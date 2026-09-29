/**
 * The weekly blocks' device events, carried out against a fake calendar.
 *
 * What cannot be seen without a device is whether an event appears. What can
 * be seen is every call made, in order, and what is recorded — which is where
 * the damage would be: a second event per launch, a permission prompt for an
 * account with the switch off, or another account's events deleted.
 */
import { describe, expect, it } from '@jest/globals';
import type { CalendarAccess, CalendarEventDraft, DeviceCalendar } from '../../calendar/deviceCalendar';
import { DeviceCalendarError } from '../../calendar/deviceCalendar';
import type { WeeklyBlock } from '../../../api/schemas/weeklyBlocks';
import { weeklyHash, type WeeklyEventLink } from '../weeklyDeviceEvents';
import { reconcileWeeklyEvents } from '../weeklyEventSync';

function block(over: Partial<WeeklyBlock> = {}): WeeklyBlock {
  const b = {
    id: 'b1', title: 'تدريب', weekdays: [6], start: '10:00', end: '16:00', timezone: 'Asia/Jerusalem',
    status: 'active' as const, source: 'manual' as const, createdAt: '2026-09-29T09:00:00.000Z', updatedAt: '2026-09-29T09:00:00.000Z',
    confirmedAt: '2026-09-29T09:00:00.000Z', startsOn: '2026-10-01', ...over,
  };
  return { ...b, deviceEvent: b.status === 'active' ? { title: b.title, weekdays: b.weekdays, start: b.start, end: b.end, timezone: b.timezone, startsOn: b.startsOn } : null };
}

function fake(options: { access?: CalendarAccess; links?: WeeklyEventLink[] | null; missing?: string[]; failCreateAfter?: number; saveFails?: boolean } = {}) {
  const calls: string[] = [];
  const events = new Map<string, CalendarEventDraft>();
  const remembered = new Set<string>();
  let saved: WeeklyEventLink[] | null = options.links === undefined ? [] : options.links;
  let next = 0;
  const calendar: DeviceCalendar = {
    getAccess: async () => { calls.push('getAccess'); return options.access ?? 'granted'; },
    requestAccess: async () => { calls.push('requestAccess'); return 'granted'; },
    listWritableCalendars: async () => [],
    listEventCalendars: async () => [],
    fetchBusyBlocks: async () => [],
    createEvent: async (calendarId, draft) => {
      if (options.failCreateAfter !== undefined && next >= options.failCreateAfter) throw new DeviceCalendarError('calendar_read_only', 'no');
      next += 1;
      const id = `evt-${next}`;
      calls.push(`create:${calendarId}:${id}`);
      events.set(id, draft);
      return id;
    },
    updateEvent: async (id, draft) => { calls.push(`update:${id}`); events.set(id, draft); },
    deleteEvent: async (id) => { calls.push(`delete:${id}`); events.delete(id); },
    eventExists: async (id) => { calls.push(`exists:${id}`); return !(options.missing ?? []).includes(id); },
  };
  return {
    calls, events, remembered,
    get saved() { return saved; },
    ports: {
      calendar,
      loadLinks: async () => (saved === null ? null : [...saved]),
      saveLinks: async (links: readonly WeeklyEventLink[]) => { if (options.saveFails) return false; saved = [...links]; return true; },
      rememberEvent: async (id: string) => { remembered.add(id); },
      forgetEvent: async (id: string) => { remembered.delete(id); },
    },
  };
}

const on = { writeTarget: 'device' as const, calendarId: 'cal-1', multiDayRule: true };

describe('create', () => {
  it('writes one recurring event per block and records it', async () => {
    const f = fake();
    const outcome = await reconcileWeeklyEvents({ ...on, blocks: [block()], ports: f.ports });
    expect(outcome.created).toBe(1);
    expect(f.calls).toEqual(['getAccess', 'create:cal-1:evt-1']);
    expect(f.events.get('evt-1')?.recurrence).toEqual({ weekdays: [6] });
    expect(f.saved).toEqual([{ blockId: 'b1', calendarId: 'cal-1', eventIds: ['evt-1'], contentHash: weeklyHash(block().deviceEvent!, true) }]);
    // The busy read skips it.
    expect([...f.remembered]).toEqual(['evt-1']);
  });

  it('writes nothing more on the next pass', async () => {
    const f = fake();
    await reconcileWeeklyEvents({ ...on, blocks: [block()], ports: f.ports });
    f.calls.length = 0;
    await reconcileWeeklyEvents({ ...on, blocks: [block()], ports: f.ports });
    expect(f.calls).toEqual([]);
  });

  it('asks the OS nothing with the switch off', async () => {
    const f = fake();
    await reconcileWeeklyEvents({ ...on, writeTarget: 'off', blocks: [block()], ports: f.ports });
    expect(f.calls).toEqual([]);
  });

  it('writes nothing when access was not granted', async () => {
    const f = fake({ access: 'denied' });
    const outcome = await reconcileWeeklyEvents({ ...on, blocks: [block()], ports: f.ports });
    expect(outcome.permissionDenied).toBe(true);
    expect(f.calls).toEqual(['getAccess']);
  });

  it('takes the event back out when the record of it cannot be kept', async () => {
    const f = fake({ saveFails: true });
    const outcome = await reconcileWeeklyEvents({ ...on, blocks: [block()], ports: f.ports });
    expect(outcome.storageFailed).toBe(true);
    expect(f.events.size).toBe(0);
    expect(f.remembered.size).toBe(0);
  });

  it('does nothing at all when the record cannot be read', async () => {
    const f = fake({ links: null });
    const outcome = await reconcileWeeklyEvents({ ...on, blocks: [block()], ports: f.ports });
    expect(outcome.storageFailed).toBe(true);
    expect(f.calls).toEqual([]);
  });

  it('writes one series per day where the rule cannot carry days, and none of them if one fails', async () => {
    const ok = fake();
    await reconcileWeeklyEvents({ ...on, multiDayRule: false, blocks: [block({ weekdays: [0, 1] })], ports: ok.ports });
    expect(ok.saved?.[0]?.eventIds).toEqual(['evt-1', 'evt-2']);

    const half = fake({ failCreateAfter: 1 });
    const outcome = await reconcileWeeklyEvents({ ...on, multiDayRule: false, blocks: [block({ weekdays: [0, 1] })], ports: half.ports });
    expect(outcome.skipped).toBe(1);
    expect(half.events.size).toBe(0);
    expect(half.saved).toEqual([]);
  });
});

describe('update', () => {
  const written = (b: WeeklyBlock, ids = ['evt-7']): WeeklyEventLink => ({ blockId: b.id, calendarId: 'cal-1', eventIds: ids, contentHash: weeklyHash(b.deviceEvent!, true) });

  it('rewrites the same event when the block changed', async () => {
    const f = fake({ links: [written(block())] });
    const outcome = await reconcileWeeklyEvents({ ...on, blocks: [block({ end: '17:00' })], ports: f.ports });
    expect(outcome.updated).toBe(1);
    expect(f.calls).toEqual(['getAccess', 'exists:evt-7', 'update:evt-7']);
    expect(f.saved?.[0]?.contentHash).toBe(weeklyHash(block({ end: '17:00' }).deviceEvent!, true));
  });

  it('never writes back an event the person deleted in their calendar', async () => {
    const f = fake({ links: [written(block())], missing: ['evt-7'] });
    const outcome = await reconcileWeeklyEvents({ ...on, blocks: [block({ end: '17:00' })], ports: f.ports });
    expect(outcome.detached).toBe(1);
    expect(f.calls).toEqual(['getAccess', 'exists:evt-7']);
    expect(f.saved?.[0]?.detached).toBe(true);
    f.calls.length = 0;
    await reconcileWeeklyEvents({ ...on, blocks: [block({ end: '18:00' })], ports: f.ports });
    expect(f.calls).toEqual([]);
  });

  it('adds and removes per-day series as days are added and removed', async () => {
    const perDay = (b: WeeklyBlock, ids: string[]): WeeklyEventLink => ({ ...written(b, ids), contentHash: weeklyHash(b.deviceEvent!, false) });
    const f = fake({ links: [perDay(block({ weekdays: [0, 1, 2] }), ['a', 'b', 'c'])] });
    await reconcileWeeklyEvents({ ...on, multiDayRule: false, blocks: [block({ weekdays: [0] })], ports: f.ports });
    expect(f.calls).toEqual(['getAccess', 'exists:a', 'exists:b', 'exists:c', 'update:a', 'delete:b', 'delete:c']);
    expect(f.saved?.[0]?.eventIds).toEqual(['a']);
  });
});

describe('delete', () => {
  it('removes the event of a paused block and forgets it — switch on or off', async () => {
    for (const writeTarget of ['device', 'off'] as const) {
      const link: WeeklyEventLink = { blockId: 'b1', calendarId: 'cal-1', eventIds: ['evt-7'], contentHash: 'x' };
      const f = fake({ links: [link] });
      const outcome = await reconcileWeeklyEvents({ ...on, writeTarget, blocks: [block({ status: 'paused' })], ports: f.ports });
      expect(outcome.deleted).toBe(1);
      expect(f.calls).toEqual(['getAccess', 'delete:evt-7']);
      expect(f.saved).toEqual([]);
    }
  });

  it('removes the event of a deleted block, and nothing while the list is unknown', async () => {
    const link: WeeklyEventLink = { blockId: 'b1', calendarId: 'cal-1', eventIds: ['evt-7'], contentHash: 'x' };
    const unknown = fake({ links: [link] });
    await reconcileWeeklyEvents({ ...on, blocks: undefined, ports: unknown.ports });
    expect(unknown.calls).toEqual([]);
    const gone = fake({ links: [link] });
    await reconcileWeeklyEvents({ ...on, blocks: [], ports: gone.ports });
    expect(gone.calls).toEqual(['getAccess', 'delete:evt-7']);
  });

  it('stops at a revoked permission and keeps the record of what is still there', async () => {
    const link: WeeklyEventLink = { blockId: 'b1', calendarId: 'cal-1', eventIds: ['evt-7'], contentHash: 'x' };
    const f = fake({ links: [link] });
    f.ports.calendar.deleteEvent = async () => { throw new DeviceCalendarError('permission_denied', 'no'); };
    const outcome = await reconcileWeeklyEvents({ ...on, blocks: [], ports: f.ports });
    expect(outcome.permissionDenied).toBe(true);
    expect(f.saved).toEqual([link]);
  });
});
