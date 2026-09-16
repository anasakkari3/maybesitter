/**
 * The one module that touches `expo-calendar` (UC-3.1, #185).
 *
 * What is testable here is not "does it write an event" — that needs a device
 * with seeded calendars, and no amount of mocking makes a green run evidence of
 * it. What is testable is the *translation*: a native error becoming one of
 * four words, and the two places where getting that translation wrong does real
 * damage.
 *
 * Those two are worth naming, because they are why this file exists:
 *
 *   `eventExists` answering `false` to a permission error would tell the sync
 *   service the user had deleted every one of their events, and it would detach
 *   every link on the account — permanently, since a detached link is never
 *   written again. The day somebody revokes calendar access in Settings, the
 *   feature would destroy itself.
 *
 *   `deleteEvent` throwing on an event that is already gone would leave the
 *   link row standing for ever, so "remove the events MaybeSitter added" could
 *   never finish.
 */
import { describe, expect, it, jest, beforeEach } from '@jest/globals';

const mockGetCalendarPermissions = jest.fn<() => Promise<unknown>>();
const mockRequestCalendarPermissions = jest.fn<() => Promise<unknown>>();
const mockGetCalendars = jest.fn<() => Promise<unknown[]>>();
const mockCalendarGet = jest.fn<(id: string) => Promise<unknown>>();
const mockEventGet = jest.fn<(id: string) => Promise<unknown>>();

jest.mock('expo-calendar', () => ({
  EntityTypes: { EVENT: 'event' },
  getCalendarPermissions: () => mockGetCalendarPermissions(),
  requestCalendarPermissions: () => mockRequestCalendarPermissions(),
  getCalendars: () => mockGetCalendars(),
  ExpoCalendar: { get: (id: string) => mockCalendarGet(id) },
  ExpoCalendarEvent: { get: (id: string) => mockEventGet(id) },
}));

// Imported after the mock is registered.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { deviceCalendar, DeviceCalendarError } = require('../deviceCalendar') as typeof import('../deviceCalendar');

const DRAFT = {
  title: 'Dentist',
  notes: 'Added by MaybeSitter.',
  startDate: new Date('2026-06-15T02:00:00.000Z'),
  endDate: new Date('2026-06-15T02:30:00.000Z'),
  allDay: false,
  timeZone: 'Pacific/Chatham',
  url: 'maybesitter://commitments/cmt-1',
};

beforeEach(() => {
  for (const mock of [mockGetCalendarPermissions, mockRequestCalendarPermissions, mockGetCalendars, mockCalendarGet, mockEventGet]) {
    mock.mockReset();
  }
});

describe('what the OS said, in three words', () => {
  it('reads a grant as granted', async () => {
    mockGetCalendarPermissions.mockResolvedValue({ granted: true, status: 'granted' });
    expect(await deviceCalendar.getAccess()).toBe('granted');
  });

  it('keeps "never asked" apart from "said no"', async () => {
    // A screen that showed "turn it on in Settings" to somebody who was never
    // prompted would be sending them to a switch that is not there yet.
    mockGetCalendarPermissions.mockResolvedValue({ granted: false, status: 'undetermined' });
    expect(await deviceCalendar.getAccess()).toBe('undetermined');

    mockGetCalendarPermissions.mockResolvedValue({ granted: false, status: 'denied' });
    expect(await deviceCalendar.getAccess()).toBe('denied');
  });

  it('reads a module that will not answer as denied, never as granted', async () => {
    mockGetCalendarPermissions.mockRejectedValue(new Error('module unavailable'));
    expect(await deviceCalendar.getAccess()).toBe('denied');
  });

  it('asks for full access, not write-only', async () => {
    // `requestCalendarPermissions(true)` is the write-only request, under which
    // an event can never be looked up again — so update, delete and "is it
    // still there" all become impossible.
    mockRequestCalendarPermissions.mockResolvedValue({ granted: true, status: 'granted' });
    await deviceCalendar.requestAccess();
    expect(mockRequestCalendarPermissions).toHaveBeenCalledWith();
  });
});

describe('the calendars the picker may offer', () => {
  it('leaves out the ones that cannot be written to', async () => {
    mockGetCalendars.mockResolvedValue([
      { id: 'a', title: 'Personal', allowsModifications: true, source: { name: 'iCloud' } },
      // A subscribed holiday feed: it is in the list and refuses every write.
      { id: 'b', title: 'Holidays', allowsModifications: false, source: { name: 'Subscribed' } },
    ]);
    const calendars = await deviceCalendar.listWritableCalendars();
    expect(calendars.map((calendar) => calendar.id)).toEqual(['a']);
  });

  it('carries the account, because two calendars are usually both called "Calendar"', async () => {
    mockGetCalendars.mockResolvedValue([
      { id: 'a', title: 'Calendar', allowsModifications: true, source: { name: 'iCloud' } },
      { id: 'b', title: 'Calendar', allowsModifications: true, ownerAccount: 'work@example.com', isPrimary: true },
    ]);
    const calendars = await deviceCalendar.listWritableCalendars();
    expect(calendars.map((calendar) => calendar.sourceName)).toEqual(['iCloud', 'work@example.com']);
    expect(calendars.map((calendar) => calendar.isPrimary)).toEqual([false, true]);
  });
});

describe('writing', () => {
  it('refuses a read-only calendar before it tries', async () => {
    const createEvent = jest.fn();
    mockCalendarGet.mockResolvedValue({ allowsModifications: false, createEvent });
    await expect(deviceCalendar.createEvent('cal-1', DRAFT)).rejects.toMatchObject({
      reason: 'calendar_read_only',
    });
    expect(createEvent).not.toHaveBeenCalled();
  });

  it('sets the fields the app writes, and no others', async () => {
    const createEvent = jest.fn<(details: Record<string, unknown>) => Promise<{ id: string }>>()
      .mockResolvedValue({ id: 'evt-1' });
    mockCalendarGet.mockResolvedValue({ allowsModifications: true, createEvent });
    expect(await deviceCalendar.createEvent('cal-1', DRAFT)).toBe('evt-1');
    expect(Object.keys(createEvent.mock.calls[0]![0]).sort()).toEqual(
      ['allDay', 'endDate', 'notes', 'startDate', 'timeZone', 'title', 'url'],
    );
  });

  it('leaves the url out entirely when there is none, rather than sending undefined', async () => {
    const createEvent = jest.fn<(details: Record<string, unknown>) => Promise<{ id: string }>>()
      .mockResolvedValue({ id: 'evt-1' });
    mockCalendarGet.mockResolvedValue({ allowsModifications: true, createEvent });
    const { url: _url, ...withoutUrl } = DRAFT;
    await deviceCalendar.createEvent('cal-1', withoutUrl);
    expect('url' in createEvent.mock.calls[0]![0]).toBe(false);
  });
});

describe('the two translations that matter', () => {
  it('does not treat a permission failure as "the event is gone"', async () => {
    // Answering `false` here would detach every link on the account the day
    // somebody revoked calendar access, permanently.
    mockEventGet.mockRejectedValue(new Error('Calendar permission denied'));
    await expect(deviceCalendar.eventExists('evt-1')).rejects.toBeInstanceOf(DeviceCalendarError);
    await expect(deviceCalendar.eventExists('evt-1')).rejects.toMatchObject({
      reason: 'permission_denied',
    });
  });

  it('answers false for an event that is genuinely not there', async () => {
    mockEventGet.mockRejectedValue(new Error('Event not found'));
    expect(await deviceCalendar.eventExists('evt-1')).toBe(false);
  });

  it('answers true for one that is', async () => {
    mockEventGet.mockResolvedValue({ id: 'evt-1' });
    expect(await deviceCalendar.eventExists('evt-1')).toBe(true);
  });

  it('treats deleting an event that is already gone as done, not as a failure', async () => {
    // Otherwise "remove the events MaybeSitter added" can never finish, and the
    // link row stands for ever.
    mockEventGet.mockRejectedValue(new Error('Event not found'));
    await expect(deviceCalendar.deleteEvent('evt-1')).resolves.toBeUndefined();
  });

  it('still reports a delete that failed for a reason the caller can act on', async () => {
    mockEventGet.mockRejectedValue(new Error('not authorized'));
    await expect(deviceCalendar.deleteEvent('evt-1')).rejects.toMatchObject({
      reason: 'permission_denied',
    });
  });

  it('calls an error it has no word for unavailable, rather than guessing not_found', async () => {
    // A wrong `not_found` would tell the sync service the user had deleted an
    // event they had not, and detach a link that is perfectly good.
    mockCalendarGet.mockRejectedValue(new Error('the disk is on fire'));
    await expect(deviceCalendar.createEvent('cal-1', DRAFT)).rejects.toMatchObject({
      reason: 'unavailable',
    });
  });
});
