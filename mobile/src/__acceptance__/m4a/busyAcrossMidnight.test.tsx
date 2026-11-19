/**
 * CXA4.6 / CXA10.2: a busy block across midnight is drawn on both days.
 *
 * Busy rows were keyed by the day the block starts. A phone-calendar shift
 * 23:30-01:00 showed on Friday and was absent from Saturday: no busy row, no
 * busy dot, and a 00:30 commitment inside the busy hour had no conflict chip
 * (seen on the simulator). The free-time arithmetic already clipped it.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { screen } from '@testing-library/react-native';
import {
  NOW,
  completeBusy,
  commitment,
  googleConnected,
  instant,
  prepareCalendar,
  press,
  renderCalendar,
  teardown,
  trust,
  type M4aHarness,
} from './harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

let harness: M4aHarness | undefined;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(async () => {
  await teardown(harness);
  harness = undefined;
  jest.useRealTimers();
});

const DAY = '2030-03-30';
const NEXT = '2030-03-31';
const SHIFT = { startAt: instant(DAY, '23:30'), endAt: instant(NEXT, '01:00'), allDay: false };

describe('a busy block across midnight', () => {
  it('from the server is drawn on the next day too, with the conflict chip', async () => {
    harness = await prepareCalendar((scenario) => {
      scenario.upcoming = [commitment('after-midnight', instant(NEXT, '00:30'))];
      scenario.busy = { status: 200, body: { ...completeBusy, blocks: [{ blockId: 'night', sourceId: 'manual:p1', sourceKind: 'manual', ...SHIFT }] } };
    });
    await renderCalendar(harness);
    await press(`calendar-day-${NEXT}`);
    expect(screen.queryAllByTestId('calendar-busy-row')).toHaveLength(1);
    expect(screen.queryByTestId('calendar-conflict-after-midnight')).not.toBeNull();
    await press(`calendar-day-${DAY}`);
    expect(screen.queryAllByTestId('calendar-busy-row')).toHaveLength(1);
  });

  it('from a connected calendar is drawn on the next day too', async () => {
    harness = await prepareCalendar((scenario) => {
      scenario.busy = { status: 200, body: { ...completeBusy, blocks: [] } };
    });
    harness.scenario.trust = trust(true);
    harness.scenario.googleStatus = googleConnected;
    harness.scenario.googleBusy = {
      ...(harness.scenario.googleBusy as object),
      blocks: [{ blockId: 'g-night', sourceId: 'google:primary', sourceKind: 'google', ...SHIFT }],
    };
    await renderCalendar(harness);
    await press(`calendar-day-${NEXT}`);
    expect(screen.queryAllByTestId('calendar-busy-row')).toHaveLength(1);
  });
});
