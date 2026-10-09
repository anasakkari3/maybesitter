/**
 * The Plan tab's day and its free time, as hooks (M4a R003/R004).
 *
 * ── The probe is the busy read ───────────────────────────────────
 *
 * `GET /api/mobile/calendar/busy` answers 404 while the capability is off.
 * The Plan tab is exactly what it was until it answers 200: a 404, an error
 * and a pending answer all mean "today's tab", and nothing else is read for
 * free time — not the routine profile, not four weeks of weekly blocks. It
 * is asked again on pull-to-refresh, on coming to the front, on a change of
 * account, zone or day, and every five minutes while the tab is open, so the
 * kill switch takes the surfaces away within five minutes at most.
 * Availability is the *latest* answer's, never a retained success after a
 * 404 (M4A-R11-003).
 *
 * ── One day, one instant ─────────────────────────────────────────
 *
 * `useLocalToday` moves at local midnight while the screen stays mounted,
 * and `usePlanSnapshot` holds one reference instant per account, zone and
 * local day, so Today and Upcoming are read at the same instant (M4A-R2-008).
 */
import { useEffect, useMemo, useState } from 'react';
import { AppState } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useUid } from '../../api/queries';
import { getServerBusy } from '../../api/endpoints/calendar';
import { dayKey, shiftDayKey } from '../../i18n/format';
import { dayBounds } from './freeTime';

/** Four weeks from today: the wider view's span, and the probe's. */
export const WIDER_DAYS = 28;
/** How often the probe is asked while the tab is open. */
export const PROBE_INTERVAL_MS = 5 * 60_000;

/** Today's local day in `timeZone`, moving at midnight while mounted. */
export function useLocalToday(timeZone: string): string {
  const [today, setToday] = useState(() => dayKey(new Date(), timeZone));
  const current = dayKey(new Date(), timeZone);
  // A zone change is seen on the render that brings it, not at the next timer.
  if (current !== today) setToday(current);
  useEffect(() => {
    const next = dayBounds(today, timeZone).end - Date.now();
    const timer = setTimeout(() => setToday(dayKey(new Date(), timeZone)), Math.max(1_000, next + 1_000));
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') setToday(dayKey(new Date(), timeZone));
    });
    return () => {
      clearTimeout(timer);
      subscription.remove();
    };
  }, [today, timeZone]);
  return today;
}

/**
 * One reference instant per `{uid, timeZone, localToday}`; `rotate()` takes a
 * new one (an explicit refresh). It never changes per render.
 */
export function usePlanSnapshot(uid: string, timeZone: string, today: string): { referenceTime: string; rotate: () => void } {
  const epoch = `${uid}|${timeZone}|${today}`;
  const [snapshot, setSnapshot] = useState(() => ({ epoch, at: new Date().toISOString(), turn: 0 }));
  if (snapshot.epoch !== epoch) setSnapshot({ epoch, at: new Date().toISOString(), turn: 0 });
  return {
    referenceTime: snapshot.at,
    rotate: () => setSnapshot((was) => ({ epoch: was.epoch, at: new Date().toISOString(), turn: was.turn + 1 })),
  };
}

/** The probe range: `[today 00:00, today + 28 00:00)` in `timeZone`. */
export function probeRange(today: string, timeZone: string): { from: string; to: string } {
  return {
    from: new Date(dayBounds(today, timeZone).start).toISOString(),
    to: new Date(dayBounds(shiftDayKey(today, WIDER_DAYS), timeZone).start).toISOString(),
  };
}

/** The server's ICS and manual busy time, which is also the free-time probe. */
export function useServerBusy(range: { from: string; to: string }) {
  const uid = useUid();
  const query = useQuery({
    queryKey: ['user', uid, 'calendar', 'serverBusy', range.from, range.to] as const,
    queryFn: () => getServerBusy(range.from, range.to),
    enabled: uid !== 'signed-out',
    retry: false,
    refetchInterval: PROBE_INTERVAL_MS,
    refetchOnWindowFocus: true,
  });
  // The latest answer decides: a success retained under a later 404 is not "on".
  const available = query.status === 'success' && !query.isRefetchError;
  return { query, available };
}

/** `keys` days from `today`. */
export function daysFrom(today: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => shiftDayKey(today, index));
}

/** Stable across renders for the same `today`. */
export function useDaysFrom(today: string, count: number): string[] {
  return useMemo(() => daysFrom(today, count), [today, count]);
}
