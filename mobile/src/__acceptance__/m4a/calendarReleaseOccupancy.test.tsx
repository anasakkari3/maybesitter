import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, screen, waitFor } from '@testing-library/react-native';
import {
  NOW,
  TODAY,
  completeBusy,
  commitment,
  firstFailureHint,
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

describe('M4a calendar release gate', () => {
  it.each([
    ['404', { status: 404, body: { success: false, error: 'feature_unavailable', reason: 'feature_unavailable' } }],
    ['error', { status: 503, body: { success: false, error: 'unavailable', reason: 'unavailable' } }],
  ])('M4A-R10-001 %s probe keeps the mounted Plan tab on its old surface and starts no free-time reads', async (_case, busy) => {
    harness = await prepareCalendar((scenario) => { scenario.busy = busy; });
    await renderCalendar(harness);

    expect(screen.getByTestId(`calendar-day-${TODAY}`).props.accessibilityState.selected).toBe(true);
    expect(screen.queryByTestId('calendar-filter-busy')).not.toBeNull();
    expect(screen.queryByTestId('calendar-filter-free')).toBeNull();
    expect(screen.queryAllByTestId(/^calendar-gap-/)).toHaveLength(0);
    expect(screen.queryByTestId('calendar-wider-open')).toBeNull();
    await waitFor(() => expect(harness!.server.matching('GET', /\/calendar\/busy$/)).toHaveLength(1));
    const probe = harness.server.matching('GET', /\/calendar\/busy$/)[0]!;
    expect(probe.query.get('from')).toBe(instant(TODAY, '00:00'));
    expect(probe.query.get('to')).toBe(instant('2030-04-26', '00:00'));
    expect(harness.server.matching('GET', /\/profile$/)).toHaveLength(0);
  });

  it('M4A-R10-001 pending probe keeps the old surface while the request is unresolved', async () => {
    harness = await prepareCalendar((scenario) => {
      scenario.pending.add('/api/mobile/calendar/busy');
    });
    await renderCalendar(harness);

    expect(screen.queryByTestId('calendar-filter-busy')).not.toBeNull();
    expect(screen.queryByTestId('calendar-filter-free')).toBeNull();
    expect(screen.queryAllByTestId(/^calendar-gap-/)).toHaveLength(0);
    expect(screen.queryByTestId('calendar-wider-open')).toBeNull();
    expect(harness.server.matching('GET', /\/calendar\/busy$/)).toHaveLength(1);
    expect(harness.server.matching('GET', /\/profile$/)).toHaveLength(0);
  });

  it('M4A-R11-003 a later 404 removes free-time surfaces without remounting', async () => {
    harness = await prepareCalendar();
    let probes = 0;
    harness.server.extra = (request) => {
      if (request.path !== '/api/mobile/calendar/busy') return undefined;
      probes += 1;
      return probes === 1
        ? { status: 200, body: completeBusy }
        : { status: 404, body: { success: false, error: 'feature_unavailable', reason: 'feature_unavailable' } };
    };
    await renderCalendar(harness);
    firstFailureHint('calendar-filter-free');

    const scroll = screen.getByTestId('calendar-scroll');
    await act(async () => { await scroll.props.refreshControl.props.onRefresh(); });
    await waitFor(() => expect(harness!.server.matching('GET', /\/calendar\/busy$/)).toHaveLength(2));
    expect(screen.queryByTestId('calendar-filter-free')).toBeNull();
    expect(screen.queryAllByTestId(/^calendar-gap-/)).toHaveLength(0);
    expect(screen.queryByTestId('calendar-wider-open')).toBeNull();
    expect(screen.queryByTestId('calendar-filter-busy')).not.toBeNull();
  });
});

describe('M4a calendar occupancy', () => {
  function occupiedScenario() {
    const day = '2030-03-30';
    return prepareCalendar((scenario) => {
      scenario.today = [
        commitment('event-with-end', instant(day, '08:00'), { end: instant(day, '09:00') }),
        commitment('event-fallback', instant(day, '09:30')),
        commitment('timed-window', instant(day, '11:00'), { kind: 'due_by', end: instant(day, '12:00') }),
        commitment('plain-deadline', instant(day, '19:00'), { kind: 'due_by' }),
        commitment('all-day', instant(day, '00:00'), { allDay: true }),
        commitment('saved-move', instant(TODAY, '16:00')),
        commitment('postponed-move', instant(TODAY, '17:00'), {
          postponed: true,
          postponedUntil: instant(day, '13:30'),
        }),
      ];
      scenario.savedWeek.saved = [{
        date: day,
        items: [{ itemId: 'saved-move', startsAt: instant(day, '12:30'), endsAt: instant(day, '13:00') }],
      }];
      scenario.weekly = [{
        occurrenceId: 'weekly-1', weeklyBlockId: 'weekly', title: 'Weekly',
        startAt: instant(day, '17:30'), endAt: instant(day, '18:30'),
      }];
      scenario.busy = {
        status: 200,
        body: {
          ...completeBusy,
          blocks: [
            { blockId: 'ics-1', sourceId: 'ics-1', sourceKind: 'ics', startAt: instant(day, '15:00'), endAt: instant(day, '16:00'), allDay: false },
            { blockId: 'manual-1', sourceId: 'manual', sourceKind: 'manual', startAt: instant(day, '16:30'), endAt: instant(day, '17:00'), allDay: false },
          ],
        },
      };
    });
  }

  function expectGapEnding(day: string, start: string, end: string): void {
    const gap = screen.getByTestId(`calendar-gap-${day}-${start.replace(':', '')}`);
    expect(String(gap.props.accessibilityLabel ?? '')).toContain(end);
  }

  it('M4A-003 / M4A-R2-003 occupancy excludes real timed intervals, ignores plain deadlines and all-day rows, and includes ICS/manual/weekly blocks', async () => {
    harness = await occupiedScenario();
    await renderCalendar(harness);
    await press('calendar-day-2030-03-30');
    await press('calendar-filter-free');

    // Explicit end, 30-minute fallback, timed due-by window, and the effective
    // saved/postponed placements each determine the adjacent gap boundary.
    expectGapEnding('2030-03-30', '09:00', '09:30');
    expectGapEnding('2030-03-30', '10:00', '11:00');
    expectGapEnding('2030-03-30', '12:00', '12:30');
    expectGapEnding('2030-03-30', '13:00', '13:30');
    expectGapEnding('2030-03-30', '14:00', '15:00');

    // ICS, manual and weekly each split the remaining window. The final gap
    // runs through the 19:00 plain deadline and the all-day row to 22:00.
    expectGapEnding('2030-03-30', '16:00', '16:30');
    expectGapEnding('2030-03-30', '17:00', '17:30');
    expectGapEnding('2030-03-30', '18:30', '22:00');
  });

  it('M4A-R5-002 effective saved and postponed placements move rows, counts and occupancy, and Today/Upcoming merge', async () => {
    harness = await prepareCalendar((scenario) => {
      scenario.today = [
        commitment('saved-move', instant(TODAY, '16:00')),
        commitment('postponed-move', instant(TODAY, '17:00'), {
          postponed: true,
          postponedUntil: instant('2030-03-30', '11:00'),
        }),
      ];
      scenario.upcoming = [commitment('tomorrow-native', instant('2030-03-30', '09:00'))];
      scenario.savedWeek.saved = [{
        date: '2030-03-30',
        items: [{ itemId: 'saved-move', startsAt: instant('2030-03-30', '10:00'), endsAt: instant('2030-03-30', '11:00') }],
      }];
    });
    await renderCalendar(harness);
    await press('calendar-day-2030-03-30');

    expect(screen.queryByTestId('calendar-item-saved-move')).not.toBeNull();
    expect(screen.queryByTestId('calendar-item-postponed-move')).not.toBeNull();
    expect(screen.queryByTestId('calendar-item-tomorrow-native')).not.toBeNull();
    await press('calendar-filter-free');
    expectGapEnding('2030-03-30', '09:30', '10:00');
    expect(screen.queryByTestId('calendar-gap-2030-03-30-1100')).toBeNull();
    expect(screen.queryByTestId('calendar-gap-2030-03-30-1130')).not.toBeNull();
  });

  it('M4A-R9-001 a 60-minute-or-longer gap appears as a quiet row in All', async () => {
    harness = await occupiedScenario();
    await renderCalendar(harness);
    await press('calendar-day-2030-03-30');

    const exactGap = screen.queryByTestId('calendar-gap-2030-03-30-1830');
    expect(exactGap).not.toBeNull();
    expect(exactGap!.props.accessibilityRole).not.toBe('button');
  });

  it('M4A-004 an overnight block is clipped into the next civil day and the DST day remains addressable', async () => {
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
      scenario.busy = {
        status: 200,
        body: {
          ...completeBusy,
          blocks: [{
            blockId: 'overnight', sourceId: 'ics', sourceKind: 'ics',
            startAt: instant('2030-03-30', '23:00'), endAt: instant('2030-03-31', '01:00'), allDay: false,
          }],
        },
      };
    });
    await renderCalendar(harness);
    await press('calendar-day-2030-03-31');
    await press('calendar-filter-free');

    expect(screen.queryByTestId('calendar-gap-2030-03-31-0000')).toBeNull();
    expectGapEnding('2030-03-31', '01:00', '02:00');
    expect(screen.queryByTestId(`calendar-day-${TODAY}`)).not.toBeNull();
  });
});
