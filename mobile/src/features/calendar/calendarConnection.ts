/**
 * What the Trust Center says about the calendar (UAT round 6, D-d, shot 845).
 *
 * The row under the Trust Center's calendar switch used to be one fixed
 * sentence — «مش موصول من هون» — while Settings → Calendar showed writing on,
 * a calendar chosen, and events landing three seconds after a confirm. A line
 * about somebody's calendar that is true only when nothing is connected is a
 * line that lies to everybody who connected it.
 *
 * So the line is decided from the same answers the Calendar screen renders
 * from, read the same way:
 *
 * - reading is the build, the consent and the phone (`reading` there);
 * - writing is the build, the account's write target and a phone that has not
 *   refused (the write toggle's `on && !denied`);
 * - a calendar counts as chosen when one was picked on this phone, or when the
 *   phone offers exactly one (`shownChosen` there, `adoptSoleCalendar` in the
 *   sync pass); two or more and none picked is `calendarPickNeeded`.
 *
 * A refusal is not a line: the Trust screen already shows the refusal and the
 * way to phone settings under the switch, and saying it twice is noise.
 */
import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import type { CalendarWriteTarget } from '../../api/schemas/calendar';
import { calendarReadEnabled, calendarWriteEnabled } from '../../config/env';
import { loadChosenCalendarId } from '../../lib/deviceSettings/calendarDevice';
import { deviceCalendar, type CalendarAccess } from './deviceCalendar';
import { useCalendarSettings } from './useDeviceCalendarSync';

export interface CalendarConnectionInput {
  readEnabled: boolean;
  writeEnabled: boolean;
  /** The Trust Center's calendar consent, as the server last said it. */
  readConsent: boolean;
  writeTarget: CalendarWriteTarget;
  /** The phone's answer, or null before it has been read. */
  access: CalendarAccess | null;
  /** Picked on this phone, or null. */
  chosenCalendarId: string | null;
  /** What this phone can write into, or null before it has been listed. */
  writableCalendarIds: readonly string[] | null;
}

/** A copy key for the line, `denied` for the refusal card, or null while unknown. */
export type CalendarConnectionLine =
  | 'trustCalendarNotConnected'
  | 'trustCalendarWriting'
  | 'trustCalendarReadingWriting'
  | 'calendarReadBody'
  | 'calendarPickNeeded'
  | 'calendarNoneWritable'
  | 'denied'
  | null;

export function calendarConnectionLine(input: CalendarConnectionInput): CalendarConnectionLine {
  if (input.access === null) return null;
  const wantsRead = input.readEnabled && input.readConsent;
  const wantsWrite = input.writeEnabled && input.writeTarget === 'device';
  if (input.access === 'denied') return wantsRead || wantsWrite ? 'denied' : 'trustCalendarNotConnected';
  // Not asked on this phone yet: nothing is read or written from here, which
  // is what «مش موصول من هون» says, and Calendar settings has the button.
  if (input.access !== 'granted') return 'trustCalendarNotConnected';
  if (wantsWrite) {
    const writable = input.writableCalendarIds;
    if (writable === null) return null;
    if (writable.length === 0) return 'calendarNoneWritable';
    const chosen = input.chosenCalendarId ?? (writable.length === 1 ? writable[0]! : null);
    if (chosen === null) return 'calendarPickNeeded';
    return wantsRead ? 'trustCalendarReadingWriting' : 'trustCalendarWriting';
  }
  return wantsRead ? 'calendarReadBody' : 'trustCalendarNotConnected';
}

/**
 * The line for this phone, read on mount and again whenever the app comes back
 * to the front — the phone's answer and the chosen calendar only change
 * elsewhere (phone settings, Settings → Calendar).
 *
 * `setAccess` is for the Trust switch, which asks the phone itself on the way
 * on and already has the answer.
 */
export function useCalendarConnection(readConsent: boolean): {
  line: CalendarConnectionLine;
  access: CalendarAccess | null;
  setAccess: (access: CalendarAccess) => void;
} {
  const settings = useCalendarSettings();
  const [access, setAccessState] = useState<CalendarAccess | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [writable, setWritable] = useState<string[] | null>(null);

  const listWritable = useCallback(async (current: CalendarAccess) => {
    if (current !== 'granted') return;
    try {
      setWritable((await deviceCalendar.listWritableCalendars()).map((calendar) => calendar.id));
    } catch {
      // A list that will not load is nothing to write into, which is what the
      // Calendar screen shows for it too.
      setWritable([]);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const [current, stored] = await Promise.all([deviceCalendar.getAccess(), loadChosenCalendarId()]);
      if (cancelled) return;
      setAccessState(current);
      setChosen(stored);
      await listWritable(current);
    };
    void refresh();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh();
    });
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, [listWritable]);

  const setAccess = useCallback((next: CalendarAccess) => {
    setAccessState(next);
    void listWritable(next);
  }, [listWritable]);

  const line = calendarConnectionLine({
    readEnabled: calendarReadEnabled(),
    writeEnabled: calendarWriteEnabled(),
    readConsent,
    writeTarget: settings.data?.calendarSettings.writeTarget ?? 'off',
    access,
    chosenCalendarId: chosen,
    writableCalendarIds: writable,
  });
  return { line, access, setAccess };
}
