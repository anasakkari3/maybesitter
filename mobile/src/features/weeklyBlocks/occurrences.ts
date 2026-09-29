/**
 * Weekly-block occurrences for the days a screen draws (Calendar tab, Today).
 *
 * The occurrences come from `/weekly-blocks/occurrences` — exactly the busy
 * time the planner keeps free — so what the phone shows is what the plan
 * does. These helpers only choose the window and sort the answer into days.
 */
import { useMemo } from 'react';
import { dayKey, shiftDayKey } from '../../i18n/format';
import { instantForWallClock } from '../../lib/time/zoneOffset';
import { useWeeklyBlockOccurrences } from '../../api/queries';
import type { WeeklyBlockOccurrence } from '../../api/schemas/weeklyBlocks';
import type { DeviceBusyBlock } from '../calendar/busyBlocks';

function midnight(key: string, timeZone: string): string {
  const [year, month, day] = key.split('-').map(Number) as [number, number, number];
  return instantForWallClock({ year, month, day, hour: 0, minute: 0 }, timeZone).toISOString();
}

/** `[first day's midnight, the midnight after the last day)` in `timeZone`. */
export function dayWindow(keys: readonly string[], timeZone: string): { from: string; to: string } {
  const first = keys[0]!;
  const last = keys[keys.length - 1]!;
  return { from: midnight(first, timeZone), to: midnight(shiftDayKey(last, 1), timeZone) };
}

/** Occurrences by the local day they start on, each day in time order. */
export function occurrencesByDay(items: readonly WeeklyBlockOccurrence[], timeZone: string): Map<string, WeeklyBlockOccurrence[]> {
  const byDay = new Map<string, WeeklyBlockOccurrence[]>();
  const sorted = [...items].sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
  for (const item of sorted) {
    const key = dayKey(new Date(item.startAt), timeZone);
    byDay.set(key, [...(byDay.get(key) ?? []), item]);
  }
  return byDay;
}

/** The occurrence under way at `now`, if any: `[startAt, endAt)`. */
export function occurrenceCovering(items: readonly WeeklyBlockOccurrence[], now: Date): WeeklyBlockOccurrence | null {
  const ms = now.getTime();
  return items.find((item) => Date.parse(item.startAt) <= ms && ms < Date.parse(item.endAt)) ?? null;
}

/**
 * The occurrences as busy intervals, for the conflict chips: a commitment at
 * 11:00 on a training Saturday is on top of the training. The phone's own
 * copy of the block's event is left out of the busy read (its id is in
 * `writtenEventIds`), so without this the chip would go quiet.
 */
export function occurrencesAsBusy(items: readonly WeeklyBlockOccurrence[]): DeviceBusyBlock[] {
  return items.map((item) => ({ nativeId: `weekly:${item.weeklyBlockId}:${item.startAt}`, startAt: item.startAt, endAt: item.endAt, allDay: false }));
}

/** The occurrences for these day keys. Empty while loading or when the read fails: a fixed block is context, not a gate. */
export function useWeeklyOccurrences(keys: readonly string[], timeZone: string): WeeklyBlockOccurrence[] {
  const first = keys[0] ?? '';
  const last = keys[keys.length - 1] ?? '';
  const window = useMemo(() => dayWindow([first, last], timeZone), [first, last, timeZone]);
  const query = useWeeklyBlockOccurrences(window.from, window.to);
  return query.data ?? [];
}
