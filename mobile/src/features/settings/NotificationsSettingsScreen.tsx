import React, { useState } from 'react';
import { Linking, Platform, ScrollView, View } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../../state/AppContext';
import { Btn, Card, Txt } from '../../ui/primitives';
import { ScreenIn } from '../../ui/motion';
import { SettingsHeader, SettingsRow } from './SettingsChrome';
import { ServerToggle } from './ServerToggle';
import { usePlanSettings, useSavePlanSettings } from '../../api/queries';
import { useTimeZone } from '../../i18n/timezone';
import { dayKey, formatRelativeDay, formatTime } from '../../i18n/format';
import { fill, ltr } from '../../i18n/strings';
import { timeShowing, timeShown } from '../plan/pickerClock';

/**
 * Reminders (UC-2.R4, #174) and the morning plan (UC-3.10b, #195).
 *
 * Education and a deep link to the OS settings. This screen deliberately does
 * **not** request the notification permission: iOS only lets an app ask once,
 * and spending that prompt from a settings screen — before the user has asked
 * for anything that would ring — is spending it on the version of the question
 * most likely to be denied. `Linking.openSettings()` sends them to the place
 * the answer can always be changed, which is the honest thing to offer.
 *
 * #195 asks that turning the morning plan on route an *undetermined* permission
 * to UC-3.11 (#196)'s flow. That flow does not exist in this app yet — there is
 * no `src/notifications` — so the switch here changes the server-side setting
 * and nothing about the OS permission. A plan is still built and still shown on
 * this screen and through `maybesitter://plan/<date>`; what a denied permission
 * costs is the tap-the-notification path, which is #196's to add.
 */
export function NotificationsSettingsScreen({ onBack }: { onBack: () => void }) {
  const { t, p, lang, actions } = useApp();
  const insets = useSafeAreaInsets();
  const device = useTimeZone();
  const settings = usePlanSettings();
  const save = useSavePlanSettings();
  const [picking, setPicking] = useState(false);

  const plan = settings.data ?? null;
  const zone = plan?.timezone ?? device;
  const deliveryLocalTime = plan?.deliveryLocalTime ?? null;

  const next = plan?.nextRunAt
    ? `${formatRelativeDay(new Date(plan.nextRunAt), { locale: lang, timeZone: zone })} · ${formatTime(new Date(plan.nextRunAt), { locale: lang, timeZone: zone })}`
    : null;

  return (
    <ScreenIn style={{ backgroundColor: p.bg }}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 8, paddingHorizontal: 20, paddingBottom: 60, gap: 14 }}>
        <SettingsHeader title={t.notifTitle} onBack={onBack} />
        <Card pad={18}>
          <Txt size={15} color={p.mu} lh={1.5}>{t.obNotifBody}</Txt>
        </Card>

        {/* ── Morning plan (UC-3.10b, #195) ───────────────────────────
            The switch's position is the server's answer, never the tap — the
            same rule as the consent toggles. The write returns the stored
            record, `useSavePlanSettings` adopts it, and a failure leaves the
            control where it was with a line saying so. */}
        <Card pad={0} style={{ overflow: 'hidden' }} testID="plan-settings">
          <ServerToggle
            testID="plan-morning-toggle"
            title={t.planMorningTitle}
            body={t.planMorningBody}
            value={plan?.enabled === true}
            // Nothing to write against until the server has answered once.
            disabled={plan === null}
            onChange={async next_ => {
              try {
                const saved = await save.mutateAsync({
                  enabled: next_,
                  // The hour is only sent when the user has one. Omitting it
                  // leaves the stored value alone rather than re-asserting it.
                  ...(deliveryLocalTime ? { deliveryLocalTime } : {}),
                });
                return saved.enabled === next_;
              } catch {
                return false;
              }
            }}
          />
          <SettingsRow
            label={t.planMorningTime}
            value={deliveryLocalTime ? ltr(deliveryLocalTime) : t.planMorningOff}
            testID="plan-delivery-time"
            onPress={plan === null ? undefined : () => setPicking(true)}
          />
          {next ? (
            <View style={{ paddingHorizontal: 18, paddingBottom: 14 }}>
              <Txt size={13} color={p.mu} testID="plan-next-run">{fill(t.planMorningNext, { when: ltr(next) })}</Txt>
            </View>
          ) : null}
          <SettingsRow
            label={t.planOpen}
            testID="plan-open"
            // The device's day, not the server's: this row means "the plan for
            // the day I am in", and the screen it opens reads every time in the
            // plan's own zone once it has one.
            onPress={() => actions.openPlan(dayKey(new Date(), device))}
          />
        </Card>

        {picking && deliveryLocalTime ? (
          <DateTimePicker
            testID="plan-delivery-picker"
            value={timeShowing(deliveryLocalTime)}
            mode="time"
            minuteInterval={15}
            // `deliveryLocalTime` is `HH:mm` on the user's own clock face and
            // nothing else — there is no instant to convert. So the wheel works
            // in the device's own wall clock and the answer is read back off
            // it, with no zone arithmetic in between to get wrong.
            is24Hour
            display={Platform.OS === 'ios' ? 'spinner' : 'default'}
            onChange={(event, value) => {
              setPicking(Platform.OS === 'ios');
              if (event.type === 'dismissed' || !value) return;
              const chosen = timeShown(value);
              if (chosen === deliveryLocalTime) return;
              save.mutate({ enabled: plan?.enabled === true, deliveryLocalTime: chosen });
            }}
          />
        ) : null}

        <Btn
          label={t.notifOpenSettings}
          testID="notifications-open-settings"
          onPress={() => void Linking.openSettings()}
          style={{ borderRadius: 16, minHeight: 52, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: p.ln }}
        >
          <Txt size={15} color={p.ac}>{t.notifOpenSettings}</Txt>
        </Btn>
      </ScrollView>
    </ScreenIn>
  );
}
