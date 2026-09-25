/**
 * Settings → Calendar: the calendars already on the phone (first iPhone run, L7).
 *
 * The owner: "I have many calendars connected to my email; they should show up
 * here, I shouldn't have to fill anything in." Accounts added in the phone's
 * settings (Google, Outlook, iCloud) reach the app through the OS calendar, so
 * after permission this screen lists every event calendar, grouped by account,
 * each with a switch that is on until the user turns it off — and the busy
 * read then skips the ones turned off.
 *
 * Also carried here: turning reading on from this screen asks the phone
 * (it only recorded consent before, and the sync then failed silently as
 * `denied`), and the university calendar link is a secondary row, not the
 * primary action.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Linking } from 'react-native';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import en from '../../../i18n/locales/en.json';
import { CalendarSettingsScreen } from '../CalendarSettingsScreen';
import * as calendarEndpoints from '../../../api/endpoints/calendar';
import * as commitmentEndpoints from '../../../api/endpoints/commitments';
import * as trustEndpoints from '../../../api/endpoints/trust';
import { deviceCalendar, type DeviceEventCalendar } from '../../calendar/deviceCalendar';
import { loadExcludedCalendarIds, resetWriterIdCache, saveExcludedCalendarIds } from '../../../lib/deviceSettings/calendarDevice';
import { resetCalendarSyncForTests } from '../../calendar/useDeviceCalendarSync';
import { resetBusySyncForTests } from '../../calendar/useBusyCalendar';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const USER: AuthUser = {
  uid: 'calendar-list-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

const CALENDARS: DeviceEventCalendar[] = [
  { id: 'g-work', title: 'Work', color: '#f00', sourceName: 'anas@gmail.com' },
  { id: 'i-home', title: 'Home', color: null, sourceName: 'iCloud' },
  { id: 'g-uni', title: 'University', color: null, sourceName: 'anas@gmail.com' },
  { id: 'local', title: 'Calendar', color: null, sourceName: null },
];

function trustWith(calendarConsent: boolean) {
  return { success: true, participantId: USER.uid, trust: { analyticsConsent: false, calendarConsent } };
}

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

beforeEach(async () => {
  process.env.EXPO_PUBLIC_FEATURE_CALENDAR_READ = 'true';
  onlineManager.setOnline(true);
  resetWriterIdCache();
  resetCalendarSyncForTests();
  resetBusySyncForTests();
  await AsyncStorage.multiRemove(['calendar.excludedCalendarIds.v1', 'calendar.busy.v1', 'calendar.busySyncedAt.v1']);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [] } as never);
  jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] } as never);
  jest.spyOn(calendarEndpoints, 'getCalendarSettings')
    .mockResolvedValue({ success: true, calendarSettings: { writeTarget: 'off', updatedAt: null } } as never);
  jest.spyOn(calendarEndpoints, 'postCalendarBusy').mockResolvedValue({
    success: true, blocks: 0, source: { sourceId: 'device:x', lastSyncedAt: null, windowStart: null, windowEnd: null },
  } as never);
  jest.spyOn(trustEndpoints, 'getTrust').mockResolvedValue(trustWith(true) as never);
  jest.spyOn(trustEndpoints, 'updateTrust').mockResolvedValue(trustWith(true) as never);
  jest.spyOn(deviceCalendar, 'getAccess').mockResolvedValue('granted');
  jest.spyOn(deviceCalendar, 'requestAccess').mockResolvedValue('granted');
  jest.spyOn(deviceCalendar, 'listWritableCalendars').mockResolvedValue([]);
  jest.spyOn(deviceCalendar, 'listEventCalendars').mockResolvedValue(CALENDARS);
  jest.spyOn(deviceCalendar, 'fetchBusyBlocks').mockResolvedValue([]);
});

afterEach(async () => {
  cleanup();
  await new Promise(resolve => setTimeout(resolve, 0));
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
  delete process.env.EXPO_PUBLIC_FEATURE_CALENDAR_READ;
  delete process.env.EXPO_PUBLIC_FEATURE_ICS_FEEDS;
});

async function show(onFeeds?: () => void) {
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}>
            <CalendarSettingsScreen onBack={() => {}} {...(onFeeds ? { onFeeds } : {})} />
          </QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
}

describe('the calendars on this phone', () => {
  it('lists every one, grouped by account, with nothing to fill in', async () => {
    await show();
    await waitFor(() => expect(screen.queryByTestId('calendar-device-g-work')).not.toBeNull());
    expect(screen.getByText(en.calendarDeviceTitle)).toBeTruthy();
    expect(screen.getByText(en.calendarDeviceHint)).toBeTruthy();

    const gmail = screen.getByTestId('calendar-account-anas@gmail.com');
    expect(within(gmail).getByText('anas@gmail.com')).toBeTruthy();
    expect(within(gmail).queryByTestId('calendar-device-g-work')).not.toBeNull();
    expect(within(gmail).queryByTestId('calendar-device-g-uni')).not.toBeNull();
    expect(within(gmail).queryByTestId('calendar-device-i-home')).toBeNull();
    expect(within(screen.getByTestId('calendar-account-iCloud')).queryByTestId('calendar-device-i-home')).not.toBeNull();
    // A calendar with no account still shows, under a plain label.
    expect(within(screen.getByTestId('calendar-account-other')).getByText(en.calendarDeviceSourceOther)).toBeTruthy();

    // On until the user says otherwise.
    for (const calendar of CALENDARS) {
      expect(screen.getByTestId(`calendar-device-${calendar.id}`).props.value).toBe(true);
    }
  });

  it('shows the switch off for a calendar switched off before', async () => {
    await saveExcludedCalendarIds(['i-home']);
    await show();
    await waitFor(() => expect(screen.getByTestId('calendar-device-i-home').props.value).toBe(false));
    expect(screen.getByTestId('calendar-device-g-work').props.value).toBe(true);
  });

  it('switching one off keeps it on this phone and the next busy read skips it', async () => {
    await show();
    await waitFor(() => expect(screen.queryByTestId('calendar-device-g-work')).not.toBeNull());
    (deviceCalendar.fetchBusyBlocks as jest.Mock).mockClear();

    await fireEvent(screen.getByTestId('calendar-device-g-work'), 'valueChange', false);
    await waitFor(() => expect(screen.getByTestId('calendar-device-g-work').props.value).toBe(false));
    expect(await loadExcludedCalendarIds()).toEqual(['g-work']);

    await waitFor(() => expect(deviceCalendar.fetchBusyBlocks).toHaveBeenCalled());
    const calls = (deviceCalendar.fetchBusyBlocks as jest.Mock).mock.calls;
    const options = calls[calls.length - 1]![0] as { excludedCalendarIds?: ReadonlySet<string> };
    expect([...(options.excludedCalendarIds ?? [])]).toEqual(['g-work']);

    // And back on.
    await fireEvent(screen.getByTestId('calendar-device-g-work'), 'valueChange', true);
    await waitFor(() => expect(screen.getByTestId('calendar-device-g-work').props.value).toBe(true));
    expect(await loadExcludedCalendarIds()).toEqual([]);
  });
});

describe('turning reading on from here', () => {
  it('asks the phone, once, and records the consent', async () => {
    jest.spyOn(trustEndpoints, 'getTrust').mockResolvedValue(trustWith(false) as never);
    jest.spyOn(deviceCalendar, 'getAccess').mockResolvedValue('undetermined');
    await show();
    await waitFor(() => expect(screen.getByTestId('calendar-read-toggle').props.accessibilityState?.disabled).toBe(false));
    expect(deviceCalendar.requestAccess).not.toHaveBeenCalled();
    expect(screen.queryByTestId('calendar-device-g-work')).toBeNull();

    await fireEvent(screen.getByTestId('calendar-read-toggle'), 'valueChange', true);
    await waitFor(() => expect(trustEndpoints.updateTrust).toHaveBeenCalledWith({ type: 'set_calendar_consent', granted: true }));
    expect(deviceCalendar.requestAccess).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId('calendar-device-g-work')).not.toBeNull());
  });

  it('asks a phone that has consent recorded but was never asked', async () => {
    jest.spyOn(deviceCalendar, 'getAccess').mockResolvedValue('undetermined');
    await show();
    await waitFor(() => expect(screen.queryByTestId('calendar-read-allow')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('calendar-read-allow'));
    expect(deviceCalendar.requestAccess).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId('calendar-device-g-work')).not.toBeNull());
  });

  it('says so, with the way to phone settings, when the phone says no', async () => {
    jest.spyOn(trustEndpoints, 'getTrust').mockResolvedValue(trustWith(false) as never);
    jest.spyOn(deviceCalendar, 'getAccess').mockResolvedValue('undetermined');
    jest.spyOn(deviceCalendar, 'requestAccess').mockResolvedValue('denied');
    const open = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
    await show();
    await waitFor(() => expect(screen.getByTestId('calendar-read-toggle').props.accessibilityState?.disabled).toBe(false));
    expect(screen.queryByTestId('calendar-open-settings')).toBeNull();

    await fireEvent(screen.getByTestId('calendar-read-toggle'), 'valueChange', true);
    await waitFor(() => expect(screen.queryByTestId('calendar-permission-denied')).not.toBeNull());
    expect(screen.queryByTestId('calendar-device-g-work')).toBeNull();
    await fireEvent.press(screen.getByTestId('calendar-open-settings'));
    expect(open).toHaveBeenCalledTimes(1);
    open.mockClear();
  });
});

describe('the university calendar link', () => {
  it('is a secondary, labelled row rather than the primary action', async () => {
    process.env.EXPO_PUBLIC_FEATURE_ICS_FEEDS = 'true';
    const onFeeds = jest.fn();
    await show(onFeeds);
    await waitFor(() => expect(screen.queryByTestId('calendar-feeds-entry')).not.toBeNull());
    expect(screen.getByTestId('calendar-feeds-entry').props.children).toBe(en.calendarUniLinkEntry);
    await fireEvent.press(screen.getByTestId('calendar-feeds-entry'));
    expect(onFeeds).toHaveBeenCalledTimes(1);
  });

  it('is absent when the build has no calendar links', async () => {
    await show(() => {});
    await waitFor(() => expect(screen.queryByTestId('calendar-read-toggle')).not.toBeNull());
    expect(screen.queryByTestId('calendar-feeds-entry')).toBeNull();
  });
});
