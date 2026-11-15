/**
 * CA4.4 / CA10.3 / CXA10.1 (and NA4.1): busy time the server holds — ICS
 * lectures and manual busy — is drawn on «الخطة», and the free-time view
 * agrees with it.
 *
 * Before the fix, `serverBusy.blocks` fed only the free-time arithmetic: the
 * day showed no busy row, a commitment inside a lecture had no conflict chip,
 * and the free view said the whole day was free because the day had "no rows".
 * The account here has no phone-calendar consent, as on the device that found it.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { screen } from '@testing-library/react-native';
import {
  NOW,
  completeBusy,
  commitment,
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

function lectureDay(withCommitment = false): Promise<M4aHarness> {
  return prepareCalendar((scenario) => {
    if (withCommitment) scenario.upcoming = [commitment('inside-lecture', instant(DAY, '11:00'))];
    scenario.busy = {
      status: 200,
      body: {
        ...completeBusy,
        blocks: [
          { blockId: 'manual-lecture', sourceId: 'manual:p1', sourceKind: 'manual', startAt: instant(DAY, '08:00'), endAt: instant(DAY, '20:00'), allDay: false },
        ],
      },
    };
  });
}

describe('CA4.4 server busy time on the Plan tab', () => {
  it('draws a 12-hour manual lecture block on its day, with no free gap over it', async () => {
    harness = await lectureDay();
    await renderCalendar(harness);
    await press(`calendar-day-${DAY}`);

    expect(screen.queryAllByTestId('calendar-busy-row')).toHaveLength(1);
    expect(screen.getByTestId('calendar-busy-range').props.children).toContain('08:00');
    expect(screen.queryByTestId('calendar-day-free')).toBeNull();
    expect(screen.queryByTestId(`calendar-gap-${DAY}-0800`)).toBeNull();
  });

  it('a commitment inside a server busy block gets the conflict chip', async () => {
    harness = await lectureDay(true);
    await renderCalendar(harness);
    await press(`calendar-day-${DAY}`);

    expect(screen.queryByTestId('calendar-conflict-inside-lecture')).not.toBeNull();
  });

  it('the free view subtracts it and does not call the day all free', async () => {
    harness = await lectureDay();
    await renderCalendar(harness);
    await press(`calendar-day-${DAY}`);
    await press('calendar-filter-free');

    expect(screen.queryByTestId('calendar-free-all')).toBeNull();
    expect(screen.queryByTestId(`calendar-gap-${DAY}-0800`)).toBeNull();
    expect(screen.queryByTestId(`calendar-gap-${DAY}-2000`)).not.toBeNull();
    expect(String(screen.getByTestId('calendar-selected-load').props.children)).toContain('2');
    expect(String(screen.getByTestId('calendar-selected-load').props.children)).not.toContain('14');
  });

  it('the busy dot under the day counts it', async () => {
    harness = await lectureDay();
    await renderCalendar(harness);

    expect(screen.queryByTestId(`calendar-busy-bar-${DAY}`)).not.toBeNull();
  });
});
