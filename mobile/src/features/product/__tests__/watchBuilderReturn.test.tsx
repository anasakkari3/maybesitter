/**
 * L6 (b): finishing the watch builder from Today used to push Background
 * activity onto a fresh Settings stack — a tab jump, with Back landing on the
 * Settings root and Today left holding the finished builder. Create now hands
 * the builder's place to its result on the tab the user is on.
 */
import React from 'react';
import { Text } from 'react-native';
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProvider, useApp } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import { WatchBuilderScreen } from '../WatcherScreens';
import * as watcherEndpoints from '../../../api/endpoints/watchers';
import response from '../../../api/__fixtures__/watchers.created.json';

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

/** Walks Today → assistant → builder the way the rows do, then shows the builder. */
function Harness() {
  const { s, actions } = useApp();
  const opened = React.useRef(false);
  React.useEffect(() => {
    if (!opened.current) { opened.current = true; actions.go('contextualAssistant'); actions.go('watchBuilder'); }
  }, [actions]);
  return <>
    <WatchBuilderScreen />
    <Text testID="probe-nav">{JSON.stringify({ tab: s.nav.tab, today: s.nav.stacks.today.map(e => e.name), settings: s.nav.stacks.settings.map(e => e.name) })}</Text>
  </>;
}
const probe = () => JSON.parse(screen.getByTestId('probe-nav').props.children as string) as { tab: string; today: string[]; settings: string[] };

it('Create replaces the builder with background activity on the same tab', async () => {
  jest.spyOn(watcherEndpoints, 'createReadinessWatcher').mockResolvedValue(response as never);
  await render(
    <SafeAreaProvider initialMetrics={metrics}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}>
            <Harness />
          </QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(probe().today).toEqual(['contextualAssistant', 'watchBuilder']));
  await fireEvent.press(screen.getByTestId('watch-create'));
  await waitFor(() => expect(probe()).toEqual({ tab: 'today', today: ['contextualAssistant', 'backgroundActivity'], settings: [] }));
});
