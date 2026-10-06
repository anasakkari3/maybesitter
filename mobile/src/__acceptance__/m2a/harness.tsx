import React from 'react';
import { expect, jest } from '@jest/globals';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../state/AppContext';
import { AuthProvider } from '../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';
import { setAuthRepository } from '../../api/auth';
import type { AuthUser } from '../../auth/types';
import { Root } from '../../Root';
import { LANGUAGE_STORAGE_KEY } from '../../i18n/language';
import * as commitmentEndpoints from '../../api/endpoints/commitments';
import * as analyticsEndpoints from '../../api/endpoints/analytics';
import * as trustEndpoints from '../../api/endpoints/trust';

export const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

export const USER: AuthUser = {
  uid: 'm2a-acceptance-user',
  email: 'acceptance@example.com',
  emailVerified: true,
  displayName: null,
  providerIds: ['password'],
};

export interface RootHarness {
  client: QueryClient;
  repository: ReturnType<typeof createFakeAuthRepository>;
}

export async function prepareRoot(language: 'ar' | 'en' = 'en'): Promise<RootHarness> {
  onlineManager.setOnline(true);
  await AsyncStorage.clear();
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [], calendarOrphans: [] } as never);
  jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] } as never);
  jest.spyOn(trustEndpoints, 'getTrust').mockResolvedValue({
    success: true,
    participantId: USER.uid,
    trust: { analyticsConsent: false, calendarConsent: false },
  } as never);
  jest.spyOn(analyticsEndpoints, 'recordAnalyticsEvent').mockResolvedValue({
    success: true,
    participantId: USER.uid,
    recorded: true,
    eventId: 'm2a-event',
  } as never);
  return { client, repository };
}

export async function openCapture(harness: RootHarness): Promise<void> {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={harness.repository} isDevBundle={false}>
          <QueryClientProvider client={harness.client}><Root /></QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryByTestId('tab-capture')).not.toBeNull());
  await act(async () => { await fireEvent.press(screen.getByTestId('tab-capture')); });
  await waitFor(() => expect(screen.queryByTestId('capture-input')).not.toBeNull());
}

export async function say(text: string): Promise<void> {
  await act(async () => { await fireEvent.changeText(screen.getByTestId('capture-input'), text); });
  await act(async () => { await fireEvent.press(screen.getByTestId('capture-analyze')); });
}

export function textOf(testID: string): string {
  const children = screen.getByTestId(testID).props.children as unknown;
  return [children].flat(Infinity).filter((value) => typeof value === 'string' || typeof value === 'number').join('');
}

export function plain(value: string): string {
  return value.replace(/[\u2066-\u2069]/g, '');
}
