/**
 * Reading busy time off the phone (UC-3.2, #186 step 1).
 *
 * What a fixture can prove here is the *shape* of the read: that it asks for
 * twenty-eight days from the start of today, that it asks every event calendar
 * rather than only the writable ones, that a refusal is a `DeviceCalendarError`
 * rather than a native throw, and that the attendee lookup is bounded.
 *
 * What it cannot prove is the thing #186 step 1 asks for: whether Android's
 * provider expands a weekly event into instances or returns the master. No
 * amount of mocking answers that — the mock returns whatever this file puts in
 * it. It is written down in the PR as an owner check on a device, and
 * `toBusyBlocks` is built so that if the assumption is wrong the failure is
 * "one block instead of twelve", not a crash.
 *
 * ── Why the attendee cap has a test at all ───────────────────────
 *
 * `getAttendees()` is one round trip into EventKit per event. A calendar with a
 * thousand entries in the window would make a sync a thousand round trips on
 * the JS thread, and the sync runs when the app comes back to the front. The
 * cap is what stops a busy person's phone hanging on resume; without a case it
 * is a number nobody would notice being deleted.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockGetCalendarPermissions = jest.fn<() => Promise<unknown>>();
const mockGetCalendars = jest.fn<() => Promise<unknown[]>>();
const mockListEvents = jest.fn<(calendars: unknown[], start: Date, end: Date) => Promise<unknown[]>>();

jest.mock('expo-calendar', () => ({
  EntityTypes: { EVENT: 'event' },
  getCalendarPermissions: () => mockGetCalendarPermissions(),
  requestCalendarPermissions: async () => ({ granted: true, status: 'granted' }),
  getCalendars: () => mockGetCalendars(),
  listEvents: (calendars: unknown[], start: Date, end: Date) => mockListEvents(calendars, start, end),
  ExpoCalendar: { get: async () => ({}) },
  ExpoCalendarEvent: { get: async () => ({}) },
}));

// `jest-expo`'s default project is iOS, which is the platform the declined
// rule exists for. Android is asserted separately by flipping this.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Platform } = require('react-native') as typeof import('react-native');

// Imported after the mocks are registered.
const { deviceCalendar, DeviceCalendarError, ATTENDEE_LOOKUP_LIMIT, BUSY_LOOK_AHEAD_DAYS } =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../deviceCalendar') as typeof import('../deviceCalendar');

const NOW = new Date();
const MINUTE = 60_000;

function at(minutes: number): Date {
  return new Date(NOW.getTime() + minutes * MINUTE);
}

function event(over: Record<string, unknown> = {}) {
  return {
    id: 'evt-1',
    title: 'Oncology — Dr Haddad',
    notes: 'Bring the referral letter.',
    location: 'Rambam, floor 4',
    startDate: at(60),
    endDate: at(120),
    allDay: false,
    availability: 'busy',
    status: 'confirmed',
    getAttendees: async () => [],
    ...over,
  };
}

beforeEach(() => {
  (Platform as { OS: string }).OS = 'ios';
  for (const mock of [mockGetCalendarPermissions, mockGetCalendars, mockListEvents]) mock.mockReset();
  mockGetCalendarPermissions.mockResolvedValue({ granted: true, status: 'granted' });
  mockGetCalendars.mockResolvedValue([
    { id: 'cal-writable', allowsModifications: true },
    { id: 'cal-subscribed', allowsModifications: false },
  ]);
  mockListEvents.mockResolvedValue([]);
});

describe('the window that is asked for', () => {
  it('asks from the start of today for twenty-eight days', async () => {
    await deviceCalendar.fetchBusyBlocks({ now: NOW });
    const [, start, end] = mockListEvents.mock.calls[0]!;
    const midnight = new Date(NOW);
    midnight.setHours(0, 0, 0, 0);
    expect(start.getTime()).toBe(midnight.getTime());
    expect(Math.round((end.getTime() - start.getTime()) / (24 * 60 * MINUTE))).toBe(BUSY_LOOK_AHEAD_DAYS);
  });

  it('asks every event calendar, including the ones it could never write to', async () => {
    await deviceCalendar.fetchBusyBlocks({ now: NOW });
    expect(mockListEvents.mock.calls[0]![0]).toEqual(['cal-writable', 'cal-subscribed']);
  });

  it('asks nothing at all when there is no calendar to ask', async () => {
    mockGetCalendars.mockResolvedValue([]);
    expect(await deviceCalendar.fetchBusyBlocks({ now: NOW })).toEqual([]);
    expect(mockListEvents).not.toHaveBeenCalled();
  });
});

describe('calendars the user switched off (first iPhone run, L7)', () => {
  it('skips a calendar switched off in Calendar settings', async () => {
    await deviceCalendar.fetchBusyBlocks({ now: NOW, excludedCalendarIds: new Set(['cal-subscribed']) });
    expect(mockListEvents.mock.calls[0]![0]).toEqual(['cal-writable']);
  });

  it('asks nothing when every calendar is switched off', async () => {
    expect(await deviceCalendar.fetchBusyBlocks({
      now: NOW, excludedCalendarIds: new Set(['cal-writable', 'cal-subscribed']),
    })).toEqual([]);
    expect(mockListEvents).not.toHaveBeenCalled();
  });
});

describe('listing the calendars on this phone', () => {
  it('lists every event calendar with its account, writable or not', async () => {
    mockGetCalendars.mockResolvedValue([
      { id: 'a', title: 'Work', color: '#f00', allowsModifications: true, source: { name: 'Google' } },
      { id: 'b', title: 'Holidays', allowsModifications: false, source: { name: 'Subscribed Calendars' } },
      { id: 'c', title: 'Home', allowsModifications: true, ownerAccount: 'me@icloud.com' },
    ]);
    expect(await deviceCalendar.listEventCalendars()).toEqual([
      { id: 'a', title: 'Work', color: '#f00', sourceName: 'Google' },
      { id: 'b', title: 'Holidays', color: null, sourceName: 'Subscribed Calendars' },
      { id: 'c', title: 'Home', color: null, sourceName: 'me@icloud.com' },
    ]);
  });

  it('is a permission error when the phone says no', async () => {
    mockGetCalendars.mockRejectedValue(new Error('Calendar permission not authorized'));
    await expect(deviceCalendar.listEventCalendars()).rejects.toMatchObject({ reason: 'permission_denied' });
  });
});

describe('what comes back', () => {
  it('is busy blocks and not events', async () => {
    mockListEvents.mockResolvedValue([event()]);
    const blocks = await deviceCalendar.fetchBusyBlocks({ now: NOW });
    expect(blocks).toHaveLength(1);
    expect(Object.keys(blocks[0]!).sort()).toEqual(['allDay', 'endAt', 'nativeId', 'startAt']);
    expect(JSON.stringify(blocks)).not.toContain('Oncology');
  });

  it('leaves out the events this installation wrote', async () => {
    mockListEvents.mockResolvedValue([event({ id: 'ours' }), event({ id: 'theirs' })]);
    const blocks = await deviceCalendar.fetchBusyBlocks({ now: NOW, ownEventIds: new Set(['ours']) });
    expect(blocks.map((block) => block.nativeId)).toEqual(['theirs']);
  });
});

describe('a meeting the user declined', () => {
  it('is not busy time, on a platform that can say so', async () => {
    mockListEvents.mockResolvedValue([
      event({ id: 'declined', getAttendees: async () => [
        { isCurrentUser: false, status: 'accepted' },
        { isCurrentUser: true, status: 'declined' },
      ] }),
      event({ id: 'accepted', getAttendees: async () => [{ isCurrentUser: true, status: 'accepted' }] }),
    ]);
    const blocks = await deviceCalendar.fetchBusyBlocks({ now: NOW });
    expect(blocks.map((block) => block.nativeId)).toEqual(['accepted']);
  });

  it('is still busy time when somebody else declined it', async () => {
    mockListEvents.mockResolvedValue([
      event({ getAttendees: async () => [{ isCurrentUser: false, status: 'declined' }] }),
    ]);
    expect(await deviceCalendar.fetchBusyBlocks({ now: NOW })).toHaveLength(1);
  });

  it('is counted as busy when the attendee lookup throws, rather than losing the block', async () => {
    mockListEvents.mockResolvedValue([
      event({ getAttendees: async () => { throw new Error('no access to attendees'); } }),
    ]);
    expect(await deviceCalendar.fetchBusyBlocks({ now: NOW })).toHaveLength(1);
  });

  it('is busy on Android, which cannot tell us whose reply it was', async () => {
    (Platform as { OS: string }).OS = 'android';
    mockListEvents.mockResolvedValue([
      event({ getAttendees: async () => [{ isCurrentUser: true, status: 'declined' }] }),
    ]);
    expect(await deviceCalendar.fetchBusyBlocks({ now: NOW })).toHaveLength(1);
  });

  it('stops looking up attendees after the cap, and keeps the rest as busy', async () => {
    const many = Array.from({ length: ATTENDEE_LOOKUP_LIMIT + 5 }, (_, index) => event({
      id: `evt-${index}`,
      startDate: at(index * 60),
      endDate: at(index * 60 + 30),
      getAttendees: async () => [{ isCurrentUser: true, status: 'declined' }],
    }));
    mockListEvents.mockResolvedValue(many);
    const blocks = await deviceCalendar.fetchBusyBlocks({ now: NOW });
    // Everything looked up was declined and dropped; the five past the cap were
    // never asked about, so they stay busy.
    expect(blocks).toHaveLength(5);
  });
});

describe('refusals', () => {
  it('is a permission error rather than a silent empty list', async () => {
    mockGetCalendarPermissions.mockResolvedValue({ granted: false, status: 'denied' });
    await expect(deviceCalendar.fetchBusyBlocks({ now: NOW })).rejects.toBeInstanceOf(DeviceCalendarError);
    expect(mockListEvents).not.toHaveBeenCalled();
  });

  it('turns a native failure into one of the four words', async () => {
    mockListEvents.mockRejectedValue(new Error('not authorized'));
    await expect(deviceCalendar.fetchBusyBlocks({ now: NOW })).rejects.toMatchObject({
      reason: 'permission_denied',
    });
  });
});
