/**
 * The native seam for a weekly block's recurring event.
 *
 *   - iOS carries the days (`daysOfTheWeek`, 1 = Sunday); Android's
 *     expo-calendar cannot, so the rule there is `FREQ=WEEKLY` alone and the
 *     caller writes one series per day (`weeklyRuleCarriesDays`);
 *   - a change or a removal acts on the whole series, never on the first
 *     Saturday only: `get(id)` answers the first occurrence with the span
 *     `thisEvent`, so a series is re-fetched with `futureEvents`.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Platform } from 'react-native';

const mockCalendarGet = jest.fn<(id: string) => Promise<unknown>>();
const mockEventGet = jest.fn<(id: string) => Promise<unknown>>();

jest.mock('expo-calendar', () => ({
  EntityTypes: { EVENT: 'event' },
  ExpoCalendar: { get: (id: string) => mockCalendarGet(id) },
  ExpoCalendarEvent: { get: (id: string) => mockEventGet(id) },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { deviceCalendar, weeklyRuleCarriesDays } = require('../deviceCalendar') as typeof import('../deviceCalendar');

const DRAFT = {
  title: 'تدريب',
  notes: 'Added by MaybeSitter.',
  startDate: new Date('2026-10-03T07:00:00.000Z'),
  endDate: new Date('2026-10-03T13:00:00.000Z'),
  allDay: false,
  timeZone: 'Asia/Jerusalem',
  recurrence: { weekdays: [0, 6] },
};

const originalOS = Platform.OS;
function onPlatform(os: 'ios' | 'android'): void {
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
}

beforeEach(() => { mockCalendarGet.mockReset(); mockEventGet.mockReset(); });
afterEach(() => { Object.defineProperty(Platform, 'OS', { value: originalOS, configurable: true }); });

async function created(): Promise<Record<string, unknown>> {
  const createEvent = jest.fn(async (_data: unknown) => ({ id: 'evt-1' }));
  mockCalendarGet.mockResolvedValue({ allowsModifications: true, createEvent });
  await deviceCalendar.createEvent('cal-1', DRAFT);
  return createEvent.mock.calls[0]![0] as Record<string, unknown>;
}

describe('the rule', () => {
  it('carries the days on iOS', async () => {
    onPlatform('ios');
    expect(weeklyRuleCarriesDays()).toBe(true);
    expect((await created()).recurrenceRule).toEqual({ frequency: 'weekly', interval: 1, daysOfTheWeek: [{ dayOfTheWeek: 1 }, { dayOfTheWeek: 7 }] });
  });

  it('is weekly alone on Android, where the days would be dropped anyway', async () => {
    onPlatform('android');
    expect(weeklyRuleCarriesDays()).toBe(false);
    expect((await created()).recurrenceRule).toEqual({ frequency: 'weekly', interval: 1 });
  });

  it('is absent for a one-off', async () => {
    const createEvent = jest.fn(async (_data: unknown) => ({ id: 'evt-1' }));
    mockCalendarGet.mockResolvedValue({ allowsModifications: true, createEvent });
    const { recurrence: _drop, ...oneOff } = DRAFT;
    await deviceCalendar.createEvent('cal-1', oneOff);
    expect(createEvent.mock.calls[0]![0]).not.toHaveProperty('recurrenceRule');
  });
});

describe('the whole series', () => {
  it('updates and deletes through the futureEvents occurrence of a recurring event', async () => {
    const series = { update: jest.fn(async () => undefined), delete: jest.fn(async () => undefined) };
    const first = {
      recurrenceRule: { frequency: 'weekly' },
      update: jest.fn(async () => undefined),
      delete: jest.fn(async () => undefined),
      getOccurrenceSync: jest.fn(() => series),
    };
    mockEventGet.mockResolvedValue(first);
    await deviceCalendar.updateEvent('evt-1', DRAFT);
    await deviceCalendar.deleteEvent('evt-1');
    expect(first.getOccurrenceSync).toHaveBeenCalledWith({ futureEvents: true });
    expect(series.update).toHaveBeenCalledTimes(1);
    expect(series.delete).toHaveBeenCalledTimes(1);
    expect(first.update).not.toHaveBeenCalled();
    expect(first.delete).not.toHaveBeenCalled();
  });

  it('acts on a one-off event itself', async () => {
    const event = { recurrenceRule: null, delete: jest.fn(async () => undefined), getOccurrenceSync: jest.fn() };
    mockEventGet.mockResolvedValue(event);
    await deviceCalendar.deleteEvent('evt-2');
    expect(event.delete).toHaveBeenCalledTimes(1);
    expect(event.getOccurrenceSync).not.toHaveBeenCalled();
  });
});
