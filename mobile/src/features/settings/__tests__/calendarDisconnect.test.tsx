/**
 * "Disconnect and delete busy times" (UC-3.2, #186 step 8).
 *
 * ── Three things have to happen, and the third is the one that gets forgotten ──
 *
 * The blocks go from the phone. The blocks go from the account. And the Trust
 * Center's calendar switch goes off.
 *
 * The third is not decoration. Clearing the cache clears
 * the last sync time with it, so the fifteen-minute throttle no longer
 * holds anything back — leave the switch on and the very next time the app came
 * to the front it would read the calendar again and upload the window that had
 * just been deleted. A disconnect that reconnects itself inside a minute is
 * worse than no button at all, and only a test can tell the two apart, because
 * on a device they look identical until somebody comes back fifteen minutes
 * later and looks at Firestore.
 *
 * ── And the local half happens even when the network does not ────
 *
 * The person most likely to press this is the person who has just decided they
 * do not want this. Leaving their busy times on the screen because a request
 * timed out would be answering "stop" with "in a minute" — so the cache is
 * cleared first, unconditionally, and the copy says plainly which half did not
 * happen.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { AppState, Platform, type AppStateStatus } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import type { AuthUser } from '../../../auth/types';
import en from '../../../i18n/locales/en.json';
import { CalendarSettingsScreen } from '../CalendarSettingsScreen';
import { BUSY_BLOCKS_KEY, LEGACY_BUSY_KEYS } from '../../../lib/deviceSettings/calendarBusy';
import { seedDeviceBusyCache } from '../../../testing/deviceBusyCache';
import { resetWriterIdCache } from '../../../lib/deviceSettings/calendarDevice';
import { resetCalendarSyncForTests } from '../../calendar/useDeviceCalendarSync';
import { resetBusySyncForTests } from '../../calendar/useBusyCalendar';
import { deviceCalendar } from '../../calendar/deviceCalendar';

import * as calendarEndpoints from '../../../api/endpoints/calendar';
import * as commitmentEndpoints from '../../../api/endpoints/commitments';
import * as trustEndpoints from '../../../api/endpoints/trust';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const USER: AuthUser = {
  uid: 'disconnect-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

const HOUR = 3_600_000;
const FROM = new Date(Date.now() + 6 * HOUR);

let client: QueryClient;
let repository: ReturnType<typeof createFakeAuthRepository>;

function trustBody(calendarConsent: boolean) {
  return { success: true, participantId: USER.uid, trust: { analyticsConsent: false, calendarConsent } };
}

beforeEach(async () => {
  onlineManager.setOnline(true);
  resetWriterIdCache();
  resetCalendarSyncForTests();
  resetBusySyncForTests();
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  repository = createFakeAuthRepository({ initialUser: USER });
  setAuthRepository(repository);
  await AsyncStorage.multiRemove([BUSY_BLOCKS_KEY, ...LEGACY_BUSY_KEYS]);
  await seedDeviceBusyCache(USER.uid, [
    { nativeId: 'evt-1', startAt: FROM.toISOString(), endAt: new Date(FROM.getTime() + HOUR).toISOString(), allDay: false },
  ], { syncedAt: Date.now() });

  jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [] } as never);
  jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] } as never);
  jest.spyOn(calendarEndpoints, 'getCalendarSettings')
    .mockResolvedValue({ success: true, calendarSettings: { writeTarget: 'off', updatedAt: null } } as never);
  jest.spyOn(deviceCalendar, 'getAccess').mockResolvedValue('granted');
  jest.spyOn(deviceCalendar, 'listWritableCalendars').mockResolvedValue([]);
  // The switch is on, so mounting this screen runs a sync — the real one, in
  // the real order, which is why the count below is a fact about the pass and
  // not about what this file seeded. An unmocked read would be a device call.
  jest.spyOn(deviceCalendar, 'fetchBusyBlocks').mockResolvedValue([
    { nativeId: 'evt-1', startAt: FROM.toISOString(), endAt: new Date(FROM.getTime() + HOUR).toISOString(), allDay: false },
  ]);
  // One consent, as the server keeps it: a read after the switch went off
  // says off (a fake that kept answering on would be a server that refused it).
  let serverConsent = true;
  jest.spyOn(trustEndpoints, 'getTrust').mockImplementation(async () => trustBody(serverConsent) as never);
  jest.spyOn(trustEndpoints, 'updateTrust').mockImplementation(async (action) => {
    if (action.type === 'set_calendar_consent') serverConsent = action.granted;
    return trustBody(serverConsent) as never;
  });
  jest.spyOn(calendarEndpoints, 'deleteCalendarBusy').mockResolvedValue({ success: true, deleted: 2 } as never);
  jest.spyOn(calendarEndpoints, 'postCalendarBusy').mockResolvedValue({
    success: true,
    blocks: 0,
    source: {
      sourceId: 'device:x', lastSyncedAt: new Date().toISOString(),
      windowStart: new Date().toISOString(), windowEnd: new Date().toISOString(),
    },
  } as never);
});

afterEach(async () => {
  await cleanup();
  // A real macrotask: a settling request when the tree came down leaves React
  // work in flight, and RNTL v14's next `render` then mounts nothing.
  await new Promise((resolve) => setTimeout(resolve, 0));
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
  delete process.env.EXPO_PUBLIC_FEATURE_CALENDAR_READ;
});

async function show() {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <QueryClientProvider client={client}>
            <CalendarSettingsScreen onBack={() => {}} />
          </QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryByTestId('calendar-disconnect')).not.toBeNull());
}

/** The button, then the dialog's confirm: the only way the deletion runs. */
async function disconnectAndConfirm() {
  await fireEvent.press(screen.getByTestId('calendar-disconnect'));
  await waitFor(() => expect(screen.queryByTestId('calendar-disconnect-dialog')).not.toBeNull());
  await fireEvent.press(screen.getByTestId('calendar-disconnect-confirm'));
}

/**
 * UAT round 6, batch 4 (shot 757): the button ran on the first tap, and an
 * accidental one wiped the busy times from the phone and the account. It now
 * asks first, in the app's one shape for "are you sure".
 */
describe('before anything is deleted', () => {
  it('asks, and deletes nothing until the answer is yes', async () => {
    await show();
    await fireEvent.press(screen.getByTestId('calendar-disconnect'));
    await waitFor(() => expect(screen.queryByTestId('calendar-disconnect-dialog')).not.toBeNull());
    expect(screen.getByText(en.calendarDisconnectTitle)).toBeTruthy();
    expect(screen.getByText(en.calendarDisconnectConfirmBody)).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calendarEndpoints.deleteCalendarBusy).not.toHaveBeenCalled();
    expect(trustEndpoints.updateTrust).not.toHaveBeenCalled();
    expect(await AsyncStorage.getItem(BUSY_BLOCKS_KEY)).not.toBeNull();
  });

  it('keeps everything when the answer is no', async () => {
    await show();
    await fireEvent.press(screen.getByTestId('calendar-disconnect'));
    await waitFor(() => expect(screen.queryByTestId('calendar-disconnect-keep')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('calendar-disconnect-keep'));
    await waitFor(() => expect(screen.queryByTestId('calendar-disconnect-dialog')).toBeNull());
    expect(calendarEndpoints.deleteCalendarBusy).not.toHaveBeenCalled();
    expect(trustEndpoints.updateTrust).not.toHaveBeenCalled();
    expect(await AsyncStorage.getItem(BUSY_BLOCKS_KEY)).not.toBeNull();
    expect(screen.queryByTestId('calendar-disconnect-result')).toBeNull();
  });
});

describe('pressing disconnect', () => {
  it('clears the phone, the account and the switch', async () => {
    await show();
    await disconnectAndConfirm();

    await waitFor(() => expect(calendarEndpoints.deleteCalendarBusy).toHaveBeenCalledTimes(1));
    expect((calendarEndpoints.deleteCalendarBusy as jest.Mock).mock.calls[0]![0] as string)
      .toMatch(/^device:/);
    expect(await AsyncStorage.getItem(BUSY_BLOCKS_KEY)).toBeNull();
    // The one that is easy to forget. Without it the next trip to the home
    // screen re-uploads everything that was just deleted, because clearing the
    // cache also cleared the throttle.
    await waitFor(() => expect(trustEndpoints.updateTrust)
      .toHaveBeenCalledWith({ type: 'set_calendar_consent', granted: false }));
  });

  it('says so, and says how many busy times the sync found', async () => {
    await show();
    await waitFor(() => expect(String(screen.getByTestId('calendar-busy-count').props.children)).toContain('1'));
    await disconnectAndConfirm();
    await waitFor(() => expect(screen.queryByTestId('calendar-disconnect-result')).not.toBeNull());
    expect(String(screen.getByTestId('calendar-disconnect-result').props.children))
      .toBe(en.calendarDisconnectDone);
  });

  it('clears the phone even when the account cannot be reached, and says which half failed', async () => {
    jest.spyOn(calendarEndpoints, 'deleteCalendarBusy').mockRejectedValue(new Error('offline') as never);
    await show();
    await disconnectAndConfirm();

    await waitFor(() => expect(screen.queryByTestId('calendar-disconnect-result')).not.toBeNull());
    expect(String(screen.getByTestId('calendar-disconnect-result').props.children))
      .toBe(en.calendarDisconnectFailed);
    expect(await AsyncStorage.getItem(BUSY_BLOCKS_KEY)).toBeNull();
  });
});

/**
 * A sync already running when disconnect is pressed (M4a, M4A-R4-REV-001).
 *
 * The pass belongs to the same account, so the account checks alone let it
 * carry on: it wrote the cache back after the clear, and its upload could
 * land after the server's delete and put the busy times back on the account.
 */
describe('a sync running when disconnect is pressed', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
  }
  const BLOCK = { nativeId: 'evt-1', startAt: FROM.toISOString(), endAt: new Date(FROM.getTime() + HOUR).toISOString(), allDay: false };
  const STORED = {
    success: true,
    blocks: 1,
    source: {
      sourceId: 'device:x', lastSyncedAt: new Date().toISOString(),
      windowStart: new Date().toISOString(), windowEnd: new Date().toISOString(),
    },
  };

  it('keeps and sends nothing it read before the disconnect', async () => {
    const read = deferred<typeof BLOCK[]>();
    jest.mocked(deviceCalendar.fetchBusyBlocks).mockReturnValue(read.promise);

    await show();
    await waitFor(() => expect(deviceCalendar.fetchBusyBlocks).toHaveBeenCalled());
    await disconnectAndConfirm();
    read.resolve([BLOCK]);

    await waitFor(() => expect(calendarEndpoints.deleteCalendarBusy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(trustEndpoints.updateTrust).toHaveBeenCalled());
    expect(calendarEndpoints.postCalendarBusy).not.toHaveBeenCalled();
    expect(await AsyncStorage.getItem(BUSY_BLOCKS_KEY)).toBeNull();
  });

  it('lets an upload already sent land before the delete, and records nothing after it', async () => {
    const upload = deferred<typeof STORED>();
    const order: string[] = [];
    jest.mocked(calendarEndpoints.postCalendarBusy).mockImplementation(async () => {
      order.push('upload sent');
      const stored = await upload.promise;
      order.push('upload landed');
      return stored as never;
    });
    jest.mocked(calendarEndpoints.deleteCalendarBusy).mockImplementation(async () => {
      order.push('delete');
      return { success: true, deleted: 1 } as never;
    });

    await show();
    await waitFor(() => expect(order).toEqual(['upload sent']));
    await disconnectAndConfirm();
    // Nothing is deleted while the upload is still on its way.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(['upload sent']);
    upload.resolve(STORED);

    await waitFor(() => expect(order).toEqual(['upload sent', 'upload landed', 'delete']));
    await waitFor(() => expect(trustEndpoints.updateTrust).toHaveBeenCalled());
    expect(await AsyncStorage.getItem(BUSY_BLOCKS_KEY)).toBeNull();
  });

  it('starts no new pass while the disconnect is still running', async () => {
    const listeners: ((state: AppStateStatus) => void)[] = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((type: string, listener: (state: AppStateStatus) => void) => {
      if (type === 'change') listeners.push(listener);
      return { remove: () => {} };
    }) as never);
    const deletion = deferred<{ success: true; deleted: number }>();
    jest.mocked(calendarEndpoints.deleteCalendarBusy).mockReturnValue(deletion.promise as never);

    await show();
    await waitFor(() => expect(calendarEndpoints.postCalendarBusy).toHaveBeenCalledTimes(1));
    await disconnectAndConfirm();
    await waitFor(() => expect(calendarEndpoints.deleteCalendarBusy).toHaveBeenCalledTimes(1));
    // Back to the front while the delete is on its way: the cache was just
    // cleared, so the throttle would let a pass through.
    for (const listener of listeners) listener('active');
    await new Promise((resolve) => setTimeout(resolve, 0));
    deletion.resolve({ success: true, deleted: 1 });

    await waitFor(() => expect(trustEndpoints.updateTrust).toHaveBeenCalled());
    expect(deviceCalendar.fetchBusyBlocks).toHaveBeenCalledTimes(1);
    expect(calendarEndpoints.postCalendarBusy).toHaveBeenCalledTimes(1);
  });

  function captureForeground(): () => void {
    const listeners: ((state: AppStateStatus) => void)[] = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((type: string, listener: (state: AppStateStatus) => void) => {
      if (type === 'change') listeners.push(listener);
      return { remove: () => {} };
    }) as never);
    return () => { for (const listener of listeners) listener('active'); };
  }

  // M4A-R5-REV-001: the switch only invalidates the trust query, so for a
  // moment after a disconnect every hook still holds the consent as on.
  it('starts no pass after the disconnect while the trust answer has not caught up', async () => {
    const foreground = captureForeground();
    const refetch = deferred<ReturnType<typeof trustBody>>();
    jest.mocked(trustEndpoints.getTrust)
      .mockResolvedValueOnce(trustBody(true) as never)
      .mockReturnValue(refetch.promise as never);

    await show();
    await waitFor(() => expect(calendarEndpoints.postCalendarBusy).toHaveBeenCalledTimes(1));
    await disconnectAndConfirm();
    await waitFor(() => expect(screen.queryByTestId('calendar-disconnect-result')).not.toBeNull());
    expect(jest.mocked(trustEndpoints.getTrust).mock.calls.length).toBeGreaterThan(1);

    foreground();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deviceCalendar.fetchBusyBlocks).toHaveBeenCalledTimes(1);
    expect(calendarEndpoints.postCalendarBusy).toHaveBeenCalledTimes(1);
    expect(await AsyncStorage.getItem(BUSY_BLOCKS_KEY)).toBeNull();
    refetch.resolve(trustBody(false));
  });

  it('syncs again when the calendar is turned back on after a disconnect', async () => {
    await show();
    await waitFor(() => expect(calendarEndpoints.postCalendarBusy).toHaveBeenCalledTimes(1));
    jest.mocked(trustEndpoints.getTrust).mockResolvedValue(trustBody(false) as never);
    await disconnectAndConfirm();
    await waitFor(() => expect(screen.getByTestId('calendar-reading-benefit').props.children)
      .toBe(en.calendarReadBenefitOff));

    jest.mocked(trustEndpoints.getTrust).mockResolvedValue(trustBody(true) as never);
    await client.invalidateQueries();
    await waitFor(() => expect(calendarEndpoints.postCalendarBusy).toHaveBeenCalledTimes(2));
  });

  it('syncs again after a disconnect that could not reach the account, whose switch is still on', async () => {
    const foreground = captureForeground();
    jest.mocked(calendarEndpoints.deleteCalendarBusy).mockRejectedValue(new Error('offline') as never);
    await show();
    await waitFor(() => expect(calendarEndpoints.postCalendarBusy).toHaveBeenCalledTimes(1));
    await disconnectAndConfirm();
    await waitFor(() => expect(screen.queryByTestId('calendar-disconnect-result')).not.toBeNull());

    foreground();
    await waitFor(() => expect(calendarEndpoints.postCalendarBusy).toHaveBeenCalledTimes(2));
  });

  /** The server's consent, and reads of it that can be held back. */
  function serverTrust(initial: boolean) {
    const state = { consent: initial, held: null as ReturnType<typeof deferred<ReturnType<typeof trustBody>>> | null };
    jest.mocked(trustEndpoints.getTrust).mockImplementation(async () => (
      state.held ? state.held.promise : trustBody(state.consent)) as never);
    jest.mocked(trustEndpoints.updateTrust).mockImplementation(async (action) => {
      if (action.type === 'set_calendar_consent') state.consent = action.granted;
      return trustBody(state.consent) as never;
    });
    return state;
  }

  // M4A-R6-REV-002: the switch went off on the server, but its answer was lost.
  it('starts no pass after a switch request whose answer was lost, until the server says what the switch is', async () => {
    const foreground = captureForeground();
    const server = serverTrust(true);
    jest.mocked(trustEndpoints.updateTrust).mockImplementation(async () => {
      server.consent = false;
      throw new Error('the answer never came back');
    });

    await show();
    await waitFor(() => expect(calendarEndpoints.postCalendarBusy).toHaveBeenCalledTimes(1));
    server.held = deferred();
    const held = server.held;
    await disconnectAndConfirm();
    await waitFor(() => expect(screen.queryByTestId('calendar-disconnect-result')).not.toBeNull());

    foreground();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deviceCalendar.fetchBusyBlocks).toHaveBeenCalledTimes(1);
    expect(await AsyncStorage.getItem(BUSY_BLOCKS_KEY)).toBeNull();

    server.held = null;
    held.resolve(trustBody(false));
    await waitFor(() => expect(screen.getByTestId('calendar-reading-benefit').props.children)
      .toBe(en.calendarReadBenefitOff));
    foreground();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deviceCalendar.fetchBusyBlocks).toHaveBeenCalledTimes(1);
    expect(calendarEndpoints.postCalendarBusy).toHaveBeenCalledTimes(1);
    expect(await AsyncStorage.getItem(BUSY_BLOCKS_KEY)).toBeNull();
  });

  it('syncs again when the server says a switch request that failed never applied', async () => {
    serverTrust(true);
    jest.mocked(trustEndpoints.updateTrust).mockRejectedValue(new Error('refused') as never);

    await show();
    await waitFor(() => expect(calendarEndpoints.postCalendarBusy).toHaveBeenCalledTimes(1));
    await disconnectAndConfirm();

    await waitFor(() => expect(calendarEndpoints.postCalendarBusy).toHaveBeenCalledTimes(2));
  });

  // M4A-R6-REV-003: the mark must not outlive the answer it waits for.
  it('syncs again after signing out and back in, once the server says the calendar was turned back on', async () => {
    const server = serverTrust(true);

    await show();
    await waitFor(() => expect(calendarEndpoints.postCalendarBusy).toHaveBeenCalledTimes(1));
    server.held = deferred();
    const held = server.held;
    await disconnectAndConfirm();
    await waitFor(() => expect(screen.queryByTestId('calendar-disconnect-result')).not.toBeNull());

    repository.emit(null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Turned back on from another phone, then signed in here again.
    server.consent = true;
    server.held = null;
    repository.emit(USER);
    held.resolve(trustBody(true));

    await waitFor(() => expect(calendarEndpoints.postCalendarBusy).toHaveBeenCalledTimes(2));
  });

  // M4A-R7-REV-001: `ApiProvider` clears the query cache on every account
  // change, which starts the trust query's count of answers again from zero.
  it('syncs again after signing out and back in when the account change clears the query cache, as ApiProvider does', async () => {
    const server = serverTrust(true);

    await show();
    await waitFor(() => expect(calendarEndpoints.postCalendarBusy).toHaveBeenCalledTimes(1));
    server.held = deferred();
    const held = server.held;
    await disconnectAndConfirm();
    await waitFor(() => expect(screen.queryByTestId('calendar-disconnect-result')).not.toBeNull());

    await act(async () => { repository.emit(null); client.clear(); });
    server.consent = true;
    server.held = null;
    await act(async () => { repository.emit(USER); });

    await waitFor(() => expect(calendarEndpoints.postCalendarBusy).toHaveBeenCalledTimes(2));
    held.resolve(trustBody(true));
  });

  it('takes no answer fetched before the switch went off for the server\'s word, across signing out and in', async () => {
    const server = serverTrust(true);

    await show();
    await waitFor(() => expect(calendarEndpoints.postCalendarBusy).toHaveBeenCalledTimes(1));
    server.held = deferred();
    const held = server.held;
    await disconnectAndConfirm();
    await waitFor(() => expect(screen.queryByTestId('calendar-disconnect-result')).not.toBeNull());

    // Back in while the server's answer is still on its way: the only answer
    // in hand is the one from before the disconnect, which says on. `act`, so
    // every effect of the sign-in has run before that answer arrives.
    await act(async () => { repository.emit(null); });
    await act(async () => { repository.emit(USER); });
    expect(deviceCalendar.fetchBusyBlocks).toHaveBeenCalledTimes(1);
    expect(calendarEndpoints.postCalendarBusy).toHaveBeenCalledTimes(1);

    server.held = null;
    held.resolve(trustBody(false));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calendarEndpoints.postCalendarBusy).toHaveBeenCalledTimes(1);
    expect(await AsyncStorage.getItem(BUSY_BLOCKS_KEY)).toBeNull();
  });

  it('acts on the server\'s answer, not a render\'s, when the sign-in\'s effects run after it arrives', async () => {
    const server = serverTrust(true);

    await show();
    await waitFor(() => expect(calendarEndpoints.postCalendarBusy).toHaveBeenCalledTimes(1));
    server.held = deferred();
    const held = server.held;
    await disconnectAndConfirm();
    await waitFor(() => expect(screen.queryByTestId('calendar-disconnect-result')).not.toBeNull());

    // Back in, but the sign-in's effects run only after the server's answer
    // has landed: the render they belong to still holds the old «on».
    repository.emit(null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    repository.emit(USER);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deviceCalendar.fetchBusyBlocks).toHaveBeenCalledTimes(1);
    expect(calendarEndpoints.postCalendarBusy).toHaveBeenCalledTimes(1);

    server.held = null;
    held.resolve(trustBody(false));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calendarEndpoints.postCalendarBusy).toHaveBeenCalledTimes(1);
    expect(await AsyncStorage.getItem(BUSY_BLOCKS_KEY)).toBeNull();
  });

  it('keeps nothing from a read that was running when the consent went off', async () => {
    const read = deferred<typeof BLOCK[]>();
    jest.mocked(deviceCalendar.fetchBusyBlocks).mockReturnValue(read.promise);
    const before = await AsyncStorage.getItem(BUSY_BLOCKS_KEY);

    await show();
    await waitFor(() => expect(deviceCalendar.fetchBusyBlocks).toHaveBeenCalled());
    // Switched off elsewhere (the Trust Center), not by this screen.
    jest.mocked(trustEndpoints.getTrust).mockResolvedValue(trustBody(false) as never);
    await client.invalidateQueries();
    await waitFor(() => expect(screen.getByTestId('calendar-reading-benefit').props.children)
      .toBe(en.calendarReadBenefitOff));
    read.resolve([BLOCK]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calendarEndpoints.postCalendarBusy).not.toHaveBeenCalled();
    expect(await AsyncStorage.getItem(BUSY_BLOCKS_KEY)).toBe(before);
  });
});

describe('what the screen says without being asked', () => {
  it('shows the reading-on benefit but no zero-count line when a current read finds nothing', async () => {
    await AsyncStorage.multiRemove([BUSY_BLOCKS_KEY, ...LEGACY_BUSY_KEYS]);
    jest.mocked(deviceCalendar.fetchBusyBlocks).mockResolvedValue([]);

    await show();

    await waitFor(() => expect(screen.getByTestId('calendar-reading-benefit').props.children)
      .toBe(en.calendarReadBenefitOn));
    // ICU's Arabic zero form has no digit, so absence of a numeral is not
    // enough to prove that the zero-count node itself stayed off the screen.
    expect(screen.queryByTestId('calendar-busy-count')).toBeNull();
  });

  it.each<[string, () => void]>([
    ['permission denied', () => { jest.mocked(deviceCalendar.getAccess).mockResolvedValue('denied'); }],
    ['consent off', () => { jest.mocked(trustEndpoints.getTrust).mockResolvedValue(trustBody(false) as never); }],
    ['feature disabled', () => { process.env.EXPO_PUBLIC_FEATURE_CALENDAR_READ = 'false'; }],
  ])('shows the reading-off benefit when %s', async (_state, arrange) => {
    arrange();

    await show();

    await waitFor(() => expect(screen.getByTestId('calendar-reading-benefit').props.children)
      .toBe(en.calendarReadBenefitOff));
    expect(screen.queryByTestId('calendar-busy-count')).toBeNull();
  });

  it('keeps the Android caveat behind the disconnect disclosure on Android', async () => {
    const original = Platform.OS;
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    try {
      await show();
      expect(screen.queryByText(en.calendarDeclinedNote)).toBeNull();
      await fireEvent.press(screen.getByTestId('calendar-disconnect-details-why'));
      expect(String(screen.getByTestId('calendar-disconnect-details-why-body').props.children))
        .toContain(en.calendarDeclinedNote);
    } finally {
      Object.defineProperty(Platform, 'OS', { value: original, configurable: true });
    }
  });

  // UAT 2026-09-26, #17, shot 57: an iPhone was told what Android does.
  it('says nothing about Android on an iPhone', async () => {
    const original = Platform.OS;
    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
    try {
      await show();
      expect(screen.queryByTestId('calendar-busy-count')).not.toBeNull();
      await fireEvent.press(screen.getByTestId('calendar-disconnect-details-why'));
      expect(String(screen.getByTestId('calendar-disconnect-details-why-body').props.children))
        .not.toContain(en.calendarDeclinedNote);
    } finally {
      Object.defineProperty(Platform, 'OS', { value: original, configurable: true });
    }
  });
});
