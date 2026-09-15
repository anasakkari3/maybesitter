/**
 * Where the calendar sync is actually run (UC-3.1, #185).
 *
 * ── Why a reconcile pass and not a mutation callback ─────────────
 *
 * #185's sketch hangs the sync off each mutation's `onSuccess`: confirm, edit,
 * delete. That would be four places that each have to be right, and it would
 * be wrong in the one case that matters most — the confirm whose calendar write
 * failed, or never ran because the app was killed between the 200 and the
 * callback. The calendar would then be permanently one event short and nothing
 * would ever notice.
 *
 * So the mutations do not write to the calendar at all. They invalidate the
 * lists, exactly as they already do, and this hook reconciles the *result*:
 * every commitment in hand, compared against every link in hand, with the same
 * decision function every time. A confirm is then just "the list changed", and
 * so is coming back to the app a day later with a calendar somebody has edited.
 *
 * ── The pass is serialised ───────────────────────────────────────
 *
 * Two overlapping reconciles would both see "no link" for the same commitment
 * and both try to create an event. The server would refuse the second, so the
 * damage is bounded — but only after a duplicate had already been written into
 * the user's calendar, since the create happens before the refusal. A single
 * in-flight flag is cheaper than relying on that.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTimeZone } from '../../i18n/timezone';
import { useToday, useUid, useUpcoming } from '../../api/queries';
import {
  deleteDeviceCalendarLink,
  getCalendarSettings,
  putDeviceCalendarLink,
} from '../../api/endpoints/calendar';
import type { CommitmentList, DeviceCalendarLink } from '../../api/schemas/common';
import type { CalendarWriteTarget } from '../../api/schemas/calendar';
import { calendarWriteEnabled } from '../../config/env';
import {
  forgetWrittenEventId,
  loadChosenCalendarId,
  rememberWrittenEventId,
  resolveWriterId,
} from '../../lib/deviceSettings/calendarDevice';
import { deviceCalendar } from './deviceCalendar';
import {
  reconcile,
  removeAllWrittenEvents,
  type SyncOutcome,
  type SyncPorts,
  type SyncSubject,
} from './deviceCalendarSync';

export const calendarQueryKeys = {
  settings: (uid: string) => ['user', uid, 'calendarSettings'] as const,
};

/**
 * Whether a pass is running, for the whole app rather than for one hook.
 *
 * Module-level on purpose. The hook is mounted twice — once by
 * `DeviceCalendarSyncHost` in `Root`, which is what makes the feature work
 * anywhere other than the settings screen, and once by the settings screen
 * itself so it can run a pass the moment a calendar is picked. Two instances
 * each with their own flag would both see "no link" for the same commitment and
 * both create an event; the server refuses the second claim, but only *after*
 * the duplicate is already in somebody's calendar, because the calendar write
 * comes first. One flag for the process is the only place that can be prevented.
 */
let passInFlight = false;

/** For tests, which must not inherit a flag from a pass they did not run. */
export function resetCalendarSyncForTests(): void {
  passInFlight = false;
}

/**
 * Where this account writes its commitments.
 *
 * `staleTime: 0`, like the consents query and for the same reason: somebody who
 * turned this off on another device must see it off here on the next look, and
 * a toggle rendered from a stale answer is a toggle that lies about what the
 * app will do next.
 */
export function useCalendarSettings() {
  const uid = useUid();
  return useQuery({
    queryKey: calendarQueryKeys.settings(uid),
    queryFn: getCalendarSettings,
    enabled: uid !== 'signed-out',
    staleTime: 0,
  });
}

/** The ports the sync runs through, so a test can hand it different ones. */
export function apiSyncPorts(): SyncPorts {
  return {
    calendar: deviceCalendar,
    putLink: async (commitmentId, link) => {
      await putDeviceCalendarLink(commitmentId, link);
    },
    deleteLink: async (commitmentId, writerId) => {
      await deleteDeviceCalendarLink(commitmentId, writerId);
    },
    rememberEvent: rememberWrittenEventId,
    forgetEvent: forgetWrittenEventId,
  };
}

/**
 * Every commitment the app currently holds, with its link — and every link the
 * account holds with no commitment left behind it.
 *
 * Read out of the query cache rather than refetched: these are the exact
 * responses the screens are rendering, so the calendar cannot end up reconciled
 * against a different answer from the one the user is looking at.
 *
 * The orphans come from the same responses (`calendarOrphans` on Today), and
 * they are added *after* the commitments and only for ids not already present.
 * That ordering is the safety rule: if one list is a moment staler than the
 * other and still shows a commitment Today has already called gone, the live
 * row wins and the deletion waits for the next pass. Erring that way leaves an
 * event a little too long; erring the other way deletes an entry out of
 * somebody's calendar that should still be in it.
 */
export function subjectsFromCache(lists: readonly (CommitmentList | undefined)[]): SyncSubject[] {
  const byId = new Map<string, SyncSubject>();
  for (const list of lists) {
    for (const commitment of list?.items ?? []) {
      byId.set(commitment.id, {
        commitmentId: commitment.id,
        commitment,
        link: commitment.deviceCalendarLink as DeviceCalendarLink | null | undefined,
      });
    }
  }
  for (const list of lists) {
    for (const orphan of list?.calendarOrphans ?? []) {
      if (byId.has(orphan.commitmentId)) continue;
      byId.set(orphan.commitmentId, {
        commitmentId: orphan.commitmentId,
        commitment: null,
        link: orphan.link,
      });
    }
  }
  return [...byId.values()];
}

export interface CalendarSyncState {
  /** The last pass's result, or null before the first one. */
  outcome: SyncOutcome | null;
  /** True while a pass is running, so a screen can wait rather than double-run. */
  running: boolean;
  /** Runs a pass now. Returns the outcome, or null when one was already running. */
  runNow(): Promise<SyncOutcome | null>;
  /** "Remove events MaybeSitter added". */
  removeAll(): Promise<{ removed: number; permissionDenied: boolean }>;
}

/**
 * Runs the pass when the lists change and when the app comes back to the front.
 *
 * Coming back to the front is what catches an event the user deleted in their
 * Calendar app while the app was in the background — which is the only way that
 * deletion can ever be noticed, since nothing tells us about it.
 */
export function useDeviceCalendarSync(
  lists: readonly (CommitmentList | undefined)[],
): CalendarSyncState {
  const uid = useUid();
  const client = useQueryClient();
  const deviceTimeZone = useTimeZone();
  const settings = useCalendarSettings();
  const [outcome, setOutcome] = useState<SyncOutcome | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  const writeTarget: CalendarWriteTarget = settings.data?.calendarSettings.writeTarget ?? 'off';
  const subjects = subjectsFromCache(lists);
  // A ref, so the AppState listener below is registered once rather than
  // re-registered on every list change — and written in an effect rather than
  // during render, so a render React discarded cannot leave the sync pass
  // holding commitments nobody is looking at. This effect is declared *first*
  // so it runs before the one that starts a pass.
  const latest = useRef({ subjects, writeTarget, deviceTimeZone, uid });
  useEffect(() => {
    latest.current = { subjects, writeTarget, deviceTimeZone, uid };
  });

  const runNow = useCallback(async (): Promise<SyncOutcome | null> => {
    if (passInFlight) return null;
    // The build-level switch, consulted here rather than on a screen: this is
    // the one place a calendar write is initiated, so "this build writes no
    // events" is a claim the code keeps however the sync is reached.
    if (!calendarWriteEnabled()) return null;
    const current = latest.current;
    if (current.uid === 'signed-out') return null;
    passInFlight = true;
    setIsRunning(true);
    try {
      const result = await reconcile({
        subjects: current.subjects,
        writeTarget: current.writeTarget,
        writerId: await resolveWriterId(),
        calendarId: await loadChosenCalendarId(),
        deviceTimeZone: current.deviceTimeZone,
        ports: apiSyncPorts(),
      });
      setOutcome(result);
      // The links the pass wrote are now out of date in the cache the next pass
      // will read. Invalidating rather than refetching: the lists are usually
      // mounted, and the ones that are not do not need the answer yet.
      if (result.created + result.updated + result.deleted + result.detached > 0) {
        void client.invalidateQueries({ queryKey: ['user', current.uid, 'commitments'] });
      }
      return result;
    } finally {
      passInFlight = false;
      setIsRunning(false);
    }
  }, [client]);

  // The lists changed: a confirm landed, an edit landed, something was deleted.
  // `gone` rather than an `updatedAt` an orphan does not have: a commitment
  // moving from a list into the orphan set changes the fingerprint, which is
  // what makes a deletion run a pass at all.
  const fingerprint = subjects
    .map((subject) => `${subject.commitmentId}:${subject.commitment?.updatedAt ?? 'gone'}:${subject.link?.contentHash ?? ''}`)
    .join('|');
  // `fingerprint` rather than `subjects`: the array is rebuilt on every render,
  // and depending on it would run a calendar pass on every render.
  useEffect(() => {
    void runNow();
  }, [fingerprint, writeTarget, runNow]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void runNow();
    });
    return () => subscription.remove();
  }, [runNow]);

  const removeAll = useCallback(async () => {
    const current = latest.current;
    const result = await removeAllWrittenEvents({
      subjects: current.subjects,
      writerId: await resolveWriterId(),
      ports: apiSyncPorts(),
    });
    void client.invalidateQueries({ queryKey: ['user', current.uid, 'commitments'] });
    return { removed: result.removed, permissionDenied: result.permissionDenied };
  }, [client]);

  return { outcome, running: isRunning, runNow, removeAll };
}


/**
 * Runs the calendar sync for the whole signed-in session (UC-3.1, #185).
 *
 * Mounted in `Root`, which renders only for a signed-in user, and drawing
 * nothing. Without it the sync would run only while somebody had the calendar
 * settings screen open — so confirming a commitment on Today would write no
 * event, which is the criterion this feature exists for.
 *
 * It subscribes to the two lists rather than fetching its own. They are the
 * responses the screens are rendering; TanStack answers both from one cache
 * entry per key, so this costs a subscription and not a request, and the
 * calendar can never be reconciled against a different answer from the one the
 * user is looking at.
 */
export function DeviceCalendarSyncHost(): null {
  const today = useToday();
  const upcoming = useUpcoming();
  useDeviceCalendarSync([today.data, upcoming.data]);
  return null;
}
