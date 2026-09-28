/**
 * The energy screen against the route's real answers.
 *
 * On the first device run «طاقتك» always said «مش قادرين نوصل الجاهزية»: the
 * route answered a new account with `freshness: 'missing'` and every snapshot
 * with `version: 'v1'`, the client schema expected `'none'` and a number, and
 * a hand-written fixture agreed with the schema instead of the server. So this
 * drives the screen through the real `apiRequest` and the shipped schema, with
 * the fixtures `exportMobileApiFixtures.test.ts` records from the route.
 */
import React from 'react';
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import { ReadinessSettingsScreen } from '../ReadinessSettingsScreen';
import missing from '../../../api/__fixtures__/readiness.missing.json';
import saved from '../../../api/__fixtures__/readiness.saved.json';
import current from '../../../api/__fixtures__/readiness.current.json';

const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const user = { uid: 'readiness-user', email: null, emailVerified: true, displayName: null, providerIds: ['password'] };
let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;
let checkedIn: boolean;
let puts: Record<string, unknown>[];

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: user });
  setAuthRepository(repository);
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://localhost:3000';
  checkedIn = false;
  puts = [];
  (globalThis as { fetch: unknown }).fetch = jest.fn(async (_url: string, init: { method?: string; body?: string }) => {
    let body: unknown = checkedIn ? current : missing;
    if (init?.method === 'PUT') {
      puts.push(JSON.parse(init.body ?? '{}') as Record<string, unknown>);
      checkedIn = true;
      body = saved;
    }
    return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  }) as never;
});

afterEach(() => {
  cleanup();
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
            <ReadinessSettingsScreen onBack={() => undefined} />
          </QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
}

it('reads a new account as "no check-in yet", not as unreachable', async () => {
  await show();
  await waitFor(() => expect(screen.getByTestId('readiness-no-check-in')).toBeTruthy());
  expect(screen.queryByTestId('readiness-unavailable')).toBeNull();
  for (const energy of [1, 2, 3, 4, 5]) {
    expect(screen.getByTestId(`readiness-energy-${energy}`).props.accessibilityState?.selected).toBe(false);
  }
});

it('shows the tapped energy as selected once the check-in is saved', async () => {
  await show();
  await waitFor(() => expect(screen.getByTestId('readiness-no-check-in')).toBeTruthy());

  await fireEvent.press(screen.getByTestId('readiness-energy-4'));

  await waitFor(() => expect(screen.getByTestId('readiness-energy-4').props.accessibilityState?.selected).toBe(true));
  expect(puts).toHaveLength(1);
  expect(puts[0]!.energy).toBe(4);
  expect(screen.queryByTestId('readiness-unavailable')).toBeNull();
  expect(screen.queryByTestId('readiness-save-failed')).toBeNull();
  expect(screen.getByTestId('readiness-band')).toBeTruthy();
  expect(screen.getByTestId('readiness-energy-3').props.accessibilityState?.selected).toBe(false);
});
