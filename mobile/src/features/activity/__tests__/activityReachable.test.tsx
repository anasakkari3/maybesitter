/**
 * Activity, from somewhere a user can actually get to (UC-3.15, #201).
 *
 * ── Why this renders `Root` ──────────────────────────────────────
 *
 * The screen, the hooks, the schemas and the projection can all be green while
 * nothing outside `src/features/activity/` imports any of them — which is
 * exactly the state UC-2.R2's capture flow was found in, with every unit test
 * passing. So this starts where the user does: the Settings tab, then the row.
 * If the row or the `Root` case comes undone, this goes red and no test of the
 * screen in isolation can.
 *
 * It also pins *where* the entry point is. #201 describes a tab; the tab bar is
 * Today · Calendar · Say it · Settings and what belongs in it is a design
 * decision this issue does not own, so Activity is a Settings sub-screen. A
 * later change that moves it has to change this test on purpose.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import { Root } from '../../../Root';
import en from '../../../i18n/locales/en.json';
import * as activityEndpoints from '../../../api/endpoints/activity';
import * as commitmentEndpoints from '../../../api/endpoints/commitments';
import * as trustEndpoints from '../../../api/endpoints/trust';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const USER: AuthUser = {
  uid: 'activity-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

beforeEach(() => {
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  // Today renders behind the tab bar and is not what this is about; an
  // unmocked call would be a network error inside the tree.
  jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [] } as never);
  jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] } as never);
  jest.spyOn(trustEndpoints, 'getTrust')
    .mockResolvedValue({ success: true, participantId: USER.uid, trust: { analyticsConsent: false } } as never);
  jest.spyOn(activityEndpoints, 'listActivity')
    .mockResolvedValue({ items: [], nextCursor: null } as never);
  jest.spyOn(activityEndpoints, 'getWeeklySummary').mockResolvedValue({
    weekStart: '2026-09-13', completedCount: 0, plannedDaysCount: 0, keptCount: 0, moments: [],
  } as never);
});

afterEach(() => {
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

describe('Activity is reachable', () => {
  it('opens from the Settings row and asks the server for the history', async () => {
    await openApp();

    // No fifth tab: the row does not exist until Settings is open.
    expect(screen.queryByLabelText(en.activityTitle)).toBeNull();

    await fireEvent.press(screen.getByLabelText(en.tabSettings));
    await waitFor(() => expect(screen.queryByTestId('settings-activity')).not.toBeNull());

    await fireEvent.press(screen.getByLabelText(en.activityTitle));
    await waitFor(() => expect(screen.queryByTestId('activity-list')).not.toBeNull());

    // The real hooks, not a seeded list: both endpoints were called, and the
    // empty state is the server's answer rather than the design's sample week.
    expect(activityEndpoints.listActivity).toHaveBeenCalled();
    expect(activityEndpoints.getWeeklySummary).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId('activity-empty')).not.toBeNull());
    expect(screen.queryByTestId('activity-week-quiet')).not.toBeNull();
  });

  it('is a Settings sub-screen, so the tab bar stays four tabs', async () => {
    await openApp();
    for (const tab of [en.tabToday, en.tabCalendar, en.tabCapture, en.tabSettings]) {
      expect(screen.queryAllByLabelText(tab).length).toBeGreaterThan(0);
    }
    // #201 asks for a tab. The tab bar is a design decision this issue does not
    // own, so the entry point is a Settings row and the bar is left alone.
    expect(screen.queryByLabelText(en.activityTitle)).toBeNull();
  });

  it('goes back to Settings rather than stranding the user', async () => {
    await openApp();
    await fireEvent.press(screen.getByLabelText(en.tabSettings));
    await waitFor(() => expect(screen.queryByTestId('settings-activity')).not.toBeNull());
    await fireEvent.press(screen.getByLabelText(en.activityTitle));
    await waitFor(() => expect(screen.queryByTestId('activity-list')).not.toBeNull());

    await fireEvent.press(screen.getByLabelText(en.settingsBack));
    await waitFor(() => expect(screen.queryByTestId('settings-activity')).not.toBeNull());
  });
});
