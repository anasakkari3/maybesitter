/**
 * Where the busy-time sync is actually run (UC-3.2, #186).
 *
 * The same shape as `useDeviceCalendarSync` for UC-3.1, and for the same
 * reasons: one module-level in-flight flag for the whole process, a host
 * component mounted in `Root` so the feature works on every screen rather than
 * only the one that configures it, and every decision pushed down into pure
 * functions (`busySyncDecision`, `toBusyBlocks`) that a test can reach without a
 * device.
 *
 * ── The cache is a query, and the chips read it ──────────────────
 *
 * `useBusyBlocks` is a TanStack query over AsyncStorage rather than over the
 * network. That is deliberate: the chip has to render on a train, the value is
 * shared by three screens, and a query key means a finished sync invalidates
 * every one of them at once instead of each screen holding its own copy.
 *
 * `src/api/`'s rule that nothing is persisted still stands — this is not in
 * `src/api/`, and what is kept is four fields per block with no commitment text
 * and nothing naming what any of the time is for. See `lib/deviceSettings/
 * calendarBusy.ts`.
 *
 * ── Disconnect clears the phone first, and turns the switch off ──
 *
 * `disconnect` empties the local cache before it calls the server, and reports
 * the server half separately. Somebody who pressed "disconnect and delete" on a
 * train must not be left with their busy times still on the screen because a
 * request timed out; and the copy tells them plainly which half did not happen.
 *
 * It also turns the Trust Center's calendar consent off, and that part is here
 * rather than on the settings screen because forgetting it would undo the whole
 * button. Clearing the cache clears the last sync time with it, so the
 * throttle no longer holds anything back — the very next time the app came to
 * the front it would read the calendar again and upload everything that had
 * just been deleted. A disconnect that reconnects itself within the minute is
 * worse than no button at all.
 */
import { useCallback, useEffect, useRef } from 'react';
import { AppState, Platform } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTrust, useTrustAction, useUid } from '../../api/queries';
import { getAuthRepository } from '../../api/auth';
import { deleteCalendarBusy, postCalendarBusy } from '../../api/endpoints/calendar';
import { calendarReadEnabled } from '../../config/env';
import {
  clearCachedBusyBlocks,
  loadBusySyncedAt,
  loadDeviceBusy,
  saveBusySyncedAt,
  saveCachedBusyBlocks,
  uncoverCachedBusyBlocks,
  type DeviceBusyCache,
} from '../../lib/deviceSettings/calendarBusy';
import { loadExcludedCalendarIds, loadWrittenEventIds, resolveWriterId } from '../../lib/deviceSettings/calendarDevice';
import { deviceCalendar, BUSY_LOOK_AHEAD_DAYS } from './deviceCalendar';
import type { DeviceBusyBlock } from './busyBlocks';
import {
  deviceSourceId,
  runBusySync,
  type BusySyncOutcome,
  type BusySyncPorts,
  type BusySyncTrigger,
} from './busySync';

export const busyQueryKeys = {
  blocks: (uid: string) => ['user', uid, 'calendarBusy'] as const,
};

/**
 * Whether a pass is running, for the process rather than for one hook.
 *
 * Module-level for the reason UC-3.1's flag is: the hook is mounted by the host
 * in `Root` and again by the settings screen, and two passes would read the
 * same calendar twice and upload the same window twice within a second of each
 * other.
 */
let passInFlight = false;
/** The pass running now, so a disconnect can wait for an upload already sent. */
let activePass: Promise<unknown> | null = null;
/**
 * Moved on by every disconnect. A pass begun before it caches, uploads and
 * records nothing more, even for the same account (M4a, M4A-R4-REV-001).
 */
let passGeneration = 0;
/** Disconnects running: no pass starts while one is. */
let disconnecting = 0;
/**
 * The account whose calendar was disconnected, until a trust answer saying
 * its consent is off reaches the hooks (M4A-R5-REV-001). The consent switch
 * only invalidates the trust query, so for a moment after a disconnect every
 * hook still holds `consented: true`; a foreground pass in that moment would
 * put the deleted busy times back on the phone.
 */
let withdrawnFor: string | null = null;

export function resetBusySyncForTests(): void {
  passInFlight = false;
  activePass = null;
  disconnecting = 0;
  withdrawnFor = null;
}

/**
 * This account's device cache: the last busy blocks it read, and the window
 * they honestly cover (M4a). Never another account's (M4A-R8-001).
 */
export function useDeviceBusy(): { data: DeviceBusyCache | undefined; isPending: boolean; isError: boolean } {
  const uid = useUid();
  const query = useQuery({
    queryKey: busyQueryKeys.blocks(uid),
    queryFn: () => loadDeviceBusy(uid),
    enabled: uid !== 'signed-out',
    // Read once and then only when a sync says so. The value changes on a
    // fifteen-minute cadence at most, and re-reading a file on every screen
    // focus would buy nothing.
    staleTime: Infinity,
  });
  return { data: query.data, isPending: query.isPending, isError: query.isError };
}

/** The last busy blocks this device read for this account. Empty until the first sync. */
export function useBusyBlocks(): DeviceBusyBlock[] {
  return useDeviceBusy().data?.blocks ?? EMPTY_BLOCKS;
}

const EMPTY_BLOCKS: DeviceBusyBlock[] = [];

/** The window one sync covers, as the device reads it. */
function windowFrom(now: Date): { startAt: string; endAt: string } {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + BUSY_LOOK_AHEAD_DAYS);
  return { startAt: start.toISOString(), endAt: end.toISOString() };
}

/**
 * `stillCurrent`: whether the pass's account is still signed in. The cache
 * writes ask it again right before they write, after their own read
 * (M4A-R3-REV-001).
 */
function apiBusyPorts(owner: string, stillCurrent: () => boolean): BusySyncPorts {
  return {
    // Calendars switched off in Calendar settings are never read (L7).
    readBusy: async (ownEventIds, now) => deviceCalendar.fetchBusyBlocks({
      ownEventIds, now, excludedCalendarIds: new Set(await loadExcludedCalendarIds()),
    }),
    ownEventIds: loadWrittenEventIds,
    cache: (blocks, coverage) => saveCachedBusyBlocks(owner, blocks, coverage, stillCurrent),
    uncover: () => uncoverCachedBusyBlocks(owner, stillCurrent),
    upload: async (body) => { await postCalendarBusy(body, { asUid: owner }); },
    recordSync: (at) => saveBusySyncedAt(owner, at, stillCurrent),
  };
}

/**
 * What a screen may do about busy time.
 *
 * Deliberately no `running` flag and no last-`outcome`. Both existed and
 * nothing rendered either of them — and holding them meant `syncNow` called
 * `setState` synchronously, which React 19's `set-state-in-effect` rule
 * correctly reports as an error for a function a mounting effect calls. A piece
 * of state no screen reads is not a feature waiting to be used; it is a
 * cascading render and a lie about what this hook is for. The count on the
 * settings screen comes from `useBusyBlocks`, which is the cache itself.
 */
export interface BusyCalendarState {
  /** Runs a pass. Returns null when one was already in flight. */
  syncNow(trigger: BusySyncTrigger): Promise<BusySyncOutcome | null>;
  /** Clears the phone, then the account, then the switch. */
  disconnect(): Promise<{ local: true; server: boolean }>;
}

export function useBusyCalendar(): BusyCalendarState {
  const uid = useUid();
  const client = useQueryClient();
  const trust = useTrust();
  const trustAction = useTrustAction();

  const consented = trust.data?.trust?.calendarConsent === true;
  const answeredOff = trust.data?.trust?.calendarConsent === false;
  // A ref so the `AppState` listener below is registered once rather than
  // re-registered every time the trust query answers, and written in an effect
  // rather than during render so a discarded render cannot leave the sync
  // holding a consent value the user never saw.
  const latest = useRef({ uid, consented });
  useEffect(() => {
    latest.current = { uid, consented };
    // The server's answer has caught up with the disconnect: from here on the
    // consent itself keeps passes from starting, and turning it back on syncs.
    if (answeredOff && withdrawnFor === uid) withdrawnFor = null;
  });

  const syncNow = useCallback(async (trigger: BusySyncTrigger): Promise<BusySyncOutcome | null> => {
    const current = latest.current;
    if (passInFlight || disconnecting > 0 || withdrawnFor === current.uid) return null;
    const generation = passGeneration;
    // The signed-in account, from the repository (it changes before React's
    // state does), and the hook's own view of it; both must still be the
    // account this pass began for (M4A-REV-001, R2-REV-001).
    // And no disconnect since it began, and the consent still on
    // (M4A-R4-REV-001, R5-REV-001).
    const stillCurrent = () => passGeneration === generation
      && latest.current.consented
      && latest.current.uid === current.uid
      && (current.uid === 'signed-out' || getAuthRepository()?.currentUser()?.uid === current.uid);
    passInFlight = true;
    const pass = (async (): Promise<BusySyncOutcome | null> => {
      const now = new Date();
      const lastSyncedAt = await loadBusySyncedAt(current.uid);
      const writerId = await resolveWriterId();
      if (!stillCurrent()) return null;
      const result = await runBusySync(apiBusyPorts(current.uid, stillCurrent), {
        trigger,
        featureEnabled: calendarReadEnabled(),
        signedIn: current.uid !== 'signed-out',
        consented: current.consented,
        lastSyncedAt,
        now,
        sourceId: deviceSourceId(writerId),
        platform: Platform.OS === 'android' ? 'android' : 'ios',
        window: windowFrom(now),
        // The pass belongs to the account it began for (M4A-REV-001).
        stillCurrent,
      });
      // Only a pass that actually read the calendar changed the cache.
      if (result.kind === 'synced' || result.kind === 'failed' || result.kind === 'denied') {
        void client.invalidateQueries({ queryKey: busyQueryKeys.blocks(current.uid) });
      }
      return result;
    })();
    activePass = pass;
    try {
      return await pass;
    } finally {
      passInFlight = false;
      activePass = null;
    }
  }, [client]);

  const disconnect = useCallback(async (): Promise<{ local: true; server: boolean }> => {
    const current = latest.current;
    // A pass already running read the calendar being disconnected: from here
    // on it keeps, sends and records nothing, and no new pass starts until
    // this is done (M4A-R4-REV-001).
    passGeneration += 1;
    disconnecting += 1;
    withdrawnFor = current.uid;
    try {
      // The phone first, and unconditionally. Whatever the network does, the
      // person who pressed this sees their busy times gone from the screen.
      await clearCachedBusyBlocks();
      void client.invalidateQueries({ queryKey: busyQueryKeys.blocks(current.uid) });
      try {
        // An upload already on its way lands first, so the delete is the last
        // word on the server rather than something the upload undoes.
        await activePass?.catch(() => undefined);
        await deleteCalendarBusy(deviceSourceId(await resolveWriterId()));
        // And the switch, so nothing syncs it back. See the header: clearing the
        // cache also cleared the throttle, so leaving this on would mean the next
        // trip to the home screen re-uploaded the window that was just deleted.
        await trustAction.mutateAsync({ type: 'set_calendar_consent', granted: false });
        return { local: true, server: true };
      } catch {
        // The switch is still on: syncing resumes, as it always has when the
        // account could not be reached.
        withdrawnFor = null;
        return { local: true, server: false };
      }
    } finally {
      disconnecting -= 1;
    }
  }, [client, trustAction]);

  // Somebody turned the switch on, or it was already on when the app started.
  useEffect(() => {
    if (!consented) return;
    void syncNow('connect');
  }, [consented, syncNow]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void syncNow('foreground');
    });
    return () => subscription.remove();
  }, [syncNow]);

  return { syncNow, disconnect };
}

/**
 * Runs the busy-time sync for the whole signed-in session (UC-3.2, #186).
 *
 * Mounted in `Root` beside `DeviceCalendarSyncHost`, and drawing nothing.
 * Without it the chips on Today and on review would only ever be populated
 * while somebody had the calendar settings screen open, which is the one screen
 * they are not on when a conflict matters.
 */
export function BusyCalendarHost(): null {
  useBusyCalendar();
  return null;
}
