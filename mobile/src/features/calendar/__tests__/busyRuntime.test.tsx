/**
 * That the busy sync runs at all, anywhere (UC-3.2, #186).
 *
 * ── Written because a mutation survived without it ───────────────
 *
 * Deleting `<BusyCalendarHost />` from `Root` left the whole suite green. Every
 * other test here renders the chips from the cache, which is right — the chips
 * must work offline — but it means nothing noticed that the thing which *fills*
 * the cache had stopped being mounted. The app would have shipped with busy
 * time that only ever refreshed while somebody had Settings → Calendar open,
 * which is the one screen they are not on when a conflict matters.
 *
 * That is the same failure the Flutter build shipped: a working conflict
 * detector reachable from exactly one screen. #185 has its own version of this
 * test for the same reason, in `syncRuntime.test.tsx`.
 *
 * ── Nothing is opened but Today ──────────────────────────────────
 *
 * The app is rendered and then left alone. If a sync happens, it happened
 * because `Root` mounts the host, and for no other reason.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, type AppStateStatus } from 'react-native';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import { Root } from '../../../Root';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';
import { resetWriterIdCache } from '../../../lib/deviceSettings/calendarDevice';
import { deviceCalendar } from '../deviceCalendar';
import { resetBusySyncForTests } from '../useBusyCalendar';

import * as calendarEndpoints from '../../../api/endpoints/calendar';
import * as commitmentEndpoints from '../../../api/endpoints/commitments';
import * as analyticsEndpoints from '../../../api/endpoints/analytics';
import * as trustEndpoints from '../../../api/endpoints/trust';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const USER: AuthUser = {
  uid: 'busy-runtime-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

const HOUR = 3_600_000;
const FROM = new Date(Date.now() + 6 * HOUR);
const TO = new Date(FROM.getTime() + HOUR);

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

/** The Trust Center's calendar switch, which is what lets a sync begin. */
function trustWith(calendarConsent: boolean) {
  return {
    success: true,
    participantId: USER.uid,
    trust: { analyticsConsent: false, calendarConsent },
  };
}

beforeEach(async () => {
  resetBusySyncForTests();
  resetWriterIdCache();
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  await AsyncStorage.multiRemove(['calendar.busy.v1', 'calendar.busySyncedAt.v1']);
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'en');
  jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [], calendarOrphans: [] } as never);
  jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] } as never);
  jest.spyOn(analyticsEndpoints, 'recordAnalyticsEvent')
    .mockResolvedValue({ success: true, participantId: USER.uid, recorded: true, eventId: 'e-1' } as never);
  // The calendar is faked at the wrapper, not at `expo-calendar`: what this
  // file is about is whether anything *asks*, not how the asking is translated.
  jest.spyOn(deviceCalendar, 'fetchBusyBlocks').mockResolvedValue([
    { nativeId: 'evt-1', startAt: FROM.toISOString(), endAt: TO.toISOString(), allDay: false },
  ]);
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

describe('with the calendar switch on', () => {
  it('reads and uploads busy time without anybody opening a settings screen', async () => {
    jest.spyOn(trustEndpoints, 'getTrust').mockResolvedValue(trustWith(true) as never);
    const upload = jest.spyOn(calendarEndpoints, 'postCalendarBusy').mockResolvedValue({
      success: true,
      blocks: 1,
      source: {
        sourceId: 'device:x', lastSyncedAt: new Date().toISOString(),
        windowStart: new Date().toISOString(), windowEnd: new Date().toISOString(),
      },
    } as never);

    await openApp();

    await waitFor(() => expect(deviceCalendar.fetchBusyBlocks).toHaveBeenCalled());
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    const sent = upload.mock.calls[0]![0];
    expect(sent.sourceId.startsWith('device:')).toBe(true);
    expect(sent.blocks).toHaveLength(1);
    // Four fields, and the calendar's own id for the event is not one of them.
    expect(Object.keys(sent.blocks[0]!).sort()).toEqual(['allDay', 'blockId', 'endAt', 'startAt']);
    expect(JSON.stringify(sent)).not.toContain('evt-1');
  });

  it('caches what it read, so the chips work before the next launch', async () => {
    jest.spyOn(trustEndpoints, 'getTrust').mockResolvedValue(trustWith(true) as never);
    jest.spyOn(calendarEndpoints, 'postCalendarBusy').mockResolvedValue({
      success: true,
      blocks: 1,
      source: {
        sourceId: 'device:x', lastSyncedAt: new Date().toISOString(),
        windowStart: new Date().toISOString(), windowEnd: new Date().toISOString(),
      },
    } as never);

    await openApp();

    await waitFor(async () => {
      expect(await AsyncStorage.getItem('calendar.busy.v1')).toContain(FROM.toISOString());
    });
  });
});

/**
 * Coming back to the front (#418 review).
 *
 * The foreground trigger is the one the fifteen-minute throttle exists for, and
 * nothing tested it: flipping `'active'` to `'background'` in the listener left
 * the suite green. So the listener is captured here and driven by hand, with a
 * sync already recorded long enough ago that the throttle lets it through.
 */
describe('coming back to the front', () => {
  function captureAppState() {
    const listeners: Array<(state: AppStateStatus) => void> = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((type: string, listener: (state: AppStateStatus) => void) => {
      if (type === 'change') listeners.push(listener);
      return { remove: () => {} };
    }) as never);
    return (state: AppStateStatus) => { for (const listener of listeners) listener(state); };
  }

  async function settledAfterConnect() {
    jest.spyOn(trustEndpoints, 'getTrust').mockResolvedValue(trustWith(true) as never);
    const upload = jest.spyOn(calendarEndpoints, 'postCalendarBusy').mockResolvedValue({
      success: true, blocks: 1,
      source: { sourceId: 'device:x', lastSyncedAt: new Date().toISOString(), windowStart: new Date().toISOString(), windowEnd: new Date().toISOString() },
    } as never);
    const fire = captureAppState();
    await openApp();
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    // Pretend the connect sync was long ago, so only the trigger decides.
    await AsyncStorage.setItem('calendar.busySyncedAt.v1', String(Date.now() - 60 * 60_000));
    return { fire, upload };
  }

  it('syncs again when the app becomes active', async () => {
    const { fire, upload } = await settledAfterConnect();
    fire('active');
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
  });

  it('does not sync when the app goes to the background', async () => {
    const { fire, upload } = await settledAfterConnect();
    fire('background');
    fire('inactive');
    // Give a sync every chance to have started.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(upload).toHaveBeenCalledTimes(1);
  });
});

describe('with the calendar switch off', () => {
  /**
   * The promise that matters most, and the one only a test can keep.
   *
   * Not "nothing is uploaded" — "nothing is *read*". A build that looked at
   * somebody's calendar and then decided not to send it has still looked at
   * somebody's calendar, and on iOS it would have spent the one permission
   * prompt the OS gives to do it.
   */
  it('never so much as asks the calendar', async () => {
    jest.spyOn(trustEndpoints, 'getTrust').mockResolvedValue(trustWith(false) as never);
    const upload = jest.spyOn(calendarEndpoints, 'postCalendarBusy');

    await openApp();
    // Long enough for the effects, the query and the AppState listener to have
    // run: the positive case above resolves inside this window.
    await waitFor(() => expect(screen.queryByTestId('today-date')).not.toBeNull());

    expect(deviceCalendar.fetchBusyBlocks).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(await AsyncStorage.getItem('calendar.busy.v1')).toBeNull();
  });
});
