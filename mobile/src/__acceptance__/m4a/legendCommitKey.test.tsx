/**
 * V3-F16-04 (#878 review): the «التزام» key names a commitment's dot on the
 * selected day. A day whose only rows are busy time or a fixed weekly block
 * has no such dot, and a lone «التزام» there read as "one commitment".
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { screen, waitFor } from '@testing-library/react-native';
import {
  NOW,
  TODAY,
  commitment,
  completeBusy,
  instant,
  prepareCalendar,
  press,
  renderCalendar,
  teardown,
  type M4aHarness,
} from './harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

const TOMORROW = '2030-03-30';

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

describe('the commitment key on the selected day', () => {
  it('is not drawn on a day with only busy time and a fixed weekly block, and is drawn on a day with a commitment', async () => {
    harness = await prepareCalendar((scenario) => {
      // Today: a weekly block and a busy block from the server, no commitment.
      scenario.weekly = [{
        occurrenceId: 'weekly-1', weeklyBlockId: 'gym', title: 'Gym',
        startAt: instant(TODAY, '17:30'), endAt: instant(TODAY, '18:30'),
      }];
      scenario.busy = {
        status: 200,
        body: {
          ...completeBusy,
          blocks: [{ blockId: 'manual-1', sourceId: 'manual', sourceKind: 'manual', startAt: instant(TODAY, '15:00'), endAt: instant(TODAY, '16:00'), allDay: false }],
        },
      };
      // Tomorrow: one commitment.
      scenario.upcoming = [commitment('dentist', instant(TOMORROW, '10:00'))];
    });
    await renderCalendar(harness);

    // Today's rows have arrived: the weekly block is drawn, and the busy time
    // has its dot in the strip; the commitment key is not there.
    await waitFor(() => expect(screen.queryByTestId('calendar-weekly-gym')).not.toBeNull());
    await waitFor(() => expect(screen.queryByTestId(`calendar-busy-bar-${TODAY}`)).not.toBeNull());
    expect(screen.queryByTestId('calendar-legend-commit')).toBeNull();

    // The day with the commitment does have it: the key is not simply gone.
    await press(`calendar-day-${TOMORROW}`);
    await waitFor(() => expect(screen.queryByTestId('calendar-legend-commit')).not.toBeNull());
  });
});
