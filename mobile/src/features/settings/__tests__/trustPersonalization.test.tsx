/**
 * The personalization toggle on the trust centre (UC-3.16, #202).
 *
 * The council's verdict, as tests: the question is asked here, it is off
 * until answered — including for an account that already agreed to the other
 * two questions — it writes to its own endpoint and never to the
 * recommendation one, and it cannot be answered against a server that has not
 * named its version.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import { TrustScreen } from '../TrustScreen';
import en from '../../../i18n/locales/en.json';
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
  uid: 'trust-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

beforeEach(() => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  // Generated from the real handler: AI processing and next-step suggestions
  // granted, and this question never asked — an existing account.
  jest.spyOn(consentEndpoints, 'getConsents').mockResolvedValue(answered as never);
  jest.spyOn(trustEndpoints, 'getTrust').mockResolvedValue(trustState as never);
  jest.spyOn(consentEndpoints, 'putPersonalizationConsent').mockResolvedValue(recorded as never);
  jest.spyOn(consentEndpoints, 'putRecommendationConsent').mockResolvedValue({} as never);
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

async function toggleReady() {
  await waitFor(() => expect(screen.getByTestId('trust-personalization').props.disabled).not.toBe(true));
}

describe('notice patterns in when you finish things', () => {
  it('is asked on the trust centre, in its own words', async () => {
    await show();
    await toggleReady();
    expect(screen.queryByText(en.trustPersonalizationTitle)).not.toBeNull();
    expect(screen.queryByText(en.trustPersonalizationBody)).not.toBeNull();
  });

  it('is off for an account that agreed to the other two questions and never this one', async () => {
    await show();
    await toggleReady();
    expect(screen.getByTestId('trust-recommendations').props.value).toBe(true);
    expect(screen.getByTestId('trust-ai-processing').props.value).toBe(true);
    expect(screen.getByTestId('trust-personalization').props.value).toBe(false);
  });

  it('turning it on writes to its own endpoint with the version the server named', async () => {
    await show();
    await toggleReady();
    await act(async () => { fireEvent(screen.getByTestId('trust-personalization'), 'valueChange', true); });

    await waitFor(() => expect(consentEndpoints.putPersonalizationConsent).toHaveBeenCalled());
    const [sent] = (consentEndpoints.putPersonalizationConsent as jest.Mock).mock.calls[0] as [Record<string, unknown>];
    expect(sent.state).toBe('granted');
    expect(sent.version).toBe('personalization-consent-v1');
    expect(consentEndpoints.putRecommendationConsent).not.toHaveBeenCalled();
  });

  it('turning it off sends a decline', async () => {
    jest.spyOn(consentEndpoints, 'getConsents').mockResolvedValue({
      ...answered,
      personalization: { ...answered.personalization, state: 'granted', asked: true },
    } as never);
    await show();
    await toggleReady();
    expect(screen.getByTestId('trust-personalization').props.value).toBe(true);

    await act(async () => { fireEvent(screen.getByTestId('trust-personalization'), 'valueChange', false); });
    await waitFor(() => expect(consentEndpoints.putPersonalizationConsent).toHaveBeenCalled());
    const [sent] = (consentEndpoints.putPersonalizationConsent as jest.Mock).mock.calls[0] as [Record<string, unknown>];
    expect(sent.state).toBe('declined');
  });

  it('cannot be answered against a server that has not named its version', async () => {
    const { personalization: _dropped, ...legacy } = answered;
    jest.spyOn(consentEndpoints, 'getConsents').mockResolvedValue({
      ...legacy,
      currentVersions: { aiProcessing: 'ai-consent-v1', recommendations: 'rec-consent-v1' },
    } as never);
    await show();
    await waitFor(() => expect(screen.getByTestId('trust-recommendations').props.disabled).not.toBe(true));
    expect(screen.getByTestId('trust-personalization').props.disabled).toBe(true);
    expect(screen.getByTestId('trust-personalization').props.value).toBe(false);
  });
});
