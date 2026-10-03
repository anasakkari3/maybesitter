/**
 * The Settings hub (Stitch `06-settings`): who is signed in, the five
 * destinations with what each holds, and the two account actions — sign out
 * asks first, delete opens its own flow and sends nothing.
 */
import React from 'react';
import { Text } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppProvider, useApp } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';
import { SettingsScreen } from '../../../screens/SettingsScreen';
import en from '../../../i18n/locales/en.json';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

function Probe() {
  const { s } = useApp();
  return <Text testID="probe-screen">{s.screen}</Text>;
}

async function show(user: AuthUser) {
  repository = createFakeAuthRepository({ initialUser: user });
  setAuthRepository(repository);
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}><SettingsScreen /><Probe /></QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryByTestId('settings-account-card')).not.toBeNull());
}

beforeEach(async () => {
  await AsyncStorage.clear();
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'en');
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  await cleanup();
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

describe('the account row', () => {
  it('names the person and opens the account page', async () => {
    await show({ uid: 'u1', email: 'anas@example.com', emailVerified: true, displayName: 'Anas', providerIds: ['password'] });
    await waitFor(() => expect(screen.queryByText('Anas')).not.toBeNull());
    expect(screen.getByText('anas@example.com')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('settings-account-card'));
    expect(screen.getByTestId('probe-screen').props.children).toBe('account');
  });

  it('falls back to the address when there is no name', async () => {
    await show({ uid: 'u2', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'] });
    await waitFor(() => expect(screen.queryByText('a@b.c')).not.toBeNull());
  });
});

describe('the destinations', () => {
  it('says what each one holds, in the words of its rows', async () => {
    await show({ uid: 'u3', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'] });
    await waitFor(() => expect(screen.queryByText(en.financialTitle)).not.toBeNull());
    for (const [id, target] of [
      ['settings-category-day', 'settingsDay'],
      ['settings-category-alerts', 'settingsAlerts'],
      ['settings-category-connections', 'settingsConnections'],
      ['settings-category-privacy', 'settingsPrivacy'],
      ['settings-category-app', 'settingsApp'],
    ] as const) {
      await fireEvent.press(screen.getByTestId(id));
      expect(screen.getByTestId('probe-screen').props.children).toBe(target);
    }
  });
});

describe('the account actions', () => {
  it('asks before signing out, and signs out only on the confirm', async () => {
    await show({ uid: 'u4', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'] });
    await fireEvent.press(screen.getByTestId('settings-sign-out'));
    expect(screen.queryByTestId('sign-out-dialog')).not.toBeNull();
    await fireEvent.press(screen.getByTestId('sign-out-cancel'));
    expect(repository.signOutReasons).toEqual([]);
    await fireEvent.press(screen.getByTestId('settings-sign-out'));
    await fireEvent.press(screen.getByTestId('sign-out-confirm'));
    await waitFor(() => expect(repository.signOutReasons).toEqual(['user']));
  });

  it('opens the deletion flow and deletes nothing from here', async () => {
    await show({ uid: 'u5', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'] });
    await fireEvent.press(screen.getByTestId('settings-delete-account'));
    expect(screen.getByTestId('probe-screen').props.children).toBe('deleteAccount');
    expect(repository.calls.map(call => call.method)).not.toContain('deleteAccount');
  });
});
