import React from 'react';
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import { WatchBuilderScreen } from '../WatcherScreens';
import { strings } from '../../../i18n/strings';
import * as watcherEndpoints from '../../../api/endpoints/watchers';
import response from './watcher-route-response.json';

const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const user = { uid: 'watch-builder-user', email: null, emailVerified: true, displayName: null, providerIds: ['password'] };
let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: user });
  setAuthRepository(repository);
});

afterEach(() => {
  cleanup();
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
            <WatchBuilderScreen />
          </QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
}

it('creates the supported readiness watcher and labels future sources honestly', async () => {
  const create = jest.spyOn(watcherEndpoints, 'createReadinessWatcher').mockResolvedValue(response as never);
  await show();
  const lang = Object.values(strings).find(t => screen.queryAllByText(t.xReadiness).length > 0)!;
  expect(lang).toBeDefined();
  expect(screen.getByTestId('watch-source-readiness').props.accessibilityState.checked).toBe(true);
  expect(screen.getAllByText(lang.xSoon).length).toBeGreaterThanOrEqual(3);

  await fireEvent.press(screen.getByTestId('watch-create'));
  await waitFor(() => expect(create).toHaveBeenCalledWith('notify'));
});
