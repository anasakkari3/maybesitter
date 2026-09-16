/**
 * Categories, from somewhere a user can actually get to (#415).
 *
 * The screen, the hooks, the schema and the filter bar can all be green while
 * nothing outside their own folders imports any of them — the state UC-2.R2's
 * capture flow was found in, with every unit test passing. So this starts where
 * the user does: the Settings tab, then the row, then the switch. If the row or
 * the `Root` case comes undone this goes red, and no test of the screen in
 * isolation can.
 *
 * The second case is the promise the whole feature rests on and it is checked
 * from the outside: open the app cold, as a user who has never touched the
 * categories screen, and Today has no filter bar on it.
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
import { Root } from '../../../Root';
import en from '../../../i18n/locales/en.json';
import * as categoryEndpoints from '../../../api/endpoints/categories';
import * as commitmentEndpoints from '../../../api/endpoints/commitments';
import * as trustEndpoints from '../../../api/endpoints/trust';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const USER: AuthUser = {
  uid: 'category-reachable-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

const ALL = ['work', 'family', 'health', 'finance', 'social', 'errands'] as const;

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

beforeEach(() => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [] } as never);
  jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] } as never);
  jest.spyOn(trustEndpoints, 'getTrust')
    .mockResolvedValue({ success: true, participantId: USER.uid, trust: { analyticsConsent: false } } as never);
  jest.spyOn(categoryEndpoints, 'getCategoryPreferences')
    .mockResolvedValue({ success: true, categoryPreferences: { enabled: [...ALL], grouping: false } } as never);
  jest.spyOn(categoryEndpoints, 'putCategoryPreferences')
    .mockResolvedValue({ success: true, categoryPreferences: { enabled: [...ALL], grouping: true } } as never);
});

afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

async function openApp() {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}><Root /></QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryByTestId('tab-capture')).not.toBeNull());
}

describe('Categories is reachable', () => {
  it('opens from the Settings row and can turn the split on', async () => {
    await openApp();

    await fireEvent.press(screen.getByLabelText(en.tabSettings));
    await waitFor(() => expect(screen.queryByTestId('settings-categories')).not.toBeNull());

    await fireEvent.press(screen.getByLabelText(en.settingsCategories));
    await waitFor(() => expect(screen.queryByTestId('category-split-toggle')).not.toBeNull());

    await fireEvent(screen.getByTestId('category-split-toggle'), 'valueChange', true);
    await waitFor(() =>
      expect(categoryEndpoints.putCategoryPreferences)
        .toHaveBeenCalledWith({ enabled: [...ALL], grouping: true }),
    );
  });

  it('leaves Today without a filter bar for a user who has never turned it on', async () => {
    await openApp();
    await waitFor(() => expect(categoryEndpoints.getCategoryPreferences).toHaveBeenCalled());
    expect(screen.queryByTestId('category-bar')).toBeNull();
  });

  it('is a Settings sub-screen, so the tab bar stays four tabs', async () => {
    await openApp();
    for (const tab of [en.tabToday, en.tabCalendar, en.tabCapture, en.tabSettings]) {
      expect(screen.queryAllByLabelText(tab).length).toBeGreaterThan(0);
    }
    expect(screen.queryByLabelText(en.settingsCategories)).toBeNull();
  });

  it('goes back to Settings rather than stranding the user', async () => {
    await openApp();
    await fireEvent.press(screen.getByLabelText(en.tabSettings));
    await waitFor(() => expect(screen.queryByTestId('settings-categories')).not.toBeNull());
    await fireEvent.press(screen.getByLabelText(en.settingsCategories));
    await waitFor(() => expect(screen.queryByTestId('category-split-toggle')).not.toBeNull());

    await fireEvent.press(screen.getByLabelText(en.settingsBack));
    await waitFor(() => expect(screen.queryByTestId('settings-categories')).not.toBeNull());
  });
});
