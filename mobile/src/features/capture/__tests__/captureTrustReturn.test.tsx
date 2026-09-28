/**
 * L6 fix round 1: the AI chip on the composer opens Trust *over* capture.
 *
 * It used to close the capture task on the way (and, before L6, jump to the
 * Settings tab), so back from Trust never came back to capture, and reopening
 * capture ran `open` — which starts a new, empty draft. The literal repro:
 * type a sentence, tap the AI chip, read Trust, press back. The sentence must
 * still be in the composer.
 */
import React from 'react';
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import { Root } from '../../../Root';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';
import en from '../../../i18n/locales/en.json';
import * as commitmentEndpoints from '../../../api/endpoints/commitments';
import * as trustEndpoints from '../../../api/endpoints/trust';
import * as consentEndpoints from '../../../api/endpoints/consents';

const METRICS: Metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const USER: AuthUser = { uid: 'capture-trust-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'] };
const DRAFT = 'Call the nursery about Thursday';

let client: QueryClient;

beforeEach(async () => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  setAuthRepository(createFakeAuthRepository({ initialUser: USER }));
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'en');
  jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [] } as never);
  jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] } as never);
  jest.spyOn(trustEndpoints, 'getTrust')
    .mockResolvedValue({ success: true, participantId: USER.uid, trust: { analyticsConsent: false } } as never);
  // AI declined, so the composer shows the chip that leads to Trust.
  jest.spyOn(consentEndpoints, 'getConsents').mockResolvedValue({
    aiProcessing: { state: 'declined', asked: true, version: 'v1', decidedAt: '2026-08-01T00:00:00.000Z' },
    recommendations: { state: 'declined', asked: true, version: 'v1', decidedAt: '2026-08-01T00:00:00.000Z' },
    currentVersions: { aiProcessing: 'v1', recommendations: 'v1' },
  } as never);
});

afterEach(async () => {
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
  await AsyncStorage.clear();
});

async function typeThenOpenTrust() {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={createFakeAuthRepository({ initialUser: USER })} isDevBundle={false}>
          <QueryClientProvider client={client}><Root /></QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryByTestId('tab-capture')).not.toBeNull());
  await fireEvent.press(screen.getByTestId('tab-capture'));
  await waitFor(() => expect(screen.queryByTestId('capture-input')).not.toBeNull());
  await fireEvent.changeText(screen.getByTestId('capture-input'), DRAFT);
  await waitFor(() => expect(screen.queryByTestId('capture-ai-off')).not.toBeNull());
  await fireEvent.press(screen.getByTestId('capture-ai-off'));
  await waitFor(() => expect(screen.queryByTestId('trust-ai-processing')).not.toBeNull());
  expect(screen.queryByTestId('capture-input')).toBeNull();
}

it('back from Trust is the composer, with the sentence still in it', async () => {
  await typeThenOpenTrust();
  await fireEvent.press(screen.getByTestId('header-back'));
  await waitFor(() => expect(screen.queryByTestId('capture-input')).not.toBeNull());
  expect(screen.getByTestId('capture-input').props.value).toBe(DRAFT);
  // Still the task: no tab bar under the composer.
  expect(screen.queryByTestId('floating-tab-bar')).toBeNull();
});

it('a fresh capture, after the resumed one is discarded, starts empty', async () => {
  await typeThenOpenTrust();
  await fireEvent.press(screen.getByTestId('header-back'));
  await waitFor(() => expect(screen.queryByTestId('capture-input')).not.toBeNull());
  await fireEvent.press(within(screen.getByTestId('task-header')).getByLabelText(en.cancel));
  await waitFor(() => expect(screen.queryByTestId('capture-discard-confirm')).not.toBeNull());
  await fireEvent.press(screen.getByTestId('capture-discard-confirm'));
  await waitFor(() => expect(screen.queryByTestId('tab-capture')).not.toBeNull());
  await fireEvent.press(screen.getByTestId('tab-capture'));
  await waitFor(() => expect(screen.queryByTestId('capture-input')).not.toBeNull());
  expect(screen.getByTestId('capture-input').props.value).toBe('');
});
