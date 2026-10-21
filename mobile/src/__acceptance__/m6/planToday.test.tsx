import React, { useEffect, useRef } from 'react';
import { Pressable, Text } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import weekFixture from '../../api/__fixtures__/plan.week.json';
import { DayTimeline, type PlanRow } from '../../features/calendar/PlanDay';
import { WeekScreen } from '../../features/plan/WeekScreen';
import { useApp } from '../../state/AppContext';
import { CalendarScreen } from '../../screens/CalendarScreen';
import { PlanScreen } from '../../screens/PlanScreen';
import { toViewModel } from '../../features/commitments/model';
import {
  NOW,
  Providers,
  TODAY,
  ZONE,
  commitment,
  flatStyle,
  keptPlan,
  prepareM6,
  teardown,
  type M6Harness,
  type RecordedRequest,
} from './harness';
import {
  ITEM_ID,
  capabilities as m4bCapabilities,
  instant as m4bInstant,
  prepare as prepareM4b,
  press as pressM4b,
  showDetails,
  teardown as teardownM4b,
  type M4bHarness,
} from '../m4b/harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

let harness: M6Harness | undefined;
let m4b: M4bHarness | undefined;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(async () => {
  await teardown(harness);
  await teardownM4b(m4b);
  harness = undefined;
  m4b = undefined;
  jest.useRealTimers();
});

describe('M6 Plan density fixes', () => {
  it('M6A-R4-007 groups kept rows by localized reason key and preserves row order', async () => {
    harness = await prepareM6('en', { plan: keptPlan() });
    await render(<Providers harness={harness}><PlanScreen date={TODAY} onBack={() => undefined} /></Providers>);
    await waitFor(() => expect(screen.queryByTestId('plan-kept')).not.toBeNull());

    expect(screen.getAllByTestId(/^m6-plan-kept-group-/)).toHaveLength(2);
    expect(screen.getByTestId('m6-plan-kept-group-planReasonNoRoom')).toHaveTextContent(/2/);
    expect(screen.getByTestId('m6-plan-kept-group-planReasonCalendarBusy')).toHaveTextContent(/1/);
    expect(screen.getAllByTestId(/^m6-plan-kept-row-/).map(row => row.props.testID)).toEqual([
      'm6-plan-kept-row-same-a',
      'm6-plan-kept-row-same-b',
      'm6-plan-kept-row-different',
    ]);
  });

  it('R54.2 #738 makes an eight-hour block taller than one hour and leaves overlapped user titles unclamped', async () => {
    harness = await prepareM6('en');
    const overlap = toViewModel(commitment('overlap', {
      title: 'A very long user title that must wrap without breaking inside a word',
      timeSpec: { kind: 'scheduled_event', dueAt: '2030-03-29T09:30:00.000Z', endAt: null, remindAt: null, allDay: false, timezone: ZONE },
    }), NOW.toISOString());
    const rows: PlanRow[] = [
      { kind: 'busy', key: 'long', at: Date.parse('2030-03-29T09:00:00.000Z'), block: { nativeId: 'long', startAt: '2030-03-29T09:00:00.000Z', endAt: '2030-03-29T17:00:00.000Z', allDay: false }, prep: null },
      { kind: 'busy', key: 'short', at: Date.parse('2030-03-29T18:00:00.000Z'), block: { nativeId: 'short', startAt: '2030-03-29T18:00:00.000Z', endAt: '2030-03-29T19:00:00.000Z', allDay: false }, prep: null },
      { kind: 'commitment', key: 'overlap', at: Date.parse('2030-03-29T09:30:00.000Z'), item: overlap, clock: '2030-03-29T09:30:00.000Z', offDay: false, due: null, conflict: null },
    ];
    await render(<Providers harness={harness}><DayTimeline rows={rows} day={TODAY} nowIso={null} /></Providers>);

    const longHeight = Number(flatStyle(screen.getByTestId('m6-timeline-block-long')).height);
    const shortHeight = Number(flatStyle(screen.getByTestId('m6-timeline-block-short')).height);
    expect(longHeight).toBeGreaterThan(shortHeight);
    expect(screen.getByTestId('m6-calendar-title-overlap').props.numberOfLines).not.toBe(1);
  });

  it('R54.2 #741 omits every load chip when no calendar is connected', async () => {
    harness = await prepareM6('ar', { commitments: [commitment('calendar-row')] });
    await render(<Providers harness={harness}><CalendarScreen /></Providers>);
    await waitFor(() => expect(screen.queryByTestId('calendar-week-strip')).not.toBeNull());

    expect(screen.queryAllByTestId(/^calendar-load-/)).toHaveLength(0);
  });
});

function CalendarIntentNavigator() {
  const { s, actions } = useApp();
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    actions.go('weekPlan');
  }, [actions]);
  return (
    <>
      <Text testID="m6-test-screen">{s.screen}</Text>
      <Pressable testID="m6-test-back" onPress={actions.back}><Text>back</Text></Pressable>
      {s.screen === 'weekPlan' ? <WeekScreen /> : null}
      {s.screen === 'calendar' ? <CalendarScreen /> : null}
    </>
  );
}

function calendarHandler(available: boolean) {
  return (request: RecordedRequest) => {
    if (request.path === '/api/mobile/plans/week' && request.query.has('decisions')) {
      return { status: 200, body: weekFixture };
    }
    if (request.path === '/api/mobile/calendar/busy') {
      return available
        ? { status: 200, body: { success: true, blocks: [], complete: true, cutoff: null, unknownRanges: [], sources: [] } }
        : { status: 404, body: { success: false, error: 'feature_unavailable', reason: 'feature_unavailable' } };
    }
    return undefined;
  };
}

describe('M6 Plan to wider calendar navigation', () => {
  it('M6A-R4-001 opens WiderView once and Back returns to Week', async () => {
    harness = await prepareM6('en', { handler: calendarHandler(true) });
    await render(<Providers harness={harness}><CalendarIntentNavigator /></Providers>);
    await waitFor(() => expect(screen.queryByTestId('m6-plan-see-further')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('m6-plan-see-further'));

    await waitFor(() => expect(screen.queryByTestId('calendar-wider')).not.toBeNull());
    expect(screen.getByTestId('m6-test-screen')).toHaveTextContent('calendar');
    await fireEvent.press(screen.getByTestId('m6-test-back'));
    await waitFor(() => expect(screen.getByTestId('m6-test-screen')).toHaveTextContent('weekPlan'));

    // The same entry point must disappear, rather than becoming a dead link,
    // when the free-time capability is unavailable.
    await teardown(harness);
    harness = await prepareM6('he', { handler: calendarHandler(false) });
    await render(<Providers harness={harness}><CalendarIntentNavigator /></Providers>);
    await waitFor(() => expect(screen.queryByTestId('week-proposal-note')).not.toBeNull());
    expect(screen.queryByTestId('m6-plan-see-further')).toBeNull();
  });
});

describe('M6 Today postpone reasons', () => {
  const same = [0, 1, 2].map(index => ({
    startsAt: m4bInstant('2030-03-30', `${10 + index}:00`),
    endsAt: m4bInstant('2030-03-30', `${11 + index}:00`),
    localDate: '2030-03-30', localTime: `${10 + index}:00`, why: 'light_day', slotToken: `same-${index}`,
  }));
  const different = same.map((slot, index) => ({ ...slot, why: ['soonest', 'light_day', 'usual_time'][index]! }));

  it('R54.2 SIM-B4 shows one shared reason only when every slot reason is identical', async () => {
    let slots = same;
    m4b = await prepareM4b('en', request => {
      if (request.path === '/api/mobile/capabilities/m4b') return { status: 200, body: m4bCapabilities() };
      if (request.path === `/api/mobile/commitments/${ITEM_ID}/postpone-slots`) {
        return { status: 200, body: { success: true, complete: true, slots } };
      }
      return undefined;
    });
    await showDetails(m4b);
    await pressM4b('details-postpone');
    await waitFor(() => expect(screen.queryByTestId('m6-postpone-shared-reason')).not.toBeNull());
    expect(screen.queryAllByTestId(/^postpone-slot-why-/)).toHaveLength(0);

    await teardownM4b(m4b);
    slots = different;
    m4b = await prepareM4b('en', request => request.path === `/api/mobile/commitments/${ITEM_ID}/postpone-slots`
      ? { status: 200, body: { success: true, complete: true, slots } }
      : undefined);
    await showDetails(m4b);
    await pressM4b('details-postpone');
    await waitFor(() => expect(screen.queryByTestId('postpone-slot-why-2')).not.toBeNull());
    expect(screen.queryByTestId('m6-postpone-shared-reason')).toBeNull();
    expect(screen.queryAllByTestId(/^postpone-slot-why-/)).toHaveLength(3);
  });
});

