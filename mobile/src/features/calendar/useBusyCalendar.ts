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
 * button. Clearing the cache clears `calendar.busySyncedAt.v1` with it, so the
 * throttle no longer holds anything back — the very next time the app came to
 * the front it would read the calendar again and upload everything that had
 * just been deleted. A disconnect that reconnects itself within the minute is
 * worse than no button at all.
 */
import { useCallback, useEffect, useRef } from 'react';
import { AppState, Platform } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTrust, useTrustAction, useUid } from '../../api/queries';
import { deleteCalendarBusy, postCalendarBusy } from '../../api/endpoints/calendar';
import { calendarReadEnabled } from '../../config/env';
import {
  clearCachedBusyBlocks,
  loadBusySyncedAt,
  loadCachedBusyBlocks,
  saveBusySyncedAt,
  saveCachedBusyBlocks,
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

export function resetBusySyncForTests(): void {
  passInFlight = false;
}

/** The last busy blocks this device read. Empty until the first sync. */
export function useBusyBlocks(): DeviceBusyBlock[] {
  const uid = useUid();
  const query = useQuery({
    queryKey: busyQueryKeys.blocks(uid),
    queryFn: loadCachedBusyBlocks,
    enabled: uid !== 'signed-out',
    // Read once and then only when a sync says so. The value changes on a
    // fifteen-minute cadence at most, and re-reading a file on every screen
    // focus would buy nothing.
    staleTime: Infinity,
  });
  return query.data ?? [];
}

/** The window one sync covers, as the device reads it. */
function windowFrom(now: Date): { startAt: string; endAt: string } {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + BUSY_LOOK_AHEAD_DAYS);
  return { startAt: start.toISOString(), endAt: end.toISOString() };
}

function apiBusyPorts(): BusySyncPorts {
  return {
    // Calendars switched off in Calendar settings are never read (L7).
    readBusy: async (ownEventIds, now) => deviceCalendar.fetchBusyBlocks({
      ownEventIds, now, excludedCalendarIds: new Set(await loadExcludedCalendarIds()),
    }),
    ownEventIds: loadWrittenEventIds,
    cache: saveCachedBusyBlocks,
    upload: async (body) => { await postCalendarBusy(body); },
    recordSync: saveBusySyncedAt,
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
  // A ref so the `AppState` listener below is registered once rather than
  // re-registered every time the trust query answers, and written in an effect
  // rather than during render so a discarded render cannot leave the sync
  // holding a consent value the user never saw.
  const latest = useRef({ uid, consented });
  useEffect(() => { latest.current = { uid, consented }; });

  const syncNow = useCallback(async (trigger: BusySyncTrigger): Promise<BusySyncOutcome | null> => {
    if (passInFlight) return null;
    const current = latest.current;
    passInFlight = true;
    try {
      const now = new Date();
      const result = await runBusySync(apiBusyPorts(), {
        trigger,
        featureEnabled: calendarReadEnabled(),
        signedIn: current.uid !== 'signed-out',
        consented: current.consented,
        lastSyncedAt: await loadBusySyncedAt(),
        now,
        sourceId: deviceSourceId(await resolveWriterId()),
        platform: Platform.OS === 'android' ? 'android' : 'ios',
        window: windowFrom(now),
      });
      // Only a pass that actually read the calendar changed the cache.
      if (result.kind === 'synced' || result.kind === 'failed') {
        void client.invalidateQueries({ queryKey: busyQueryKeys.blocks(current.uid) });
      }
      return result;
    } finally {
      passInFlight = false;
    }
  }, [client]);

  const disconnect = useCallback(async (): Promise<{ local: true; server: boolean }> => {
    const current = latest.current;
    // The phone first, and unconditionally. Whatever the network does, the
    // person who pressed this sees their busy times gone from the screen.
    await clearCachedBusyBlocks();
    void client.invalidateQueries({ queryKey: busyQueryKeys.blocks(current.uid) });
    try {
      await deleteCalendarBusy(deviceSourceId(await resolveWriterId()));
      // And the switch, so nothing syncs it back. See the header: clearing the
      // cache also cleared the throttle, so leaving this on would mean the next
      // trip to the home screen re-uploaded the window that was just deleted.
      await trustAction.mutateAsync({ type: 'set_calendar_consent', granted: false });
      return { local: true, server: true };
    } catch {
      return { local: true, server: false };
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
