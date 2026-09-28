import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Switch, View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { Btn, Card, Txt } from '../../ui/primitives';
import { Screen, ScreenScroll } from '../../ui/screen';
import { SettingsHeader, SettingsRow } from './SettingsChrome';
import { ServerToggle } from './ServerToggle';
import { useSetCalendarWriteTarget, useToday, useTrust, useTrustAction, useUpcoming } from '../../api/queries';
import {
  useCalendarSettings,
  useDeviceCalendarSync,
} from '../calendar/useDeviceCalendarSync';
import {
  deviceCalendar,
  type CalendarAccess,
  type DeviceEventCalendar,
  type WritableCalendar,
} from '../calendar/deviceCalendar';
import {
  loadChosenCalendarId,
  loadExcludedCalendarIds,
  saveChosenCalendarId,
  saveExcludedCalendarIds,
} from '../../lib/deviceSettings/calendarDevice';
import { calendarReadEnabled, calendarWriteEnabled, icsFeedsEnabled } from '../../config/env';
import { useBusyBlocks, useBusyCalendar } from '../calendar/useBusyCalendar';
import { fill } from '../../i18n/strings';
import { SectionLabel } from '../../ui/chrome';

/** The key a calendar with no account is grouped under. */
const OTHER_SOURCE = 'other';

/** Calendars by account, in the order the phone lists them. */
export function groupByAccount(calendars: readonly DeviceEventCalendar[]): { source: string; calendars: DeviceEventCalendar[] }[] {
  const groups = new Map<string, DeviceEventCalendar[]>();
  for (const calendar of calendars) {
    const source = calendar.sourceName?.trim() || OTHER_SOURCE;
    groups.set(source, [...(groups.get(source) ?? []), calendar]);
  }
  return [...groups.entries()].map(([source, list]) => ({ source, calendars: list }));
}

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
 * ── The calendars already on the phone come first (first iPhone run, L7) ──
 *
 * "I have many calendars connected to my email; they should show up here, I
 * shouldn't have to fill anything in." They do: an account added in the
 * phone's own settings — Google, Outlook, iCloud — reaches this app through
 * the OS calendar. So the top of the screen is reading, with its switch here
 * as well as in the Trust Center, and once the phone allows it every event
 * calendar is listed by account with a switch that stays on until the user
 * turns it off. The choice is kept on this phone (`calendarDevice.ts`; a
 * calendar id means nothing elsewhere) and the busy read skips those
 * calendars. Turning reading on asks the phone first: recording the consent
 * alone left the sync failing, silently, as `denied`.
 *
 * The university calendar link (ICS, UC-3.4) is a secondary row at the
 * bottom, named for what it is. Most people's calendars are already listed.
 *
 * The Android caveat is written on the screen rather than only in an issue.
 * `isCurrentUser` is iOS-only, so a meeting somebody declined still counts as
 * busy on Android, and a product that quietly counted a refused invitation as
 * an hour of the user's day owes them the sentence.
 */
export function CalendarSettingsScreen({ onBack, onFeeds }: { onBack: () => void; onFeeds?: () => void }) {
  const { t, p } = useApp();
  const settings = useCalendarSettings();
  const setTarget = useSetCalendarWriteTarget();
  const today = useToday();
  const upcoming = useUpcoming();
  const sync = useDeviceCalendarSync([today.data, upcoming.data]);
  const busyCalendar = useBusyCalendar();
  const busyBlocks = useBusyBlocks();
  const trust = useTrust();
  const trustAction = useTrustAction();
  const consented = trust.data?.trust?.calendarConsent === true;

  const [access, setAccess] = useState<CalendarAccess | null>(null);
  const [calendars, setCalendars] = useState<WritableCalendar[]>([]);
  const [phoneCalendars, setPhoneCalendars] = useState<DeviceEventCalendar[] | null>(null);
  const [excluded, setExcluded] = useState<string[]>([]);
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

  const loadPhoneCalendars = useCallback(async () => {
    try {
      setPhoneCalendars(await deviceCalendar.listEventCalendars());
    } catch {
      setPhoneCalendars([]);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const current = await deviceCalendar.getAccess();
      const stored = await loadChosenCalendarId();
      const off = await loadExcludedCalendarIds();
      if (cancelled) return;
      setAccess(current);
      setChosen(stored);
      setExcluded(off);
      if (current === 'granted') await Promise.all([loadCalendars(), loadPhoneCalendars()]);
    })();
    return () => { cancelled = true; };
  }, [loadCalendars, loadPhoneCalendars]);

  /** Asks the phone if it has not answered yet; reads the calendars on a yes. */
  const askPhone = useCallback(async (): Promise<CalendarAccess> => {
    const answer = access === 'granted' ? 'granted' : await deviceCalendar.requestAccess();
    setAccess(answer);
    if (answer === 'granted') await Promise.all([loadCalendars(), loadPhoneCalendars()]);
    return answer;
  }, [access, loadCalendars, loadPhoneCalendars]);

  /**
   * Reading on: the phone is asked first, then the consent is recorded.
   *
   * Recorded even when the phone says no. The consent also covers the
   * university calendar link, which needs no phone permission, and a no here
   * is shown with the way to phone settings rather than rolled back — the
   * same rule the reminders switch follows.
   */
  const changeRead = useCallback(async (next: boolean): Promise<boolean> => {
    if (next) await askPhone();
    await trustAction.mutateAsync({ type: 'set_calendar_consent', granted: next });
    return true;
  }, [askPhone, trustAction]);

  /** One calendar on or off for busy time; the next read already knows. */
  const toggleCalendar = useCallback(async (calendarId: string, on: boolean) => {
    const next = on ? excluded.filter((id) => id !== calendarId) : [...excluded, calendarId];
    setExcluded(next);
    await saveExcludedCalendarIds(next);
    void busyCalendar.syncNow('refresh');
  }, [busyCalendar, excluded]);

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
  // What reading needs, all three: the build, the consent and the phone. The
  // list and its switches show only then — a list of calendars with their
  // switches on while nothing is read looks connected and is not (review I1).
  const reading = calendarReadEnabled() && consented && access === 'granted';
  // Anything short of that, on a build that reads and a phone that has not
  // said no: one button that does all of it.
  const canAllow = calendarReadEnabled() && trust.data !== undefined && access !== null && !denied && !reading;
  const [allowing, setAllowing] = useState(false);
  const allow = useCallback(async () => {
    setAllowing(true);
    try {
      await changeRead(true);
    } catch {
      // The switch above shows the same failure on its next attempt; the
      // button simply stays, because nothing changed.
    } finally {
      setAllowing(false);
    }
  }, [changeRead]);

  return (
    <Screen pinned={<SettingsHeader title={t.calendarWriteTitle} onBack={onBack} />}>
      <ScreenScroll>

        {/* Reading first: the calendars already on the phone (L7). */}
        <Card pad={0} style={{ overflow: 'hidden' }}>
          <ServerToggle
            title={t.calendarReadTitle}
            body={t.calendarReadBody}
            value={consented}
            disabled={!calendarReadEnabled() || trust.data === undefined}
            onChange={changeRead}
            testID="calendar-read-toggle"
          />
          {calendarReadEnabled() ? null : (
            <View style={{ paddingHorizontal: 18, paddingVertical: 12 }}>
              <Txt size={13} color={p.mu} lh={1.5} testID="calendar-read-unavailable">
                {t.calendarReadUnavailable}
              </Txt>
            </View>
          )}
          <View style={{ paddingHorizontal: 18, paddingVertical: 14, gap: 4 }}>
            <Txt role="action">{t.calendarDeviceTitle}</Txt>
            <Txt role="supporting" color={p.mu}>{t.calendarDeviceHint}</Txt>
          </View>
          {canAllow ? (
            <View style={{ paddingHorizontal: 18, paddingBottom: 16 }}>
              <Btn
                label={t.calendarDeviceAllow}
                testID="calendar-read-allow"
                disabled={allowing}
                onPress={() => void allow()}
                style={{ borderRadius: 16, minHeight: 52, alignItems: 'center', justifyContent: 'center', backgroundColor: p.ac }}
              >
                <Txt size={15} weight={600} color={p.onAccent}>{t.calendarDeviceAllow}</Txt>
              </Btn>
            </View>
          ) : null}
          {reading && phoneCalendars !== null && phoneCalendars.length === 0 ? (
            <View style={{ paddingHorizontal: 18, paddingBottom: 14 }}>
              <Txt size={13} color={p.mu} testID="calendar-device-none">{t.calendarDeviceNone}</Txt>
            </View>
          ) : null}
          {reading && phoneCalendars ? groupByAccount(phoneCalendars).map(({ source, calendars: list }) => (
            <View key={source} testID={`calendar-account-${source}`} style={{ borderTopWidth: 1, borderTopColor: p.ln, paddingHorizontal: 18, paddingTop: 12 }}>
              <SectionLabel>{source === OTHER_SOURCE ? t.calendarDeviceSourceOther : source}</SectionLabel>
              {list.map((calendar) => {
                const on = !excluded.includes(calendar.id);
                return (
                  <View key={calendar.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52 }}>
                    <Txt role="body" style={{ flex: 1 }}>{calendar.title}</Txt>
                    <Switch
                      testID={`calendar-device-${calendar.id}`}
                      accessibilityRole="switch"
                      accessibilityLabel={`${calendar.title}, ${source === OTHER_SOURCE ? t.calendarDeviceSourceOther : source}`}
                      accessibilityState={{ checked: on }}
                      value={on}
                      trackColor={{ false: p.ln, true: p.ac }}
                      onValueChange={(next) => void toggleCalendar(calendar.id, next)}
                    />
                  </View>
                );
              })}
            </View>
          )) : null}
        </Card>

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

        {/* What has been read, and the way to stop and delete it (UC-3.2, #186). */}
        <Card pad={18} style={{ gap: 12 }}>
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

        {/* A university calendar link (UC-3.4, #188), secondary on purpose:
            the phone's own calendars are listed above with nothing to fill in.
            Absent, not disabled, when the build does not have the feature. */}
        {icsFeedsEnabled() && onFeeds ? (
          <Card pad={0} style={{ overflow: 'hidden', paddingHorizontal: 18 }}>
            <SettingsRow first label={t.calendarUniLinkEntry} sub={t.icsFeedsEntryBody} onPress={onFeeds} testID="calendar-feeds-entry" />
          </Card>
        ) : null}
      </ScreenScroll>
    </Screen>
  );
}
