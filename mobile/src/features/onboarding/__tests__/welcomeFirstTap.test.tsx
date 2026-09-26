/**
 * Welcome «كمّل» answers the first press after a fresh sign-up (UAT
 * 2026-09-26, D4).
 *
 * The UAT saw the first tap ignored on two fresh email accounts, both right
 * after iOS's «حفظ كلمة السر؟» prompt. This drives the same path in JS — sign
 * up, land on welcome, press once — and it advances: nothing in the gate, the
 * flow, the stored step or the button needs a second press. What is left is
 * native (the password prompt and the touch that follows it), which this
 * cannot see; it guards the JS half so a real regression there is caught.
 */
import React from 'react';
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { OnboardingGate } from '../OnboardingGate';
import en from '../../../i18n/locales/en.json';
import * as consentEndpoints from '../../../api/endpoints/consents';

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

beforeEach(async () => {
  await AsyncStorage.clear();
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: null });
  setAuthRepository(repository);
  jest.spyOn(consentEndpoints, 'getConsents').mockResolvedValue({
    aiProcessing: { state: 'declined', version: 'ai-consent-v1', changedAt: '', asked: false },
    recommendations: { state: 'declined', version: 'rec-consent-v1', changedAt: '', asked: false },
    currentVersions: { aiProcessing: 'ai-consent-v1', recommendations: 'rec-consent-v1' },
    currentVersion: 'ai-consent-v1',
  } as never);
});

afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
  await AsyncStorage.clear();
});

it('one press on welcome Continue after signing up opens the consent step', async () => {
  await render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 402, height: 874 }, insets: { top: 62, left: 0, right: 0, bottom: 34 } }}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}>
            <OnboardingGate><Text>THE APP</Text></OnboardingGate>
          </QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryByText(en.authContinueEmail)).not.toBeNull());
  await fireEvent.press(screen.getByText(en.authContinueEmail));
  await fireEvent.press(screen.getByText(en.authSwitchToSignUp));
  await fireEvent.changeText(screen.getByTestId('authEmailInput'), 'fresh@example.com');
  await fireEvent.changeText(screen.getByTestId('authPasswordInput'), 'a-long-password');
  await fireEvent.press(screen.getAllByText(en.authModeSignUp).at(-1)!);
  await waitFor(() => expect(screen.queryByText(en.obWelcomeTitle)).not.toBeNull());

  await fireEvent.press(screen.getByText(en.obContinue));

  await waitFor(() => expect(screen.queryByText(en.obConsentTitle)).not.toBeNull());
  expect(screen.queryByText(en.obWelcomeTitle)).toBeNull();
});
