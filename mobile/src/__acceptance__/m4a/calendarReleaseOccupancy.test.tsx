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
    return prepareCalendar((scenario) => {
      scenario.today = [
        commitment('event-with-end', instant(TODAY, '08:00'), { end: instant(TODAY, '09:00') }),
        commitment('event-fallback', instant(TODAY, '09:00')),
        commitment('timed-window', instant(TODAY, '09:30'), { kind: 'due_by', end: instant(TODAY, '10:30') }),
        commitment('plain-deadline', instant(TODAY, '15:00'), { kind: 'due_by' }),
        commitment('all-day', instant(TODAY, '00:00'), { allDay: true }),
        commitment('saved-move', instant(TODAY, '16:00')),
        commitment('postponed-move', instant(TODAY, '17:00'), {
          postponed: true,
          postponedUntil: instant('2030-03-30', '11:00'),
        }),
      ];
      scenario.savedWeek.saved = [{
        date: '2030-03-30',
        items: [{ itemId: 'saved-move', startsAt: instant('2030-03-30', '10:00'), endsAt: instant('2030-03-30', '11:00') }],
      }];
      scenario.weekly = [{
        occurrenceId: 'weekly-1', weeklyBlockId: 'weekly', title: 'Weekly',
        startAt: instant(TODAY, '12:00'), endAt: instant(TODAY, '13:00'),
      }];
      scenario.busy = {
        status: 200,
        body: {
          ...completeBusy,
          blocks: [
            { blockId: 'ics-1', sourceId: 'ics-1', sourceKind: 'ics', startAt: instant(TODAY, '10:30'), endAt: instant(TODAY, '11:30'), allDay: false },
            { blockId: 'manual-1', sourceId: 'manual', sourceKind: 'manual', startAt: instant(TODAY, '11:30'), endAt: instant(TODAY, '12:00'), allDay: false },
          ],
        },
      };
    });
  }

  it('M4A-003 / M4A-R2-003 occupancy excludes real timed intervals, ignores plain deadlines and all-day rows, and includes ICS/manual/weekly blocks', async () => {
    harness = await occupiedScenario();
    await renderCalendar(harness);
    await press('calendar-filter-free');

    expect(screen.queryByTestId(`calendar-gap-${TODAY}-1300`)).not.toBeNull();
    expect(screen.queryByTestId(`calendar-gap-${TODAY}-0800`)).toBeNull();
    expect(screen.queryByTestId(`calendar-gap-${TODAY}-1500`)).not.toBeNull();
  });

  it('M4A-R5-002 effective saved and postponed placements move rows, counts and occupancy, and Today/Upcoming merge', async () => {
    harness = await occupiedScenario();
    harness.scenario.upcoming = [commitment('tomorrow-native', instant('2030-03-30', '09:00'))];
    await renderCalendar(harness);
    await press('calendar-day-2030-03-30');

    expect(screen.queryByTestId('calendar-item-saved-move')).not.toBeNull();
    expect(screen.queryByTestId('calendar-item-postponed-move')).not.toBeNull();
    expect(screen.queryByTestId('calendar-item-tomorrow-native')).not.toBeNull();
    await press('calendar-filter-free');
    expect(screen.queryByTestId('calendar-gap-2030-03-30-1000')).toBeNull();
    expect(screen.queryByTestId('calendar-gap-2030-03-30-1100')).toBeNull();
  });

  it('M4A-R9-001 a 60-minute-or-longer gap appears as a quiet row in All', async () => {
    harness = await occupiedScenario();
    await renderCalendar(harness);

    const gap = screen.queryByTestId(`calendar-gap-${TODAY}-1300`);
    expect(gap).not.toBeNull();
    expect(gap!.props.accessibilityRole).not.toBe('button');
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
            startAt: instant('2030-03-28', '23:00'), endAt: instant(TODAY, '01:00'), allDay: false,
          }],
        },
      };
    });
    await renderCalendar(harness);
    await press('calendar-filter-free');

    expect(screen.queryByTestId(`calendar-gap-${TODAY}-0000`)).toBeNull();
    expect(screen.queryByTestId(`calendar-gap-${TODAY}-0100`)).not.toBeNull();
    expect(screen.queryByTestId(`calendar-day-${TODAY}`)).not.toBeNull();
  });
});
