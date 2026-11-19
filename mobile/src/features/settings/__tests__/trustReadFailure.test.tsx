/**
 * QA v3 V3-F35-09 (old CXA12.5): with `GET /consents` and `GET /pilot/trust`
 * failing, «الثقة والخصوصية» drew every switch OFF with no error line — a
 * person read "nothing is shared" while the real state was unknown. A switch
 * whose position is unknown is not drawn; the card says the read failed and
 * offers a retry, and the switches come back with the server's answer.
 *
 * RNTL v14: `render()` and `fireEvent` are awaited.
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
import { ServerError } from '../../../api/errors';
import en from '../../../i18n/locales/en.json';
import answered from '../../../api/__fixtures__/consents.answered.json';
import trustState from '../../../api/__fixtures__/trust.state.json';
import * as consentEndpoints from '../../../api/endpoints/consents';
import * as trustEndpoints from '../../../api/endpoints/trust';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const USER: AuthUser = { uid: 'trust-read-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'] };
const SWITCHES = ['trust-recommendations', 'trust-personalization', 'trust-analytics', 'trust-quiet-mode', 'trust-calendar'];

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

beforeEach(() => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
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

describe('the trust reads fail', () => {
  it('draws no switch as off, says the read failed, and brings the switches back on retry', async () => {
    const getConsents = jest.spyOn(consentEndpoints, 'getConsents').mockRejectedValue(new ServerError('boom', 500));
    const getTrust = jest.spyOn(trustEndpoints, 'getTrust').mockRejectedValue(new ServerError('boom', 500));
    await show();
    await waitFor(() => expect(screen.queryAllByTestId('query-error').length).toBe(2));
    for (const id of SWITCHES) expect(screen.queryByTestId(id)).toBeNull();
    // Still reachable while the switches are unknown.
    expect(screen.queryByTestId('trust-knows')).not.toBeNull();
    expect(screen.queryByTestId('trust-export')).not.toBeNull();

    getConsents.mockResolvedValue(answered as never);
    getTrust.mockResolvedValue(trustState as never);
    for (const retry of screen.getAllByText(en.errorsRetry)) await fireEvent.press(retry);
    await waitFor(() => expect(screen.queryByTestId('trust-analytics')).not.toBeNull());
    for (const id of SWITCHES) expect(screen.queryByTestId(id)).not.toBeNull();
    expect(screen.getByTestId('trust-recommendations').props.value).toBe(true);
    expect(screen.queryByTestId('query-error')).toBeNull();
  });
});
