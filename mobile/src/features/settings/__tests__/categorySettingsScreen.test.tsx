/**
 * Settings → Categories (#415).
 *
 * The screen has two controls and they are deliberately separate: whether the
 * lists are split, and which categories exist at all. Somebody can narrow the
 * catalog to the two parts of their life without ever turning the filter bar
 * on, and the app will quietly sort into those two from then on — so the day
 * they do turn it on, their history is already filed.
 *
 * Both writes go through `ServerToggle`'s rule: nothing moves until the server
 * agrees. A switch that flipped optimistically would tell the user their
 * captures are being sorted a particular way before anything had agreed to it.
 *
 * The last case is the one worth the most: turning every category off is
 * allowed, and the screen says what it means rather than refusing or silently
 * re-enabling one. It is a real answer — "do not sort my commitments" — and
 * the product's whole position is that the user's answer stands.
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
import { CategorySettingsScreen } from '../CategorySettingsScreen';
import * as categoryEndpoints from '../../../api/endpoints/categories';
import type { CategoryPreferences } from '../../../api/schemas/categories';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const USER: AuthUser = {
  uid: 'category-settings-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

const ALL: CategoryPreferences['enabled'] = ['work', 'family', 'health', 'finance', 'social', 'errands'];

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

function answer(preferences: CategoryPreferences) {
  return { success: true as const, categoryPreferences: preferences };
}

beforeEach(() => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
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
            <CategorySettingsScreen onBack={() => {}} />
          </QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
}

describe('Settings → Categories', () => {
  it('shows the split off and every category available for an account that never chose', async () => {
    jest.spyOn(categoryEndpoints, 'getCategoryPreferences')
      .mockResolvedValue(answer({ enabled: ALL, grouping: false }));
    await show();

    await waitFor(() => expect(screen.getByTestId('category-split-toggle')).toBeTruthy());
    expect(screen.getByTestId('category-split-toggle').props.accessibilityState.checked).toBe(false);
    for (const category of ALL) {
      expect(screen.getByTestId(`category-toggle-${category}`).props.accessibilityState.checked).toBe(true);
    }
  });

  it('turning the split on sends the whole preference, not half of one', async () => {
    jest.spyOn(categoryEndpoints, 'getCategoryPreferences')
      .mockResolvedValue(answer({ enabled: ['work', 'family'], grouping: false }));
    const put = jest.spyOn(categoryEndpoints, 'putCategoryPreferences')
      .mockResolvedValue(answer({ enabled: ['work', 'family'], grouping: true }));
    await show();

    await waitFor(() => expect(screen.getByTestId('category-split-toggle')).toBeTruthy());
    await fireEvent(screen.getByTestId('category-split-toggle'), 'valueChange', true);

    await waitFor(() => expect(put).toHaveBeenCalledWith({ enabled: ['work', 'family'], grouping: true }));
  });

  it('turning a category off keeps the split setting it had', async () => {
    jest.spyOn(categoryEndpoints, 'getCategoryPreferences')
      .mockResolvedValue(answer({ enabled: ALL, grouping: true }));
    const put = jest.spyOn(categoryEndpoints, 'putCategoryPreferences')
      .mockResolvedValue(answer({ enabled: ALL.filter((c) => c !== 'finance'), grouping: true }));
    await show();

    await waitFor(() => expect(screen.getByTestId('category-toggle-finance')).toBeTruthy());
    await fireEvent(screen.getByTestId('category-toggle-finance'), 'valueChange', false);

    await waitFor(() => expect(put).toHaveBeenCalledWith({
      enabled: ['work', 'family', 'health', 'social', 'errands'],
      grouping: true,
    }));
  });

  it('a category is sent back in the catalog order however it was toggled', async () => {
    jest.spyOn(categoryEndpoints, 'getCategoryPreferences')
      .mockResolvedValue(answer({ enabled: ['errands'], grouping: false }));
    const put = jest.spyOn(categoryEndpoints, 'putCategoryPreferences')
      .mockResolvedValue(answer({ enabled: ['work', 'errands'], grouping: false }));
    await show();

    await waitFor(() => expect(screen.getByTestId('category-toggle-work')).toBeTruthy());
    await fireEvent(screen.getByTestId('category-toggle-work'), 'valueChange', true);

    await waitFor(() => expect(put).toHaveBeenCalledWith({ enabled: ['work', 'errands'], grouping: false }));
  });

  it('a switch does not move until the server has agreed', async () => {
    jest.spyOn(categoryEndpoints, 'getCategoryPreferences')
      .mockResolvedValue(answer({ enabled: ALL, grouping: false }));
    jest.spyOn(categoryEndpoints, 'putCategoryPreferences')
      .mockRejectedValue(new Error('offline'));
    await show();

    await waitFor(() => expect(screen.getByTestId('category-split-toggle')).toBeTruthy());
    await fireEvent(screen.getByTestId('category-split-toggle'), 'valueChange', true);

    await waitFor(() =>
      expect(screen.getByTestId('category-split-toggle').props.accessibilityState.checked).toBe(false),
    );
  });

  it('turning every category off is allowed and the screen says what it means', async () => {
    jest.spyOn(categoryEndpoints, 'getCategoryPreferences')
      .mockResolvedValue(answer({ enabled: [], grouping: true }));
    await show();

    await waitFor(() => expect(screen.getByText(en.catSettingsNone)).toBeTruthy());
    for (const category of ALL) {
      expect(screen.getByTestId(`category-toggle-${category}`).props.accessibilityState.checked).toBe(false);
    }
  });
});
