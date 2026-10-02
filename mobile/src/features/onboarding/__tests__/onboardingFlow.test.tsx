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
import { Platform, Text } from 'react-native';
import * as notifications from 'expo-notifications';
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
import { setupChatStorageKey } from '../../../lib/deviceSettings/setupChatCache';
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
let putRecommendationConsent: jest.SpiedFunction<typeof consentEndpoints.putRecommendationConsent>;
let updateTrust: jest.SpiedFunction<typeof trustEndpoints.updateTrust>;
let recordAnalyticsEvent: jest.SpiedFunction<typeof analyticsEndpoints.recordAnalyticsEvent>;
let describeProfile: jest.SpiedFunction<typeof profileEndpoints.describeProfile>;

beforeEach(async () => {
  await AsyncStorage.clear();
  // Without this react-query treats the suite as offline and never runs a
  // query — the app sets it from the device in `installDeviceManagers`.
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  getConsents = jest.spyOn(consentEndpoints, 'getConsents').mockResolvedValue(CONSENTS);
  putRecommendationConsent = jest.spyOn(consentEndpoints, 'putRecommendationConsent')
    .mockResolvedValue({ success: true, recommendations: { state: 'declined', version: 'rec-consent-v1', changedAt: 'x' } } as never);
  updateTrust = jest.spyOn(trustEndpoints, 'updateTrust').mockResolvedValue({} as never);
  jest.spyOn(profileEndpoints, 'putRoutine').mockResolvedValue({} as never);
  recordAnalyticsEvent = jest.spyOn(analyticsEndpoints, 'recordAnalyticsEvent').mockResolvedValue({} as never);
  describeProfile = jest.spyOn(profileEndpoints, 'describeProfile').mockResolvedValue({
    success: true,
    proposalId: 'pp-1',
    suggestions: [{
      kind: 'goal' as const, category: 'fitness_habit' as const, content: 'Swim twice a week',
      targetDate: null, confidence: 0.8,
    }],
    createdAt: '2026-09-13T09:00:00.000Z',
    promptVersion: 'v1',
    model: 'gemini-2.5-flash',
  } as never);
  jest.spyOn(profileEndpoints, 'confirmProfileSuggestions')
    .mockResolvedValue({ success: true, saved: 0, kinds: {} } as never);
});

afterEach(async () => {
  // The order the rest of this suite's component tests use. `resetAuthForTests`
  // matters most: the repository is a module singleton, and leaving one test's
  // behind means the next render never resolves a user.
  await cleanup();
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

/** Mounts the gate without waiting: the step it lands on is the caller's claim. */
async function mountApp() {
  return render(
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
}

async function renderApp() {
  const view = await mountApp();
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

  // Audit 2026-10-03 #5: Settings → Account → sign out → sign in again with the
  // same email replayed the whole onboarding, consents included, because the
  // only record of "finished" was a device bit that sign-out clears. The
  // account's own answers are on the server and survive the sign-out.
  it('does not replay onboarding when the same account signs out and back in', async () => {
    await AsyncStorage.setItem(ONBOARDING_STORAGE_KEY, 'done');
    // What the server holds once this account has been through the consent
    // screen: the recommendation question answered (declined counts).
    getConsents.mockResolvedValue({
      ...CONSENTS,
      recommendations: { state: 'declined', version: 'rec-consent-v1', changedAt: '2026-10-03T09:00:00.000Z', asked: true },
    });
    await mountApp();
    await waitFor(() => expect(screen.queryByText('THE APP')).not.toBeNull());

    await repository.signOut();
    await waitFor(() => expect(screen.queryByText('THE APP')).toBeNull());
    // Sign-out still forgets the device copy: a shared phone must not hand the
    // next person this one's state.
    await waitFor(async () => expect(await AsyncStorage.getItem(ONBOARDING_STORAGE_KEY)).toBeNull());

    repository.emit({ ...USER });
    await waitFor(() => expect(screen.queryByText('THE APP')).not.toBeNull());
    expect(screen.queryByText(en.obWelcomeTitle)).toBeNull();
    expect(screen.queryByText(en.obConsentTitle)).toBeNull();
    // And the account's answer is written back, so the next launch does not
    // have to ask the server again before showing the app.
    expect(await AsyncStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe('done');
  });

  it('never flashes the welcome screen while it asks the server', async () => {
    let answer: (value: typeof CONSENTS) => void = () => {};
    getConsents.mockReturnValue(new Promise(resolve => { answer = resolve as never; }));
    await mountApp();
    await waitFor(() => expect(screen.queryByTestId('onboarding-loading')).not.toBeNull());
    expect(screen.queryByText(en.obWelcomeTitle)).toBeNull();
    answer({
      ...CONSENTS,
      recommendations: { state: 'granted', version: 'rec-consent-v1', changedAt: '2026-10-03T09:00:00.000Z', asked: true },
    } as never);
    await waitFor(() => expect(screen.queryByText('THE APP')).not.toBeNull());
  });

  it('still onboards a brand-new account on a phone that has never seen it', async () => {
    await renderApp();
    expect(getConsents).toHaveBeenCalled();
    expect(screen.queryByText('THE APP')).toBeNull();
  });

  it('keeps a brand-new account in onboarding after its consent answer lands', async () => {
    // The consent write invalidates the consents query; the refetch now says
    // the question has been asked. That must not end onboarding early.
    let answered = false;
    getConsents.mockImplementation(async () => (answered
      ? { ...CONSENTS, recommendations: { state: 'declined', version: 'rec-consent-v1', changedAt: '2026-10-03T09:00:00.000Z', asked: true } }
      : CONSENTS));
    putRecommendationConsent.mockImplementation(async () => {
      answered = true;
      return { success: true, recommendations: { state: 'declined', version: 'rec-consent-v1', changedAt: 'x' } } as never;
    });
    await renderApp();
    await press(en.obContinue);
    await waitFor(() => expect(screen.queryByText(en.obConsentTitle)).not.toBeNull());
    await press(en.obContinue);
    await waitFor(() => expect(screen.queryByText(en.obRoutineTitle)).not.toBeNull());
    await waitFor(() => expect(getConsents.mock.calls.length).toBeGreaterThan(1));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(screen.queryByText('THE APP')).toBeNull();
    expect(screen.queryByText(en.obRoutineTitle)).not.toBeNull();
  });

  it('falls back to onboarding when the server cannot be reached', async () => {
    getConsents.mockRejectedValue(new NetworkError('no signal'));
    await renderApp();
    expect(screen.queryByText('THE APP')).toBeNull();
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

  it('pre-selects nothing, discloses AI processing, and asks nothing about it', async () => {
    await reachConsent();
    // Both switches start off.
    for (const label of [en.obRecTitle, en.obAnalyticsTitle]) {
      expect(screen.getByLabelText(label).props.value).toBe(false);
    }
    // AI processing is told, before the first capture — not asked.
    expect(screen.queryByTestId('onboarding-ai-disclosure')).not.toBeNull();
    expect(screen.queryByText(en.aiDisclosure)).not.toBeNull();
    expect(screen.queryByRole('radiogroup')).toBeNull();

    // Nothing has to be answered to go on.
    await press(en.obContinue);
    await waitFor(() => expect(screen.queryByText(en.obRoutineTitle)).not.toBeNull());
  });

  it('sends each answer with the version the server said it recognises', async () => {
    await reachConsent();
    await fireEvent(screen.getByLabelText(en.obRecTitle), 'valueChange', true);
    await waitFor(() => expect(screen.getByLabelText(en.obRecTitle).props.value).toBe(true));
    await press(en.obContinue);

    await waitFor(() => expect(putRecommendationConsent).toHaveBeenCalled());
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
   *  2. This install is part-way through onboarding — resumed on the consent
   *     step — and the screen seeds the toggle from that record: on. (Signing
   *     back in on a phone with no progress used to be the way here; since
   *     audit 2026-10-03 #5 an account that has answered goes straight to the
   *     app instead, so the resumed install is the path that is left.)
   *  3. The user turns it off. That is an explicit decline, not an absence.
   *  4. A consents refetch lands. There is nothing exotic about it — the
   *     recommendation write invalidates this very query when it settles, so
   *     it happens on the way through the screen, and the payload differs
   *     (here: the AI record, which the server now always reads as granted).
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
    // The refetched payload is a different value from the one the screen
    // seeded from: after the first write attempt, the AI record reads back as
    // the always-on grant.
    let attempted = false;
    getConsents.mockImplementation(async () => (attempted
      ? {
        ...previouslyGranted,
        aiProcessing: {
          state: 'granted' as const, version: 'ai-consent-v1',
          changedAt: '2026-09-14T09:00:00.000Z', asked: true,
        },
      }
      : previouslyGranted));
    // One failed write, so the user is left on the screen with Retry — which
    // is the press that sends whatever the toggle says by then.
    putRecommendationConsent
      .mockImplementationOnce(async () => { attempted = true; throw new NetworkError('no signal'); })
      .mockResolvedValue({ success: true, recommendations: { state: 'declined', version: 'rec-consent-v1', changedAt: 'x' } } as never);

    await AsyncStorage.setItem(ONBOARDING_STORAGE_KEY, 'consent');
    await mountApp();
    await waitFor(() => expect(screen.queryByText(en.obConsentTitle)).not.toBeNull());
    // Seeded from the account's own earlier answer: the question is not asked
    // twice, which is what the seeding block is for.
    await waitFor(() => expect(screen.getByLabelText(en.obRecTitle).props.value).toBe(true));

    await fireEvent(screen.getByLabelText(en.obRecTitle), 'valueChange', false);
    await waitFor(() => expect(screen.getByLabelText(en.obRecTitle).props.value).toBe(false));

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
 * defect — Continue stayed dead with nothing on screen to explain it.
 */
describe('when the consent versions cannot be fetched', () => {
  it('says what went wrong and offers a retry that actually recovers', async () => {
    getConsents.mockRejectedValueOnce(new NetworkError('no signal'));
    // Resumed on the consent step. From the welcome screen the gate itself
    // asks first, and the consent screen's mount refetches past the failure.
    await AsyncStorage.setItem(ONBOARDING_STORAGE_KEY, 'consent');
    await mountApp();
    await waitFor(() => expect(screen.queryByText(en.obConsentTitle)).not.toBeNull());

    // The screen says it, in the words `userFacingMessage` owns.
    await waitFor(() => expect(screen.queryByText(en.errorsNetwork)).not.toBeNull());

    // Answering does not make the explanation disappear, which is exactly what
    // it used to do.
    await fireEvent(screen.getByLabelText(en.obRecTitle), 'valueChange', true);
    await waitFor(() => expect(screen.getByLabelText(en.obRecTitle).props.value).toBe(true));
    expect(screen.queryByText(en.errorsNetwork)).not.toBeNull();
    expect(putRecommendationConsent).not.toHaveBeenCalled();

    await pressTestId('onboarding-consent-refetch');
    await waitFor(() => expect(getConsents).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText(en.errorsNetwork)).toBeNull());

    // And the screen is usable again: the same answer now records.
    await press(en.obContinue);
    await waitFor(() => expect(putRecommendationConsent).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText(en.obRoutineTitle)).not.toBeNull());
  });

  it('says it is still waiting rather than showing a dead button', async () => {
    let release: (() => void) | undefined;
    getConsents.mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve(CONSENTS);
    }) as never);
    // Resumed on the consent step: from the welcome screen the gate holds on
    // the plain background until this answer lands.
    await AsyncStorage.setItem(ONBOARDING_STORAGE_KEY, 'consent');
    await mountApp();
    await waitFor(() => expect(screen.queryByText(en.obConsentTitle)).not.toBeNull());

    // Continue will not move yet: the screen has to say why.
    await waitFor(() => expect(screen.queryByText(en.obConsentChecking)).not.toBeNull());

    release?.();
    await waitFor(() => expect(screen.queryByText(en.obConsentChecking)).toBeNull());
  });
});

/**
 * The guided setup, driven through the flow (UC-3.17, #469).
 *
 * The screen's own contract is in `setupChatStep.test.tsx`. What is proved
 * here is what leaves the phone and when: the composed text reaches
 * `describeProfile` only after "Read my answers"; the
 * draft survives a remount through the per-account cache; and the count
 * event fires only with analytics consent — and carries a count, not words.
 */
describe('the guided setup', () => {
  /**
   * Sign-in to the "about" step, answering analytics the way the caller says.
   * Pressed, not stubbed, so the branch below is the one a person reaches.
   * (AI processing is not a question any more: the guided setup is always
   * offered.)
   */
  async function reachSetup(analytics: boolean) {
    const view = await renderApp();
    await press(en.obContinue);
    await waitFor(() => expect(screen.queryByText(en.obConsentTitle)).not.toBeNull());
    await waitFor(() => expect(getConsents).toHaveBeenCalled());
    if (analytics) {
      await fireEvent(screen.getByLabelText(en.obAnalyticsTitle), 'valueChange', true);
      await waitFor(() => expect(screen.getByLabelText(en.obAnalyticsTitle).props.value).toBe(true));
    }
    await press(en.obContinue);
    await waitFor(() => expect(screen.queryByTestId('onboarding-routine')).not.toBeNull());
    await press(en.obSkip);
    await waitFor(() => expect(screen.queryByTestId('onboarding-progress-about')).not.toBeNull());
    return view;
  }

  it('asks about their life first, and sends the composed answers to describe', async () => {
    await reachSetup(false);
    expect(screen.queryByText(en.obSetupLifeTitle)).not.toBeNull();
    expect(screen.queryByTestId('onboarding-about-manual')).toBeNull();

    // A prompt is not an answer: tapping one changes nothing that is sent.
    await pressTestId('setup-life-prompt-1');
    const story = "I'm a nursing student.\nI work three evenings and I'm trying to get back to swimming.";
    await fireEvent.changeText(screen.getByTestId('setup-life-input'), story);
    await press(en.obSetupLifeCta);
    for (let i = 0; i < 3; i += 1) await press(en.obSetupNext);
    await waitFor(() => expect(screen.queryByText(en.obSetupHabitsPrompt)).not.toBeNull());
    expect(describeProfile).not.toHaveBeenCalled();

    await press(en.obSetupRead);
    await waitFor(() => expect(describeProfile).toHaveBeenCalledTimes(1));
    expect(describeProfile.mock.calls[0]![0]).toBe(`${en.obSetupLifeLabel}: ${story}`);
    expect(describeProfile.mock.calls[0]![0]).not.toContain(en.obSetupLifePrompt1);
    await waitFor(() => expect(screen.queryByTestId('onboarding-about-review')).not.toBeNull());
  });

  it('restores the draft and the question after a remount', async () => {
    const view = await reachSetup(false);
    const story = 'Two kids, a night shift, and a thesis due in March.\nI keep forgetting the dentist.';
    await fireEvent.changeText(screen.getByTestId('setup-life-input'), story);
    await press(en.obSetupLifeCta);
    await waitFor(() => expect(screen.queryByText(en.obSetupDayPrompt)).not.toBeNull());
    // Per account, on this device — the draft is not the phone's (#148).
    await waitFor(() => expect(AsyncStorage.getItem(setupChatStorageKey(USER.uid))).resolves.not.toBeNull());

    await view.unmount();
    // Resumes on the about step, so there is no welcome screen to wait for.
    await mountApp();
    await waitFor(() => expect(screen.queryByText(en.obSetupDayPrompt)).not.toBeNull());
    await press(en.obBack);
    await waitFor(() => expect(screen.getByTestId('setup-life-input').props.value).toBe(story));
  });

  it('reports how many were answered when analytics was granted', async () => {
    await reachSetup(true);
    await fireEvent.changeText(screen.getByTestId('setup-life-input'), 'I study and work nights');
    await pressTestId('setup-skip');
    await waitFor(() => expect(screen.queryByTestId('onboarding-notifications')).not.toBeNull());
    expect(recordAnalyticsEvent).toHaveBeenCalledWith('onboarding_setup_answered', { answeredCount: 1 });
    // The draft is gone with the step: the next sign-in starts clean.
    await waitFor(() => expect(AsyncStorage.getItem(setupChatStorageKey(USER.uid))).resolves.toBeNull());
  });

  it('does not count a tapped inspiration prompt as an answer', async () => {
    await reachSetup(true);
    await pressTestId('setup-life-prompt-1');
    await pressTestId('setup-life-prompt-3');
    await pressTestId('setup-skip');
    await waitFor(() => expect(screen.queryByTestId('onboarding-notifications')).not.toBeNull());
    expect(recordAnalyticsEvent).toHaveBeenCalledWith('onboarding_setup_answered', { answeredCount: 0 });
    expect(describeProfile).not.toHaveBeenCalled();
  });

  it('reports nothing without analytics consent', async () => {
    await reachSetup(false);
    await pressTestId('setup-skip');
    await waitFor(() => expect(screen.queryByTestId('onboarding-notifications')).not.toBeNull());
    expect(recordAnalyticsEvent).not.toHaveBeenCalledWith('onboarding_setup_answered', expect.anything());
    expect(describeProfile).not.toHaveBeenCalled();
  });

  it('saves nothing from the review without a tick', async () => {
    await reachSetup(false);
    await fireEvent.changeText(screen.getByTestId('setup-life-input'), 'Nursing student, night shifts, a thesis in March');
    await press(en.obSetupLifeCta);
    for (let i = 0; i < 3; i += 1) await press(en.obSetupNext);
    await press(en.obSetupRead);
    await waitFor(() => expect(screen.queryByTestId('onboarding-about-review')).not.toBeNull());
    await press(en.obAboutSaveNone);
    await waitFor(() => expect(profileEndpoints.confirmProfileSuggestions).toHaveBeenCalledWith('pp-1', []));
    await waitFor(() => expect(screen.queryByTestId('onboarding-notifications')).not.toBeNull());
  });
});

describe('finishing', () => {
  // Audit 2026-10-03 #7: «تذكيرات، وقت ما بدك ياها» → «يلا نبلّش» never put
  // Android's prompt on screen, and POST_NOTIFICATIONS stayed not granted.
  // Driven through the native module, in the shape Android 13+ reports a
  // permission that has never been asked: `denied`, but `canAskAgain`.
  async function reachReminders() {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(notifications, 'getPermissionsAsync')
      .mockResolvedValue({ status: 'denied', granted: false, canAskAgain: true, expires: 'never', android: { importance: 3 } } as never);
    await AsyncStorage.setItem(ONBOARDING_STORAGE_KEY, 'notifications');
    await mountApp();
    await waitFor(() => expect(screen.queryByText(en.obNotifTitle)).not.toBeNull());
  }

  it('asks the phone for notifications when the user taps Start', async () => {
    await reachReminders();
    const request = jest.spyOn(notifications, 'requestPermissionsAsync')
      .mockResolvedValue({ status: 'granted', granted: true, canAskAgain: true, expires: 'never' } as never);
    await press(en.obDone);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText('THE APP')).not.toBeNull());
  });

  it('still finishes onboarding when the phone says no', async () => {
    await reachReminders();
    jest.spyOn(notifications, 'requestPermissionsAsync')
      .mockResolvedValue({ status: 'denied', granted: false, canAskAgain: true, expires: 'never' } as never);
    await press(en.obDone);
    await waitFor(() => expect(screen.queryByText('THE APP')).not.toBeNull());
  });

  it('asks nothing when the user says later, or goes back', async () => {
    await reachReminders();
    const request = jest.spyOn(notifications, 'requestPermissionsAsync');
    await press(en.obBack);
    await waitFor(() => expect(screen.queryByText(en.obNotifTitle)).toBeNull());
    expect(request).not.toHaveBeenCalled();
    await cleanup();

    await reachReminders();
    await pressTestId('onboarding-notifications-later');
    await waitFor(() => expect(screen.queryByText('THE APP')).not.toBeNull());
    expect(request).not.toHaveBeenCalled();
  });

  it('asks from the reminders step and from nowhere else in onboarding', () => {
    // Asserted at the source: the welcome, consent, routine and about steps
    // come before the explanation, and must not reach the one prompt iOS allows.
    const directory = join(__dirname, '..');
    for (const file of readdirSync(directory).filter(name => name.endsWith('.tsx') || name.endsWith('.ts'))) {
      const source = readFileSync(join(directory, file), 'utf8');
      expect(source).not.toMatch(/expo-notifications|requestPermissionsAsync/);
      if (file !== 'NotificationsStep.tsx') expect(source).not.toMatch(/requestNotificationPermission/);
    }
  });
});
