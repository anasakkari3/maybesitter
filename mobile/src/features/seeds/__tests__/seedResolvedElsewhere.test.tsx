/**
 * A seed settled on another device (CA5.5).
 *
 * «حوّله لمهمة» on a seed dismissed or promoted elsewhere answers 409
 * `seed_resolved`. The card used to say only «ما زبطت. جرّب كمان مرّة.» and
 * stay, because the list was re-read on success only — every retry failed the
 * same way (3 of 3 on the simulator). The route's 409 exists "so the app can
 * say this one is gone": the list is re-read, the card leaves, and a toast
 * says why.
 */
import React from 'react';
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Text } from 'react-native';
import { AppProvider, useApp } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import { ConflictError } from '../../../api/errors';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';
import * as language from '../../../i18n/language';
import en from '../../../i18n/locales/en.json';
import * as seedEndpoints from '../../../api/endpoints/seeds';
import type { Seed } from '../../../api/schemas/seeds';
import { SeedsScreen } from '../SeedsScreen';

const METRICS: Metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const USER = { uid: 'seed-elsewhere', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'] };
const SEED: Seed = {
  version: 'intent-seed-v1', seedId: 'seed-1', scopeId: USER.uid, kind: 'idea', summary: 'Lose five kilos',
  status: 'open', revisitAt: null, source: 'capture', sourceRef: 'proposal-1',
  provenance: { proposalId: 'proposal-1', extractor: 'rule-based', confirmedByUserAt: '2026-09-20T09:00:00.000Z' },
  promotedTo: null, createdAt: '2026-09-20T09:00:00.000Z', updatedAt: '2026-09-20T09:00:00.000Z',
} as Seed;

let client: QueryClient;

function ToastProbe() {
  const { s } = useApp();
  return <Text testID="probe-toast">{s.toast?.text ?? ''}</Text>;
}

beforeEach(async () => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  setAuthRepository(createFakeAuthRepository({ initialUser: USER }));
  jest.spyOn(language, 'systemLanguageTag').mockReturnValue('en-US');
  await AsyncStorage.removeItem(LANGUAGE_STORAGE_KEY);
  jest.spyOn(seedEndpoints, 'listSeeds')
    .mockResolvedValueOnce({ items: [SEED] } as never)
    .mockResolvedValue({ items: [] } as never);
  jest.spyOn(seedEndpoints, 'promoteSeed').mockRejectedValue(new ConflictError('seed_resolved') as never);
});

afterEach(async () => {
  await cleanup();
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

it('re-reads the list, drops the card and says it was settled elsewhere', async () => {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={createFakeAuthRepository({ initialUser: USER })} isDevBundle={false}>
          <QueryClientProvider client={client}><SeedsScreen onBack={() => {}} /><ToastProbe /></QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryByTestId('seed-to-task-seed-1')).not.toBeNull());
  await act(async () => { await fireEvent.press(screen.getByTestId('seed-to-task-seed-1')); });

  await waitFor(() => expect(screen.queryByTestId('seed-seed-1')).toBeNull());
  expect(screen.getByTestId('probe-toast').props.children).toBe(en.seedResolvedElsewhere);
});

// QA v3 V3-F24-05: «حوّله لمهمة» made the idea vanish with no word about where it went.
it.each([
  ['seed-to-task-seed-1', 'commitment', 'seedPromotedToTask'],
  ['seed-to-goal-seed-1', 'goal', 'seedPromotedToGoal'],
] as const)('%s says what the idea became once it leaves the list', async (button, kind, message) => {
  jest.mocked(seedEndpoints.promoteSeed).mockReset();
  jest.mocked(seedEndpoints.promoteSeed).mockResolvedValue({
    success: true, replayed: false, seed: { ...SEED, status: 'promoted', promotedTo: { kind, id: 'made-1' } },
  } as never);
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={createFakeAuthRepository({ initialUser: USER })} isDevBundle={false}>
          <QueryClientProvider client={client}><SeedsScreen onBack={() => {}} /><ToastProbe /></QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryByTestId(button)).not.toBeNull());
  await act(async () => { await fireEvent.press(screen.getByTestId(button)); });

  await waitFor(() => expect(screen.queryByTestId('seed-seed-1')).toBeNull());
  const expected = (en as Record<string, string>)[message];
  expect(expected).toBeTruthy();
  expect(screen.getByTestId('probe-toast').props.children).toBe(expected);
});
