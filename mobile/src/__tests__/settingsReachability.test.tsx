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
import { BackHandler, StyleSheet } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
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
import * as footballEndpoints from '../api/endpoints/football';
import footballOn from '../api/__fixtures__/football.settings.configured.json';
import footballOff from '../api/__fixtures__/football.settings.json';
import * as feedEndpoints from '../api/endpoints/icsFeeds';
import * as readinessEndpoints from '../api/endpoints/readiness';
import * as financialEndpoints from '../api/endpoints/financial';
import financialContextFixture from '../api/__fixtures__/financial.context.json';
import financialConnectedFixture from '../api/__fixtures__/financial.connected.json';
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
  jest.spyOn(financialEndpoints, 'getFinancialContext').mockResolvedValue(financialContextFixture as never);
  jest.spyOn(financialEndpoints, 'getFinancialConnection').mockResolvedValue(financialConnectedFixture as never);
  jest.spyOn(deviceCalendar, 'getAccess').mockResolvedValue('undetermined' as never);
  jest.spyOn(deviceCalendar, 'listWritableCalendars').mockResolvedValue([]);
  jest.spyOn(feedEndpoints, 'listIcsFeeds').mockResolvedValue({ success: true, feeds: [], deadlines: [] } as never);
  // A server holding the match data key; the test that needs none says so.
  jest.spyOn(footballEndpoints, 'getFootballSettings').mockResolvedValue(footballOn as never);
});

afterEach(async () => {
  await cleanup();
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
  await fireEvent.press(screen.getByTestId('open-settings'));
  await waitFor(() => expect(screen.queryByTestId('settings-category-day')).not.toBeNull());
}

async function openCategory(category: 'day' | 'connections' | 'alerts' | 'privacy' | 'app') {
  await fireEvent.press(screen.getByTestId(`settings-category-${category}`));
  await waitFor(() => expect(screen.queryByTestId(`settings-group-${category}`)).not.toBeNull());
}

describe('from Settings, on the merged Root', () => {
  it('opens with five short categories and keeps detailed options one level down', async () => {
    await openApp();
    await openSettings();
    for (const category of ['day', 'connections', 'alerts', 'privacy', 'app']) {
      expect(screen.queryByTestId(`settings-category-${category}`)).not.toBeNull();
    }
    for (const detail of ['settings-routine', 'settings-calendar', 'settings-widget', 'settings-knows', 'settings-account']) {
      expect(screen.queryByTestId(detail)).toBeNull();
    }
    expect(screen.queryByText(en.settingsRoutineSub)).toBeNull();
    await openCategory('day');
    expect(screen.queryByTestId('settings-routine')).not.toBeNull();
    expect(screen.queryByTestId('settings-financial')).not.toBeNull();
    await fireEvent.press(screen.getByLabelText(en.settingsBack));
    await waitFor(() => expect(screen.queryByTestId('settings-category-day')).not.toBeNull());
  });

  it('opens from the avatar without the bar or the pill, and back returns to the tab it came from', async () => {
    // Stitch redesign (2026-10-02): Settings left the bar. It is pushed onto
    // the tab the avatar was pressed on, so nothing floats over its rows.
    const handlers: (() => boolean | null | undefined)[] = [];
    type Handler = Parameters<typeof BackHandler.addEventListener>[1];
    const addListener = BackHandler.addEventListener.bind(BackHandler);
    jest.spyOn(BackHandler, 'addEventListener').mockImplementation((event, handler) => {
      if (event === 'hardwareBackPress') handlers.push(() => (handler as Handler)({} as never));
      return addListener(event, handler);
    });
    await openApp();
    await fireEvent.press(screen.getByTestId('tab-calendar'));
    await waitFor(() => expect(screen.queryByTestId('calendar-scroll')).not.toBeNull());
    await openSettings();
    expect(screen.queryByTestId('settings-root')).not.toBeNull();
    expect(screen.queryByTestId('floating-tab-bar')).toBeNull();
    expect(screen.queryByTestId('tab-capture')).toBeNull();
    // Its viewport is not inset for a bar that is not there.
    expect(StyleSheet.flatten(screen.getByTestId('settings-scroll').props.style)?.marginBottom ?? 0).toBe(0);

    // The header's back returns to the Calendar root, bar and pill back.
    await fireEvent.press(screen.getByTestId('header-back'));
    await waitFor(() => expect(screen.queryByTestId('calendar-scroll')).not.toBeNull());
    expect(screen.queryByTestId('settings-root')).toBeNull();
    expect(screen.queryByTestId('floating-tab-bar')).not.toBeNull();

    // Android's back does the same: it is consumed, and lands on Calendar.
    await openSettings();
    expect(handlers.length).toBeGreaterThan(0);
    let consumed: boolean | null | undefined;
    await act(async () => { consumed = handlers[handlers.length - 1]!(); });
    expect(consumed).toBe(true);
    await waitFor(() => expect(screen.queryByTestId('calendar-scroll')).not.toBeNull());
    expect(screen.queryByTestId('settings-root')).toBeNull();
    // At the tab root back is the platform's again.
    expect(handlers[handlers.length - 1]!()).toBe(false);
  });

  it('reaches the widget settings screen', async () => {
    await openApp();
    await openSettings();
    await openCategory('alerts');
    await fireEvent.press(screen.getByTestId('settings-widget'));
    await waitFor(() => expect(screen.queryByTestId('widget-titles-toggle')).not.toBeNull());
  });

  it('reaches the calendar links screen through Settings → Calendar', async () => {
    await openApp();
    await openSettings();
    await openCategory('connections');
    await fireEvent.press(screen.getByTestId('settings-calendar'));
    await waitFor(() => expect(screen.queryByTestId('calendar-feeds-entry')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('calendar-feeds-entry'));
    await waitFor(() => expect(screen.queryByTestId('ics-url-input')).not.toBeNull());
    expect(screen.queryByText(en.icsFeedsTitle)).not.toBeNull();
  });

  it('keeps Sources available for matches when calendar links are off', async () => {
    process.env.EXPO_PUBLIC_FEATURE_ICS_FEEDS = 'false';
    await openApp();
    await openSettings();
    await openCategory('connections');
    await waitFor(() => expect(screen.queryByTestId('settings-sources')).not.toBeNull());
    expect(screen.queryByText(en.settingsSourcesSub)).toBeNull();
  });

  it('keeps Sources available when calendar links are on', async () => {
    await openApp();
    await openSettings();
    await openCategory('connections');
    await waitFor(() => expect(screen.queryByTestId('settings-sources')).not.toBeNull());
  });

  // Closure CL7: without the match data key (staging and production today)
  // matches are not a source at all, so they are not named — and with no
  // calendar links either, there is no Sources row to open.
  it('keeps Sources available for calendar links without match data', async () => {
    jest.spyOn(footballEndpoints, 'getFootballSettings').mockResolvedValue(footballOff as never);
    await openApp();
    await openSettings();
    await openCategory('connections');
    await waitFor(() => expect(screen.queryByTestId('settings-sources')).not.toBeNull());
  });

  it('there is no Sources row with neither calendar links nor match data', async () => {
    process.env.EXPO_PUBLIC_FEATURE_ICS_FEEDS = 'false';
    jest.spyOn(footballEndpoints, 'getFootballSettings').mockResolvedValue(footballOff as never);
    await openApp();
    await openSettings();
    await openCategory('connections');
    await waitFor(() => expect(footballEndpoints.getFootballSettings).toHaveBeenCalled());
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(screen.queryByTestId('settings-sources')).toBeNull();
  });

  it('reaches the readiness settings screen', async () => {
    await openApp();
    await openSettings();
    await openCategory('day');
    await fireEvent.press(screen.getByTestId('settings-readiness'));
    await waitFor(() => expect(screen.queryByTestId('readiness-band')).not.toBeNull());
    expect(screen.queryByText(en.settingsEnergy)).not.toBeNull();
  });

  it('reaches the AI context import through Sources', async () => {
    await openApp();
    await openSettings();
    await openCategory('connections');
    await fireEvent.press(screen.getByTestId('settings-ai-import'));
    await waitFor(() => expect(screen.queryByTestId('ai-import-pick-chatgpt')).not.toBeNull());
  });

  it('reaches the financial context screen', async () => {
    await openApp();
    await openSettings();
    await openCategory('day');
    await fireEvent.press(screen.getByTestId('settings-financial'));
    await waitFor(() => expect(screen.queryByTestId('financial-band')).not.toBeNull());
    expect(screen.queryByText(en.financialTitle)).not.toBeNull();
  });

  it('has no calendar links row when the build flag is off, and the widget row is still there', async () => {
    delete process.env.EXPO_PUBLIC_FEATURE_ICS_FEEDS;
    await openApp();
    await openSettings();
    await openCategory('connections');
    await fireEvent.press(screen.getByTestId('settings-calendar'));
    await waitFor(() => expect(screen.queryByTestId('calendar-disconnect')).not.toBeNull());
    expect(screen.queryByTestId('calendar-feeds-entry')).toBeNull();
  });
});

/**
 * Audit 2026-10-03 #9: the «احكيها» pill covered «ليش هاي بالذات» (text size
 * 1.3) and «…» (1.5) on Today before any scroll. What Today keeps clear is
 * the bar-and-pill block as it actually measured — at the reader's text size
 * — and it is kept clear of the viewport, not only of the scroll's end.
 */
describe('Today keeps the floating pill off its rows', () => {
  it('insets the viewport by the bar and pill as they measured, and follows when they grow', async () => {
    await openApp();
    await waitFor(() => expect(screen.queryByTestId('today-scroll')).not.toBeNull());
    const inset = () => StyleSheet.flatten(screen.getByTestId('today-scroll').props.style)?.marginBottom;
    // The block at an enlarged text size: taller than the 170 fallback.
    await act(async () => {
      await fireEvent(screen.getByTestId('floating-tab-bar'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 214 } } });
    });
    expect(inset()).toBe(214);
    await act(async () => {
      await fireEvent(screen.getByTestId('floating-tab-bar'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 238 } } });
    });
    expect(inset()).toBe(238);
  });
});
