/**
 * "What's your week like?" (UC-2.7b, #168), reached the way a person does.
 *
 * AI processing is no longer a question (owner decision 2026-09-30): the
 * consent screen discloses it, and every account gets the guided setup. The
 * manual card that a declined AI answer led to is gone with the answer.
 *
 * ── The claim is about the request, not about the field ──────────
 *
 * What leaves the phone is observable only at `POST /api/mobile/profile/
 * describe`, so the assertions are on that endpoint spy: called with exactly
 * what was typed once "Read my answers" is pressed, and never for an empty
 * description.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import { NetworkError, NotFoundError } from '../../../api/errors';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import type { AuthUser } from '../../../auth/types';
import { OnboardingGate } from '../OnboardingGate';
import en from '../../../i18n/locales/en.json';

import * as consentEndpoints from '../../../api/endpoints/consents';
import * as profileEndpoints from '../../../api/endpoints/profile';
import * as trustEndpoints from '../../../api/endpoints/trust';
import * as analyticsEndpoints from '../../../api/endpoints/analytics';

const USER: AuthUser = {
  uid: 'about-you-user',
  email: 'someone@example.com',
  emailVerified: true,
  displayName: null,
  providerIds: ['password'],
};

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

/** Nothing answered yet: the account has never been asked. */
const CONSENTS = {
  aiProcessing: { state: 'declined' as const, version: 'ai-consent-v1', changedAt: '', asked: false },
  recommendations: { state: 'declined' as const, version: 'rec-consent-v1', changedAt: '', asked: false },
  currentVersions: { aiProcessing: 'ai-consent-v1', recommendations: 'rec-consent-v1' },
  currentVersion: 'ai-consent-v1',
};

const PROPOSAL = {
  success: true,
  proposalId: 'pp-1',
  suggestions: [{
    kind: 'goal' as const,
    category: 'fitness_habit' as const,
    content: 'Swim twice a week',
    targetDate: null,
    confidence: 0.8,
  }],
  createdAt: '2026-09-13T09:00:00.000Z',
  promptVersion: 'v1',
  model: 'gemini-2.5-flash',
};

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;
let describeProfile: jest.SpiedFunction<typeof profileEndpoints.describeProfile>;
let confirmProfileSuggestions: jest.SpiedFunction<typeof profileEndpoints.confirmProfileSuggestions>;

beforeEach(async () => {
  await AsyncStorage.clear();
  // Without this react-query treats the suite as offline and never runs a
  // query, so the consent screen waits forever for its versions.
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  jest.spyOn(consentEndpoints, 'getConsents').mockResolvedValue(CONSENTS);
  jest.spyOn(consentEndpoints, 'putRecommendationConsent')
    .mockResolvedValue({ success: true, recommendations: { state: 'declined', version: 'rec-consent-v1', changedAt: 'x' } } as never);
  jest.spyOn(trustEndpoints, 'updateTrust').mockResolvedValue({} as never);
  jest.spyOn(profileEndpoints, 'putRoutine').mockResolvedValue({} as never);
  jest.spyOn(analyticsEndpoints, 'recordAnalyticsEvent').mockResolvedValue({} as never);
  describeProfile = jest.spyOn(profileEndpoints, 'describeProfile').mockResolvedValue(PROPOSAL as never);
  confirmProfileSuggestions = jest.spyOn(profileEndpoints, 'confirmProfileSuggestions')
    .mockResolvedValue({ success: true, saved: 1, kinds: { goal: 1 } } as never);
});

afterEach(async () => {
  await cleanup();
  // A real macrotask: the flow writes its step through AsyncStorage after a
  // mutation resolves, and a write still in flight when the tree came down
  // would land after the clear below and start the next test on the wrong
  // step.
  await new Promise(resolve => setTimeout(resolve, 0));
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
  await AsyncStorage.clear();
});

async function renderOnboarding() {
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
  await waitFor(() => expect(screen.queryByText(en.obWelcomeTitle)).not.toBeNull());
}

/** Presses a button by the accessibility label the design gives it. */
async function press(label: string) {
  await fireEvent.press(screen.getByLabelText(label));
}

/**
 * Sign-in to the self-description screen. Everything in between is pressed,
 * not stubbed.
 */
async function reachAboutYou() {
  await renderOnboarding();
  await press(en.obContinue);
  await waitFor(() => expect(screen.queryByText(en.obConsentTitle)).not.toBeNull());
  // The AI disclosure is on the way in; there is nothing to answer about it.
  expect(screen.queryByTestId('onboarding-ai-disclosure')).not.toBeNull();

  await press(en.obContinue);
  await waitFor(() => expect(screen.queryByTestId('onboarding-routine')).not.toBeNull());

  // The survey is somebody else's test (#171); skipping it is a normal answer.
  await press(en.obSkip);
  await waitFor(() => expect(screen.queryByTestId('onboarding-progress-about')).not.toBeNull());
}

/** Through the five questions with one typed answer, to "Read my answers". */
async function answerAndRead(text: string) {
  await fireEvent.changeText(screen.getByTestId('setup-life-input'), text);
  await press(en.obSetupLifeCta);
  for (let i = 0; i < 3; i += 1) await press(en.obSetupNext);
  await waitFor(() => expect(screen.queryByText(en.obSetupHabitsPrompt)).not.toBeNull());
  await press(en.obSetupRead);
}

describe('the guided setup, which every account now gets', () => {
  it('offers the guided setup, and sends what they wrote to describe', async () => {
    await reachAboutYou();

    expect(screen.queryByTestId('onboarding-setup')).not.toBeNull();
    expect(screen.queryByTestId('onboarding-about-manual')).toBeNull();

    await answerAndRead('  Two kids, work Sunday to Thursday, and I want to swim again  ');

    await waitFor(() => expect(describeProfile).toHaveBeenCalled());
    // Labelled with the question, trimmed, and exactly what was typed — no
    // padding, nothing the user cannot see on screen.
    expect(describeProfile.mock.calls[0]![0])
      .toBe(`${en.obSetupLifeLabel}: Two kids, work Sunday to Thursday, and I want to swim again`);

    // Settle on the checklist the suggestions produce, so the tree is not torn
    // down mid-mutation.
    await waitFor(() => expect(screen.queryByTestId('onboarding-about-review')).not.toBeNull());
  });

  it('will not send an empty description', async () => {
    await reachAboutYou();
    // Whitespace is not an answer: the first screen's CTA stays shut, and
    // "Not now" ends the step without reading anything.
    await fireEvent.changeText(screen.getByTestId('setup-life-input'), '   ');
    expect(screen.getByLabelText(en.obSetupLifeCta).props.accessibilityState).toMatchObject({ disabled: true });
    await press(en.obSetupLifeSkip);
    await waitFor(() => expect(screen.queryByTestId('onboarding-notifications')).not.toBeNull());
    expect(describeProfile).not.toHaveBeenCalled();
  });
});

/**
 * What the checklist is allowed to do when the save does not land (UC-2.7b
 * #168, and the "false save" class of defect this app has already shipped
 * once).
 *
 * Every failure used to be swallowed by a bare `catch {}` whose comment
 * assumed the proposal had expired, and the flow then dropped the proposal and
 * advanced regardless. A dropped connection was therefore indistinguishable
 * from a save: the ticks vanished, the next screen appeared, and nothing had
 * been written.
 *
 * Only one failure really does mean "there is nothing left to save" — the 404
 * the route answers for a proposal that has expired or already been consumed —
 * and only that one may move the user on.
 */
describe('when the checklist cannot be saved', () => {
  async function reachTheChecklist() {
    await reachAboutYou();
    await answerAndRead('I want to swim again');
    await waitFor(() => expect(screen.queryByTestId('onboarding-about-review')).not.toBeNull());
    // Tick the one suggestion, so there is something whose loss would matter.
    await press(PROPOSAL.suggestions[0]!.content);
  }

  it('keeps the ticks and says so, rather than advancing past a write that never landed', async () => {
    confirmProfileSuggestions.mockRejectedValueOnce(new NetworkError('no signal'));
    await reachTheChecklist();

    await press(en.obAboutSaveSelected);
    await waitFor(() => expect(confirmProfileSuggestions).toHaveBeenCalledTimes(1));

    // The harm first: the checklist used to be thrown away and the next screen
    // shown, over a write that never happened.
    expect(screen.queryByTestId('onboarding-about-review')).not.toBeNull();
    expect(screen.queryByTestId('onboarding-notifications')).toBeNull();
    // And told why — in the words `userFacingMessage` owns, never the error's.
    await waitFor(() => expect(screen.queryByText(en.errorsNetwork)).not.toBeNull());

    // And the same button re-sends the same ticks: pressing on is the retry.
    await press(en.obAboutSaveSelected);
    await waitFor(() => expect(confirmProfileSuggestions).toHaveBeenCalledTimes(2));
    expect(confirmProfileSuggestions.mock.calls[1]).toEqual(confirmProfileSuggestions.mock.calls[0]);
    await waitFor(() => expect(screen.queryByTestId('onboarding-notifications')).not.toBeNull());
  });

  it('moves on when the proposal itself is gone, because nothing can be saved to it', async () => {
    // The thirty minutes elapsed, or it was already confirmed. There is
    // nothing to retry and holding somebody on a checklist that cannot commit
    // would be the worse failure.
    confirmProfileSuggestions.mockRejectedValueOnce(new NotFoundError('proposal not found'));
    await reachTheChecklist();

    await press(en.obAboutSaveSelected);
    await waitFor(() => expect(screen.queryByTestId('onboarding-notifications')).not.toBeNull());
    expect(screen.queryByText(en.errorsNetwork)).toBeNull();
  });
});
