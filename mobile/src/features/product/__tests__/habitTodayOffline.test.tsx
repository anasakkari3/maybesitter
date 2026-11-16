/**
 * A «تمّت» / «مش اليوم» press that fails offline is said exactly once (lane
 * B4 review): in place, on the habit's card, and never again by the toast
 * bridge. The decide mutation is the real one, on a real query client.
 */
import React from 'react';
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider, useApp } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import { createAppQueryClient } from '../../../api/queryClient';
import { NetworkError } from '../../../api/errors';
import { MutationFailureToasts, UNHANDLED_FAILURE_DELAY_MS } from '../../../api/ui/MutationFailureToasts';
import * as habitEndpoints from '../../../api/endpoints/habits';
import en from '../../../i18n/locales/en.json';
import { HabitDetailScreen } from '../ControlScreens';

jest.mock('../../capture/useCaptureKinds', () => ({ useCaptureKinds: () => ({ pending: false, entries: [] }) }));

const METRICS: Metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const USER = { uid: 'habit-offline-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'] };
const HABIT = {
  habitId: 'h1', title: 'Walk', cadence: { kind: 'weekdays', weekdays: [0, 1, 2, 3, 4, 5, 6] }, durationMinutes: 30,
  preferredWindows: [], minimumOccurrences: 7, maximumOccurrences: 7, flexibility: 'flexible', recoveryPolicy: 'skip',
  status: 'active', source: 'user_created',
  confirmation: { confirmedByUserAt: '2026-11-01T09:00:00.000Z', sourceRef: null, acceptedSuggestedValues: true },
  createdAt: '2026-11-01T09:00:00.000Z', updatedAt: '2026-11-01T09:00:00.000Z',
};
const TODAY = { localDate: '2026-11-15', occurrences: [{ occurrenceId: 'h1.2026-11-15.0', habitId: 'h1', localDate: '2026-11-15', ordinal: 0, state: 'pending', durationMinutes: 30, recoveredFromOccurrenceId: null }] };

let client: ReturnType<typeof createAppQueryClient>;
let toasts: string[];

function ToastLog() {
  const { s } = useApp();
  React.useEffect(() => { if (s.toast) toasts.push(s.toast.text); }, [s.toast]);
  return null;
}

beforeEach(() => {
  onlineManager.setOnline(true);
  client = createAppQueryClient();
  setAuthRepository(createFakeAuthRepository({ initialUser: USER }));
  toasts = [];
  jest.spyOn(habitEndpoints, 'listHabits').mockResolvedValue([HABIT] as never);
  jest.spyOn(habitEndpoints, 'listHabitsToday').mockResolvedValue(TODAY as never);
  jest.spyOn(habitEndpoints, 'decideHabitOccurrence').mockRejectedValue(new NetworkError('offline'));
});

afterEach(() => {
  onlineManager.setOnline(true);
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

it('a failed press is said once, on the card, and the bridge stays quiet', async () => {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={createFakeAuthRepository({ initialUser: USER })} isDevBundle={false}>
          <QueryClientProvider client={client}><HabitDetailScreen /><MutationFailureToasts /><ToastLog /></QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryByTestId('habit-today-done-h1')).not.toBeNull());
  await act(async () => { onlineManager.setOnline(false); });
  await act(async () => { await fireEvent.press(screen.getByTestId('habit-today-done-h1')); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, UNHANDLED_FAILURE_DELAY_MS + 100)); });
  expect(screen.getAllByText(en.errorsNetwork)).toHaveLength(1);
  expect(toasts).toEqual([]);
});
