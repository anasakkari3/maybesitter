import React from 'react';
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClient } from '@tanstack/react-query';
import { AppProvider } from '../../state/AppContext';
import { AuthProvider } from '../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';
import { ApiProvider } from '../../api/ui/ApiProvider';
import { CalendarScreen } from '../../screens/CalendarScreen';
import { BusyCalendarHost, resetBusySyncForTests } from '../../features/calendar/useBusyCalendar';
import { deviceCalendar } from '../../features/calendar/deviceCalendar';
import { BUSY_BLOCKS_KEY } from '../../lib/deviceSettings/calendarBusy';
import { LANGUAGE_STORAGE_KEY } from '../../i18n/language';
import {
  ACCOUNT_A,
  ACCOUNT_B,
  METRICS,
  M4aServer,
  NOW,
  TODAY,
  calendarScenario,
  completeBusy,
  instant,
  press,
  teardown,
  trust,
} from './harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

let client: QueryClient | undefined;

function installDeviceServer(scenario = calendarScenario()): M4aServer {
  scenario.trust = trust(true);
  scenario.busy = { status: 200, body: completeBusy };
  const server = new M4aServer(scenario);
  server.extra = (request) => {
    if (request.path !== '/api/mobile/calendar/busy' || request.method !== 'POST') return undefined;
    const body = request.body as { blocks?: unknown[]; windowStart?: string; windowEnd?: string } | null;
    return {
      status: 200,
      body: {
        success: true,
        blocks: body?.blocks?.length ?? 0,
        source: {
          sourceId: 'device:test',
          lastSyncedAt: new Date().toISOString(),
          windowStart: body?.windowStart ?? instant(TODAY, '00:00'),
          windowEnd: body?.windowEnd ?? instant('2030-04-26', '00:00'),
        },
      },
    };
  };
  server.install();
  return server;
}

async function renderDeviceCalendar(
  repository: ReturnType<typeof createFakeAuthRepository>,
  expectedDay = TODAY,
  busyHostKey = repository.currentUser()?.uid ?? 'signed-out',
) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <ApiProvider client={client}>
            <BusyCalendarHost key={busyHostKey} />
            <CalendarScreen />
          </ApiProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryByTestId(`calendar-day-${expectedDay}`)).not.toBeNull());
  return view;
}

function expectGapEnding(day: string, start: string, end: string): void {
  const gap = screen.getByTestId(`calendar-gap-${day}-${start.replace(':', '')}`);
  expect(String(gap.props.accessibilityLabel ?? '')).toContain(end);
}

beforeEach(async () => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  resetBusySyncForTests();
  await AsyncStorage.clear();
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'en');
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://localhost:3000';
  delete process.env.EXPO_PUBLIC_FEATURE_CALENDAR_READ;
});

afterEach(async () => {
  client?.clear();
  client = undefined;
  resetBusySyncForTests();
  await teardown();
  jest.useRealTimers();
});

it('M4A-R8-001 account A device blocks never appear for B and sign-out clears the envelope', async () => {
  const block = {
    nativeId: 'account-a-private-block',
    startAt: instant(TODAY, '13:00'),
    endAt: instant(TODAY, '14:00'),
    allDay: false,
  };
  const read = jest.spyOn(deviceCalendar, 'fetchBusyBlocks')
    .mockResolvedValueOnce([block])
    .mockImplementationOnce(() => new Promise(() => undefined));
  const scenario = calendarScenario();
  const server = installDeviceServer(scenario);
  const repository = createFakeAuthRepository({ initialUser: ACCOUNT_A, idToken: 'm4a-token' });

  const view = await renderDeviceCalendar(repository);
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.queryByTestId('calendar-busy-row')).not.toBeNull());
  await waitFor(async () => expect(await AsyncStorage.getItem(BUSY_BLOCKS_KEY)).toContain(block.nativeId));
  await waitFor(() => expect(server.matching('POST', /\/calendar\/busy$/)).toHaveLength(1));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  resetBusySyncForTests();
  await act(async () => { repository.emit(ACCOUNT_B); });
  await act(async () => {
    view.rerender(
      <SafeAreaProvider initialMetrics={METRICS}>
        <AppProvider>
          <AuthProvider repository={repository} isDevBundle={false}>
            <ApiProvider client={client!}>
              <BusyCalendarHost key={ACCOUNT_B.uid} />
              <CalendarScreen />
            </ApiProvider>
          </AuthProvider>
        </AppProvider>
      </SafeAreaProvider>,
    );
  });
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(screen.queryByTestId('calendar-busy-row')).toBeNull();
  expect(screen.queryByTestId('calendar-free-unknown')).not.toBeNull();

  await act(async () => { repository.emit(null); });
  await waitFor(async () => expect(await AsyncStorage.getItem(BUSY_BLOCKS_KEY)).toBeNull());

  await act(async () => { repository.emit(ACCOUNT_B); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect((await AsyncStorage.getItem(BUSY_BLOCKS_KEY)) ?? '').not.toContain(block.nativeId);
  expect(screen.queryByTestId('calendar-busy-row')).toBeNull();
});

it('M4A-R9-004 a covered device block splits free time without any gap overlapping it', async () => {
  const read = jest.spyOn(deviceCalendar, 'fetchBusyBlocks').mockResolvedValue([{
    nativeId: 'device-meeting',
    startAt: instant('2030-03-30', '13:00'),
    endAt: instant('2030-03-30', '14:00'),
    allDay: false,
  }]);
  const server = installDeviceServer();
  const repository = createFakeAuthRepository({ initialUser: ACCOUNT_A, idToken: 'm4a-token' });

  await renderDeviceCalendar(repository);
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(server.matching('POST', /\/calendar\/busy$/)).toHaveLength(1));
  expect(screen.queryByTestId('calendar-filter-free')).not.toBeNull();
  await press('calendar-day-2030-03-30');
  await press('calendar-filter-free');

  expectGapEnding('2030-03-30', '08:00', '13:00');
  expectGapEnding('2030-03-30', '14:00', '22:00');
  expect(screen.queryByTestId('calendar-gap-2030-03-30-1300')).toBeNull();
});

it('M4A-R9-004 more than 1000 device intervals makes the first omitted interval and later time unknown', async () => {
  const blocks = Array.from({ length: 1000 }, (_, index) => ({
    nativeId: `kept-${index}`,
    startAt: instant('2030-03-30', '12:00'),
    endAt: instant('2030-03-30', '12:01'),
    allDay: true,
  }));
  blocks.push({
    nativeId: 'first-omitted',
    startAt: instant('2030-03-30', '13:00'),
    endAt: instant('2030-03-30', '14:00'),
    allDay: false,
  });
  jest.spyOn(deviceCalendar, 'fetchBusyBlocks').mockResolvedValue(blocks);
  const server = installDeviceServer();
  const repository = createFakeAuthRepository({ initialUser: ACCOUNT_A, idToken: 'm4a-token' });

  await renderDeviceCalendar(repository);
  await waitFor(() => expect(server.matching('POST', /\/calendar\/busy$/)).toHaveLength(1));
  expect(screen.queryByTestId('calendar-filter-free')).not.toBeNull();
  await press('calendar-day-2030-03-30');
  await press('calendar-filter-free');

  expectGapEnding('2030-03-30', '08:00', '13:00');
  expect(screen.queryByTestId('calendar-gap-2030-03-30-1300')).toBeNull();
  expect(screen.queryByTestId('calendar-free-unknown')).not.toBeNull();
});

it('M4A-R7-002 a device cache whose honest window ended across midnight is unknown', async () => {
  const read = jest.spyOn(deviceCalendar, 'fetchBusyBlocks')
    .mockResolvedValueOnce([])
    .mockRejectedValueOnce(new Error('permission denied'));
  const server = installDeviceServer();
  const repository = createFakeAuthRepository({ initialUser: ACCOUNT_A, idToken: 'm4a-token' });

  await renderDeviceCalendar(repository);
  await waitFor(() => expect(server.matching('POST', /\/calendar\/busy$/)).toHaveLength(1));
  await cleanup();
  client?.clear();
  resetBusySyncForTests();
  jest.setSystemTime(new Date(NOW.getTime() + 28 * 24 * 60 * 60 * 1000));

  const laterRepository = createFakeAuthRepository({ initialUser: ACCOUNT_A, idToken: 'm4a-token' });
  await renderDeviceCalendar(laterRepository, '2030-04-26');
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(screen.getByTestId('calendar-day-2030-04-26').props.accessibilityState.selected).toBe(true);
  expect(screen.queryByTestId('calendar-free-unknown')).not.toBeNull();
  expect(screen.queryAllByTestId(/^calendar-gap-/)).toHaveLength(0);
  expect(screen.queryAllByTestId(/^calendar-free-total-/)).toHaveLength(0);
});
