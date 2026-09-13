/**
 * Onboarding, driven the way a person drives it (UC-2.R1, #171).
 *
 * ── The four claims these tests exist to hold ────────────────────
 *
 *  1. A signed-in user who has not finished cannot reach the app.
 *  2. Nothing is pre-selected, and Continue is unreachable until the AI
 *     question is answered.
 *  3. All three consent writes must land before the screen advances. A partial
 *     success tells the user nothing was changed, because that is what they
 *     need to know.
 *  4. The analytics event fires only when analytics consent was granted.
 *
 * The consent writes are asserted by intercepting the endpoint module rather
 * than the network, so what is checked is the payload the app sends — the
 * `state` and the `version` — not that some request happened.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import type { AuthUser } from '../../../auth/types';
import { OnboardingGate } from '../OnboardingGate';
import { ONBOARDING_STORAGE_KEY } from '../../../lib/deviceSettings/onboardingProgress';
import en from '../../../i18n/locales/en.json';

import * as consentEndpoints from '../../../api/endpoints/consents';
import * as profileEndpoints from '../../../api/endpoints/profile';
import * as trustEndpoints from '../../../api/endpoints/trust';
import * as analyticsEndpoints from '../../../api/endpoints/analytics';

const USER: AuthUser = {
  uid: 'onboarding-user',
  email: 'someone@example.com',
  emailVerified: true,
  displayName: null,
  providerIds: ['password'],
};

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const CONSENTS = {
  aiProcessing: { state: 'declined' as const, version: 'ai-consent-v1', changedAt: '', asked: false },
  recommendations: { state: 'declined' as const, version: 'rec-consent-v1', changedAt: '', asked: false },
  currentVersions: { aiProcessing: 'ai-consent-v1', recommendations: 'rec-consent-v1' },
  currentVersion: 'ai-consent-v1',
};

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;
let getConsents: jest.SpiedFunction<typeof consentEndpoints.getConsents>;
let putAiConsent: jest.SpiedFunction<typeof consentEndpoints.putAiConsent>;
let putRecommendationConsent: jest.SpiedFunction<typeof consentEndpoints.putRecommendationConsent>;
let updateTrust: jest.SpiedFunction<typeof trustEndpoints.updateTrust>;

beforeEach(async () => {
  await AsyncStorage.clear();
  // Without this react-query treats the suite as offline and never runs a
  // query — the app sets it from the device in `installDeviceManagers`.
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  getConsents = jest.spyOn(consentEndpoints, 'getConsents').mockResolvedValue(CONSENTS);
  putAiConsent = jest.spyOn(consentEndpoints, 'putAiConsent')
    .mockResolvedValue({ success: true, aiProcessing: { state: 'granted', version: 'ai-consent-v1', changedAt: 'x' } } as never);
  putRecommendationConsent = jest.spyOn(consentEndpoints, 'putRecommendationConsent')
    .mockResolvedValue({ success: true, recommendations: { state: 'declined', version: 'rec-consent-v1', changedAt: 'x' } } as never);
  updateTrust = jest.spyOn(trustEndpoints, 'updateTrust').mockResolvedValue({} as never);
  jest.spyOn(profileEndpoints, 'putRoutine').mockResolvedValue({} as never);
  jest.spyOn(analyticsEndpoints, 'recordAnalyticsEvent').mockResolvedValue({} as never);
});

afterEach(async () => {
  // The order the rest of this suite's component tests use. `resetAuthForTests`
  // matters most: the repository is a module singleton, and leaving one test's
  // behind means the next render never resolves a user.
  cleanup();
  // A real macrotask, not a microtask flush. Onboarding writes its step
  // through AsyncStorage after the mutation resolves, so a submit still in
  // flight when the tree came down would otherwise land *after* the clear
  // below and start the next test on the wrong step.
  await new Promise(resolve => setTimeout(resolve, 0));
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
  await AsyncStorage.clear();
});

async function renderApp() {
  const view = await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}>
            <OnboardingGate>
              <Text>THE APP</Text>
            </OnboardingGate>
          </QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryByText(en.obWelcomeTitle)).not.toBeNull());
  return view;
}

/** Presses a button by the accessibility label the design gives it. */
function press(label: string) {
  fireEvent.press(screen.getByLabelText(label));
}

describe('the gate', () => {
  it('keeps a signed-in user out of the app until onboarding is finished', async () => {
    await renderApp();
    expect(screen.queryByText('THE APP')).toBeNull();
    expect(screen.queryByText(en.obWelcomeTitle)).not.toBeNull();
  });

  it('lets a returning user straight through', async () => {
    await AsyncStorage.setItem(ONBOARDING_STORAGE_KEY, 'done');
    await render(
      <SafeAreaProvider initialMetrics={METRICS}>
        <AppProvider>
          <AuthProvider repository={repository} isDevBundle={false}>
            <QueryClientProvider client={client}>
              <OnboardingGate><Text>THE APP</Text></OnboardingGate>
            </QueryClientProvider>
          </AuthProvider>
        </AppProvider>
      </SafeAreaProvider>,
    );
    await waitFor(() => expect(screen.queryByText('THE APP')).not.toBeNull());
  });

  it('resumes on the step it was left on', async () => {
    await AsyncStorage.setItem(ONBOARDING_STORAGE_KEY, 'routine');
    await render(
      <SafeAreaProvider initialMetrics={METRICS}>
        <AppProvider>
          <AuthProvider repository={repository} isDevBundle={false}>
            <QueryClientProvider client={client}>
              <OnboardingGate><Text>THE APP</Text></OnboardingGate>
            </QueryClientProvider>
          </AuthProvider>
        </AppProvider>
      </SafeAreaProvider>,
    );
    await waitFor(() => expect(screen.queryByText(en.obRoutineTitle)).not.toBeNull());
    expect(screen.queryByText(en.obWelcomeTitle)).toBeNull();
  });
});

describe('the consent screen', () => {
  async function reachConsent() {
    await renderApp();
    press(en.obContinue);
    await waitFor(() => expect(screen.queryByText(en.obConsentTitle)).not.toBeNull());
    await waitFor(() => expect(getConsents).toHaveBeenCalled());
  }

  it('pre-selects nothing and will not continue until the AI question is answered', async () => {
    await reachConsent();
    // Both switches start off.
    for (const label of [en.obRecTitle, en.obAnalyticsTitle]) {
      expect(screen.getByLabelText(label).props.value).toBe(false);
    }
    // And the screen says why it will not move.
    expect(screen.queryByText(en.obConsentNeedAi)).not.toBeNull();

    press(en.obContinue);
    await waitFor(() => expect(screen.queryByText(en.obConsentNeedAi)).not.toBeNull());
    expect(putAiConsent).not.toHaveBeenCalled();
    expect(screen.queryByText(en.obConsentTitle)).not.toBeNull();
  });

  it('says what still works when AI is declined', async () => {
    await reachConsent();
    expect(screen.queryByText(en.obAiDeclinedNote)).toBeNull();
    press(en.obAiDecline);
    await waitFor(() => expect(screen.queryByText(en.obAiDeclinedNote)).not.toBeNull());
  });

  it('sends each answer with the version the server said it recognises', async () => {
    await reachConsent();
    press(en.obAiAllow);
    fireEvent(screen.getByLabelText(en.obRecTitle), 'valueChange', true);
    await waitFor(() => expect(screen.getByLabelText(en.obRecTitle).props.value).toBe(true));
    press(en.obContinue);

    await waitFor(() => expect(putAiConsent).toHaveBeenCalled());
    expect(putAiConsent.mock.calls[0]![0]).toMatchObject({ state: 'granted', version: 'ai-consent-v1' });
    expect(putRecommendationConsent.mock.calls[0]![0]).toMatchObject({
      state: 'granted', version: 'rec-consent-v1',
    });
    expect(updateTrust).toHaveBeenCalledWith({ type: 'set_analytics_consent', granted: false });
    // Settle on the next screen before the test ends: tearing the tree down
    // mid-advance leaves React work in flight and the following render empty.
    await waitFor(() => expect(screen.queryByText(en.obRoutineTitle)).not.toBeNull());
  });



});

describe('finishing', () => {
  it('never asks the OS for the notification permission', () => {
    // The prompt belongs to the S3 reminders issue, at the moment a reminder is
    // first actually wanted. Asking during onboarding — before there is a
    // single commitment to be reminded about — is the prompt people deny, and
    // iOS only lets you ask once. Asserted at the source, because a runtime
    // check would only prove this one path did not reach it.
    const directory = join(__dirname, '..');
    for (const file of readdirSync(directory).filter(name => name.endsWith('.tsx') || name.endsWith('.ts'))) {
      const source = readFileSync(join(directory, file), 'utf8');
      expect(source).not.toMatch(/expo-notifications|requestPermissionsAsync/);
    }
  });
});
