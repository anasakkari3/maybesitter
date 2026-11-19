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
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
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
    expect(screen.getByTestId('trust-revoke').props.accessibilityState?.disabled).toBe(true);
    expect(screen.queryByTestId('trust-resume')).toBeNull();
    expect(screen.queryByTestId('trust-revoked')).toBeNull();
  });
});
