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
import { NetworkError } from '../../../api/errors';
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

/**
 * Presses a button by the accessibility label the design gives it, and waits.
 *
 * `render` and `fireEvent` are both asynchronous in RNTL v14. A press that is
 * not awaited leaves the re-render it caused unflushed — the next query reads
 * the tree as it was before, and, worse, the *next test's* `render` mounts
 * nothing at all and every query on it returns null. Three tests added here
 * failed that way before this helper was awaited at every call site, and the
 * failure looked nothing like its cause.
 */
async function press(label: string) {
  await fireEvent.press(screen.getByLabelText(label));
}

/**
 * Pressed by identity rather than by words.
 *
 * "Try again" is the honest label for both retries this screen can show — the
 * one that re-sends the answers and the one that re-asks for the versions —
 * so the test that means a particular one says which.
 */
async function pressTestId(testID: string) {
  await fireEvent.press(screen.getByTestId(testID));
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
    await press(en.obContinue);
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

    await press(en.obContinue);
    await waitFor(() => expect(screen.queryByText(en.obConsentNeedAi)).not.toBeNull());
    expect(putAiConsent).not.toHaveBeenCalled();
    expect(screen.queryByText(en.obConsentTitle)).not.toBeNull();
  });

  it('says what still works when AI is declined', async () => {
    await reachConsent();
    expect(screen.queryByText(en.obAiDeclinedNote)).toBeNull();
    await press(en.obAiDecline);
    await waitFor(() => expect(screen.queryByText(en.obAiDeclinedNote)).not.toBeNull());
  });

  it('sends each answer with the version the server said it recognises', async () => {
    await reachConsent();
    await press(en.obAiAllow);
    fireEvent(screen.getByLabelText(en.obRecTitle), 'valueChange', true);
    await waitFor(() => expect(screen.getByLabelText(en.obRecTitle).props.value).toBe(true));
    await press(en.obContinue);

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

  /**
   * A consent the user turned **off** is not a consent (#374 follow-up).
   *
   * The reachable path, and the reason a device audit of new accounts could
   * not see it: it needs somebody who already granted.
   *
   *  1. The account granted recommendations before — on another device, or
   *     before a sign-out. The record is on the server.
   *  2. Signing back in runs onboarding again, deliberately (#171), and the
   *     screen seeds the toggle from that record: on.
   *  3. The user turns it off. That is an explicit decline, not an absence.
   *  4. A consents refetch lands. There is nothing exotic about it — the AI
   *     write invalidates this very query, so it happens on the way through
   *     the screen, and the payload really does differ because the AI record
   *     the user just wrote now reads back as granted.
   *
   * With `recommendations` as a plain boolean there was no value meaning
   * "untouched", so the seeding could not tell the decline from the default
   * and `false || true` put the grant back.
   */
  async function declineAfterAnEarlierGrant() {
    const previouslyGranted = {
      ...CONSENTS,
      recommendations: {
        state: 'granted' as const, version: 'rec-consent-v1',
        changedAt: '2026-08-01T09:00:00.000Z', asked: true,
      },
    };
    // The server as it behaves: once the AI answer is written, the next GET
    // reports it. That is what makes the refetched payload a different value
    // from the one the screen seeded from.
    let aiRecorded = false;
    getConsents.mockImplementation(async () => (aiRecorded
      ? {
        ...previouslyGranted,
        aiProcessing: {
          state: 'granted' as const, version: 'ai-consent-v1',
          changedAt: '2026-09-14T09:00:00.000Z', asked: true,
        },
      }
      : previouslyGranted));
    putAiConsent.mockImplementation(async () => {
      aiRecorded = true;
      return { success: true, aiProcessing: { state: 'granted', version: 'ai-consent-v1', changedAt: 'x' } } as never;
    });
    // One failed write, so the user is left on the screen with Retry — which
    // is the press that sends whatever the toggle says by then.
    putRecommendationConsent
      .mockRejectedValueOnce(new NetworkError('no signal'))
      .mockResolvedValue({ success: true, recommendations: { state: 'declined', version: 'rec-consent-v1', changedAt: 'x' } } as never);

    await reachConsent();
    // Seeded from the account's own earlier answer: the question is not asked
    // twice, which is what the seeding block is for.
    await waitFor(() => expect(screen.getByLabelText(en.obRecTitle).props.value).toBe(true));

    await fireEvent(screen.getByLabelText(en.obRecTitle), 'valueChange', false);
    await waitFor(() => expect(screen.getByLabelText(en.obRecTitle).props.value).toBe(false));

    await press(en.obAiAllow);
    await press(en.obContinue);

    await waitFor(() => expect(screen.queryByText(en.obConsentFailed)).not.toBeNull());
    // The refetch has landed, so the seeding block has had its chance to undo
    // the user's answer.
    await waitFor(() => expect(getConsents.mock.calls.length).toBeGreaterThan(1));
  }

  it('records the decline the user made, not the grant the refetch put back', async () => {
    await declineAfterAnEarlierGrant();

    await press(en.obConsentRetry);
    await waitFor(() => expect(putRecommendationConsent).toHaveBeenCalledTimes(2));
    // The assertion that matters. A flipped switch is a nuisance; a consent
    // record written against somebody who declined is the harm, and this is
    // the request that writes it.
    expect(putRecommendationConsent.mock.calls[1]![0]).toMatchObject({ state: 'declined' });
    await waitFor(() => expect(screen.queryByText(en.obRoutineTitle)).not.toBeNull());
  });

  it('leaves the switch where the user left it when the refetch lands', async () => {
    await declineAfterAnEarlierGrant();
    expect(screen.getByLabelText(en.obRecTitle).props.value).toBe(false);
  });

  /**
   * The account has never been asked, so the server's "declined" is not an
   * answer — and the screen must not present it as one by seeding a decline
   * the user never gave. Guards the other side of the widened type: `null`
   * still has to reach the server as a decline.
   */
  it('seeds nothing from a question the account was never asked', async () => {
    await reachConsent();
    expect(screen.getByLabelText(en.obRecTitle).props.value).toBe(false);
    await press(en.obAiAllow);
    await press(en.obContinue);
    await waitFor(() => expect(putRecommendationConsent).toHaveBeenCalled());
    expect(putRecommendationConsent.mock.calls[0]![0]).toMatchObject({ state: 'declined' });
    await waitFor(() => expect(screen.queryByText(en.obRoutineTitle)).not.toBeNull());
  });
});

/**
 * The consent versions are the one thing this screen cannot proceed without,
 * and the failure to fetch them used to be silent (#374 follow-up).
 *
 * Waiting is right: a guessed version is refused by the server and a
 * hard-coded one would claim agreement to words this build cannot prove were
 * shown. Waiting *without saying so, forever, with no way to try again* is the
 * defect — once the AI question was answered even the "choose an answer"
 * footnote went away, and Continue stayed dead with nothing on screen to
 * explain it.
 */
describe('when the consent versions cannot be fetched', () => {
  it('says what went wrong and offers a retry that actually recovers', async () => {
    getConsents.mockRejectedValueOnce(new NetworkError('no signal'));
    await renderApp();
    await press(en.obContinue);
    await waitFor(() => expect(screen.queryByText(en.obConsentTitle)).not.toBeNull());

    // The screen says it, in the words `userFacingMessage` owns.
    await waitFor(() => expect(screen.queryByText(en.errorsNetwork)).not.toBeNull());

    // Answering does not make the explanation disappear, which is exactly what
    // it used to do.
    await press(en.obAiAllow);
    expect(screen.queryByText(en.errorsNetwork)).not.toBeNull();
    expect(putAiConsent).not.toHaveBeenCalled();

    await pressTestId('onboarding-consent-refetch');
    await waitFor(() => expect(getConsents).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText(en.errorsNetwork)).toBeNull());

    // And the screen is usable again: the same answer now records.
    await press(en.obContinue);
    await waitFor(() => expect(putAiConsent).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText(en.obRoutineTitle)).not.toBeNull());
  });

  it('says it is still waiting rather than showing a dead button', async () => {
    let release: (() => void) | undefined;
    getConsents.mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve(CONSENTS);
    }) as never);
    await renderApp();
    await press(en.obContinue);
    await waitFor(() => expect(screen.queryByText(en.obConsentTitle)).not.toBeNull());
    await press(en.obAiAllow);

    // Answered, and Continue still will not move: the screen has to say why.
    await waitFor(() => expect(screen.queryByText(en.obConsentChecking)).not.toBeNull());

    release?.();
    await waitFor(() => expect(screen.queryByText(en.obConsentChecking)).toBeNull());
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
