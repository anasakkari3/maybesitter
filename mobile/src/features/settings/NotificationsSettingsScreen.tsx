import React, { useState } from 'react';
import { Linking, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../../state/AppContext';
import { Btn, Card, Pill, Txt } from '../../ui/primitives';
import { ScreenIn } from '../../ui/motion';
import { useReminderSettings, useSaveReminderSettings } from '../../api/queries';
import { requestNotificationPermission } from '../../notifications/permission';
import { softRemindersEnabled } from '../../config/env';
import { quietChoiceFor, quietWindowFor, type QuietChoice } from '../routine/routineProfile';
import { ServerToggle } from './ServerToggle';
import { SettingsHeader } from './SettingsChrome';

/**
 * Reminders (UC-2.R4 #174, and the controls from UC-3.11 #196).
 *
 * ── This screen owns the OS prompt, and only here ────────────────
 *
 * iOS allows one permission prompt per install. It is asked at the moment the
 * user turns gentle reminders **on** — the version of the question a person is
 * most likely to say yes to, because they have just asked for the thing it is
 * about. Onboarding deliberately does not ask (`onboardingFlow.test.tsx`
 * asserts it at the source), and nothing asks at cold start.
 *
 * A denial is not an error and is not a rollback. The setting is what the user
 * wants; the permission is what the phone currently allows. So the switch
 * stays where they put it, the row says the phone is set to show nothing, and
 * `Linking.openSettings()` — which this screen has offered since #174 — is the
 * only place that answer can be changed.
 *
 * ── Quiet hours are the routine survey's, on purpose ─────────────
 *
 * The same four windows, the same store. See `quietWindowFor` in
 * `features/routine/routineProfile.ts`.
 */
const LEAD_MINUTES = [60, 30, 15] as const;
const QUIET_CHOICES: readonly QuietChoice[] = ['none', 'early', 'standard', 'late'];

export function NotificationsSettingsScreen({ onBack }: { onBack: () => void }) {
  const { t, p } = useApp();
  const insets = useSafeAreaInsets();
  const settings = useReminderSettings();
  const save = useSaveReminderSettings();
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [failed, setFailed] = useState(false);

  const current = settings.data?.reminderSettings;
  const quietChoice = quietChoiceFor(current?.quietHours ?? null) ?? 'none';
  const killed = !softRemindersEnabled();

  const leadLabel: Record<number, string> = {
    60: t.notifLead60,
    30: t.notifLead30,
    15: t.notifLead15,
  };
  const quietLabel: Record<QuietChoice, string> = {
    none: t.notifQuietNone,
    early: t.notifQuietEarly,
    standard: t.notifQuietStandard,
    late: t.notifQuietLate,
  };

  const setEnabled = async (next: boolean): Promise<boolean> => {
    // Asked before the write, and only on the way *on*. Turning reminders off
    // needs no permission, and asking then would spend the one prompt on the
    // question nobody wants answered.
    if (next) setPermissionDenied((await requestNotificationPermission()) === 'denied');
    try {
      await save.mutateAsync({ softEnabled: next });
      setFailed(false);
      return true;
    } catch {
      setFailed(true);
      return false;
    }
  };

  const setLead = (minutes: number) => {
    setFailed(false);
    save.mutate({ softLeadMinutes: minutes }, { onError: () => setFailed(true) });
  };

  const setQuiet = (choice: QuietChoice) => {
    setFailed(false);
    const window = quietWindowFor(choice);
    save.mutate(
      {
        quietHours: window
          ? { start: window.start, end: window.end, timezone: current?.timezone ?? 'UTC' }
          : null,
      },
      { onError: () => setFailed(true) },
    );
  };

  return (
    <ScreenIn style={{ backgroundColor: p.bg }}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 8, paddingHorizontal: 20, paddingBottom: 60, gap: 14 }}>
        <SettingsHeader title={t.notifTitle} onBack={onBack} />
        <Card pad={18}>
          <Txt size={15} color={p.mu} lh={1.5}>{t.obNotifBody}</Txt>
        </Card>

        {/* The kill switch is a fact about this build, not a control: when it
            is thrown the section is not there to be argued with, and the
            engine has already cancelled everything pending. */}
        {killed ? null : (
          <Card pad={0} testID="gentle-reminders">
            <ServerToggle
              title={t.notifGentleOn}
              body={t.notifGentleBody}
              value={current?.softEnabled ?? false}
              disabled={current === undefined}
              onChange={setEnabled}
              testID="gentle-reminders-switch"
            />
          </Card>
        )}

        {killed || !current?.softEnabled ? null : (
          <>
            <Txt size={13} color={p.mu}>{t.notifLeadTitle}</Txt>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {LEAD_MINUTES.map(minutes => (
                <Pill
                  key={minutes}
                  label={leadLabel[minutes] as string}
                  kind={current.softLeadMinutes === minutes ? 'accent' : 'outline'}
                  size={14}
                  pad={12}
                  style={{ flex: 1 }}
                  testID={`reminder-lead-${minutes}`}
                  onPress={() => setLead(minutes)}
                />
              ))}
            </View>

            <Txt size={13} color={p.mu}>{t.notifQuietTitle}</Txt>
            <Txt size={13} color={p.mu} lh={1.5}>{t.notifQuietBody}</Txt>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {QUIET_CHOICES.map(choice => (
                <Pill
                  key={choice}
                  label={quietLabel[choice]}
                  kind={quietChoice === choice ? 'accent' : 'outline'}
                  size={14}
                  pad={12}
                  testID={`reminder-quiet-${choice}`}
                  onPress={() => setQuiet(choice)}
                />
              ))}
            </View>
          </>
        )}

        {permissionDenied ? (
          <Txt size={13} color={p.mu} lh={1.5} testID="notifications-denied">{t.notifDenied}</Txt>
        ) : null}
        {failed ? (
          <Txt size={13} color={p.wm} testID="notifications-save-failed">{t.notifSaveFailed}</Txt>
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
