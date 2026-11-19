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

/*
 * QA v3, V3-F18-04. On the iPhone the class API answered the new event without
 * its id: the app stored `[null]` as every id it wrote, claimed the link with
 * no `eventId` (400), and the repair that should have taken the event back out
 * deleted "nothing" and called it done. These hold the native seam to what it
 * must do about that.
 */
describe('an event the class API answers without its id', () => {
  const OURS = { id: 'ITEM-1', url: DRAFT.url };

  it('finds the id by the address the app wrote on it', async () => {
    const listEvents = jest.fn<() => Promise<unknown[]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([OURS, { id: 'users-own', url: null }]);
    mockCalendarGet.mockResolvedValue({
      allowsModifications: true,
      createEvent: async () => ({ id: undefined }),
      listEvents,
    });
    expect(await deviceCalendar.createEvent('cal-1', DRAFT)).toBe('ITEM-1');
  });

  it('tells the new event from an older one at the same address', async () => {
    // The weekly blocks share one address; a guess here links the wrong event.
    const OLDER = { id: 'ITEM-0', url: DRAFT.url };
    mockCalendarGet.mockResolvedValue({
      allowsModifications: true,
      createEvent: async () => ({ id: undefined }),
      listEvents: jest.fn<() => Promise<unknown[]>>()
        .mockResolvedValueOnce([OLDER])
        .mockResolvedValueOnce([OLDER, OURS]),
    });
    expect(await deviceCalendar.createEvent('cal-1', DRAFT)).toBe('ITEM-1');
  });

  it('never answers an empty id: it takes the event back out and fails instead', async () => {
    const remove = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    mockCalendarGet.mockResolvedValue({
      allowsModifications: true,
      createEvent: async () => ({ id: null, delete: remove }),
      listEvents: async () => [],
    });
    await expect(deviceCalendar.createEvent('cal-1', DRAFT)).rejects.toMatchObject({ reason: 'unavailable' });
    expect(remove).toHaveBeenCalled();
  });

  it('does not call deleting an event with no id "done"', async () => {
    // `deleteEvent(undefined)` was answered "already gone", so the event the
    // failed claim should have removed stayed in the calendar every time.
    await expect(deviceCalendar.deleteEvent('')).rejects.toMatchObject({ reason: 'unavailable' });
  });
});

describe('the events the app wrote, and only those', () => {
  it('lists the ones with its address, and none of the user\'s own', async () => {
    mockCalendarGet.mockResolvedValue({
      listEvents: async () => [
        { id: 'a', url: 'maybesitter://commitments/cmt-1' },
        { id: 'b', url: 'https://example.com/meeting' },
        { id: 'c', url: null },
        { id: null, url: 'maybesitter://commitments/cmt-2' },
      ],
    });
    const found = await deviceCalendar.findOwnEvents!(
      'cal-1', 'maybesitter://commitments/', new Date('2026-06-01'), new Date('2026-07-01'),
    );
    expect(found).toEqual([{ id: 'a', url: 'maybesitter://commitments/cmt-1' }]);
  });

  it('finds an event by its calendar when the lookup by id says it is not there', async () => {
    // The class API looks an id up with `event(withIdentifier:)`, which takes
    // an event identifier, while the id it hands out is the calendar item
    // identifier. Without this, a linked event reads as deleted by hand.
    mockEventGet.mockRejectedValue(new Error('Event not found'));
    const remove = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    mockCalendarGet.mockResolvedValue({
      listEvents: async () => [{ id: 'ITEM-1', url: DRAFT.url, delete: remove }],
    });
    expect(await deviceCalendar.eventExists('ITEM-1', 'cal-1')).toBe(true);
    await deviceCalendar.deleteEvent('ITEM-1', 'cal-1');
    expect(remove).toHaveBeenCalled();
  });
});

describe('a lookup that could not finish is not a deletion', () => {
  it('does not answer "gone" when the calendar would not list', async () => {
    // `false` detaches the link, for ever. A calendar that failed to answer
    // has said nothing about whether the user deleted the event.
    mockEventGet.mockRejectedValue(new Error('Event not found'));
    mockCalendarGet.mockRejectedValue(new Error('the disk is on fire'));
    await expect(deviceCalendar.eventExists('ITEM-1', 'cal-1')).rejects.toMatchObject({ reason: 'unavailable' });
  });
});

describe('review of #870', () => {
  it('finds the event whose id is the one asked for, not one it starts', async () => {
    mockEventGet.mockRejectedValue(new Error('Event not found'));
    const wrong = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const right = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    mockCalendarGet.mockResolvedValue({
      listEvents: async () => [
        { id: 'ITEM-10', url: DRAFT.url, delete: wrong },
        { id: 'ITEM-1', url: DRAFT.url, delete: right },
      ],
    });
    await deviceCalendar.deleteEvent('ITEM-1', 'cal-1');
    expect(right).toHaveBeenCalled();
    expect(wrong).not.toHaveBeenCalled();
  });

  it('answers no id when two new events carry the address, and takes its own back out', async () => {
    const remove = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    mockCalendarGet.mockResolvedValue({
      allowsModifications: true,
      createEvent: async () => ({ id: undefined, delete: remove }),
      listEvents: jest.fn<() => Promise<unknown[]>>()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'ITEM-1', url: DRAFT.url }, { id: 'ITEM-2', url: DRAFT.url }]),
    });
    await expect(deviceCalendar.createEvent('cal-1', DRAFT)).rejects.toMatchObject({ reason: 'unavailable' });
    expect(remove).toHaveBeenCalled();
  });

  it('takes back a whole recurring series, not its first occurrence', async () => {
    const occurrence = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const series = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    mockCalendarGet.mockResolvedValue({
      allowsModifications: true,
      createEvent: async () => ({
        id: undefined,
        recurrenceRule: { frequency: 'weekly' },
        delete: occurrence,
        getOccurrenceSync: () => ({ delete: series }),
      }),
      listEvents: async () => [],
    });
    await expect(deviceCalendar.createEvent('cal-1', DRAFT)).rejects.toMatchObject({ reason: 'unavailable' });
    expect(series).toHaveBeenCalled();
    expect(occurrence).not.toHaveBeenCalled();
  });
});

