import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react-native';
import { queryKeys, useTrustAction } from '../../../api/queries';
import type { TrustAction } from '../../../api/schemas/trust';
import { BusyCalendarHost } from '../../calendar/useBusyCalendar';
import { CalendarSettingsScreen } from '../CalendarSettingsScreen';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { deviceCalendar } from '../../calendar/deviceCalendar';
import {
  ACCOUNT_A, NOW, Providers, captureAppState, changeSwitch, initialState, prepare, showCalendar, teardown, trustResponse,
  type M5aHarness, type RouteReply,
} from '../../../__acceptance__/m5a/harness';

/**
 * M6b BB-08 with Codex M6B-R02: the phone-calendar switches follow the master
 * «MaybeSitter uses your calendar» switch itself, not enrollment, and say so.
 */
let harness: M5aHarness | undefined;
const ENROLLED = `calendar.choiceEnrolledAt.v1:${ACCOUNT_A.uid}`;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  jest.spyOn(deviceCalendar, 'getAccess').mockResolvedValue('granted');
  jest.spyOn(deviceCalendar, 'requestAccess').mockResolvedValue('granted');
  jest.spyOn(deviceCalendar, 'listWritableCalendars').mockResolvedValue([]);
  jest.spyOn(deviceCalendar, 'listEventCalendars').mockResolvedValue([
    { id: 'work', title: 'Work', color: null, sourceName: 'work@example.com' },
  ]);
  jest.spyOn(deviceCalendar, 'fetchBusyBlocks').mockResolvedValue([]);
});

afterEach(async () => {
  await teardown(harness);
  harness = undefined;
  jest.useRealTimers();
});

const PENDING = `calendar.pendingSelection.v1:${ACCOUNT_A.uid}`;

async function calendarWith(consent: boolean, handler?: Parameters<typeof prepare>[2]) {
  harness = await prepare('en', { ...initialState(), trustConsent: consent }, handler);
  await AsyncStorage.setItem(ENROLLED, '2030-03-20T08:00:00.000Z');
  await showCalendar(harness);
  await waitFor(() => expect(screen.queryByTestId('calendar-include-work')).not.toBeNull());
}

describe('the calendar switches follow «uses your calendar»', () => {
  it('an enrolled account with the master switch off: switches disabled, and the hint says why', async () => {
    await calendarWith(false);
    expect(screen.getByTestId('calendar-include-work').props.accessibilityState).toMatchObject({ disabled: true });
    expect(screen.queryByTestId('calendar-list-needs-use')).not.toBeNull();
  });

  it('with the master switch on: switches usable and no hint', async () => {
    await calendarWith(true);
    await waitFor(() => expect(screen.getByTestId('calendar-include-work').props.accessibilityState).toMatchObject({ disabled: false }));
    expect(screen.queryByTestId('calendar-list-needs-use')).toBeNull();
  });

  it('turning the master switch off disables the list at once, before the server answers (Codex M6B-R3-001)', async () => {
    let answer: ((reply: RouteReply) => void) | undefined;
    await calendarWith(true, (request) => {
      if (request.method !== 'POST' || request.path !== '/api/mobile/pilot/trust') return undefined;
      return new Promise<RouteReply>((resolve) => { answer = resolve; });
    });
    await waitFor(() => expect(screen.getByTestId('calendar-include-work').props.accessibilityState).toMatchObject({ disabled: false }));

    await changeSwitch('calendar-use-toggle', false);
    await waitFor(() => expect(answer).toBeDefined());
    // The trust query still says on: the list must not, and the master switch
    // shows the off it was given, locked until the answer (Codex M6B-R4-004).
    await waitFor(() => expect(screen.getByTestId('calendar-include-work').props.accessibilityState).toMatchObject({ disabled: true }));
    expect(screen.getByTestId('calendar-use-toggle').props.value).toBe(false);
    expect(screen.getByTestId('calendar-use-toggle').props.accessibilityState).toMatchObject({ checked: false, disabled: true });
    expect(screen.queryByTestId('calendar-list-needs-use')).not.toBeNull();
    await changeSwitch('calendar-include-work', true);
    expect(await AsyncStorage.getItem(PENDING)).toBeNull();

    harness!.server.state.trustConsent = false;
    await act(async () => { answer!({ status: 200, body: trustResponse(false) }); });
    await waitFor(() => expect(screen.getByTestId('calendar-use-toggle').props.value).toBe(false));
    expect(screen.getByTestId('calendar-include-work').props.accessibilityState).toMatchObject({ disabled: true });
    expect(await AsyncStorage.getItem(PENDING)).toBeNull();
  });

  it('a refused switch-off leaves the list usable again', async () => {
    await calendarWith(true, (request) => (
      request.method === 'POST' && request.path === '/api/mobile/pilot/trust' ? { status: 503, body: { success: false } } : undefined
    ));
    await waitFor(() => expect(screen.getByTestId('calendar-include-work').props.accessibilityState).toMatchObject({ disabled: false }));
    await changeSwitch('calendar-use-toggle', false);
    await waitFor(() => expect(screen.getByTestId('calendar-include-work').props.accessibilityState).toMatchObject({ disabled: false }));
    expect(screen.getByTestId('calendar-use-toggle').props.value).toBe(true);
  });

  it('a switch-off the server confirmed holds even when the refetch after it fails (Codex M6B-R4-001)', async () => {
    const foreground = captureAppState();
    let posted = false;
    await calendarWith(true, (request) => {
      if (request.path !== '/api/mobile/pilot/trust') return undefined;
      if (request.method === 'POST') {
        posted = true;
        return { status: 200, body: trustResponse(false) };
      }
      return posted ? { status: 503, body: { success: false } } : undefined;
    });
    await waitFor(() => expect(screen.getByTestId('calendar-include-work').props.accessibilityState).toMatchObject({ disabled: false }));

    await changeSwitch('calendar-use-toggle', false);
    await waitFor(() => expect(screen.getByTestId('calendar-use-toggle').props.value).toBe(false));
    await waitFor(() => expect(harness!.server.matching('GET', /\/api\/mobile\/pilot\/trust$/).length).toBeGreaterThan(1));
    // The failed refetch did not bring the old «on» back.
    expect(screen.getByTestId('calendar-use-toggle').props.value).toBe(false);
    expect(screen.getByTestId('calendar-include-work').props.accessibilityState).toMatchObject({ disabled: true });

    const reads = jest.mocked(deviceCalendar.fetchBusyBlocks);
    reads.mockClear();
    await act(async () => { foreground('active'); await jest.advanceTimersByTimeAsync(2_000); });
    expect(reads).not.toHaveBeenCalled();
  });

  it('a switch-off on its way survives leaving and reopening the screen (Codex M6B-R5-002)', async () => {
    let answer: ((reply: RouteReply) => void) | undefined;
    await calendarWith(true, (request) => {
      if (request.method !== 'POST' || request.path !== '/api/mobile/pilot/trust') return undefined;
      return new Promise<RouteReply>((resolve) => { answer = resolve; });
    });
    await waitFor(() => expect(screen.getByTestId('calendar-include-work').props.accessibilityState).toMatchObject({ disabled: false }));
    await changeSwitch('calendar-use-toggle', false);
    await waitFor(() => expect(answer).toBeDefined());
    // Back, and in again, with the request still open.
    await cleanup();
    await showCalendar(harness!);
    await waitFor(() => expect(screen.queryByTestId('calendar-include-work')).not.toBeNull());
    expect(screen.getByTestId('calendar-include-work').props.accessibilityState).toMatchObject({ disabled: true });
    // The master switch is still locked: the off is on its way whatever screen
    // asked for it, so an on cannot race it (Codex M6B-R6-002).
    expect(screen.getByTestId('calendar-use-toggle').props.disabled).toBe(true);
    expect(screen.getByTestId('calendar-use-toggle').props.accessibilityState).toMatchObject({ checked: false, disabled: true });
    await changeSwitch('calendar-include-work', true);
    expect(await AsyncStorage.getItem(PENDING)).toBeNull();
    harness!.server.state.trustConsent = false;
    await act(async () => { answer!({ status: 200, body: trustResponse(false) }); });
    expect(await AsyncStorage.getItem(PENDING)).toBeNull();
  });

  it('no other trust answer brings a switch-off back: not a read that lands first, not a slower other action (Codex M6B-R5-001)', async () => {
    let calendarAnswer: ((reply: RouteReply) => void) | undefined;
    let analyticsAnswer: ((reply: RouteReply) => void) | undefined;
    let staleRead: ((reply: RouteReply) => void) | undefined;
    let holdNextRead = false;
    let confirmed = false;
    let mutate: ((action: TrustAction) => void) | undefined;
    function AnalyticsProbe() {
      const action = useTrustAction();
      mutate = action.mutate;
      return null;
    }
    harness = await prepare('en', { ...initialState(), trustConsent: true }, (request) => {
      if (request.path !== '/api/mobile/pilot/trust') return undefined;
      const type = (request.body as { action?: { type?: string } } | null)?.action?.type;
      if (request.method === 'POST' && type === 'set_analytics_consent') return new Promise<RouteReply>((resolve) => { analyticsAnswer = resolve; });
      if (request.method === 'POST') return new Promise<RouteReply>((resolve) => { calendarAnswer = resolve; });
      if (holdNextRead) {
        holdNextRead = false;
        return new Promise<RouteReply>((resolve) => { staleRead = resolve; });
      }
      return confirmed ? { status: 503, body: { success: false } } : undefined;
    });
    await AsyncStorage.setItem(ENROLLED, '2030-03-20T08:00:00.000Z');
    await render(
      <Providers harness={harness}>
        <BusyCalendarHost />
        <CalendarSettingsScreen onBack={() => {}} />
        <AnalyticsProbe />
      </Providers>,
    );
    await waitFor(() => expect(screen.getByTestId('calendar-include-work').props.accessibilityState).toMatchObject({ disabled: false }));

    // Another trust action goes first and is slow to answer.
    await act(async () => { mutate!({ type: 'set_analytics_consent', granted: true }); });
    await waitFor(() => expect(analyticsAnswer).toBeDefined());
    await changeSwitch('calendar-use-toggle', false);
    await waitFor(() => expect(calendarAnswer).toBeDefined());
    // A read starts while the switch-off is on its way, and lands before the
    // server has applied it, saying on.
    holdNextRead = true;
    await act(async () => { void harness!.client.invalidateQueries({ queryKey: queryKeys.trust(ACCOUNT_A.uid) }); });
    await waitFor(() => expect(staleRead).toBeDefined());
    await act(async () => { staleRead!({ status: 200, body: trustResponse(true) }); await jest.advanceTimersByTimeAsync(100); });
    expect(harness!.client.getQueryData<{ trust: { calendarConsent: boolean } }>(queryKeys.trust(ACCOUNT_A.uid))?.trust.calendarConsent).toBe(false);
    expect(screen.getByTestId('calendar-use-toggle').props.value).toBe(false);
    // The server confirms the off; every read after it fails; the slower
    // action's answer lands saying on.
    confirmed = true;
    await act(async () => { calendarAnswer!({ status: 200, body: trustResponse(false) }); });
    await act(async () => { analyticsAnswer!({ status: 200, body: trustResponse(true) }); });
    await act(async () => { await jest.advanceTimersByTimeAsync(500); });
    expect(harness!.client.getQueryData<{ trust: { calendarConsent: boolean } }>(queryKeys.trust(ACCOUNT_A.uid))?.trust.calendarConsent).toBe(false);
    expect(screen.getByTestId('calendar-use-toggle').props.value).toBe(false);
    expect(screen.getByTestId('calendar-include-work').props.accessibilityState).toMatchObject({ disabled: true });
  });

  it('says nothing about the master switch until the trust has answered (Codex M6B-R5-004)', async () => {
    await calendarWith(false, (request) => (
      request.method === 'GET' && request.path === '/api/mobile/pilot/trust' ? new Promise<RouteReply>(() => {}) : undefined
    ));
    expect(screen.queryByTestId('calendar-list-needs-use')).toBeNull();
  });

  it('a switch-on the server confirmed holds even when the refetch after it fails (Codex M6B-R6-003)', async () => {
    let posted = false;
    await calendarWith(false, (request) => {
      if (request.path !== '/api/mobile/pilot/trust') return undefined;
      if (request.method === 'POST') {
        posted = true;
        return { status: 200, body: trustResponse(true) };
      }
      return posted ? { status: 503, body: { success: false } } : undefined;
    });
    await waitFor(() => expect(screen.getByTestId('calendar-use-toggle').props.disabled).toBe(false));
    await changeSwitch('calendar-use-toggle', true);
    await waitFor(() => expect(harness!.server.matching('GET', /\/api\/mobile\/pilot\/trust$/).length).toBeGreaterThan(1));
    await act(async () => { await jest.advanceTimersByTimeAsync(200); });
    expect(screen.getByTestId('calendar-use-toggle').props.value).toBe(true);
    expect(screen.getByTestId('calendar-use-toggle').props.disabled).toBe(false);
    expect(screen.getByTestId('calendar-include-work').props.accessibilityState).toMatchObject({ disabled: false });
  });

  it('calendar-consent writes from different places go one after another, and the newest answer decides (Codex M6B-R7-002)', async () => {
    const answers: ((reply: RouteReply) => void)[] = [];
    let posted = 0;
    let mutate: ((action: TrustAction) => void) | undefined;
    function OtherScreen() {
      const action = useTrustAction();
      mutate = action.mutate;
      return null;
    }
    harness = await prepare('en', { ...initialState(), trustConsent: true }, (request) => {
      if (request.path !== '/api/mobile/pilot/trust') return undefined;
      if (request.method === 'POST') {
        posted += 1;
        return new Promise<RouteReply>((resolve) => { answers.push(resolve); });
      }
      return posted > 0 ? { status: 503, body: { success: false } } : undefined;
    });
    await AsyncStorage.setItem(ENROLLED, '2030-03-20T08:00:00.000Z');
    await render(
      <Providers harness={harness}>
        <BusyCalendarHost />
        <CalendarSettingsScreen onBack={() => {}} />
        <OtherScreen />
      </Providers>,
    );
    await waitFor(() => expect(screen.getByTestId('calendar-include-work').props.accessibilityState).toMatchObject({ disabled: false }));
    await changeSwitch('calendar-use-toggle', false);
    await waitFor(() => expect(answers).toHaveLength(1));
    // Another screen asks for on while the off is still open: it waits its turn.
    await act(async () => { mutate!({ type: 'set_calendar_consent', granted: true }); await jest.advanceTimersByTimeAsync(50); });
    expect(answers).toHaveLength(1);
    await act(async () => { answers[0]!({ status: 200, body: trustResponse(false) }); await jest.advanceTimersByTimeAsync(50); });
    await waitFor(() => expect(answers).toHaveLength(2));
    await act(async () => { answers[1]!({ status: 200, body: trustResponse(true) }); await jest.advanceTimersByTimeAsync(200); });
    // The newest write was on, and its answer holds even though every refetch fails.
    expect(harness.client.getQueryData<{ trust: { calendarConsent: boolean } }>(queryKeys.trust(ACCOUNT_A.uid))?.trust.calendarConsent).toBe(true);
    await waitFor(() => expect(screen.getByTestId('calendar-use-toggle').props.value).toBe(true));
  });
});
