import React, { useCallback, useState } from 'react';
import { Linking, Switch, View } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useApp } from '../../state/AppContext';
import { Btn, Card, Txt } from '../../ui/primitives';
import { LiveRegion } from '../../ui/liveRegion';
import { SectionLabel } from '../../ui/chrome';
import { fill } from '../../i18n/strings';
import { isolate, isolateAuto } from '../../i18n/bidi';
import { formatRelativeDay } from '../../i18n/format';
import { useTimeZone } from '../../i18n/timezone';
import { getPhoneSources, revokePhoneSource } from '../../api/endpoints/m5a';
import type { PhoneSource } from '../../api/schemas/m5a';
import { useTrustAction } from '../../api/queries';
import { useGoogleStatus } from '../google/useGoogle';
import type { CalendarAccess, DeviceEventCalendar } from '../calendar/deviceCalendar';
import type { BusyCalendarState } from '../calendar/useBusyCalendar';
import { SelectionNotSavedError, shownIncluded, type M5aCalendarView } from '../calendar/m5aCalendar';
import { groupByAccount, OTHER_SOURCE } from './CalendarSettingsScreen';

/**
 * Settings → Calendar on an enrolled phone (M5a R1.2): four sections, each
 * naming exactly one thing and who allowed what —
 *
 *  1. the phone's permission, with the only button that asks the OS;
 *  2. whether MaybeSitter uses the calendar at all (the Trust consent), a
 *     switch that never prompts the OS;
 *  3. the calendars read, grouped by the accounts added to this phone, every
 *     one off until the person turns it on (D8);
 *  4. the Google account connected to MaybeSitter, which is a different thing
 *     from the phone's accounts above (image 13).
 *
 * Plus the other phones that send busy time, each removable (M5A-R58-002).
 */

/** iOS's own local calendar sources, which it names in English (SIM-M5A-03). */
const LOCAL_SOURCE_KEYS: Readonly<Record<string, 'm5CalLocalDefault' | 'm5CalLocalOther' | 'm5CalLocalSubscribed'>> = {
  Default: 'm5CalLocalDefault',
  Other: 'm5CalLocalOther',
  'Subscribed Calendars': 'm5CalLocalSubscribed',
};

export function M5aCalendarSections({
  uid, view, access, phoneCalendars, consented, trustLoaded, onAskPhone, busyCalendar,
}: {
  uid: string;
  view: M5aCalendarView;
  access: CalendarAccess | null;
  phoneCalendars: DeviceEventCalendar[] | null;
  consented: boolean;
  trustLoaded: boolean;
  onAskPhone: () => Promise<unknown>;
  busyCalendar: BusyCalendarState;
}) {
  const { t, p, actions } = useApp();
  const trustAction = useTrustAction();
  const google = useGoogleStatus();
  const [needsPermission, setNeedsPermission] = useState(false);
  const [asking, setAsking] = useState(false);
  const shown = shownIncluded(view);
  const granted = access === 'granted';

  const ask = useCallback(async () => {
    setAsking(true);
    try {
      await onAskPhone();
      setNeedsPermission(false);
    } finally {
      setAsking(false);
    }
  }, [onAskPhone]);

  const changeUse = useCallback((next: boolean) => {
    // The switch never asks the OS: that is section 1's button (R1.2).
    if (next && !granted) {
      setNeedsPermission(true);
      return;
    }
    setNeedsPermission(false);
    trustAction.mutate({ type: 'set_calendar_consent', granted: next });
  }, [granted, trustAction]);

  const toggle = useCallback(async (calendarId: string, on: boolean) => {
    try {
      // Applied to the newest selection at save time, not to this render's list (M5A-R3-005).
      await busyCalendar.toggleCalendar(calendarId, on);
    } catch (error) {
      // The line under the list says it; the switch never moved.
      if (!(error instanceof SelectionNotSavedError)) throw error;
    }
  }, [busyCalendar]);

  const googleStatus = google.data;
  // The connected account's address: an LTR run inside the line.
  const email = googleStatus?.status === 'connected' && googleStatus.features.calendar ? googleStatus.accountEmail : null;
  const googleLine = email ? fill(t.m5CalGooglePrimary, { email: isolate(email) }) : t.m5CalGoogleNone;

  return (
    <>
      <Card pad={18} style={{ gap: 10 }} testID="calendar-perm-section">
        <SectionLabel>{t.m5CalPermTitle}</SectionLabel>
        {access === null ? null : (
          <Txt role="supporting" color={access === 'denied' ? p.wm : p.mu} testID="calendar-perm-state">
            {access === 'granted' ? t.m5CalPermGranted : access === 'denied' ? t.m5CalPermDenied : t.m5CalPermUnasked}
          </Txt>
        )}
        {access !== null && access !== 'granted' && access !== 'denied' ? (
          <ActionButton testID="calendar-perm-allow" label={t.m5CalPermAsk} disabled={asking} primary onPress={() => void ask()} />
        ) : null}
        {access === 'denied' ? (
          <ActionButton testID="calendar-perm-open-settings" label={t.m5CalPermOpen} onPress={() => void Linking.openSettings()} />
        ) : null}
      </Card>

      <Card pad={18} style={{ gap: 8 }} testID="calendar-use-section">
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={{ flex: 1, gap: 4, alignItems: 'flex-start' }}>
            <Txt role="action">{t.m5CalUseTitle}</Txt>
            <Txt role="supporting" color={p.mu}>{t.m5CalUseBody}</Txt>
          </View>
          <Switch
            testID="calendar-use-toggle"
            accessibilityRole="switch"
            accessibilityLabel={t.m5CalUseTitle}
            accessibilityState={{ checked: consented, disabled: false }}
            value={consented}
            disabled={!trustLoaded}
            trackColor={{ false: p.ln, true: p.ac }}
            onValueChange={changeUse}
          />
        </View>
        <LiveRegion>
          {needsPermission ? <Txt role="supporting" color={p.wm} testID="calendar-use-needs-permission">{t.m5CalUseNeedsPerm}</Txt> : null}
        </LiveRegion>
      </Card>

      <Card pad={0} style={{ overflow: 'hidden' }} testID="calendar-list-section">
        <View style={{ paddingHorizontal: 18, paddingTop: 14, paddingBottom: 10, gap: 4, alignItems: 'flex-start' }}>
          <Txt role="action">{t.m5CalListTitle}</Txt>
          <Txt role="supporting" color={p.mu}>{t.m5CalListHint}</Txt>
        </View>
        <LiveRegion style={{ paddingHorizontal: 18, gap: 8 }}>
          {view.saveFailed ? <Txt role="supporting" color={p.wm} testID="calendar-save-failed">{t.m5CalSaveFailed}</Txt> : null}
          {view.clearFailed ? <Txt role="supporting" color={p.wm} testID="calendar-clear-failed">{t.m5CalClearFailed}</Txt> : null}
          {view.tooManyPhones ? <Txt role="supporting" color={p.wm} testID="calendar-too-many-phones">{t.m5CalTooManyPhones}</Txt> : null}
        </LiveRegion>
        {view.removed ? (
          <View style={{ paddingHorizontal: 18, paddingBottom: 14, gap: 10, alignItems: 'flex-start' }}>
            <Txt role="supporting" color={p.wm} testID="calendar-this-phone-removed">{t.m5CalThisPhoneRemoved}</Txt>
            <ActionButton testID="calendar-this-phone-rejoin" label={t.m5CalThisPhoneRejoin} onPress={() => void busyCalendar.rejoin()} />
          </View>
        ) : null}
        {!view.removed && consented && shown.length === 0 ? (
          <View style={{ paddingHorizontal: 18, paddingBottom: 12 }}>
            <Txt role="supporting" color={p.wm} testID="calendar-none-chosen">{t.m5CalNoneChosen}</Txt>
          </View>
        ) : null}
        {granted && phoneCalendars ? groupByAccount(phoneCalendars).map(({ source, calendars }) => {
          const account = source === OTHER_SOURCE ? t.calendarDeviceSourceOther : source;
          // iOS names its own local sources in English whatever the language
          // (SIM-M5A-03): those get our words; a real account keeps its name.
          const local = Object.hasOwn(LOCAL_SOURCE_KEYS, source) ? LOCAL_SOURCE_KEYS[source] : undefined;
          return (
            <View key={source} testID={`calendar-account-${source}`} style={{ borderTopWidth: 1, borderTopColor: p.ln, paddingHorizontal: 18, paddingTop: 12 }}>
              <SectionLabel>{local ? t[local] : fill(t.m5CalListGroup, { account: isolateAuto(account) })}</SectionLabel>
              {calendars.map((calendar) => {
                const on = shown.includes(calendar.id);
                return (
                  <View key={calendar.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52 }}>
                    <Txt role="body" style={{ flex: 1 }}>{calendar.title}</Txt>
                    <Switch
                      testID={`calendar-include-${calendar.id}`}
                      accessibilityRole="switch"
                      accessibilityLabel={fill(t.m5CalCalendarA11y, { title: calendar.title, account })}
                      accessibilityState={{ checked: on, disabled: view.removed || !view.enrolled }}
                      value={on}
                      disabled={view.removed || !view.enrolled}
                      trackColor={{ false: p.ln, true: p.ac }}
                      onValueChange={(next) => void toggle(calendar.id, next)}
                    />
                  </View>
                );
              })}
            </View>
          );
        }) : null}
      </Card>

      {view.enrolled ? <OtherPhones uid={uid} ownSourceId={view.sourceId} /> : null}

      <Card pad={18} style={{ gap: 10 }} testID="calendar-google-section">
        <SectionLabel>{t.m5CalGoogleTitle}</SectionLabel>
        <Txt role="supporting" color={p.mu} testID="calendar-google-line">{googleLine}</Txt>
        <ActionButton testID="calendar-google-open" label={t.m5CalGoogleOpen} onPress={() => actions.go('googleIntegration')} />
      </Card>
    </>
  );
}

/** «تلفونات تانية بتبعتلنا أوقات مشغولة»: every registration but this phone's, each removable. */
function OtherPhones({ uid, ownSourceId }: { uid: string; ownSourceId: string | null }) {
  const { t, p, lang } = useApp();
  const zone = useTimeZone();
  const client = useQueryClient();
  const key = ['user', uid, 'calendarPhoneSources'] as const;
  const sources = useQuery({
    queryKey: key,
    queryFn: () => getPhoneSources({ asUid: uid }),
    enabled: uid !== 'signed-out',
    retry: false,
  });
  const [removing, setRemoving] = useState<string | null>(null);
  const others = (sources.data?.sources ?? []).filter((source) => source.sourceId !== ownSourceId);
  if (others.length === 0) return null;

  const label = (source: PhoneSource) => (source.platform === 'ios' ? 'iPhone' : source.platform === 'android' ? 'Android' : t.m5CalOtherPhoneUnknown);
  const day = (at: string) => formatRelativeDay(new Date(at), { locale: lang, timeZone: zone });
  const line = (source: PhoneSource) => {
    if (source.status === 'clearing' || source.status === 'retiring') return `${label(source)} · ${t.m5CalOtherPhoneClearing}`;
    if (source.lastUploadAt === null) return `${label(source)} · ${t.m5CalOtherPhoneNotFinished}`;
    return fill(t.m5CalOtherPhoneRow, { platform: label(source), date: day(source.lastUploadAt) });
  };
  const remove = async (sourceId: string) => {
    setRemoving(sourceId);
    try {
      await revokePhoneSource(sourceId, { asUid: uid });
    } catch {
      // The row stays; the next look shows what the server holds.
    } finally {
      setRemoving(null);
      void client.invalidateQueries({ queryKey: key });
    }
  };

  return (
    <Card pad={0} style={{ overflow: 'hidden' }} testID="calendar-other-phones">
      <View style={{ paddingHorizontal: 18, paddingTop: 14, paddingBottom: 6 }}>
        <Txt role="action">{t.m5CalOtherPhones}</Txt>
      </View>
      {others.map((source) => (
        <View key={source.sourceId} testID={`calendar-other-phone-${source.sourceId}`}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, paddingHorizontal: 18, borderTopWidth: 1, borderTopColor: p.ln }}>
          <Txt role="supporting" style={{ flex: 1 }}>{line(source)}</Txt>
          <Btn
            testID={`calendar-other-phone-remove-${source.sourceId}`}
            label={fill(t.m5CalOtherPhoneRemoveA11y, {
              platform: label(source),
              date: source.lastUploadAt ? day(source.lastUploadAt) : t.m5CalOtherPhoneNotFinished,
            })}
            disabled={removing !== null}
            onPress={() => void remove(source.sourceId)}
            style={{ minHeight: 44, minWidth: 44, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center', borderRadius: 14, borderWidth: 1, borderColor: p.ln }}
          >
            <Txt size={14} color={p.ac}>{t.m5CalOtherPhoneRemove}</Txt>
          </Btn>
        </View>
      ))}
    </Card>
  );
}

function ActionButton({ testID, label, onPress, disabled, primary }: {
  testID: string; label: string; onPress: () => void; disabled?: boolean; primary?: boolean;
}) {
  const { p } = useApp();
  return (
    <Btn
      testID={testID}
      label={label}
      disabled={disabled}
      onPress={onPress}
      style={{
        alignSelf: 'stretch', borderRadius: 16, minHeight: 52, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16,
        ...(primary ? { backgroundColor: p.ac } : { borderWidth: 1, borderColor: p.ln }),
      }}
    >
      <Txt size={15} weight={primary ? 600 : 400} color={primary ? p.onAccent : p.ac} align="center">{label}</Txt>
    </Btn>
  );
}
