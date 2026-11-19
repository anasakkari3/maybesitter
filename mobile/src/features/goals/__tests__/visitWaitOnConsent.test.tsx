/**
 * QA CA7.5: Today's banner asks for a visit while recommendations are
 * declined, gets 403, and the phone then waits 6 hours. Turning
 * recommendations on in the trust centre must end that wait, or «يتابع لك»
 * stays empty for hours right after the person said yes.
 */
import React from 'react';
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import { TrustScreen } from '../../settings/TrustScreen';
import answered from '../../../api/__fixtures__/consents.answered.json';
import trustState from '../../../api/__fixtures__/trust.state.json';
import * as consentEndpoints from '../../../api/endpoints/consents';
import * as trustEndpoints from '../../../api/endpoints/trust';
import { claimVisit, recordVisitFailure, resetVisitThrottleForTests } from '../../../lib/deviceSettings/visitThrottle';

const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const user = { uid: 'visit-wait-user', email: null, emailVerified: true, displayName: null, providerIds: ['password'] };
let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

const declined = { ...answered, recommendations: { ...answered.recommendations, state: 'declined' } };
const saved = (state: 'granted' | 'declined') => ({
  success: true, recommendations: { state, version: 'rec-consent-v1', changedAt: '2026-11-12T07:00:00.000Z' },
});

beforeEach(() => {
  onlineManager.setOnline(true);
  resetVisitThrottleForTests();
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: user });
  setAuthRepository(repository);
  jest.spyOn(trustEndpoints, 'getTrust').mockResolvedValue(trustState as never);
});

afterEach(async () => {
  await cleanup();
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

async function show() {
  await render(
    <SafeAreaProvider initialMetrics={metrics}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}>
            <TrustScreen onBack={() => {}} onKnows={() => {}} />
          </QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('trust-recommendations').props.disabled).not.toBe(true));
}

it('turning recommendations on ends the wait a refused visit started', async () => {
  jest.spyOn(consentEndpoints, 'getConsents').mockResolvedValue(declined as never);
  const put = jest.spyOn(consentEndpoints, 'putRecommendationConsent').mockResolvedValue(saved('granted') as never);
  recordVisitFailure(user.uid, true);
  expect(await claimVisit(user.uid)).toBe(false);
  await show();
  await fireEvent(screen.getByTestId('trust-recommendations'), 'valueChange', true);
  await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
  await waitFor(async () => expect(await claimVisit(user.uid)).toBe(true));
});

it('turning them off leaves the wait as it was', async () => {
  jest.spyOn(consentEndpoints, 'getConsents').mockResolvedValue(answered as never);
  const put = jest.spyOn(consentEndpoints, 'putRecommendationConsent').mockResolvedValue(saved('declined') as never);
  recordVisitFailure(user.uid, true);
  await show();
  await fireEvent(screen.getByTestId('trust-recommendations'), 'valueChange', false);
  await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
  expect(await claimVisit(user.uid)).toBe(false);
});
