/**
 * Two screens that landed in parallel, both reachable from Settings on the
 * merged `Root` (UC-3.R1 #203 and UC-3.4 #188).
 *
 * The widget settings screen and the calendar links screen were added by two
 * lanes editing the same screen switch, the same `Screen` union and the same
 * locale files. A merge that kept one side's case and dropped the other's
 * compiles, and every screen-level test still passes, because those tests
 * render the screen directly. This walks the real navigation instead: the
 * Settings tab, the row, the screen — for both, in one app.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppProvider } from '../state/AppContext';
import { AuthProvider } from '../auth/AuthProvider';
import { createFakeAuthRepository } from '../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../api/auth';
import type { AuthUser } from '../auth/types';
import { Root } from '../Root';
import en from '../i18n/locales/en.json';
import * as commitmentEndpoints from '../api/endpoints/commitments';
import * as nextStepEndpoints from '../api/endpoints/nextStep';
import * as trustEndpoints from '../api/endpoints/trust';
import * as categoryEndpoints from '../api/endpoints/categories';
import * as calendarEndpoints from '../api/endpoints/calendar';
import * as feedEndpoints from '../api/endpoints/icsFeeds';
import * as readinessEndpoints from '../api/endpoints/readiness';
import { deviceCalendar } from '../features/calendar/deviceCalendar';
import { resetWidgetSettingsForTests } from '../lib/deviceSettings/widget';
import nextStepFixture from '../api/__fixtures__/nextStep.recommendation.json';

jest.mock('../features/widget/widgetBridge', () => ({
  createNativeWidgetBridge: () => ({ write: async () => undefined, clear: async () => undefined }),
}));

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const USER: AuthUser = {
  uid: 'reach-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};
const originalFlag = process.env.EXPO_PUBLIC_FEATURE_ICS_FEEDS;

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

beforeEach(async () => {
  resetWidgetSettingsForTests();
  await AsyncStorage.clear();
  onlineManager.setOnline(true);
  process.env.EXPO_PUBLIC_FEATURE_ICS_FEEDS = 'true';
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [] } as never);
  jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] } as never);
  jest.spyOn(nextStepEndpoints, 'getNextStep').mockResolvedValue(nextStepFixture as never);
  jest.spyOn(trustEndpoints, 'getTrust').mockResolvedValue({
    success: true, participantId: USER.uid, trust: { analyticsConsent: false, calendarConsent: true },
  } as never);
  jest.spyOn(categoryEndpoints, 'getCategoryPreferences')
    .mockResolvedValue({ success: true, categoryPreferences: { enabled: [], grouping: false } } as never);
  jest.spyOn(calendarEndpoints, 'getCalendarSettings')
    .mockResolvedValue({ success: true, calendarSettings: { writeTarget: 'off', updatedAt: null } } as never);
  jest.spyOn(readinessEndpoints, 'getReadiness').mockResolvedValue({
    readiness: {
      version: 1,
      schemaVersion: 'readiness-v1',
      scopeId: USER.uid,
      computedAt: '2026-09-17T06:30:00.000Z',
      windowStart: '2026-09-16T06:30:00.000Z',
      windowEnd: '2026-09-17T06:30:00.000Z',
      band: 'steady',
      score: 0.64,
      normalizedSignals: {},
      subjective: { energy: 4, observedAt: '2026-09-17T06:25:00.000Z' },
      derived: { readinessBand: 'steady', confidence: 0.8 },
      signals: [],
      sourceKinds: ['subjective'],
      missingSourceKinds: ['healthkit', 'health_connect', 'whoop'],
    },
    selectedSource: 'current_subjective',
    freshness: 'fresh',
  } as never);
  jest.spyOn(deviceCalendar, 'getAccess').mockResolvedValue('undetermined' as never);
  jest.spyOn(deviceCalendar, 'listWritableCalendars').mockResolvedValue([]);
  jest.spyOn(feedEndpoints, 'listIcsFeeds').mockResolvedValue({ success: true, feeds: [], deadlines: [] } as never);
});

afterEach(async () => {
  cleanup();
  await new Promise(resolve => setTimeout(resolve, 0));
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
  if (originalFlag === undefined) delete process.env.EXPO_PUBLIC_FEATURE_ICS_FEEDS;
  else process.env.EXPO_PUBLIC_FEATURE_ICS_FEEDS = originalFlag;
});

async function openApp() {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}>
            <Root />
          </QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryByTestId('tab-capture')).not.toBeNull());
}

async function openSettings() {
  await fireEvent.press(screen.getByLabelText(en.tabSettings));
  await waitFor(() => expect(screen.queryByTestId('settings-widget')).not.toBeNull());
}

describe('from Settings, on the merged Root', () => {
  it('reaches the widget settings screen', async () => {
    await openApp();
    await openSettings();
    await fireEvent.press(screen.getByTestId('settings-widget'));
    await waitFor(() => expect(screen.queryByTestId('widget-titles-toggle')).not.toBeNull());
  });

  it('reaches the calendar links screen through Settings → Calendar', async () => {
    await openApp();
    await openSettings();
    await fireEvent.press(screen.getByTestId('settings-calendar'));
    await waitFor(() => expect(screen.queryByTestId('calendar-feeds-entry')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('calendar-feeds-entry'));
    await waitFor(() => expect(screen.queryByTestId('ics-url-input')).not.toBeNull());
    expect(screen.queryByText(en.icsFeedsTitle)).not.toBeNull();
  });

  it('reaches the readiness settings screen', async () => {
    await openApp();
    await openSettings();
    await fireEvent.press(screen.getByTestId('settings-readiness'));
    await waitFor(() => expect(screen.queryByTestId('readiness-band')).not.toBeNull());
    expect(screen.queryByText(en.readinessTitle)).not.toBeNull();
  });

  it('has no calendar links row when the build flag is off, and the widget row is still there', async () => {
    delete process.env.EXPO_PUBLIC_FEATURE_ICS_FEEDS;
    await openApp();
    await openSettings();
    await fireEvent.press(screen.getByTestId('settings-calendar'));
    await waitFor(() => expect(screen.queryByTestId('calendar-disconnect')).not.toBeNull());
    expect(screen.queryByTestId('calendar-feeds-entry')).toBeNull();
  });
});
