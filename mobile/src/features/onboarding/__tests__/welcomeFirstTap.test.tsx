/**
 * Welcome «كمّل» answers the first press after a fresh sign-up (UAT
 * 2026-09-26, D4).
 *
 * On the device the first press after sign-up left welcome on screen, and the
 * second press moved it at once (3/3 fresh accounts, no prompt up, a tap on
 * empty space first did not help). Welcome is the one step whose press did
 * nothing on screen until a native write had answered: `advance` awaited
 * `saveOnboardingProgress` and only then called `setStep`. Everything the
 * press did was parked behind that write; whatever held its answer up, the
 * next touch was what let it through.
 *
 * The screen now moves inside the press and the write follows it. The second
 * test holds the write open — the device's state — and asks for consent after
 * one press.
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
import { ONBOARDING_STORAGE_KEY } from '../../../lib/deviceSettings/onboardingProgress';
import { deferred } from '../../../testing/deferred';

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

async function signUpToWelcome() {
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
}

it('one press on welcome Continue after signing up opens the consent step', async () => {
  await signUpToWelcome();
  await fireEvent.press(screen.getByText(en.obContinue));
  await waitFor(() => expect(screen.queryByText(en.obConsentTitle)).not.toBeNull());
  expect(screen.queryByText(en.obWelcomeTitle)).toBeNull();
  await waitFor(async () => expect(await AsyncStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe('consent'));
});

it('moves on the press itself, not when the device write answers', async () => {
  await signUpToWelcome();
  // The progress write is held open: the press must not wait on it.
  // (The mock store's own setItem is not called through: it re-enters
  // setItem internally, and a spy that delegated to it recursed.)
  const write = deferred<void>();
  const setItem = jest.spyOn(AsyncStorage, 'setItem').mockImplementation(((key: string) =>
    key === ONBOARDING_STORAGE_KEY ? write.promise : Promise.resolve()) as never);

  await fireEvent.press(screen.getByText(en.obContinue));

  // Synchronously, before anything settles: the press alone moved the screen.
  expect(screen.queryByText(en.obConsentTitle)).not.toBeNull();
  expect(screen.queryByText(en.obWelcomeTitle)).toBeNull();
  // And the step was still written — after the screen moved, not before.
  expect(setItem).toHaveBeenCalledWith(ONBOARDING_STORAGE_KEY, 'consent');
  await React.act(async () => { write.resolve(); });
  expect(screen.queryByText(en.obConsentTitle)).not.toBeNull();
});

it('a write that never lands costs a repeated step, never a skipped one', async () => {
  await signUpToWelcome();
  jest.spyOn(AsyncStorage, 'setItem').mockRejectedValue(new Error('disk full') as never);
  await fireEvent.press(screen.getByText(en.obContinue));
  expect(screen.queryByText(en.obConsentTitle)).not.toBeNull();
  // Nothing stored past welcome: a relaunch shows welcome again, and consent
  // is still ahead of it.
  expect(await AsyncStorage.getItem(ONBOARDING_STORAGE_KEY)).not.toBe('consent');
});

// The instrumented device run found the email screen's password field still
// hit-testable over welcome. In React the screen is gone — this holds that
// half; what lingered on the device was the native view (see emailAuth.test).
it('the email screen is not in the tree once welcome shows', async () => {
  await signUpToWelcome();
  expect(screen.queryByTestId('authPasswordInput')).toBeNull();
  expect(screen.queryByTestId('authEmailInput')).toBeNull();
});
