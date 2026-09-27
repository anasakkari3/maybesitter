/**
 * Settings → Sources offers football only when the server holds the match
 * data key (closure CL7). Staging and production have none today, so in the
 * real app the row is hidden — not labelled «قريبًا», hidden — and following a
 * club can never be a promise that nothing ever fills.
 *
 * Driven by the two recorded server answers (`football.settings.json`, no key;
 * `football.settings.configured.json`, with one).
 */
import React from 'react';
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { cleanup, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import * as footballEndpoints from '../../../api/endpoints/football';
import footballOff from '../../../api/__fixtures__/football.settings.json';
import footballOn from '../../../api/__fixtures__/football.settings.configured.json';
import { SourcesScreen } from '../SourcesScreen';

const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const user = { uid: 'sources-user', email: null, emailVerified: true, displayName: null, providerIds: ['password'] };
let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: user });
  setAuthRepository(repository);
});

afterEach(async () => {
  await cleanup();
  await new Promise(resolve => setTimeout(resolve, 0));
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

async function show() {
  return render(
    <SafeAreaProvider initialMetrics={metrics}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}>
            <SourcesScreen onBack={() => undefined} />
          </QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
}

it('hides football when the server has no match data key', async () => {
  const read = jest.spyOn(footballEndpoints, 'getFootballSettings').mockResolvedValue(footballOff as never);
  await show();
  await waitFor(() => expect(read).toHaveBeenCalled());
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(screen.queryByTestId('settings-football')).toBeNull();
});

it('offers football once the server has the key', async () => {
  jest.spyOn(footballEndpoints, 'getFootballSettings').mockResolvedValue(footballOn as never);
  await show();
  expect(await screen.findByTestId('settings-football')).toBeTruthy();
});
