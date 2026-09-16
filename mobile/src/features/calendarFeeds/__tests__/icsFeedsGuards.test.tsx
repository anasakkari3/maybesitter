/**
 * The guards around calendar links that are not the screen itself
 * (UC-3.4, #188): the build flag and its release check, the entry in
 * Settings → Calendar, the copy in three languages, and dates under Hermes.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { cleanup, render, renderHook, screen, waitFor } from '@testing-library/react-native';
import { useIcsFeeds } from '../../../api/queries';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import { configProblems, icsFeedsEnabled } from '../../../config/env';
import { releaseConfigProblems } from '../../../config/releaseGuard';
import { CalendarSettingsScreen } from '../../settings/CalendarSettingsScreen';
import { deviceCalendar } from '../../calendar/deviceCalendar';
import * as calendarEndpoints from '../../../api/endpoints/calendar';
import * as commitmentEndpoints from '../../../api/endpoints/commitments';
import * as trustEndpoints from '../../../api/endpoints/trust';
import * as feedEndpoints from '../../../api/endpoints/icsFeeds';
import { resetCalendarSyncForTests } from '../../calendar/useDeviceCalendarSync';
import { resetBusySyncForTests } from '../../calendar/useBusyCalendar';
import { withHermesIntl } from '../../../testing/hermesIntl';
import { formatDate, formatTime } from '../../../i18n/format';
import en from '../../../i18n/locales/en.json';
import ar from '../../../i18n/locales/ar.json';
import he from '../../../i18n/locales/he.json';

const FLAG = 'EXPO_PUBLIC_FEATURE_ICS_FEEDS';
const original = process.env[FLAG];

afterEach(() => {
  if (original === undefined) delete process.env[FLAG];
  else process.env[FLAG] = original;
});

describe('icsFeedsEnabled', () => {
  it('is on only for the literal string true, mirroring ICS_FEEDS_ENABLED', () => {
    for (const [value, expected] of [
      ['true', true], [' true ', true], ['TRUE', false], ['1', false], ['yes', false], ['', false], ['false', false],
    ] as const) {
      process.env[FLAG] = value;
      expect({ value, on: icsFeedsEnabled() }).toEqual({ value, on: expected });
    }
    delete process.env[FLAG];
    expect(icsFeedsEnabled()).toBe(false);
  });

  it('refuses to configure a build with a misspelt value', () => {
    expect(releaseConfigProblems({ appEnv: 'development', icsFeeds: 'yes' }))
      .toContain('EXPO_PUBLIC_FEATURE_ICS_FEEDS must be true or false (got yes)');
    expect(releaseConfigProblems({ appEnv: 'development', icsFeeds: 'true' })).toEqual([]);
    const appEnv = process.env.EXPO_PUBLIC_APP_ENV;
    process.env.EXPO_PUBLIC_APP_ENV = 'development';
    try {
      process.env[FLAG] = 'on';
      expect(configProblems()).toContain('EXPO_PUBLIC_FEATURE_ICS_FEEDS must be true or false (got on)');
    } finally {
      if (appEnv === undefined) delete process.env.EXPO_PUBLIC_APP_ENV;
      else process.env.EXPO_PUBLIC_APP_ENV = appEnv;
    }
  });
});

describe('the entry in Settings → Calendar', () => {
  const METRICS: Metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
  const USER = { uid: 'entry-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'] };
  let client: QueryClient;
  let repository: ReturnType<typeof createFakeAuthRepository>;

  beforeEach(() => {
    onlineManager.setOnline(true);
    resetCalendarSyncForTests();
    resetBusySyncForTests();
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    repository = createFakeAuthRepository({ initialUser: USER });
    setAuthRepository(repository);
    jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [] } as never);
    jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] } as never);
    jest.spyOn(calendarEndpoints, 'getCalendarSettings')
      .mockResolvedValue({ success: true, calendarSettings: { writeTarget: 'off', updatedAt: null } } as never);
    jest.spyOn(deviceCalendar, 'getAccess').mockResolvedValue('undetermined' as never);
    jest.spyOn(deviceCalendar, 'listWritableCalendars').mockResolvedValue([]);
    jest.spyOn(trustEndpoints, 'getTrust')
      .mockResolvedValue({ success: true, participantId: USER.uid, trust: { analyticsConsent: false, calendarConsent: false } } as never);
    jest.spyOn(feedEndpoints, 'listIcsFeeds');
  });

  afterEach(async () => {
    cleanup();
    await new Promise(resolve => setTimeout(resolve, 0));
    client.clear();
    resetAuthForTests();
    jest.restoreAllMocks();
  });

  async function show() {
    await render(
      <SafeAreaProvider initialMetrics={METRICS}>
        <AppProvider>
          <AuthProvider repository={repository} isDevBundle={false}>
            <QueryClientProvider client={client}>
              <CalendarSettingsScreen onBack={() => {}} onFeeds={() => {}} />
            </QueryClientProvider>
          </AuthProvider>
        </AppProvider>
      </SafeAreaProvider>,
    );
    await waitFor(() => expect(screen.queryByTestId('calendar-disconnect')).not.toBeNull());
  }

  it('is there when the build has the feature', async () => {
    process.env[FLAG] = 'true';
    await show();
    expect(screen.queryByTestId('calendar-feeds-entry')).not.toBeNull();
  });

  it('is absent, not disabled, when it does not — and nothing asks for feeds', async () => {
    delete process.env[FLAG];
    await show();
    expect(screen.queryByTestId('calendar-feeds-entry')).toBeNull();
    expect(feedEndpoints.listIcsFeeds).not.toHaveBeenCalled();
  });
  it('the feeds query itself refuses to run without the flag, wherever it is mounted', async () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <AuthProvider repository={repository} isDevBundle={false}>
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </AuthProvider>
    );
    jest.spyOn(feedEndpoints, 'listIcsFeeds').mockResolvedValue({ success: true, feeds: [], deadlines: [] } as never);
    delete process.env[FLAG];
    const off = await renderHook(() => useIcsFeeds(), { wrapper });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(off.result.current.fetchStatus).toBe('idle');
    expect(feedEndpoints.listIcsFeeds).not.toHaveBeenCalled();
    off.unmount();

    // The control: the same mount with the flag on does ask.
    process.env[FLAG] = 'true';
    const on = await renderHook(() => useIcsFeeds(), { wrapper });
    await waitFor(() => expect(on.result.current.isSuccess).toBe(true));
    expect(feedEndpoints.listIcsFeeds).toHaveBeenCalled();
    on.unmount();
  });
});

describe('the copy', () => {
  const BUNDLES = { en, ar, he } as unknown as Record<string, Record<string, unknown>>;
  const feedCopy = (bundle: Record<string, unknown>) => Object.entries(bundle)
    .filter(([key, value]) => key.startsWith('icsFeeds') && typeof value === 'string') as [string, string][];

  /**
   * No blame and no alarm: a deadline is not "overdue", a feed that cannot be
   * read has not "failed" the user, and nothing here is "urgent". Each banned
   * word is checked in the language it would be written in — Arabic and
   * Hebrew are the app's first languages, and an English-only ban is none.
   */
  const BANNED: Record<string, RegExp> = {
    en: /\b(overdue|late|missed|failed?|failure|urgent|error|warning|must)\b/i,
    ar: /(متأخر|تأخرت|فاتك|فشل|قصّرت|قصرت|خطأ|تحذير|عاجل|لازم تسلّم)/,
    he: /(באיחור|איחרת|פספסת|נכשל|כישלון|שגיאה|אזהרה|דחוף)/,
  };

  it('has every key in all three languages', () => {
    const keys = feedCopy(BUNDLES.en!).map(([key]) => key).sort();
    expect(keys.length).toBeGreaterThan(40);
    for (const lang of ['ar', 'he']) {
      expect(feedCopy(BUNDLES[lang]!).map(([key]) => key).sort()).toEqual(keys);
    }
  });

  it.each(['en', 'ar', 'he'])('carries no blame or alarm words in %s', lang => {
    const offending = feedCopy(BUNDLES[lang]!).filter(([, value]) => BANNED[lang]!.test(value));
    expect(offending).toEqual([]);
  });

  it('is in the right script: Arabic copy is Arabic, Hebrew copy is Hebrew', () => {
    for (const [key, value] of feedCopy(BUNDLES.ar!)) {
      expect({ key, arabic: /[؀-ۿ]/.test(value) }).toEqual({ key, arabic: true });
    }
    for (const [key, value] of feedCopy(BUNDLES.he!)) {
      expect({ key, hebrew: /[֐-׿]/.test(value) }).toEqual({ key, hebrew: true });
    }
  });

  it('keeps the placeholders the screen fills', () => {
    for (const key of ['icsFeedsPreviewDeadlines', 'icsFeedsPreviewBusy', 'icsFeedsUpdated', 'icsFeedsDue', 'icsFeedsMoved']) {
      const placeholder = key === 'icsFeedsUpdated' || key === 'icsFeedsDue' || key === 'icsFeedsMoved' ? '{when}' : '{n}';
      for (const lang of ['en', 'ar', 'he']) expect({ lang, key, ok: String(BUNDLES[lang]![key]).includes(placeholder) }).toEqual({ lang, key, ok: true });
    }
  });
});

describe('due dates under Hermes', () => {
  it('format the same day and time as the real Intl in every language and zone', () => {
    const due = new Date('2026-10-09T20:59:00.000Z');
    for (const locale of ['ar', 'en', 'he'] as const) {
      for (const timeZone of ['Asia/Jerusalem', 'UTC', 'America/New_York']) {
        const real = `${formatDate(due, 'weekday', { locale, timeZone })} ${formatTime(due, { locale, timeZone })}`;
        const hermes = withHermesIntl(() => `${formatDate(due, 'weekday', { locale, timeZone })} ${formatTime(due, { locale, timeZone })}`);
        expect({ locale, timeZone, hermes }).toEqual({ locale, timeZone, hermes: real });
      }
    }
    // And the day really is the zone's: 23:59 Friday in Jerusalem is Friday.
    expect(formatTime(due, { locale: 'en', timeZone: 'Asia/Jerusalem' })).toBe('23:59');
  });
});
