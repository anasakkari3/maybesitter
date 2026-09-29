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
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { cleanup, render, renderHook, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import * as footballEndpoints from '../../../api/endpoints/football';
import * as feedEndpoints from '../../../api/endpoints/icsFeeds';
import { IcsFeedRefusedError } from '../../../api/errors';
import footballOff from '../../../api/__fixtures__/football.settings.json';
import footballOn from '../../../api/__fixtures__/football.settings.configured.json';
import { SourcesScreen } from '../SourcesScreen';
import { useSourcesAvailability } from '../sourcesAvailability';

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

function Providers({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider repository={repository} isDevBundle={false}>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </AuthProvider>
  );
}

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

/**
 * Calendar links, the same rule (owner's Redmi, 2026-09-29): a build with the
 * feature against a server without it (`ICS_FEEDS_ENABLED` unset) offered a
 * row whose screen only said «not available». The server's `feature_disabled`
 * now hides the row; a server that answers keeps it.
 */
describe('calendar links', () => {
  const original = process.env.EXPO_PUBLIC_FEATURE_ICS_FEEDS;
  beforeEach(() => {
    process.env.EXPO_PUBLIC_FEATURE_ICS_FEEDS = 'true';
    jest.spyOn(footballEndpoints, 'getFootballSettings').mockResolvedValue(footballOff as never);
  });
  afterEach(() => {
    if (original === undefined) delete process.env.EXPO_PUBLIC_FEATURE_ICS_FEEDS;
    else process.env.EXPO_PUBLIC_FEATURE_ICS_FEEDS = original;
  });

  it('are hidden when the server has them switched off', async () => {
    const list = jest.spyOn(feedEndpoints, 'listIcsFeeds').mockRejectedValue(new IcsFeedRefusedError('feature_disabled', null));
    await show();
    await waitFor(() => expect(list).toHaveBeenCalled());
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(screen.queryByTestId('sources-calendar-links')).toBeNull();
  });

  it('are offered when the server answers', async () => {
    jest.spyOn(feedEndpoints, 'listIcsFeeds').mockResolvedValue({ success: true, feeds: [], deadlines: [] } as never);
    await show();
    expect(await screen.findByTestId('sources-calendar-links')).toBeTruthy();
  });

  it('say nothing in Settings when neither source is there', async () => {
    jest.spyOn(feedEndpoints, 'listIcsFeeds').mockRejectedValue(new IcsFeedRefusedError('feature_disabled', null));
    const { result } = await renderHook(() => useSourcesAvailability(), { wrapper: Providers });
    await waitFor(() => expect(feedEndpoints.listIcsFeeds).toHaveBeenCalled());
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(result.current).toEqual({ ics: false, football: false, any: false });
  });
});
