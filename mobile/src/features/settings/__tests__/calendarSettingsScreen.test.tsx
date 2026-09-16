/**
 * Settings → Calendar (UC-3.1, #185).
 *
 * The criterion this file carries is the one about a refusal: "denied
 * permission → the toggle shows an explanation and an OS-settings link, and
 * nothing crashes". The rest of the screen — the picker showing real calendars,
 * an event actually appearing — needs a device with seeded calendars.
 *
 * The other thing asserted here is the order of two operations. Turning the
 * switch on asks the OS *before* it saves `device` to the account. Saving first
 * and being refused afterwards would leave the account claiming it writes to a
 * calendar this phone cannot reach, and a second device would show the switch
 * on for a feature that had never worked anywhere.
 */
import React from 'react';
import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
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
import { deviceCalendar } from '../../calendar/deviceCalendar';
import { resetWriterIdCache } from '../../../lib/deviceSettings/calendarDevice';
import { resetCalendarSyncForTests } from '../../calendar/useDeviceCalendarSync';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const USER: AuthUser = {
  uid: 'calendar-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

function settings(writeTarget: 'off' | 'device' | 'google') {
  return { success: true as const, calendarSettings: { writeTarget, updatedAt: null } };
}

beforeEach(() => {
  // The build switch, on, so the toggle is reachable. The case where it is off
  // is asserted separately below.
  process.env.EXPO_PUBLIC_FEATURE_CALENDAR_WRITE = 'true';
  onlineManager.setOnline(true);
  resetWriterIdCache();
  // The in-flight flag is module-level, so a pass left running by a previous
  // case would make this one's `runNow` a silent no-op.
  resetCalendarSyncForTests();
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [] });
  jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] });
  jest.spyOn(calendarEndpoints, 'getCalendarSettings').mockResolvedValue(settings('off'));
  jest.spyOn(calendarEndpoints, 'putCalendarWriteTarget').mockResolvedValue(settings('device'));
  jest.spyOn(deviceCalendar, 'listWritableCalendars').mockResolvedValue([]);
});

afterEach(async () => {
  cleanup();
  // A real macrotask: a settling request when the tree came down leaves React
  // work in flight, and RNTL v14's next `render` then mounts nothing.
  await new Promise(resolve => setTimeout(resolve, 0));
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
  delete process.env.EXPO_PUBLIC_FEATURE_CALENDAR_WRITE;
});

async function show() {
  return render(
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
}

describe('turning it on', () => {
  it('asks the phone before it tells the account', async () => {
    jest.spyOn(deviceCalendar, 'getAccess').mockResolvedValue('undetermined');
    const request = jest.spyOn(deviceCalendar, 'requestAccess').mockResolvedValue('granted');
    await show();
    await waitFor(() => expect(screen.queryByTestId('calendar-write-toggle')).not.toBeNull());

    await fireEvent(screen.getByTestId('calendar-write-toggle'), 'valueChange', true);
    await waitFor(() => expect(calendarEndpoints.putCalendarWriteTarget).toHaveBeenCalledWith('device'));
    expect(request).toHaveBeenCalled();
    expect(request.mock.invocationCallOrder[0]!)
      .toBeLessThan((calendarEndpoints.putCalendarWriteTarget as jest.Mock).mock.invocationCallOrder[0]!);
  });

  it('tells the account nothing when the phone said no', async () => {
    jest.spyOn(deviceCalendar, 'getAccess').mockResolvedValue('undetermined');
    jest.spyOn(deviceCalendar, 'requestAccess').mockResolvedValue('denied');
    await show();
    await waitFor(() => expect(screen.queryByTestId('calendar-write-toggle')).not.toBeNull());

    await fireEvent(screen.getByTestId('calendar-write-toggle'), 'valueChange', true);
    await waitFor(() => expect(screen.queryByTestId('calendar-permission-denied')).not.toBeNull());
    // The account never heard that this phone writes to a calendar.
    expect(calendarEndpoints.putCalendarWriteTarget).not.toHaveBeenCalled();
    // And the switch did not move: it never shows "on" for a thing that cannot
    // happen.
    expect(screen.getByTestId('calendar-write-toggle').props.value).toBe(false);
  });
});

describe('when the phone has said no', () => {
  it('explains, and offers the one place the answer can still be changed', async () => {
    jest.spyOn(deviceCalendar, 'getAccess').mockResolvedValue('denied');
    const open = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
    await show();
    await waitFor(() => expect(screen.queryByTestId('calendar-permission-denied')).not.toBeNull());

    // The explanation is copy, not a raw error, and it says why nothing will
    // be added.
    expect(screen.getByTestId('calendar-permission-denied').props.children)
      .toBe(en.calendarPermissionDenied);

    await fireEvent.press(screen.getByTestId('calendar-open-settings'));
    expect(open).toHaveBeenCalled();
  });

  it('renders without crashing and shows no calendar picker', async () => {
    jest.spyOn(deviceCalendar, 'getAccess').mockResolvedValue('denied');
    jest.spyOn(calendarEndpoints, 'getCalendarSettings').mockResolvedValue(settings('device'));
    await show();
    await waitFor(() => expect(screen.queryByTestId('calendar-permission-denied')).not.toBeNull());
    // Offering a picker for calendars the app cannot read would be a list that
    // is always empty and a choice that never takes.
    expect(screen.queryByTestId('calendar-none-writable')).toBeNull();
  });
});

describe('the build switch', () => {
  it('says out loud that this build writes nothing, rather than hiding the row', async () => {
    delete process.env.EXPO_PUBLIC_FEATURE_CALENDAR_WRITE;
    jest.spyOn(deviceCalendar, 'getAccess').mockResolvedValue('granted');
    await show();
    await waitFor(() => expect(screen.queryByTestId('calendar-write-unavailable')).not.toBeNull());
    expect(screen.getByTestId('calendar-write-toggle').props.disabled).toBe(true);
  });
});

describe('removing what was added', () => {
  it('is offered whatever the target is, because turning it off removes nothing', async () => {
    // "Stop adding" and "remove what you added" are two sentences. The second
    // has to stay reachable after the first.
    jest.spyOn(deviceCalendar, 'getAccess').mockResolvedValue('granted');
    await show();
    await waitFor(() => expect(screen.queryByTestId('calendar-remove-all')).not.toBeNull());
    expect(screen.getByTestId('calendar-remove-all')).not.toBeNull();
  });
});

describe('where the sync actually runs', () => {
  /**
   * A source assertion, because the failure it guards against is invisible.
   *
   * `useDeviceCalendarSync` is also mounted by this screen, so every case above
   * would keep passing if `DeviceCalendarSyncHost` were dropped from `Root` —
   * and the feature would be one where confirming a commitment on Today writes
   * no event unless you happen to open the calendar settings screen afterwards.
   * Nothing would be red. This is.
   */
  it('is mounted for the whole session, not only on this screen', () => {
    const root = readFileSync(join(__dirname, '..', '..', '..', 'Root.tsx'), 'utf8');
    expect(root).toContain('DeviceCalendarSyncHost');
    expect(root).toContain('<DeviceCalendarSyncHost />');
  });
});
