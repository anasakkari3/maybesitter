/**
 * The four weeks of weekly blocks are read when they are drawn, not with the
 * probe (owner decision 2026-10-09, M4A-REV-003).
 *
 * Most visits to the Plan tab never open «شوف أبعد», so the 28-day read
 * waited for nobody. It now goes out when the view opens, and stays for a
 * day chosen from it that lies past the strip: that day's free time needs
 * its own weekly blocks, or a fixed block there would be offered as free.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { screen, waitFor } from '@testing-library/react-native';
import { NOW, TODAY, instant, prepareCalendar, press, renderCalendar, teardown, type M4aHarness } from '../../../__acceptance__/m4a/harness';

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

const STRIP_END = instant('2030-04-05', '00:00');
const WIDER_END = instant('2030-04-26', '00:00');

function weeklyReads(): (string | null)[] {
  return harness!.server.matching('GET', /\/weekly-blocks\/occurrences$/).map((read) => read.query.get('to'));
}

describe('the four weeks of weekly blocks', () => {
  it('are not read while «شوف أبعد» is closed: only the strip\'s seven days', async () => {
    harness = await prepareCalendar();
    await renderCalendar(harness);

    await waitFor(() => expect(weeklyReads().length).toBeGreaterThan(0));
    expect(weeklyReads().every((to) => to === STRIP_END)).toBe(true);
    expect(harness.server.matching('GET', /\/weekly-blocks\/occurrences$/).at(-1)?.query.get('from')).toBe(instant(TODAY, '00:00'));
  });

  it('are read when the view opens', async () => {
    harness = await prepareCalendar();
    await renderCalendar(harness);
    await waitFor(() => expect(weeklyReads().length).toBeGreaterThan(0));
    expect(weeklyReads()).not.toContain(WIDER_END);

    await press('calendar-wider-open');

    await waitFor(() => expect(weeklyReads()).toContain(WIDER_END));
  });

  it('stay for a day past the strip chosen from the view: its weekly block is not offered as free', async () => {
    harness = await prepareCalendar((scenario) => {
      scenario.weekly = [{
        occurrenceId: 'far', weeklyBlockId: 'far', title: 'Weekly',
        startAt: instant('2030-04-18', '10:00'), endAt: instant('2030-04-18', '12:00'),
      }];
    });
    await renderCalendar(harness);
    await press('calendar-wider-open');
    await waitFor(() => expect(weeklyReads()).toContain(WIDER_END));
    await press('calendar-wider-day-2030-04-18');
    expect(screen.queryByTestId('calendar-wider')).toBeNull();
    await press('calendar-filter-free');

    await waitFor(() => expect(screen.queryAllByTestId(/^calendar-gap-2030-04-18-/).length).toBeGreaterThan(0));
    // A gap starts where the block ends, which only a day that knows its
    // block can say; and no gap starts inside it.
    expect(screen.queryByTestId('calendar-gap-2030-04-18-1200')).not.toBeNull();
    expect(screen.queryByTestId('calendar-gap-2030-04-18-1000')).toBeNull();
    expect(weeklyReads().at(-1)).toBe(WIDER_END);
  });
});
