/**
 * "Disconnect and delete busy times" (UC-3.2, #186 step 8).
 *
 * ── Three things have to happen, and the third is the one that gets forgotten ──
 *
 * The blocks go from the phone. The blocks go from the account. And the Trust
 * Center's calendar switch goes off.
 *
 * The third is not decoration. Clearing the cache clears
 * `calendar.busySyncedAt.v1` with it, so the fifteen-minute throttle no longer
 * holds anything back — leave the switch on and the very next time the app came
 * to the front it would read the calendar again and upload the window that had
 * just been deleted. A disconnect that reconnects itself inside a minute is
 * worse than no button at all, and only a test can tell the two apart, because
 * on a device they look identical until somebody comes back fifteen minutes
 * later and looks at Firestore.
 *
 * ── And the local half happens even when the network does not ────
 *
 * The person most likely to press this is the person who has just decided they
 * do not want this. Leaving their busy times on the screen because a request
 * timed out would be answering "stop" with "in a minute" — so the cache is
 * cleared first, unconditionally, and the copy says plainly which half did not
 * happen.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import en from '../../../i18n/locales/en.json';
import { CalendarSettingsScreen } from '../CalendarSettingsScreen';
import { BUSY_BLOCKS_KEY, BUSY_SYNCED_AT_KEY } from '../../../lib/deviceSettings/calendarBusy';
import { resetWriterIdCache } from '../../../lib/deviceSettings/calendarDevice';
import { resetCalendarSyncForTests } from '../../calendar/useDeviceCalendarSync';
import { resetBusySyncForTests } from '../../calendar/useBusyCalendar';
import { deviceCalendar } from '../../calendar/deviceCalendar';

import * as calendarEndpoints from '../../../api/endpoints/calendar';
import * as commitmentEndpoints from '../../../api/endpoints/commitments';
import * as trustEndpoints from '../../../api/endpoints/trust';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const USER: AuthUser = {
  uid: 'disconnect-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

const HOUR = 3_600_000;
const FROM = new Date(Date.now() + 6 * HOUR);

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

function trustBody(calendarConsent: boolean) {
  return { success: true, participantId: USER.uid, trust: { analyticsConsent: false, calendarConsent } };
}

beforeEach(async () => {
  onlineManager.setOnline(true);
  resetWriterIdCache();
  resetCalendarSyncForTests();
  resetBusySyncForTests();
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  await AsyncStorage.multiRemove([BUSY_BLOCKS_KEY, BUSY_SYNCED_AT_KEY]);
  await AsyncStorage.setItem(BUSY_BLOCKS_KEY, JSON.stringify([
    { nativeId: 'evt-1', startAt: FROM.toISOString(), endAt: new Date(FROM.getTime() + HOUR).toISOString(), allDay: false },
  ]));
  await AsyncStorage.setItem(BUSY_SYNCED_AT_KEY, String(Date.now()));

  jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [] } as never);
  jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] } as never);
  jest.spyOn(calendarEndpoints, 'getCalendarSettings')
    .mockResolvedValue({ success: true, calendarSettings: { writeTarget: 'off', updatedAt: null } } as never);
  jest.spyOn(deviceCalendar, 'getAccess').mockResolvedValue('granted');
  jest.spyOn(deviceCalendar, 'listWritableCalendars').mockResolvedValue([]);
  // The switch is on, so mounting this screen runs a sync — the real one, in
  // the real order, which is why the count below is a fact about the pass and
  // not about what this file seeded. An unmocked read would be a device call.
  jest.spyOn(deviceCalendar, 'fetchBusyBlocks').mockResolvedValue([
    { nativeId: 'evt-1', startAt: FROM.toISOString(), endAt: new Date(FROM.getTime() + HOUR).toISOString(), allDay: false },
  ]);
  jest.spyOn(trustEndpoints, 'getTrust').mockResolvedValue(trustBody(true) as never);
  jest.spyOn(trustEndpoints, 'updateTrust').mockResolvedValue(trustBody(false) as never);
  jest.spyOn(calendarEndpoints, 'deleteCalendarBusy').mockResolvedValue({ success: true, deleted: 2 } as never);
  jest.spyOn(calendarEndpoints, 'postCalendarBusy').mockResolvedValue({
    success: true,
    blocks: 0,
    source: {
      sourceId: 'device:x', lastSyncedAt: new Date().toISOString(),
      windowStart: new Date().toISOString(), windowEnd: new Date().toISOString(),
    },
  } as never);
});

afterEach(async () => {
  cleanup();
  // A real macrotask: a settling request when the tree came down leaves React
  // work in flight, and RNTL v14's next `render` then mounts nothing.
  await new Promise((resolve) => setTimeout(resolve, 0));
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

async function show() {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}>
            <CalendarSettingsScreen onBack={() => {}} />
          </QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryByTestId('calendar-disconnect')).not.toBeNull());
}

describe('pressing disconnect', () => {
  it('clears the phone, the account and the switch', async () => {
    await show();
    await fireEvent.press(screen.getByTestId('calendar-disconnect'));

    await waitFor(() => expect(calendarEndpoints.deleteCalendarBusy).toHaveBeenCalledTimes(1));
    expect((calendarEndpoints.deleteCalendarBusy as jest.Mock).mock.calls[0]![0] as string)
      .toMatch(/^device:/);
    expect(await AsyncStorage.getItem(BUSY_BLOCKS_KEY)).toBeNull();
    // The one that is easy to forget. Without it the next trip to the home
    // screen re-uploads everything that was just deleted, because clearing the
    // cache also cleared the throttle.
    await waitFor(() => expect(trustEndpoints.updateTrust)
      .toHaveBeenCalledWith({ type: 'set_calendar_consent', granted: false }));
  });

  it('says so, and says how many busy times the sync found', async () => {
    await show();
    await waitFor(() => expect(String(screen.getByTestId('calendar-busy-count').props.children)).toContain('1'));
    await fireEvent.press(screen.getByTestId('calendar-disconnect'));
    await waitFor(() => expect(screen.queryByTestId('calendar-disconnect-result')).not.toBeNull());
    expect(String(screen.getByTestId('calendar-disconnect-result').props.children))
      .toBe(en.calendarDisconnectDone);
  });

  it('clears the phone even when the account cannot be reached, and says which half failed', async () => {
    jest.spyOn(calendarEndpoints, 'deleteCalendarBusy').mockRejectedValue(new Error('offline') as never);
    await show();
    await fireEvent.press(screen.getByTestId('calendar-disconnect'));

    await waitFor(() => expect(screen.queryByTestId('calendar-disconnect-result')).not.toBeNull());
    expect(String(screen.getByTestId('calendar-disconnect-result').props.children))
      .toBe(en.calendarDisconnectFailed);
    expect(await AsyncStorage.getItem(BUSY_BLOCKS_KEY)).toBeNull();
  });
});

describe('what the screen says without being asked', () => {
  it('names the Android caveat on Android', async () => {
    const original = Platform.OS;
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    try {
      await show();
      expect(String(screen.getByTestId('calendar-declined-note').props.children))
        .toBe(en.calendarDeclinedNote);
    } finally {
      Object.defineProperty(Platform, 'OS', { value: original, configurable: true });
    }
  });

  // UAT 2026-09-26, #17, shot 57: an iPhone was told what Android does.
  it('says nothing about Android on an iPhone', async () => {
    const original = Platform.OS;
    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
    try {
      await show();
      expect(screen.queryByTestId('calendar-busy-count')).not.toBeNull();
      expect(screen.queryByTestId('calendar-declined-note')).toBeNull();
    } finally {
      Object.defineProperty(Platform, 'OS', { value: original, configurable: true });
    }
  });
});
