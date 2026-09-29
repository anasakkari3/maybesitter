/**
 * «الثابت الأسبوعي» is reachable the way a person reaches it: the Settings
 * tab, the row beside «روتينك», the screen — on the real `Root`.
 */
import React from 'react';
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import { Root } from '../../../Root';
import * as commitmentEndpoints from '../../../api/endpoints/commitments';
import * as trustEndpoints from '../../../api/endpoints/trust';
import * as endpoints from '../../../api/endpoints/weeklyBlocks';

const METRICS: Metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const USER: AuthUser = { uid: 'weekly-reach-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'] };
let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

beforeEach(() => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [] } as never);
  jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] } as never);
  jest.spyOn(trustEndpoints, 'getTrust').mockResolvedValue({ success: true, participantId: USER.uid, trust: { analyticsConsent: false } } as never);
  jest.spyOn(endpoints, 'listWeeklyBlocks').mockResolvedValue([]);
  jest.spyOn(endpoints, 'listWeeklyBlockOccurrences').mockResolvedValue([]);
});

afterEach(() => { client.clear(); resetAuthForTests(); jest.restoreAllMocks(); });

it('opens from the Settings row and goes back to Settings', async () => {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}><Root /></QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryByTestId('tab-settings')).not.toBeNull());
  await fireEvent.press(screen.getByTestId('tab-settings'));
  await waitFor(() => expect(screen.queryByTestId('settings-weekly-blocks')).not.toBeNull());
  await fireEvent.press(screen.getByTestId('settings-weekly-blocks'));
  expect(await screen.findByTestId('weekly-blocks-empty')).toBeTruthy();
});
