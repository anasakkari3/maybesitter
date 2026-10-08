import React from 'react';
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { act, render, screen, waitFor } from '@testing-library/react-native';
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
  teardown,
} from './harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

let client: QueryClient | undefined;

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
    .mockRejectedValueOnce(new Error('permission denied'));
  const scenario = calendarScenario();
  scenario.busy = { status: 200, body: completeBusy };
  const server = new M4aServer(scenario);
  server.extra = (request) => request.path === '/api/mobile/calendar/busy' && request.method === 'POST'
    ? {
        status: 200,
        body: {
          success: true,
          blocks: 1,
          source: {
            sourceId: 'device:test',
            lastSyncedAt: NOW.toISOString(),
            windowStart: instant(TODAY, '00:00'),
            windowEnd: instant('2030-04-26', '00:00'),
          },
        },
      }
    : undefined;
  server.install();
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const repository = createFakeAuthRepository({ initialUser: ACCOUNT_A, idToken: 'm4a-token' });

  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <ApiProvider client={client}>
            <BusyCalendarHost />
            <CalendarScreen />
          </ApiProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.queryByTestId('calendar-busy-row')).not.toBeNull());

  await act(async () => { repository.emit(ACCOUNT_B); });
  expect(screen.queryByTestId('calendar-busy-row')).toBeNull();
  expect(screen.queryByTestId('calendar-free-unknown')).not.toBeNull();

  await act(async () => { repository.emit(null); });
  await waitFor(async () => expect(await AsyncStorage.getItem(BUSY_BLOCKS_KEY)).toBeNull());
});
