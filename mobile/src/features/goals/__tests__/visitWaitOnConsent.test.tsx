/**
 * QA CA7.5: Today's banner asks for a visit while recommendations are
 * declined, gets 403, and the phone then waits 6 hours. Turning
 * recommendations on must end that wait, or «يتابع لك» stays empty for hours
 * right after the person said yes.
 */
import React from 'react';
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { act, cleanup, renderHook } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import { useSetRecommendationConsent } from '../../../api/queries';
import * as consentEndpoints from '../../../api/endpoints/consents';
import { claimVisit, recordVisitFailure, resetVisitThrottleForTests } from '../../../lib/deviceSettings/visitThrottle';

const user = { uid: 'visit-wait-user', email: null, emailVerified: true, displayName: null, providerIds: ['password'] };
let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

beforeEach(() => {
  resetVisitThrottleForTests();
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: user });
  setAuthRepository(repository);
});

afterEach(async () => {
  await cleanup();
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

function wrapper({ children }: { children: React.ReactNode }) {
  return <AuthProvider repository={repository} isDevBundle={false}>
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  </AuthProvider>;
}

const answer = (state: 'granted' | 'declined') => ({
  success: true, recommendations: { state, version: 'rec-consent-v1', changedAt: '2026-11-12T07:00:00.000Z' },
});

it('granting recommendations ends the wait a refused visit started', async () => {
  // The banner's refused visit (403 consent_required): six hours.
  recordVisitFailure(user.uid, true);
  expect(await claimVisit(user.uid)).toBe(false);

  jest.spyOn(consentEndpoints, 'putRecommendationConsent').mockResolvedValue(answer('granted') as never);
  const { result } = await renderHook(() => useSetRecommendationConsent(), { wrapper });
  await act(async () => {
    await result.current.mutateAsync({ state: 'granted', version: 'rec-consent-v1', locale: 'ar', platform: 'ios' } as never);
  });
  expect(await claimVisit(user.uid)).toBe(true);
});

it('declining leaves the wait as it was', async () => {
  recordVisitFailure(user.uid, true);
  jest.spyOn(consentEndpoints, 'putRecommendationConsent').mockResolvedValue(answer('declined') as never);
  const { result } = await renderHook(() => useSetRecommendationConsent(), { wrapper });
  await act(async () => {
    await result.current.mutateAsync({ state: 'declined', version: 'rec-consent-v1', locale: 'ar', platform: 'ios' } as never);
  });
  expect(await claimVisit(user.uid)).toBe(false);
});
