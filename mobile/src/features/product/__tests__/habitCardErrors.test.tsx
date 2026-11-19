/**
 * The habits page (A5).
 *
 * CA5.8: a failed pause or delete is said under the habit it was for. One
 * shared error used to be drawn inside every habit section, so a 404 on one
 * habit printed «هاد ما عاد موجود.» under habits nobody touched (seen 4×).
 *
 * CA5.9: the page lists the habits «أشيائي» counts. An archived habit was
 * counted out on the hub (3) but drawn here (4), with a disabled toggle.
 */
import React from 'react';
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClientProvider } from '@tanstack/react-query';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import { createAppQueryClient } from '../../../api/queryClient';
import { NotFoundError } from '../../../api/errors';
import * as habitEndpoints from '../../../api/endpoints/habits';
import { HabitDetailScreen } from '../ControlScreens';

jest.mock('../../capture/useCaptureKinds', () => ({ useCaptureKinds: () => ({ pending: false, entries: [] }) }));

const METRICS: Metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const USER = { uid: 'habit-card-errors', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'] };
const habit = (habitId: string, title: string, status: 'active' | 'paused' | 'archived') => ({
  habitId, title, cadence: { kind: 'weekdays', weekdays: [0, 1, 2, 3, 4, 5, 6] }, durationMinutes: 30,
  preferredWindows: [], minimumOccurrences: 7, maximumOccurrences: 7, flexibility: 'flexible', recoveryPolicy: 'skip',
  status, source: 'user_created',
  confirmation: { confirmedByUserAt: '2026-11-01T09:00:00.000Z', sourceRef: null, acceptedSuggestedValues: true },
  createdAt: '2026-11-01T09:00:00.000Z', updatedAt: '2026-11-01T09:00:00.000Z',
});

let client: ReturnType<typeof createAppQueryClient>;

beforeEach(() => {
  client = createAppQueryClient();
  setAuthRepository(createFakeAuthRepository({ initialUser: USER }));
  jest.spyOn(habitEndpoints, 'listHabits').mockResolvedValue([
    habit('h1', 'Walk', 'active'), habit('h2', 'Read', 'active'), habit('h3', 'Meditate', 'archived'),
  ] as never);
  jest.spyOn(habitEndpoints, 'listHabitsToday').mockResolvedValue({ localDate: '2026-11-15', occurrences: [] } as never);
  jest.spyOn(habitEndpoints, 'setHabitStatus').mockRejectedValue(new NotFoundError('not_found'));
});

afterEach(() => {
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

async function renderPage() {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={createFakeAuthRepository({ initialUser: USER })} isDevBundle={false}>
          <QueryClientProvider client={client}><HabitDetailScreen /></QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryByTestId('habit-toggle-h1')).not.toBeNull());
}

it('says a failed pause under that habit only (CA5.8)', async () => {
  await renderPage();
  await act(async () => { await fireEvent.press(screen.getByTestId('habit-toggle-h1')); });
  await waitFor(() => expect(screen.queryByTestId('habit-error-h1')).not.toBeNull());
  expect(screen.queryByTestId('habit-error-h2')).toBeNull();
});

it('lists the habits the hub counts: an archived one is not drawn (CA5.9)', async () => {
  await renderPage();
  expect(screen.queryByTestId('habit-toggle-h2')).not.toBeNull();
  expect(screen.queryByTestId('habit-toggle-h3')).toBeNull();
  expect(within(screen.getByTestId('habit-toggle-h1')).queryByText(/./)).not.toBeNull();
});
