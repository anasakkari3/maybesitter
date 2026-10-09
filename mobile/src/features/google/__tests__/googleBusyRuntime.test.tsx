/**
 * That Google busy time is refreshed for the whole session, not only while the
 * Calendar tab is open (CL6a review I1).
 *
 * The phone's calendar has `BusyCalendarHost` in `Root`, and a test that
 * renders the app, opens nothing but Today, and sees the upload happen
 * (`busyRuntime.test.tsx`). Google Calendar had no such host: its refresh ran
 * inside the Calendar tab's query, so a person who connected it and went
 * straight to Today got a plan — and a replan tick — that ignored their Google
 * meetings. This is the same test for Google: the app is rendered and left on
 * Today; if a sync happens, it is because `Root` mounts `GoogleBusyHost`.
 *
 * Statuses are the recorded fixtures, so the host reads the shape the server
 * sends.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, Pressable, type AppStateStatus } from 'react-native';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import { Root } from '../../../Root';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';
import { deviceCalendar } from '../../calendar/deviceCalendar';
import { resetBusySyncForTests } from '../../calendar/useBusyCalendar';
import { googleQueryKeys, resetGoogleBusySyncForTests, useGoogleCalendarSync } from '../useGoogle';
import connected from '../../../api/__fixtures__/google.connected.json';
import notConnected from '../../../api/__fixtures__/google.notConnected.json';
import gmailOnly from '../../../api/__fixtures__/google.status.json';
import calendarSynced from '../../../api/__fixtures__/google.calendarSynced.json';
import calendarBlocks from '../../../api/__fixtures__/google.calendarBlocks.json';

import * as googleEndpoints from '../../../api/endpoints/google';
import * as captureEndpoints from '../../../api/endpoints/capture';
import en from '../../../i18n/locales/en.json';
import * as calendarEndpoints from '../../../api/endpoints/calendar';
import * as commitmentEndpoints from '../../../api/endpoints/commitments';
import * as analyticsEndpoints from '../../../api/endpoints/analytics';
import * as trustEndpoints from '../../../api/endpoints/trust';
import { chatServer } from '../../../testing/captureChat';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const USER: AuthUser = {
  uid: 'google-busy-runtime-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;
let sync: jest.SpiedFunction<typeof googleEndpoints.syncGoogleCalendar>;
let list: jest.SpiedFunction<typeof googleEndpoints.listGoogleBusy>;

function trustWith(calendarConsent: boolean) {
  return { success: true, participantId: USER.uid, trust: { analyticsConsent: false, calendarConsent } };
}

function statusIs(fixture: { google: unknown }) {
  jest.spyOn(googleEndpoints, 'getGoogleStatus').mockResolvedValue(fixture as never);
}

/** The `AppState` listeners the app registers, driven by hand. */
function captureAppState() {
  const listeners: ((state: AppStateStatus) => void)[] = [];
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((type: string, listener: (state: AppStateStatus) => void) => {
    if (type === 'change') listeners.push(listener);
    return { remove: () => {} };
  }) as never);
  return async (state: AppStateStatus) => {
    await act(async () => { for (const listener of listeners) listener(state); });
  };
}

beforeEach(async () => {
  resetBusySyncForTests();
  resetGoogleBusySyncForTests();
  onlineManager.setOnline(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'en');
  jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [], calendarOrphans: [] } as never);
  jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] } as never);
  jest.spyOn(analyticsEndpoints, 'recordAnalyticsEvent')
    .mockResolvedValue({ success: true, participantId: USER.uid, recorded: true, eventId: 'e-1' } as never);
  // The phone's own calendar is not what this file is about; it stays quiet.
  jest.spyOn(deviceCalendar, 'fetchBusyBlocks').mockResolvedValue([]);
  jest.spyOn(calendarEndpoints, 'postCalendarBusy').mockResolvedValue({
    success: true, blocks: 0,
    source: { sourceId: 'device:x', lastSyncedAt: null, windowStart: null, windowEnd: null },
  } as never);
  sync = jest.spyOn(googleEndpoints, 'syncGoogleCalendar').mockResolvedValue(calendarSynced as never);
  list = jest.spyOn(googleEndpoints, 'listGoogleBusy').mockResolvedValue(calendarBlocks as never);
});

afterEach(() => {
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

/** The Google page's «حدّث» button, without the page around it. */
function ManualSync() {
  const manual = useGoogleCalendarSync();
  return <Pressable testID="manual-google-sync" onPress={() => manual.mutate()} />;
}

async function openApp(options: { manual?: boolean } = {}) {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}>
            <Root />
            {options.manual ? <ManualSync /> : null}
          </QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryByTestId('tab-capture')).not.toBeNull());
}

describe('with Google Calendar connected and the calendar switch on', () => {
  it('refreshes Google busy time without anybody opening the Calendar tab, and has the blocks ready for the chips', async () => {
    jest.spyOn(trustEndpoints, 'getTrust').mockResolvedValue(trustWith(true) as never);
    statusIs(connected);

    await openApp();

    await waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(list).toHaveBeenCalled());
    await waitFor(() => expect((client.getQueryData(googleQueryKeys.busy(USER.uid)) as { blocks: unknown[] } | undefined)?.blocks).toHaveLength(calendarBlocks.blocks.length));
  });

  it('refreshes again when the app comes back to the front, at most every fifteen minutes', async () => {
    jest.spyOn(trustEndpoints, 'getTrust').mockResolvedValue(trustWith(true) as never);
    statusIs(connected);
    const fire = captureAppState();
    await openApp();
    await waitFor(() => expect(sync).toHaveBeenCalledTimes(1));

    // Straight back: inside the throttle, nothing.
    await fire('active');
    expect(sync).toHaveBeenCalledTimes(1);

    // An hour later: once.
    resetGoogleBusySyncForTests({ uid: USER.uid, at: Date.now() - 60 * 60_000 });
    await fire('active');
    await waitFor(() => expect(sync).toHaveBeenCalledTimes(2));
    // Going to the background is not coming back.
    resetGoogleBusySyncForTests({ uid: USER.uid, at: Date.now() - 60 * 60_000 });
    await fire('background');
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('refreshes as soon as Calendar is connected, not at the next launch', async () => {
    jest.spyOn(trustEndpoints, 'getTrust').mockResolvedValue(trustWith(true) as never);
    statusIs(notConnected);
    await openApp();
    await waitFor(() => expect(googleEndpoints.getGoogleStatus).toHaveBeenCalled());
    expect(sync).not.toHaveBeenCalled();

    // What `useGoogleConnect` writes when the callback answers «connected».
    await act(async () => { client.setQueryData(googleQueryKeys.status(USER.uid), connected.google); });
    await waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
  });
});

/** A sync that answers only when the test says so. */
function holdSync(): () => Promise<void> {
  let release: (() => void) | undefined;
  sync.mockImplementationOnce(() => new Promise((resolve) => {
    release = () => resolve(calendarSynced as never);
  }) as never);
  return async () => { await act(async () => { release?.(); }); };
}

describe('one pass at a time, per account (CL6a round 2, N6)', () => {
  const OTHER: AuthUser = { ...USER, uid: 'google-busy-runtime-other', email: 'o@b.c' };

  it('signing out and in as someone else during a pass does not hold up the new account\'s sync', async () => {
    jest.spyOn(trustEndpoints, 'getTrust').mockResolvedValue(trustWith(true) as never);
    statusIs(connected);
    const release = holdSync();
    await openApp();
    await waitFor(() => expect(sync).toHaveBeenCalledTimes(1));

    await act(async () => { repository.emit(null); });
    await act(async () => { repository.emit(OTHER); });
    // The first account's pass is still out; the second account's connect
    // sync is its own.
    await waitFor(() => expect(sync).toHaveBeenCalledTimes(2));
    await release();
  });

  it('a manual refresh during the session\'s pass joins it rather than asking Google twice', async () => {
    jest.spyOn(trustEndpoints, 'getTrust').mockResolvedValue(trustWith(true) as never);
    statusIs(connected);
    const release = holdSync();
    await openApp({ manual: true });
    await waitFor(() => expect(sync).toHaveBeenCalledTimes(1));

    await fireEvent.press(screen.getByTestId('manual-google-sync'));
    await release();
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(sync).toHaveBeenCalledTimes(1);
  });
});

describe('when there is nothing to refresh', () => {
  it('asks Google for nothing while the Trust Center calendar switch is off', async () => {
    jest.spyOn(trustEndpoints, 'getTrust').mockResolvedValue(trustWith(false) as never);
    statusIs(connected);
    const fire = captureAppState();
    await openApp();
    await waitFor(() => expect(googleEndpoints.getGoogleStatus).toHaveBeenCalled());
    await fire('active');
    expect(sync).not.toHaveBeenCalled();
  });

  it('asks Google for nothing when Calendar is not the feature connected', async () => {
    jest.spyOn(trustEndpoints, 'getTrust').mockResolvedValue(trustWith(true) as never);
    statusIs({ ...gmailOnly, google: { ...gmailOnly.google, features: { calendar: false, gmail: true, drive: true } } });
    await openApp();
    await waitFor(() => expect(googleEndpoints.getGoogleStatus).toHaveBeenCalled());
    expect(sync).not.toHaveBeenCalled();
  });
});

describe('the conflict chips', () => {
  it('a proposed time inside a Google meeting gets the note on review, with the phone calendar empty', async () => {
    const at = new Date(Date.now() + 6 * 3_600_000);
    jest.spyOn(trustEndpoints, 'getTrust').mockResolvedValue(trustWith(true) as never);
    statusIs(connected);
    list.mockResolvedValue({
      success: true,
      blocks: [{
        ...calendarBlocks.blocks[0]!,
        startAt: new Date(at.getTime() - 30 * 60_000).toISOString(),
        endAt: new Date(at.getTime() + 60 * 60_000).toISOString(),
        allDay: false,
      }],
    } as never);
    jest.spyOn(captureEndpoints, 'chatCapture').mockImplementation(chatServer(() => ({
      version: 'v1',
      proposalId: 'p-1',
      status: 'proposed',
      items: [{
        itemId: 'i-1', title: 'Hand in the report', resolvedTime: at.toISOString(),
        needsClarification: false, priority: 'high', priorityEstimated: false,
      }],
      provenance: { requestedEngine: 'rules', executedEngine: 'rule-based', fallbackUsed: false },
    })) as never);

    await openApp();
    await waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
    await fireEvent.press(screen.getByTestId('tab-capture'));
    await waitFor(() => expect(screen.queryByTestId('capture-input')).not.toBeNull());
    await fireEvent.changeText(screen.getByTestId('capture-input'), 'Hand in the report at six');
    await fireEvent.press(screen.getByTestId('capture-analyze'));
    await waitFor(() => expect(screen.queryByTestId('review-busy-i-1')).not.toBeNull());
    expect(String(screen.getByTestId('review-busy-i-1').props.children))
      .toContain(en.calendarBusyConflict.split('{range}')[0]!.trim());
  });

  /*
   * Today and Details read the same merged blocks as review (CL6a round 2,
   * N3). Each case leaves the phone's calendar empty, so a chip can only come
   * from Google; switching either screen back to the phone's blocks alone
   * turns its case red.
   */
  function meetingAround(at: Date) {
    list.mockResolvedValue({
      success: true,
      blocks: [{
        ...calendarBlocks.blocks[0]!,
        startAt: new Date(at.getTime() - 30 * 60_000).toISOString(),
        endAt: new Date(at.getTime() + 60 * 60_000).toISOString(),
        allDay: false,
      }],
    } as never);
  }

  function commitmentAt(at: Date) {
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    return {
      id: 'c-1', kind: 'task', title: 'Hand in the report', description: null, person: null, status: 'active',
      priority: { level: 'high', source: 'default', pressureAllowed: false, pressureLevel: 'none' },
      timeSpec: { kind: 'due_by', dueAt: at.toISOString(), endAt: null, remindAt: null, allDay: false, timezone: 'UTC' },
      currentAckState: 'not_seen', postponedUntil: null,
      createdAt: hourAgo, updatedAt: hourAgo, confirmedAt: hourAgo,
      completedAt: null, droppedAt: null, deviceCalendarLink: null,
    };
  }

  it('a commitment on Today inside a Google meeting gets the note, with the phone calendar empty', async () => {
    const at = new Date(Date.now() + 6 * 3_600_000);
    jest.spyOn(trustEndpoints, 'getTrust').mockResolvedValue(trustWith(true) as never);
    statusIs(connected);
    meetingAround(at);
    jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [commitmentAt(at)], calendarOrphans: [] } as never);

    await openApp();
    await waitFor(() => expect(screen.queryByTestId('today-item-c-1')).not.toBeNull());
    await waitFor(() => expect(screen.queryByTestId('today-busy-c-1')).not.toBeNull());
  });

  it('the same commitment\'s details get the note too', async () => {
    const at = new Date(Date.now() + 6 * 3_600_000);
    jest.spyOn(trustEndpoints, 'getTrust').mockResolvedValue(trustWith(true) as never);
    statusIs(connected);
    meetingAround(at);
    const item = commitmentAt(at);
    jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [item], calendarOrphans: [] } as never);
    jest.spyOn(commitmentEndpoints, 'getCommitment').mockResolvedValue({ data: item, etag: 'W/"v1"' } as never);

    await openApp();
    await waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId('today-item-c-1')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('today-item-c-1'));
    await waitFor(() => expect(screen.queryByTestId('details-title')).not.toBeNull());
    await waitFor(() => expect(screen.queryByTestId('details-busy')).not.toBeNull());
  });
});
