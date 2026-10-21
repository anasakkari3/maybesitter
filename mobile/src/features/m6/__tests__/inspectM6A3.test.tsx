import React, { useEffect, useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import weekFixture from '../../../api/__fixtures__/plan.week.json';
import { WeekScreen } from '../../plan/WeekScreen';
import { useApp } from '../../../state/AppContext';
import { CalendarScreen } from '../../../screens/CalendarScreen';
import { NOW, Providers, prepareM6, teardown, type M6Harness, type RecordedRequest } from '../../../__acceptance__/m6/harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

/** Regression for Codex's M6a-1 Task A inspection r3 (R3-001) and SIM-M6A-02/03. */
let harness: M6Harness | undefined;
beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(NOW); });
afterEach(async () => { await teardown(harness); harness = undefined; jest.useRealTimers(); });

function handler(request: RecordedRequest) {
  if (request.path === '/api/mobile/plans/week' && request.query.has('decisions')) return { status: 200, body: weekFixture };
  if (request.path === '/api/mobile/calendar/busy') {
    return { status: 200, body: { success: true, blocks: [], complete: true, cutoff: null, unknownRanges: [], sources: [] } };
  }
  return undefined;
}

function Navigator() {
  const { s, actions } = useApp();
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    actions.go('weekPlan');
  }, [actions]);
  return <>{s.screen === 'weekPlan' ? <WeekScreen /> : null}{s.screen === 'calendar' ? <CalendarScreen /> : null}</>;
}

describe('R3-001 the calendar opened over the week', () => {
  it('has one header: a back pinned outside the scroller, and no tab-root header', async () => {
    harness = await prepareM6('en', { handler });
    await render(<Providers harness={harness}><Navigator /></Providers>);
    await waitFor(() => expect(screen.queryByTestId('m6-plan-see-further')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('m6-plan-see-further'));
    await waitFor(() => expect(screen.queryByTestId('calendar-wider')).not.toBeNull());

    expect(screen.getAllByTestId('back-header')).toHaveLength(1);
    expect(within(screen.getByTestId('calendar-scroll')).queryByTestId('back-header')).toBeNull();
    expect(screen.queryByTestId('calendar-range')).toBeNull();
  });

  it('at the tab root there is no back header', async () => {
    harness = await prepareM6('en', { handler });
    await render(<Providers harness={harness}><CalendarScreen /></Providers>);
    await waitFor(() => expect(screen.queryByTestId('calendar-week-strip')).not.toBeNull());
    expect(screen.queryByTestId('back-header')).toBeNull();
  });
});
