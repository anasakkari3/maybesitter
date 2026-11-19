/**
 * «وقّف مشاركتك» stops suggestions and learning, and the app keeps working
 * (QA v3, V3-F35-07; owner decision 2026-11-19).
 *
 * The card sent `{ type: 'revoke' }`, which locked the whole account behind
 * «هالحساب موقوف» with no way back. It now answers the two questions its words
 * name — next-step suggestions and pattern learning — through the same
 * endpoints the switches above it use, never the trust `revoke`, and once
 * both are off it offers «شغّلها من جديد».
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';
import { NetworkError } from '../../../api/errors';
import { claimVisit, recordVisitFailure, resetVisitThrottleForTests } from '../../../lib/deviceSettings/visitThrottle';
import en from '../../../i18n/locales/en.json';
import ar from '../../../i18n/locales/ar.json';
import he from '../../../i18n/locales/he.json';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import { TrustScreen } from '../TrustScreen';
import answered from '../../../api/__fixtures__/consents.answered.json';
import trustState from '../../../api/__fixtures__/trust.state.json';
import recorded from '../../../api/__fixtures__/consents.personalizationRecorded.json';

import * as consentEndpoints from '../../../api/endpoints/consents';
import * as trustEndpoints from '../../../api/endpoints/trust';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const USER: AuthUser = {
  uid: 'trust-stop-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

const BOTH_ON = {
  ...answered,
  personalization: { ...answered.personalization, state: 'granted', asked: true, changedAt: '2026-08-09T09:00:00.000Z' },
};
const BOTH_OFF = {
  ...answered,
  recommendations: { ...answered.recommendations, state: 'declined' },
  personalization: { ...answered.personalization, state: 'declined', asked: true, changedAt: '2026-08-09T09:00:00.000Z' },
};

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

beforeEach(() => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  jest.spyOn(trustEndpoints, 'getTrust').mockResolvedValue(trustState as never);
  jest.spyOn(trustEndpoints, 'updateTrust').mockResolvedValue(trustState as never);
  jest.spyOn(consentEndpoints, 'putPersonalizationConsent').mockResolvedValue(recorded as never);
  jest.spyOn(consentEndpoints, 'putRecommendationConsent').mockImplementation(async (answer) => ({
    success: true,
    recommendations: { ...answered.recommendations, state: answer.state },
  }) as never);
});

afterEach(() => {
  resetVisitThrottleForTests();
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

async function show() {
  return render(
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
}

function sentStates(mock: unknown): string[] {
  return ((mock as jest.Mock).mock.calls as [{ state: string }][]).map(([answer]) => answer.state);
}

function trustActionsSent(): string[] {
  return ((trustEndpoints.updateTrust as jest.Mock).mock.calls as [{ type: string }][]).map(([action]) => action.type);
}

describe('«وقّف مشاركتك» on the trust centre', () => {
  it('stops suggestions and learning, and never revokes the account', async () => {
    jest.spyOn(consentEndpoints, 'getConsents').mockResolvedValue(BOTH_ON as never);
    await show();
    await waitFor(() => expect(screen.getByTestId('trust-revoke').props.accessibilityState?.disabled).not.toBe(true));
    await fireEvent.press(screen.getByTestId('trust-revoke'));
    await fireEvent.press(screen.getByTestId('trust-revoke-confirm'));

    await waitFor(() => expect(sentStates(consentEndpoints.putPersonalizationConsent)).toEqual(['declined']));
    expect(sentStates(consentEndpoints.putRecommendationConsent)).toEqual(['declined']);
    expect(trustActionsSent()).not.toContain('revoke');
  });

  it('once both are off, says so and offers the way back', async () => {
    jest.spyOn(consentEndpoints, 'getConsents').mockResolvedValue(BOTH_OFF as never);
    await show();
    await waitFor(() => expect(screen.queryByTestId('trust-resume')).not.toBeNull());
    expect(screen.queryByTestId('trust-revoked')).not.toBeNull();
    expect(screen.queryByTestId('trust-revoke')).toBeNull();

    await fireEvent.press(screen.getByTestId('trust-resume'));
    await waitFor(() => expect(sentStates(consentEndpoints.putPersonalizationConsent)).toEqual(['granted']));
    expect(sentStates(consentEndpoints.putRecommendationConsent)).toEqual(['granted']);
    expect(trustActionsSent()).toEqual([]);
  });

  it('claims neither state while the answers cannot be read', async () => {
    jest.spyOn(consentEndpoints, 'getConsents').mockRejectedValue(new Error('unreachable') as never);
    await show();
    await waitFor(() => expect(screen.queryByTestId('trust-revoke')).not.toBeNull());
    // Still offered: pressing it reads again (trustReadFailure.test.tsx).
    await waitFor(() => expect(screen.getByTestId('trust-revoke').props.accessibilityState?.disabled).not.toBe(true));
    expect(screen.queryByTestId('trust-resume')).toBeNull();
    expect(screen.queryByTestId('trust-revoked')).toBeNull();
  });

  it('a stop whose learning half fails says exactly that, and says it out loud', async () => {
    jest.spyOn(consentEndpoints, 'getConsents').mockResolvedValue(BOTH_ON as never);
    jest.spyOn(consentEndpoints, 'putPersonalizationConsent').mockRejectedValue(new NetworkError('offline') as never);
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    announce.mockClear();
    await show();
    await waitFor(() => expect(screen.getByTestId('trust-revoke').props.accessibilityState?.disabled).not.toBe(true));
    await fireEvent.press(screen.getByTestId('trust-revoke'));
    await fireEvent.press(screen.getByTestId('trust-revoke-confirm'));

    await waitFor(() => expect(screen.queryByTestId('trust-stop-failed')).not.toBeNull());
    expect(screen.getByText(en.trustStopPartial)).toBeTruthy();
    expect(screen.getByTestId('trust-stop-live').props.accessibilityLiveRegion).toBe('polite');
    expect(announce).toHaveBeenCalledWith(en.trustStopPartial);
    expect(sentStates(consentEndpoints.putRecommendationConsent)).toEqual(['declined']);
  });

  it('a stop that fails at its first write says nothing changed, and does not go on to the second', async () => {
    jest.spyOn(consentEndpoints, 'getConsents').mockResolvedValue(BOTH_ON as never);
    jest.spyOn(consentEndpoints, 'putRecommendationConsent').mockRejectedValue(new NetworkError('offline') as never);
    await show();
    await waitFor(() => expect(screen.getByTestId('trust-revoke').props.accessibilityState?.disabled).not.toBe(true));
    await fireEvent.press(screen.getByTestId('trust-revoke'));
    await fireEvent.press(screen.getByTestId('trust-revoke-confirm'));
    await waitFor(() => expect(screen.queryByTestId('trust-stop-failed')).not.toBeNull());
    expect(screen.getByText(en.trustActionFailed)).toBeTruthy();
    expect(consentEndpoints.putPersonalizationConsent).not.toHaveBeenCalled();
  });

  it('stops suggestions before learning', async () => {
    jest.spyOn(consentEndpoints, 'getConsents').mockResolvedValue(BOTH_ON as never);
    await show();
    await waitFor(() => expect(screen.getByTestId('trust-revoke').props.accessibilityState?.disabled).not.toBe(true));
    await fireEvent.press(screen.getByTestId('trust-revoke'));
    await fireEvent.press(screen.getByTestId('trust-revoke-confirm'));
    await waitFor(() => expect(consentEndpoints.putPersonalizationConsent).toHaveBeenCalled());
    const suggestionsAt = (consentEndpoints.putRecommendationConsent as jest.Mock).mock.invocationCallOrder[0]!;
    const learningAt = (consentEndpoints.putPersonalizationConsent as jest.Mock).mock.invocationCallOrder[0]!;
    expect(suggestionsAt).toBeLessThan(learningAt);
  });

  it('the failure line goes away once a switch is moved by hand', async () => {
    jest.spyOn(consentEndpoints, 'getConsents').mockResolvedValue(BOTH_ON as never);
    jest.spyOn(consentEndpoints, 'putPersonalizationConsent').mockRejectedValueOnce(new NetworkError('offline') as never);
    await show();
    await waitFor(() => expect(screen.getByTestId('trust-revoke').props.accessibilityState?.disabled).not.toBe(true));
    await fireEvent.press(screen.getByTestId('trust-revoke'));
    await fireEvent.press(screen.getByTestId('trust-revoke-confirm'));
    await waitFor(() => expect(screen.queryByTestId('trust-stop-failed')).not.toBeNull());
    await waitFor(() => expect(screen.getByTestId('trust-personalization').props.disabled).not.toBe(true));
    await fireEvent(screen.getByTestId('trust-personalization'), 'valueChange', false);
    await waitFor(() => expect(screen.queryByTestId('trust-stop-failed')).toBeNull());
  });

  it('is not «off» while only one of the two is off', async () => {
    jest.spyOn(consentEndpoints, 'getConsents').mockResolvedValue({
      ...BOTH_ON, recommendations: { ...answered.recommendations, state: 'declined' },
    } as never);
    await show();
    await waitFor(() => expect(screen.getByTestId('trust-revoke').props.accessibilityState?.disabled).not.toBe(true));
    expect(screen.queryByTestId('trust-revoked')).toBeNull();
    expect(screen.queryByTestId('trust-resume')).toBeNull();
  });

  it('does not call an account that was never asked «stopped», nor offer to turn things back on', async () => {
    jest.spyOn(consentEndpoints, 'getConsents').mockResolvedValue({
      ...BOTH_OFF,
      recommendations: { ...BOTH_OFF.recommendations, asked: false, changedAt: '' },
      personalization: { ...BOTH_OFF.personalization, asked: false, changedAt: '' },
    } as never);
    await show();
    await waitFor(() => expect(screen.getByTestId('trust-revoke').props.accessibilityState?.disabled).not.toBe(true));
    expect(screen.queryByTestId('trust-revoked')).toBeNull();
    expect(screen.queryByTestId('trust-resume')).toBeNull();
  });

  /**
   * A server that remembers: each answer written is what the next read says,
   * so the card follows the writes the way it does on a phone.
   */
  function rememberingServer(start: typeof BOTH_ON | typeof BOTH_OFF, failSuggestions = false) {
    let current = JSON.parse(JSON.stringify(start)) as typeof BOTH_ON;
    jest.spyOn(consentEndpoints, 'getConsents').mockImplementation(async () => JSON.parse(JSON.stringify(current)) as never);
    jest.spyOn(consentEndpoints, 'putPersonalizationConsent').mockImplementation(async (answer) => {
      current = { ...current, personalization: { ...current.personalization, state: answer.state, asked: true } };
      return { success: true, personalization: current.personalization } as never;
    });
    jest.spyOn(consentEndpoints, 'putRecommendationConsent').mockImplementation(async (answer) => {
      if (failSuggestions) throw new NetworkError('offline');
      current = { ...current, recommendations: { ...current.recommendations, state: answer.state, asked: true } };
      return { success: true, recommendations: current.recommendations } as never;
    });
  }

  it('a turn-back-on whose suggestions half fails says so, and still offers to turn them back on', async () => {
    rememberingServer(BOTH_OFF, true);
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    announce.mockClear();
    await show();
    await waitFor(() => expect(screen.queryByTestId('trust-resume')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('trust-resume'));
    await waitFor(() => expect(screen.queryByTestId('trust-stop-failed')).not.toBeNull());
    expect(screen.getByText(en.trustResumePartial)).toBeTruthy();
    expect(announce).toHaveBeenCalledWith(en.trustResumePartial);
    // Learning came back, suggestions did not: the card still offers what the
    // person asked for, not «stop».
    await waitFor(() => expect(screen.getByTestId('trust-resume').props.accessibilityState?.disabled).not.toBe(true));
    expect(screen.queryByTestId('trust-revoke')).toBeNull();
  });

  it('turning suggestions back on ends the six-hour wait a refused visit set (QA CA7.5)', async () => {
    rememberingServer(BOTH_OFF);
    recordVisitFailure(USER.uid, true);
    expect(await claimVisit(USER.uid)).toBe(false);
    await show();
    await waitFor(() => expect(screen.queryByTestId('trust-resume')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('trust-resume'));
    await waitFor(() => expect(sentStates(consentEndpoints.putRecommendationConsent)).toEqual(['granted']));
    await waitFor(async () => expect(await claimVisit(USER.uid)).toBe(true));
  });

  it('turning them back on is said out loud once it landed', async () => {
    rememberingServer(BOTH_OFF);
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    announce.mockClear();
    await show();
    await waitFor(() => expect(screen.queryByTestId('trust-resume')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('trust-resume'));
    await waitFor(() => expect(screen.queryByTestId('trust-resumed')).not.toBeNull());
    expect(announce).toHaveBeenCalledWith(en.trustResumed);
    expect(screen.queryByTestId('trust-stop-failed')).toBeNull();
  });

  it('stopping is said out loud once it landed', async () => {
    rememberingServer(BOTH_ON);
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    announce.mockClear();
    await show();
    await waitFor(() => expect(screen.getByTestId('trust-revoke').props.accessibilityState?.disabled).not.toBe(true));
    await fireEvent.press(screen.getByTestId('trust-revoke'));
    await fireEvent.press(screen.getByTestId('trust-revoke-confirm'));
    await waitFor(() => expect(screen.queryByTestId('trust-revoked')).not.toBeNull());
    await waitFor(() => expect(announce).toHaveBeenCalledWith(en.trustRevoked));
  });

  it('opening the screen on an account already off does not announce «off»', async () => {
    rememberingServer(BOTH_OFF);
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    announce.mockClear();
    await show();
    await waitFor(() => expect(screen.queryByTestId('trust-revoked')).not.toBeNull());
    expect(announce).not.toHaveBeenCalledWith(en.trustRevoked);
  });

  it('a second turn-back-on after a partial one, whose learning half fails offline, still offers to turn them back on', async () => {
    rememberingServer(BOTH_OFF, true);
    await show();
    await waitFor(() => expect(screen.queryByTestId('trust-resume')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('trust-resume'));
    await waitFor(() => expect(screen.queryByText(en.trustResumePartial)).not.toBeNull());
    jest.spyOn(consentEndpoints, 'putPersonalizationConsent').mockRejectedValue(new NetworkError('offline') as never);
    await fireEvent.press(screen.getByTestId('trust-resume'));
    await waitFor(() => expect(screen.queryByText(en.trustActionFailed)).not.toBeNull());
    expect(screen.queryByTestId('trust-resume')).not.toBeNull();
    expect(screen.queryByTestId('trust-revoke')).toBeNull();
  });

  it('while that second try is on its way, the button does not turn into «stop»', async () => {
    rememberingServer(BOTH_OFF, true);
    await show();
    await waitFor(() => expect(screen.queryByTestId('trust-resume')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('trust-resume'));
    await waitFor(() => expect(screen.queryByText(en.trustResumePartial)).not.toBeNull());
    let release!: () => void;
    jest.spyOn(consentEndpoints, 'putPersonalizationConsent').mockImplementation(() => new Promise(resolve => { release = () => resolve(recorded as never); }) as never);
    await fireEvent.press(screen.getByTestId('trust-resume'));
    await waitFor(() => expect(screen.queryByTestId('trust-stop-busy')).not.toBeNull());
    expect(screen.queryByTestId('trust-revoke')).toBeNull();
    expect(screen.queryByTestId('trust-resume')).not.toBeNull();
    release();
  });

  it('opening an account that is on shows neither «off» nor «back on»', async () => {
    rememberingServer(BOTH_ON);
    await show();
    await waitFor(() => expect(screen.getByTestId('trust-revoke').props.accessibilityState?.disabled).not.toBe(true));
    expect(screen.queryByTestId('trust-resumed')).toBeNull();
    expect(screen.queryByTestId('trust-revoked')).toBeNull();
  });

  it('the standing «off» line sits outside the live region, so opening the screen announces nothing', async () => {
    rememberingServer(BOTH_OFF);
    await show();
    await waitFor(() => expect(screen.queryByTestId('trust-revoked')).not.toBeNull());
    expect(within(screen.getByTestId('trust-stop-live')).queryByTestId('trust-revoked')).toBeNull();
  });

  it('the card says what keeps going, and says email is still read and analysed', async () => {
    rememberingServer(BOTH_ON);
    await show();
    await waitFor(() => expect(screen.queryByTestId('trust-revoke-email')).not.toBeNull());
    expect(screen.getByText(en.trustRevokeEmail)).toBeTruthy();
    for (const copy of [ar, en, he]) {
      // The watches' own cards keep coming: the card names them by their title.
      expect(copy.trustRevokeBody).toContain(copy.xProposalsTitle);
      // It does not claim Watching goes quiet: those cards live there.
      expect(copy.trustRevokeBody).not.toContain(copy.tabWatching);
    }
    // The confirmation says what stays, without repeating the card.
    expect(en.trustRevokeConfirmBody).not.toBe(en.trustRevokeBody);
  });

  // QA v3 (#873 follow-up): stopping declines the suggestions and learning
  // consents only. The email auto-add from the person's own sent reply is gated
  // on Gmail monitoring and the calendar consent (lib/intelligence/
  // m5aGmailScan.ts), so it keeps adding after «وقّف». The card says so.
  it('the card says a commitment agreed to in your own email reply is still added by itself', async () => {
    rememberingServer(BOTH_ON);
    await show();
    await waitFor(() => expect(screen.queryByTestId('trust-revoke-email-autoadd')).not.toBeNull());
    expect(screen.getByTestId('trust-revoke-email-autoadd').props.children).toBe(en.trustRevokeEmailAutoAdd);
    for (const copy of [ar, en, he] as unknown as Array<Record<string, string>>) {
      expect(copy.trustRevokeEmailAutoAdd).toBeTruthy();
      // It names the switch it depends on, by the title the screen gives it.
      expect(copy.trustRevokeEmailAutoAdd).toContain(copy.trustCalendar);
      // And the one-tap removal the added item offers.
      expect(copy.trustRevokeEmailAutoAdd).not.toBe(copy.trustRevokeEmail);
    }
  });

  it('the same sentence is there once both are off, beside «شغّلها من جديد»', async () => {
    rememberingServer(BOTH_OFF);
    await show();
    await waitFor(() => expect(screen.queryByTestId('trust-resume')).not.toBeNull());
    expect(screen.queryByTestId('trust-revoke-email-autoadd')).not.toBeNull();
  });
});
