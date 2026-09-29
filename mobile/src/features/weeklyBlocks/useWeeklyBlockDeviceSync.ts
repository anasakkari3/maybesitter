/**
 * Where the weekly blocks' device events are kept in step (weekly fixed
 * blocks, «ثابت أسبوعي») — the twin of `useDeviceCalendarSync`, for blocks.
 *
 * The same shape and the same rules: a host mounted in `Root` for the whole
 * signed-in session, one in-flight flag for the process, a pass when the
 * blocks or the write target change and when the app comes back to the front,
 * the build-level switch (`calendarWriteEnabled`) consulted at the one place a
 * write is started, and the only-calendar adoption (`adoptSoleCalendar`) asked
 * only when a block is actually waiting for a calendar.
 *
 * The links — which events this phone wrote for which block — are this
 * phone's, per account (`loadWeeklyEventLinks`). `useWeeklyEventIds` reads
 * them for the Calendar tab and Today, which hide those events from the busy
 * rows because they draw the block itself.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { AppState } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useUid, useWeeklyBlocks } from '../../api/queries';
import type { WeeklyBlock } from '../../api/schemas/weeklyBlocks';
import type { CalendarWriteTarget } from '../../api/schemas/calendar';
import { calendarWriteEnabled } from '../../config/env';
import {
  forgetWrittenEventId,
  loadChosenCalendarId,
  loadWeeklyEventLinks,
  rememberWrittenEventId,
  saveChosenCalendarId,
  saveWeeklyEventLinks,
} from '../../lib/deviceSettings/calendarDevice';
import { deviceCalendar, DeviceCalendarError, weeklyRuleCarriesDays } from '../calendar/deviceCalendar';
import { adoptSoleCalendar } from '../calendar/deviceCalendarSync';
import { useCalendarSettings } from '../calendar/useDeviceCalendarSync';
import { needsWeeklyCalendar } from './weeklyDeviceEvents';
import { reconcileWeeklyEvents, type WeeklySyncOutcome, type WeeklySyncPorts } from './weeklyEventSync';

export const weeklyEventQueryKeys = {
  eventIds: (uid: string) => ['user', uid, 'weeklyBlockEvents'] as const,
};

/** See `useDeviceCalendarSync`'s flag: two passes would both create. */
let passInFlight = false;

export function resetWeeklySyncForTests(): void {
  passInFlight = false;
}

function portsFor(uid: string): WeeklySyncPorts {
  return {
    calendar: deviceCalendar,
    loadLinks: () => loadWeeklyEventLinks(uid),
    saveLinks: (links) => saveWeeklyEventLinks(uid, links),
    rememberEvent: rememberWrittenEventId,
    forgetEvent: forgetWrittenEventId,
  };
}

/** The device event ids this phone wrote for weekly blocks, for de-duplicating busy rows. */
export function useWeeklyEventIds(): ReadonlySet<string> {
  const uid = useUid();
  const query = useQuery({
    queryKey: weeklyEventQueryKeys.eventIds(uid),
    queryFn: async () => (await loadWeeklyEventLinks(uid) ?? []).flatMap((link) => link.eventIds),
    enabled: uid !== 'signed-out',
    staleTime: Infinity,
  });
  const ids = query.data;
  return useMemo(() => new Set(ids ?? []), [ids]);
}

export function useWeeklyBlockDeviceSync(): { runNow(): Promise<WeeklySyncOutcome | null>; removeAll(): Promise<{ removed: number; permissionDenied: boolean }> } {
  const uid = useUid();
  const client = useQueryClient();
  const blocks = useWeeklyBlocks();
  const settings = useCalendarSettings();
  const writeTarget: CalendarWriteTarget = settings.data?.calendarSettings.writeTarget ?? 'off';
  // `undefined` until the list has answered: the plan then does nothing,
  // because an empty list would take every block's event back out.
  const list: WeeklyBlock[] | undefined = blocks.data;
  const latest = useRef({ uid, list, writeTarget });
  useEffect(() => { latest.current = { uid, list, writeTarget }; });

  const runNow = useCallback(async (): Promise<WeeklySyncOutcome | null> => {
    if (passInFlight) return null;
    if (!calendarWriteEnabled()) return null;
    const current = latest.current;
    if (current.uid === 'signed-out' || current.list === undefined) return null;
    passInFlight = true;
    try {
      const multiDayRule = weeklyRuleCarriesDays();
      const ports = portsFor(current.uid);
      let calendarId = await loadChosenCalendarId();
      if (calendarId === null) {
        const links = await ports.loadLinks();
        if (links !== null && needsWeeklyCalendar({ blocks: current.list, links, writeTarget: current.writeTarget, multiDayRule })) {
          calendarId = await adoptSoleCalendar(deviceCalendar, saveChosenCalendarId);
        }
      }
      const outcome = await reconcileWeeklyEvents({
        blocks: current.list,
        writeTarget: current.writeTarget,
        calendarId,
        multiDayRule,
        ports,
      });
      if (outcome.created + outcome.updated + outcome.deleted + outcome.detached > 0) {
        void client.invalidateQueries({ queryKey: weeklyEventQueryKeys.eventIds(current.uid) });
      }
      return outcome;
    } finally {
      passInFlight = false;
    }
  }, [client]);

  const fingerprint = (list ?? []).map((block) => `${block.id}:${block.updatedAt}:${block.status}`).join('|');
  const loaded = list !== undefined;
  useEffect(() => {
    if (!loaded) return;
    void runNow();
  }, [fingerprint, loaded, writeTarget, runNow]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void runNow();
    });
    return () => subscription.remove();
  }, [runNow]);

  /** "Remove events MaybeSitter added", for the blocks' events: every one this phone wrote. */
  const removeAll = useCallback(async () => {
    const current = latest.current;
    const ports = portsFor(current.uid);
    const links = await ports.loadLinks();
    const mine = (links ?? []).filter((link) => !link.detached);
    if (mine.length === 0) return { removed: 0, permissionDenied: false };
    if ((await deviceCalendar.getAccess()) !== 'granted') return { removed: 0, permissionDenied: true };
    let removed = 0;
    const kept = new Map((links ?? []).map((link) => [link.blockId, link]));
    for (const link of mine) {
      try {
        for (const id of link.eventIds) {
          await deviceCalendar.deleteEvent(id);
          await forgetWrittenEventId(id);
        }
        kept.delete(link.blockId);
        removed += 1;
      } catch (error) {
        if (error instanceof DeviceCalendarError && error.reason === 'permission_denied') {
          await ports.saveLinks([...kept.values()]);
          return { removed, permissionDenied: true };
        }
      }
    }
    await ports.saveLinks([...kept.values()]);
    void client.invalidateQueries({ queryKey: weeklyEventQueryKeys.eventIds(current.uid) });
    return { removed, permissionDenied: false };
  }, [client]);

  return { runNow, removeAll };
}

/** Mounted in `Root` beside `DeviceCalendarSyncHost`; draws nothing. */
export function WeeklyBlockCalendarHost(): null {
  useWeeklyBlockDeviceSync();
  return null;
}
