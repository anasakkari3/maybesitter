import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Linking, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../../state/AppContext';
import { Btn, Card, Txt } from '../../ui/primitives';
import { ScreenIn } from '../../ui/motion';
import { SettingsHeader } from './SettingsChrome';
import { ServerToggle } from './ServerToggle';
import { useSetCalendarWriteTarget, useToday, useUpcoming } from '../../api/queries';
import {
  useCalendarSettings,
  useDeviceCalendarSync,
} from '../calendar/useDeviceCalendarSync';
import { deviceCalendar, type CalendarAccess, type WritableCalendar } from '../calendar/deviceCalendar';
import { loadChosenCalendarId, saveChosenCalendarId } from '../../lib/deviceSettings/calendarDevice';
import { calendarReadEnabled, calendarWriteEnabled } from '../../config/env';
import { useBusyBlocks, useBusyCalendar } from '../calendar/useBusyCalendar';
import { fill } from '../../i18n/strings';

/**
 * Settings → Calendar (UC-3.1, #185).
 *
 * Three controls, in the order somebody actually makes the decision: whether to
 * write at all, which calendar to write into, and a way to undo everything that
 * was written.
 *
 * ── The permission is asked for here, and only here ──────────────
 *
 * Turning the switch on is the moment the request makes sense: the person has
 * just said they want their commitments in their calendar, so the OS prompt is
 * answering a question they asked. Asking on first launch — or from the sync
 * pass, in the background — spends the one prompt iOS gives on the version of
 * the question most likely to be refused.
 *
 * ── A refusal is explained, not swallowed ────────────────────────
 *
 * If they say no, the switch goes back to off (it never shows "on" for a thing
 * that cannot happen), the screen says what was refused, and it offers
 * `Linking.openSettings()` — the only place the answer can still be changed,
 * because iOS will not prompt a second time. Nothing crashes and nothing
 * retries silently.
 *
 * ── Why the calendar picker is on the device ─────────────────────
 *
 * A calendar id means nothing on another phone, so the choice is stored here
 * rather than on the account. The list shows the source — "iCloud", "Google",
 * the account name — because a person with a work account and a personal one
 * usually has two calendars both called "Calendar", and picking the wrong one
 * puts their dentist appointment in front of their colleagues.
 *
 * ── Reading is a separate thing from writing, and says so ────────
 *
 * UC-3.2 (#186) added the bottom half: what MaybeSitter reads *out* of the
 * calendar, how many busy times this phone has found, and the way to stop and
 * delete them. It is its own card rather than another line under the write
 * toggle because they are two different permissions in the user's head — "put
 * my things in my calendar" and "look at my calendar" — and the switch that
 * governs reading is not here at all: it is the Trust Center's calendar
 * consent, which is where every other "may we use this" lives.
 *
 * The Android caveat is written on the screen rather than only in an issue.
 * `isCurrentUser` is iOS-only, so a meeting somebody declined still counts as
 * busy on Android, and a product that quietly counted a refused invitation as
 * an hour of the user's day owes them the sentence.
 */
export function CalendarSettingsScreen({ onBack }: { onBack: () => void }) {
  const { t, p } = useApp();
  const insets = useSafeAreaInsets();
  const settings = useCalendarSettings();
  const setTarget = useSetCalendarWriteTarget();
  const today = useToday();
  const upcoming = useUpcoming();
  const sync = useDeviceCalendarSync([today.data, upcoming.data]);
  const busyCalendar = useBusyCalendar();
  const busyBlocks = useBusyBlocks();

  const [access, setAccess] = useState<CalendarAccess | null>(null);
  const [calendars, setCalendars] = useState<WritableCalendar[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [removed, setRemoved] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [disconnected, setDisconnected] = useState<null | 'done' | 'localOnly'>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  const target = settings.data?.calendarSettings.writeTarget ?? 'off';
  const on = target === 'device';

  const loadCalendars = useCallback(async () => {
    try {
      setCalendars(await deviceCalendar.listWritableCalendars());
    } catch {
      // A read that fails is a list nobody can pick from, which the screen
      // already renders as "no calendar chosen". It is not an error to report.
      setCalendars([]);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const current = await deviceCalendar.getAccess();
      const stored = await loadChosenCalendarId();
      if (cancelled) return;
      setAccess(current);
      setChosen(stored);
      if (current === 'granted') await loadCalendars();
    })();
    return () => { cancelled = true; };
  }, [loadCalendars]);

  /**
   * Turning it on: ask the OS first, and write the setting only if it said yes.
   *
   * The order matters. Saving `device` and then being refused would leave the
   * account claiming it writes to a calendar this device cannot reach — and the
   * switch on a second device would show "on" for a feature that had never
   * worked anywhere.
   */
  const change = useCallback(async (next: boolean): Promise<boolean> => {
    if (!next) {
      await setTarget.mutateAsync('off');
      return true;
    }
    const granted = access === 'granted' ? 'granted' : await deviceCalendar.requestAccess();
    setAccess(granted);
    if (granted !== 'granted') return false;
    await loadCalendars();
    await setTarget.mutateAsync('device');
    return true;
  }, [access, loadCalendars, setTarget]);

  const pick = useCallback(async (calendarId: string) => {
    setChosen(calendarId);
    await saveChosenCalendarId(calendarId);
    // The pass had nothing to write into until now.
    await sync.runNow();
  }, [sync]);

  const removeAll = useCallback(async () => {
    setBusy(true);
    setRemoved(null);
    try {
      const result = await sync.removeAll();
      if (result.permissionDenied) setAccess('denied');
      else setRemoved(result.removed);
    } finally {
      setBusy(false);
    }
  }, [sync]);

  const disconnect = useCallback(async () => {
    setDisconnecting(true);
    setDisconnected(null);
    try {
      const result = await busyCalendar.disconnect();
      setDisconnected(result.server ? 'done' : 'localOnly');
    } finally {
      setDisconnecting(false);
    }
  }, [busyCalendar]);

  const denied = access === 'denied';

  return (
    <ScreenIn style={{ backgroundColor: p.bg }}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 8, paddingHorizontal: 20, paddingBottom: 60, gap: 14 }}>
        <SettingsHeader title={t.calendarWriteTitle} onBack={onBack} />

        <Card pad={0} style={{ overflow: 'hidden' }}>
          <ServerToggle
            title={t.calendarWriteToggle}
            body={t.calendarWriteBody}
            value={on}
            disabled={!calendarWriteEnabled() || settings.isLoading}
            onChange={change}
            testID="calendar-write-toggle"
          />
        </Card>

        {/* The build switch, said out loud. A toggle that does nothing because
            of a flag the user cannot see is worse than a toggle that is absent. */}
        {calendarWriteEnabled() ? null : (
          <Card pad={18}>
            <Txt size={13} color={p.mu} lh={1.5} testID="calendar-write-unavailable">
              {t.calendarWriteUnavailable}
            </Txt>
          </Card>
        )}

        {denied ? (
          <Card pad={18} style={{ gap: 12 }}>
            <Txt size={15} color={p.mu} lh={1.5} testID="calendar-permission-denied">
              {t.calendarPermissionDenied}
            </Txt>
            <Btn
              label={t.notifOpenSettings}
              testID="calendar-open-settings"
              onPress={() => void Linking.openSettings()}
              style={{ borderRadius: 16, minHeight: 52, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: p.ln }}
            >
              <Txt size={15} color={p.ac}>{t.notifOpenSettings}</Txt>
            </Btn>
          </Card>
        ) : null}

        {on && !denied ? (
          <Card pad={0} style={{ overflow: 'hidden' }}>
            <View style={{ paddingVertical: 14, paddingHorizontal: 18 }}>
              <Txt size={15}>{t.calendarPickTitle}</Txt>
              <Txt size={13} color={p.mu} lh={1.5}>{t.calendarPickBody}</Txt>
            </View>
            {calendars.map((calendar, index) => (
              <Btn
                key={calendar.id}
                label={calendar.title}
                testID={`calendar-option-${calendar.id}`}
                onPress={() => void pick(calendar.id)}
                scaleTo={0.98}
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  paddingVertical: 16,
                  paddingHorizontal: 18,
                  minHeight: 52,
                  borderTopWidth: index === 0 ? 1 : 1,
                  borderTopColor: p.ln,
                }}
              >
                {/* The source, not just the name: two accounts usually both
                    have a calendar called "Calendar". */}
                <Txt size={15}>{calendar.sourceName ? `${calendar.title} · ${calendar.sourceName}` : calendar.title}</Txt>
                {chosen === calendar.id ? <Txt size={13} color={p.ac}>{t.done}</Txt> : null}
              </Btn>
            ))}
            {calendars.length === 0 ? (
              <View style={{ paddingVertical: 14, paddingHorizontal: 18, borderTopWidth: 1, borderTopColor: p.ln }}>
                <Txt size={13} color={p.mu} testID="calendar-none-writable">{t.calendarNoneWritable}</Txt>
              </View>
            ) : null}
          </Card>
        ) : null}

        {/* What is read, as opposed to what is written (UC-3.2, #186). */}
        <Card pad={18} style={{ gap: 12 }}>
          <Txt size={15}>{t.calendarReadTitle}</Txt>
          <Txt size={13} color={p.mu} lh={1.5}>{t.calendarReadBody}</Txt>
          {calendarReadEnabled() ? null : (
            <Txt size={13} color={p.mu} lh={1.5} testID="calendar-read-unavailable">
              {t.calendarReadUnavailable}
            </Txt>
          )}
          <Txt size={13} color={p.mu} testID="calendar-busy-count">
            {fill(t.calendarBusyCount, { n: busyBlocks.length })}
          </Txt>
          <Txt size={13} color={p.mu} lh={1.5} testID="calendar-declined-note">{t.calendarDeclinedNote}</Txt>
          <Txt size={13} color={p.mu} lh={1.5}>{t.calendarDisconnectBody}</Txt>
          <Btn
            label={t.calendarDisconnectAction}
            testID="calendar-disconnect"
            onPress={() => void disconnect()}
            disabled={disconnecting}
            style={{ borderRadius: 16, minHeight: 52, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: p.ln }}
          >
            {disconnecting
              ? <ActivityIndicator testID="calendar-disconnect-busy" color={p.ac} />
              : <Txt size={15} color={p.ac}>{t.calendarDisconnectAction}</Txt>}
          </Btn>
          {disconnected === null ? null : (
            <Txt size={13} color={p.mu} lh={1.5} testID="calendar-disconnect-result">
              {disconnected === 'done' ? t.calendarDisconnectDone : t.calendarDisconnectFailed}
            </Txt>
          )}
        </Card>

        <Card pad={18} style={{ gap: 12 }}>
          <Txt size={13} color={p.mu} lh={1.5}>{t.calendarRemoveBody}</Txt>
          <Btn
            label={t.calendarRemoveAction}
            testID="calendar-remove-all"
            onPress={() => void removeAll()}
            disabled={busy}
            style={{ borderRadius: 16, minHeight: 52, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: p.ln }}
          >
            {busy
              ? <ActivityIndicator testID="calendar-remove-busy" color={p.ac} />
              : <Txt size={15} color={p.ac}>{t.calendarRemoveAction}</Txt>}
          </Btn>
          {removed === null ? null : (
            <Txt size={13} color={p.mu} testID="calendar-removed-count">{t.calendarRemoveDone}</Txt>
          )}
        </Card>
      </ScrollView>
    </ScreenIn>
  );
}
