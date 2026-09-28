/**
 * The Trust Center's calendar switch asks the phone (first iPhone run, L7).
 *
 * The literal repro: turning the calendar consent on only recorded it. The OS
 * was never asked, so the busy read then failed — silently, as `denied` — and
 * nothing on screen said why. Now turning it on asks the phone (only when it
 * has not answered), and a no is shown with the way to phone settings.
 */
import React from 'react';
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
import { TrustScreen } from '../TrustScreen';
import answered from '../../../api/__fixtures__/consents.answered.json';
import trustState from '../../../api/__fixtures__/trust.state.json';
import * as consentEndpoints from '../../../api/endpoints/consents';
import * as trustEndpoints from '../../../api/endpoints/trust';
import { deviceCalendar } from '../../calendar/deviceCalendar';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const USER: AuthUser = {
  uid: 'trust-calendar-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

const granted = { ...trustState, trust: { ...trustState.trust, calendarConsent: true } };

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

beforeEach(() => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  jest.spyOn(consentEndpoints, 'getConsents').mockResolvedValue(answered as never);
  // The real handler's answer: calendar consent off.
  jest.spyOn(trustEndpoints, 'getTrust').mockResolvedValue(trustState as never);
  jest.spyOn(trustEndpoints, 'updateTrust').mockResolvedValue(granted as never);
  jest.spyOn(deviceCalendar, 'getAccess').mockResolvedValue('undetermined');
  jest.spyOn(deviceCalendar, 'requestAccess').mockResolvedValue('granted');
});

afterEach(async () => {
  cleanup();
  await new Promise(resolve => setTimeout(resolve, 0));
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
            <TrustScreen onBack={() => {}} onKnows={() => {}} />
          </QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('trust-calendar').props.disabled).not.toBe(true));
}

describe('turning the calendar on', () => {
  it('asks the phone once, and records the consent', async () => {
    await show();
    expect(deviceCalendar.requestAccess).not.toHaveBeenCalled();
    await fireEvent(screen.getByTestId('trust-calendar'), 'valueChange', true);
    await waitFor(() => expect(trustEndpoints.updateTrust).toHaveBeenCalledWith({ type: 'set_calendar_consent', granted: true }));
    expect(deviceCalendar.requestAccess).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('trust-calendar-denied')).toBeNull();
  });

  it('does not ask again on the way off', async () => {
    jest.spyOn(trustEndpoints, 'getTrust').mockResolvedValue(granted as never);
    await show();
    await fireEvent(screen.getByTestId('trust-calendar'), 'valueChange', false);
    await waitFor(() => expect(trustEndpoints.updateTrust).toHaveBeenCalledWith({ type: 'set_calendar_consent', granted: false }));
    expect(deviceCalendar.requestAccess).not.toHaveBeenCalled();
  });

  it('shows a no with the way to phone settings', async () => {
    jest.spyOn(deviceCalendar, 'requestAccess').mockResolvedValue('denied');
    const open = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
    await show();
    expect(screen.queryByTestId('trust-calendar-open-settings')).toBeNull();
    await fireEvent(screen.getByTestId('trust-calendar'), 'valueChange', true);
    await waitFor(() => expect(screen.queryByTestId('trust-calendar-denied')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('trust-calendar-open-settings'));
    expect(open).toHaveBeenCalledTimes(1);
    open.mockClear();
  });
});
