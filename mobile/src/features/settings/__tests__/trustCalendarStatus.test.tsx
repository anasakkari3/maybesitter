/**
 * The line under the Trust Center's calendar switch tells the truth (UAT round
 * 6, D-d, shot 845).
 *
 * The literal repro: reading on, «حطّ التزاماتي بتقويمي» on with a calendar
 * chosen and events landing — and the row said «مش موصول من هون», always,
 * because it was one fixed string. The line now comes from the state the
 * Calendar screen reads: the consent, the write target, the phone's answer, the
 * calendar chosen on this phone and the ones it can write to.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppState, type AppStateStatus } from 'react-native';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import en from '../../../i18n/locales/en.json';
import { TrustScreen } from '../TrustScreen';
import answered from '../../../api/__fixtures__/consents.answered.json';
import trustState from '../../../api/__fixtures__/trust.state.json';
import * as consentEndpoints from '../../../api/endpoints/consents';
import * as trustEndpoints from '../../../api/endpoints/trust';
import * as calendarEndpoints from '../../../api/endpoints/calendar';
import { deviceCalendar, type WritableCalendar } from '../../calendar/deviceCalendar';
import { saveChosenCalendarId } from '../../../lib/deviceSettings/calendarDevice';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const USER: AuthUser = {
  uid: 'trust-calendar-status-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

const WORK: WritableCalendar = { id: 'work', title: 'Calendar', sourceName: 'Work' } as WritableCalendar;
const HOME: WritableCalendar = { id: 'home', title: 'Calendar', sourceName: 'iCloud' } as WritableCalendar;

function trust(calendarConsent: boolean) {
  return { ...trustState, trust: { ...trustState.trust, calendarConsent } };
}

function settings(writeTarget: 'off' | 'device') {
  return { success: true as const, calendarSettings: { writeTarget, updatedAt: null } };
}

/** The four answers the row is built from, as the repro had them unless a case says otherwise. */
function given({
  read = true, write = 'device', access = 'granted', calendars = [WORK, HOME],
}: {
  read?: boolean;
  write?: 'off' | 'device';
  access?: 'granted' | 'denied' | 'undetermined';
  calendars?: WritableCalendar[];
} = {}) {
  jest.spyOn(trustEndpoints, 'getTrust').mockResolvedValue(trust(read) as never);
  jest.spyOn(calendarEndpoints, 'getCalendarSettings').mockResolvedValue(settings(write));
  jest.spyOn(deviceCalendar, 'getAccess').mockResolvedValue(access);
  jest.spyOn(deviceCalendar, 'listWritableCalendars').mockResolvedValue(calendars);
}

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

beforeEach(async () => {
  process.env.EXPO_PUBLIC_FEATURE_CALENDAR_WRITE = 'true';
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  jest.spyOn(consentEndpoints, 'getConsents').mockResolvedValue(answered as never);
  jest.spyOn(deviceCalendar, 'requestAccess').mockResolvedValue('granted');
  await saveChosenCalendarId('work');
});

afterEach(async () => {
  await cleanup();
  await new Promise(resolve => setTimeout(resolve, 0));
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
  await saveChosenCalendarId(null);
  delete process.env.EXPO_PUBLIC_FEATURE_CALENDAR_WRITE;
});

async function show() {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}>
            <TrustScreen onBack={() => {}} onKnows={() => {}} />
          </QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('trust-calendar').props.disabled).not.toBe(true));
}

/** The line, once it has settled on one. */
async function lineIs(text: string) {
  await waitFor(() => expect(screen.queryByText(text)).not.toBeNull());
  for (const other of [
    en.trustCalendarNotConnected, en.trustCalendarWriting, en.trustCalendarReadingWriting,
    en.calendarReadBody, en.calendarPickNeeded, en.calendarNoneWritable,
  ]) {
    if (other !== text) expect(screen.queryByText(other)).toBeNull();
  }
}

describe('the calendar line in the Trust Center', () => {
  it('says connected when it reads and writes into the chosen calendar (the repro)', async () => {
    given();
    await show();
    await lineIs(en.trustCalendarReadingWriting);
    expect(screen.queryByTestId('trust-calendar-denied')).toBeNull();
  });

  it('says it writes when reading is off', async () => {
    given({ read: false });
    await show();
    await lineIs(en.trustCalendarWriting);
  });

  it('says it reads when writing is off', async () => {
    given({ write: 'off' });
    await show();
    await lineIs(en.calendarReadBody);
  });

  it('says not connected when both are off', async () => {
    given({ read: false, write: 'off' });
    await show();
    await lineIs(en.trustCalendarNotConnected);
  });

  it('asks for a pick when writing is on and nothing is chosen from two calendars', async () => {
    await saveChosenCalendarId(null);
    given();
    await show();
    await lineIs(en.calendarPickNeeded);
  });

  it('shows the phone refusal and the way to phone settings instead of a line', async () => {
    given({ access: 'denied' });
    await show();
    await waitFor(() => expect(screen.queryByTestId('trust-calendar-denied')).not.toBeNull());
    expect(screen.getByText(en.calendarPermissionDenied)).toBeTruthy();
    expect(screen.getByTestId('trust-calendar-open-settings')).toBeTruthy();
    for (const other of [en.trustCalendarNotConnected, en.trustCalendarWriting, en.trustCalendarReadingWriting, en.calendarReadBody]) {
      expect(screen.queryByText(other)).toBeNull();
    }
  });

  it('reads the phone again when the app comes back from phone settings', async () => {
    const listeners: ((state: AppStateStatus) => void)[] = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
      listeners.push(listener as (state: AppStateStatus) => void);
      return { remove: () => {} } as never;
    });
    given({ access: 'denied' });
    await show();
    await waitFor(() => expect(screen.queryByTestId('trust-calendar-denied')).not.toBeNull());

    jest.spyOn(deviceCalendar, 'getAccess').mockResolvedValue('granted');
    await act(async () => { for (const listener of listeners) listener('active'); });
    await lineIs(en.trustCalendarReadingWriting);
    expect(screen.queryByTestId('trust-calendar-denied')).toBeNull();
  });
});
