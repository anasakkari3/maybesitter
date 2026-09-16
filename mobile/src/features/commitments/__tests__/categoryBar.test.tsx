/**
 * The filter bar on Today (#415).
 *
 * Two promises are asserted here and they are the ones the feature was
 * accepted on:
 *
 *  1. **Off by default.** A user who has never opened the categories screen
 *     sees no bar at all — not an empty bar, not a bar with only "All". Their
 *     app is the app they had yesterday. This is the first case and it is the
 *     one that would be easiest to break by rendering the bar and hiding its
 *     chips.
 *  2. **A filter narrows, it does not hide.** Tapping "Work" leaves the work
 *     commitments and removes the others; tapping "All" brings them back. An
 *     uncategorised commitment is reachable throughout, under "All".
 *
 * `RNTL v14 render() is async` — every `render` and every `fireEvent` is
 * awaited, because an un-awaited event leaves React work in flight and the
 * next render mounts nothing.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import en from '../../../i18n/locales/en.json';
import { TodayScreen } from '../../../screens/TodayScreen';
import * as commitmentEndpoints from '../../../api/endpoints/commitments';
import * as categoryEndpoints from '../../../api/endpoints/categories';
import type { Commitment } from '../../../api/schemas/common';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const USER: AuthUser = {
  uid: 'category-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

function commitment(id: string, title: string, category: Commitment['category']): Commitment {
  return {
    id,
    kind: 'task',
    title,
    description: null,
    person: null,
    status: 'active',
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureLevel: 'none' },
    category,
    categorySource: 'inferred',
    timeSpec: {
      kind: 'due_by',
      dueAt: '2030-01-01T12:00:00.000Z',
      endAt: null,
      remindAt: null,
      allDay: false,
      timezone: 'UTC',
    },
    currentAckState: 'not_seen',
    postponedUntil: null,
    createdAt: '2026-09-01T09:00:00.000Z',
    updatedAt: '2026-09-01T09:00:00.000Z',
    confirmedAt: '2026-09-01T09:00:00.000Z',
    completedAt: null,
    droppedAt: null,
  };
}

const ITEMS = [
  commitment('a', 'Send the invoice', 'work'),
  commitment('b', 'Call the school', 'family'),
  commitment('c', 'Finish the thing', null),
];

function preferences(grouping: boolean, enabled: Commitment['category'][] = ['work', 'family']) {
  return {
    success: true as const,
    categoryPreferences: { enabled: enabled.filter(Boolean) as NonNullable<Commitment['category']>[], grouping },
  };
}

beforeEach(() => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: ITEMS });
  jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] });
});

afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
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
            <TodayScreen />
          </QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
}

describe('the category filter bar', () => {
  it('is absent for a user who has never turned it on', async () => {
    jest.spyOn(categoryEndpoints, 'getCategoryPreferences').mockResolvedValue(preferences(false));
    await show();

    await waitFor(() => expect(screen.getByText('Send the invoice')).toBeTruthy());
    expect(screen.queryByTestId('category-bar')).toBeNull();
    // Every commitment is there, exactly as it was before the feature existed.
    expect(screen.getByText('Call the school')).toBeTruthy();
    expect(screen.getByText('Finish the thing')).toBeTruthy();
  });

  it('appears once the user turns it on, with All selected', async () => {
    jest.spyOn(categoryEndpoints, 'getCategoryPreferences').mockResolvedValue(preferences(true));
    await show();

    await waitFor(() => expect(screen.getByTestId('category-bar')).toBeTruthy());
    expect(screen.getByTestId('category-chip-all')).toBeTruthy();
    expect(screen.getByTestId('category-chip-work')).toBeTruthy();
    expect(screen.getByTestId('category-chip-family')).toBeTruthy();
    // Nothing on this list is health, so no health chip — a chip that filters
    // to an empty screen is a chip that should not be there.
    expect(screen.queryByTestId('category-chip-health')).toBeNull();
  });

  it('narrows the list to one category and back again', async () => {
    jest.spyOn(categoryEndpoints, 'getCategoryPreferences').mockResolvedValue(preferences(true));
    await show();

    await waitFor(() => expect(screen.getByTestId('category-chip-work')).toBeTruthy());

    await fireEvent.press(screen.getByTestId('category-chip-work'));
    await waitFor(() => expect(screen.queryByText('Call the school')).toBeNull());
    expect(screen.getByText('Send the invoice')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('category-chip-all'));
    await waitFor(() => expect(screen.getByText('Call the school')).toBeTruthy());
  });

  it('an uncategorised commitment is reachable under All and hidden by a filter', async () => {
    jest.spyOn(categoryEndpoints, 'getCategoryPreferences').mockResolvedValue(preferences(true));
    await show();

    await waitFor(() => expect(screen.getByText('Finish the thing')).toBeTruthy());

    await fireEvent.press(screen.getByTestId('category-chip-work'));
    await waitFor(() => expect(screen.queryByText('Finish the thing')).toBeNull());

    await fireEvent.press(screen.getByTestId('category-chip-all'));
    await waitFor(() => expect(screen.getByText('Finish the thing')).toBeTruthy());
  });

  it('a preference that fails to load leaves the ordinary one-list screen', async () => {
    jest.spyOn(categoryEndpoints, 'getCategoryPreferences').mockRejectedValue(new Error('offline'));
    await show();

    await waitFor(() => expect(screen.getByText('Send the invoice')).toBeTruthy());
    expect(screen.queryByTestId('category-bar')).toBeNull();
    expect(screen.getByText('Call the school')).toBeTruthy();
  });

  it('names the chips in the user language rather than in category codes', async () => {
    jest.spyOn(categoryEndpoints, 'getCategoryPreferences').mockResolvedValue(preferences(true));
    await show();

    await waitFor(() => expect(screen.getByTestId('category-bar')).toBeTruthy());
    expect(screen.getByText(en.catAll)).toBeTruthy();
    expect(screen.getByText(en.catWork)).toBeTruthy();
  });
});
