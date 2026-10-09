import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, screen, waitFor } from '@testing-library/react-native';
import en from '../../i18n/locales/en.json';
import {
  NOW,
  TODAY,
  commitment,
  completeBusy,
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

function expectNoFreeClaims(): void {
  expect(screen.queryAllByTestId(/^calendar-gap-/)).toHaveLength(0);
  expect(screen.queryAllByTestId(/^calendar-free-total-/)).toHaveLength(0);
  expect(screen.queryAllByTestId(/^calendar-wider-free-bar-/)).toHaveLength(0);
}

function copy(key: string): string {
  const value = (en as unknown as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : `__missing_${key}__`;
}

function expectGapEnding(day: string, start: string, end: string): void {
  const gap = screen.getByTestId(`calendar-gap-${day}-${start.replace(':', '')}`);
  expect(String(gap.props.accessibilityLabel ?? '')).toContain(end);
}

function unknownGoogleLabelText(): string {
  return copy('yWiderCellUnknownA11y')
    .replace('{date}, ', '')
    .replace('{count}, ', '');
}

describe('M4a readiness fails closed', () => {
  it.each([
    ['weekly occurrences', '/api/mobile/weekly-blocks/occurrences'],
    ['saved week', '/api/mobile/plans/week'],
    ['routine profile', '/api/mobile/profile'],
  ])('M4A-R7-002 failed %s shows unknown and no free rows, totals or bars', async (_source, path) => {
    harness = await prepareCalendar((scenario) => { scenario.fail.add(path); });
    await renderCalendar(harness);

    await waitFor(() => expect(screen.queryByTestId('calendar-free-unknown')).not.toBeNull());
    expectNoFreeClaims();
  });

  it.each([
    ['weekly occurrences', '/api/mobile/weekly-blocks/occurrences'],
    ['saved week', '/api/mobile/plans/week'],
    ['routine profile', '/api/mobile/profile'],
  ])('M4A-R7-002 pending %s shows loading and no free rows, totals or bars', async (_source, path) => {
    harness = await prepareCalendar((scenario) => { scenario.pending.add(path); });
    await renderCalendar(harness);

    expect(screen.queryByTestId('calendar-free-loading')).not.toBeNull();
    expectNoFreeClaims();
  });

  it('M4A-R8-003 a connected Google account waits for Google status and its busy coverage', async () => {
    harness = await prepareCalendar((scenario) => {
      scenario.googleStatus = googleConnected;
      scenario.fail.add('/api/mobile/integrations/google/calendar');
    });
    await renderCalendar(harness);

    expect(screen.queryByTestId('calendar-free-unknown')).not.toBeNull();
    expectNoFreeClaims();
  });

  it('M4A-R9-002 unresolved Google status is loading, not disconnected', async () => {
    harness = await prepareCalendar((scenario) => {
      scenario.pending.add('/api/mobile/integrations/google');
    });
    await renderCalendar(harness);

    expect(screen.queryByTestId('calendar-free-loading')).not.toBeNull();
    expectNoFreeClaims();
  });

  it('M4A-R9-004 denied or absent device coverage is unknown, never an empty calendar', async () => {
    harness = await prepareCalendar((scenario) => { scenario.trust = trust(true); });
    await renderCalendar(harness);

    expect(screen.queryByTestId('calendar-free-unknown')).not.toBeNull();
    expectNoFreeClaims();
  });

  it('M4A-R19-001 unknownRanges suppress free time inside the malformed legacy interval', async () => {
    harness = await prepareCalendar((scenario) => {
      scenario.busy = {
        status: 200,
        body: {
          ...completeBusy,
          unknownRanges: [{ from: instant(TODAY, '13:00'), to: instant(TODAY, '15:00') }],
        },
      };
    });
    await renderCalendar(harness);

    expect(screen.queryByTestId('calendar-free-unknown')).not.toBeNull();
    expect(screen.queryByTestId(`calendar-gap-${TODAY}-1300`)).toBeNull();
  });

  it('M4A-R9-004 a successful 02:00-10:00 sleep window moves the evaluated day window', async () => {
    harness = await prepareCalendar((scenario) => {
      scenario.profile = {
        routine: {
          schemaVersion: 1,
          updatedAt: '2030-03-01T08:00:00.000Z',
          timezone: 'Asia/Jerusalem',
          sleepWindow: { start: '02:00', end: '10:00' },
          focusWindows: [], fixedCommitmentWindows: [], preferredReminderIntensity: 'none', quietHours: null, surveySkipped: false,
        },
        updatedAt: '2030-03-01T08:00:00.000Z',
        aiContextImport: null,
      };
    });
    await renderCalendar(harness);
    await press('calendar-day-2030-03-30');
    await press('calendar-filter-free');

    expect(screen.queryByTestId('calendar-gap-2030-03-30-1000')).not.toBeNull();
    expect(screen.queryByTestId('calendar-gap-2030-03-30-0800')).toBeNull();
  });

  it('M4A-R9-004 a successful null routine uses the 08:00 fallback window', async () => {
    harness = await prepareCalendar();
    await renderCalendar(harness);
    await press('calendar-day-2030-03-30');
    await press('calendar-filter-free');

    expect(screen.queryByTestId('calendar-gap-2030-03-30-0800')).not.toBeNull();
  });

  it.each([
    ['disconnected', {
      success: true,
      google: { status: 'not_connected', accountEmail: null, features: { calendar: false, gmail: false, drive: false }, pickerAvailable: false, connectedAt: null },
    }],
    ['needs_reauth', {
      success: true,
      google: { status: 'needs_reauth', accountEmail: 'person@example.com', features: { calendar: true, gmail: false, drive: false }, pickerAvailable: false, connectedAt: '2030-03-01T08:00:00.000Z' },
    }],
  ])('M4A-R8-003 Google %s is not treated as connected coverage', async (_status, googleStatus) => {
    harness = await prepareCalendar((scenario) => { scenario.googleStatus = googleStatus; });
    await renderCalendar(harness);
    await press('calendar-wider-open');

    expect(screen.queryByTestId('calendar-wider-google-note')).toBeNull();
    expect(screen.queryByTestId(`calendar-wider-free-bar-${TODAY}`)).not.toBeNull();
  });

  it.each(['paused', 'error', 'stale'] as const)(
    'M4A-R10-002 an ICS source with %s readiness makes its covered days unknown',
    async (status) => {
      harness = await prepareCalendar((scenario) => {
        scenario.busy = {
          status: 200,
          body: {
            ...completeBusy,
            sources: [{
              sourceId: 'ics-feed',
              kind: 'ics',
              windowStart: instant(TODAY, '00:00'),
              windowEnd: instant('2030-04-05', '00:00'),
              lastRefreshedAt: instant(TODAY, '08:00'),
              status,
            }],
          },
        };
      });
      await renderCalendar(harness);
      await press('calendar-day-2030-03-30');

      expect(screen.queryByTestId('calendar-free-unknown')).not.toBeNull();
      expectNoFreeClaims();
    },
  );

  it('M4A-R10-002 a manual block outside the selected day does not make that day incomplete', async () => {
    harness = await prepareCalendar((scenario) => {
      scenario.busy = {
        status: 200,
        body: {
          ...completeBusy,
          blocks: [{
            blockId: 'manual-later', sourceId: 'manual', sourceKind: 'manual',
            startAt: instant('2030-04-02', '10:00'), endAt: instant('2030-04-02', '11:00'), allDay: false,
          }],
        },
      };
    });
    await renderCalendar(harness);
    await press('calendar-day-2030-03-30');
    await press('calendar-filter-free');

    expectGapEnding('2030-03-30', '08:00', '22:00');
  });

  it('M4A-R10-003 complete false exposes free time only before its cutoff', async () => {
    harness = await prepareCalendar((scenario) => {
      scenario.busy = {
        status: 200,
        body: {
          ...completeBusy,
          complete: false,
          cutoff: instant('2030-03-30', '15:00'),
        },
      };
    });
    await renderCalendar(harness);
    await press('calendar-day-2030-03-30');
    await press('calendar-filter-free');

    expectGapEnding('2030-03-30', '08:00', '15:00');
    expect(screen.queryByTestId('calendar-gap-2030-03-30-1500')).toBeNull();
    expect(screen.queryByTestId('calendar-free-unknown')).not.toBeNull();
  });
});

describe('M4a wider calendar', () => {
  it('M4A-005 / M4A-R4-002 opens 28 cells, counts a week-four block, and asks weekly occurrences for all 28 days', async () => {
    harness = await prepareCalendar((scenario) => {
      scenario.weekly = [{
        occurrenceId: 'week-four', weeklyBlockId: 'week-four', title: 'Weekly',
        startAt: instant('2030-04-23', '10:00'), endAt: instant('2030-04-23', '12:00'),
      }];
    });
    await renderCalendar(harness);
    await press('calendar-wider-open');

    expect(screen.getAllByTestId(/^calendar-wider-day-/)).toHaveLength(28);
    expect(screen.queryByTestId('calendar-wider-free-bar-2030-04-23')).not.toBeNull();
    const reads = harness.server.matching('GET', /\/weekly-blocks\/occurrences$/);
    expect(reads.at(-1)?.query.get('from')).toBe(instant(TODAY, '00:00'));
    expect(reads.at(-1)?.query.get('to')).toBe(instant('2030-04-26', '00:00'));
  });

  it('M4A-R2-006 day 20 selection closes wider view, keeps a seven-cell strip, and Back to today works', async () => {
    harness = await prepareCalendar();
    await renderCalendar(harness);
    await press('calendar-wider-open');
    await press('calendar-wider-day-2030-04-18');

    expect(screen.queryByTestId('calendar-wider')).toBeNull();
    expect(screen.getAllByTestId(/^calendar-day-\d{4}-\d{2}-\d{2}$/)).toHaveLength(7);
    expect(screen.queryByTestId('calendar-back-today')).not.toBeNull();
    await press('calendar-back-today');
    expect(screen.getByTestId(`calendar-day-${TODAY}`).props.accessibilityState.selected).toBe(true);
  });

  it('M4A-R2-007 / M4A-R3-003 the normal 14-day Google cutoff has one note and uncovered cells have no free claim', async () => {
    harness = await prepareCalendar((scenario) => {
      scenario.googleStatus = googleConnected;
      scenario.googleBusy = {
        success: true,
        blocks: [],
        windowStart: instant(TODAY, '00:00'),
        windowEnd: new Date(NOW.getTime() + 14 * 86_400_000).toISOString(),
      };
    });
    await renderCalendar(harness);
    await press('calendar-wider-open');

    const note = screen.getAllByTestId('calendar-wider-google-note');
    expect(note).toHaveLength(1);
    expect(note[0]).toHaveTextContent(copy('yWiderGoogleNote'));
    expect(screen.queryByTestId('calendar-wider-free-bar-2030-04-11')).not.toBeNull();
    expect(screen.queryByTestId('calendar-wider-free-bar-2030-04-12')).toBeNull();
    expect(screen.getByTestId('calendar-wider-day-2030-04-12').props.accessibilityLabel)
      .toContain(unknownGoogleLabelText());
  });

  it('M4A-R4-003 a missing Google window uses the from-here note and never draws an uncovered bar', async () => {
    harness = await prepareCalendar((scenario) => {
      scenario.googleStatus = googleConnected;
      scenario.googleBusy = { success: true, blocks: [], windowStart: null, windowEnd: null };
    });
    await renderCalendar(harness);
    await press('calendar-wider-open');

    const note = screen.getByTestId('calendar-wider-google-note');
    expect(note).toHaveTextContent(copy('yWiderGoogleNoteFromHere'));
    expect(screen.queryAllByTestId(/^calendar-wider-free-bar-/)).toHaveLength(0);
    expect(screen.getByTestId(`calendar-wider-day-${TODAY}`).props.accessibilityLabel)
      .toContain(unknownGoogleLabelText());
  });

  it('M4A-R4-003 an early truncated Google window starts the from-here note at the first uncovered cell', async () => {
    harness = await prepareCalendar((scenario) => {
      scenario.googleStatus = googleConnected;
      scenario.googleBusy = {
        success: true,
        blocks: [],
        windowStart: instant(TODAY, '00:00'),
        windowEnd: instant('2030-04-02', '19:20'),
      };
    });
    await renderCalendar(harness);
    await press('calendar-wider-open');

    expect(screen.getByTestId('calendar-wider-google-note'))
      .toHaveTextContent(copy('yWiderGoogleNoteFromHere'));
    expect(screen.queryByTestId('calendar-wider-free-bar-2030-04-01')).not.toBeNull();
    expect(screen.queryByTestId('calendar-wider-free-bar-2030-04-02')).toBeNull();
    expect(screen.getByTestId('calendar-wider-day-2030-04-02').props.accessibilityLabel)
      .toContain(unknownGoogleLabelText());
  });
});

describe('M4a day identity', () => {
  it('M4A-R2-008 null selection follows midnight while mounted and both list reads refresh as one snapshot', async () => {
    harness = await prepareCalendar();
    await renderCalendar(harness);
    const beforeToday = harness.server.matching('GET', /\/commitments\/today$/).length;
    const beforeUpcoming = harness.server.matching('GET', /\/commitments\/upcoming$/).length;

    await act(async () => {
      await jest.advanceTimersByTimeAsync(14 * 60 * 60 * 1000);
    });

    await waitFor(() => expect(screen.queryByTestId('calendar-day-2030-03-30')).not.toBeNull());
    expect(screen.getByTestId('calendar-day-2030-03-30').props.accessibilityState.selected).toBe(true);
    expect(harness.server.matching('GET', /\/commitments\/today$/).length).toBeGreaterThan(beforeToday);
    expect(harness.server.matching('GET', /\/commitments\/upcoming$/).length).toBeGreaterThan(beforeUpcoming);
  });

  it('M4A-R3-004 an explicit future date stays selected across midnight', async () => {
    harness = await prepareCalendar((scenario) => {
      scenario.upcoming = [commitment('future', instant('2030-04-18', '12:00'))];
    });
    await renderCalendar(harness);
    await press('calendar-wider-open');
    await press('calendar-wider-day-2030-04-18');

    await act(async () => {
      await jest.advanceTimersByTimeAsync(14 * 60 * 60 * 1000);
    });

    expect(screen.queryByTestId('calendar-item-future')).not.toBeNull();
    expect(screen.queryByTestId('calendar-back-today')).not.toBeNull();
  });
});
