import React, { useEffect, useRef, useState } from 'react';
import { AppState, Linking, Platform, View } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useApp } from '../../state/AppContext';
import { Btn, Card, Pill, Txt } from '../../ui/primitives';
import { Screen, ScreenScroll } from '../../ui/screen';
import {
  usePlanSettings,
  useProfile,
  useReminderSettings,
  useSavePlanSettings,
  useSaveReminderSettings,
} from '../../api/queries';
import { useTimeZone } from '../../i18n/timezone';
import { dayKey, formatClockRange, formatRelativeDay, formatTime } from '../../i18n/format';
import { fill, ltr } from '../../i18n/strings';
import {
  getNotificationPermission,
  requestNotificationPermission,
  type NotificationPermission,
} from '../../notifications/permission';
import { refreshPushAfterPrompt } from '../../notifications/pushRegistration';
import { softRemindersEnabled } from '../../config/env';
import { quietChoiceFor, quietWindowFor, type QuietChoice } from '../routine/routineProfile';
import { timeShowing, timeShown } from '../plan/pickerClock';
import { ServerToggle } from './ServerToggle';
import { canScheduleExactAlarms, openExactAlarmSettings } from '../../notifications/exactAlarms';
import { toEngineSettings } from '../reminders/reminderInputs';
import type { EscalationCeiling } from '../reminders/policy';
import { SettingsHeader, SettingsRow } from './SettingsChrome';

/**
 * Everything this app may put on somebody's lock screen, in one place:
 * reminders (UC-2.R4 #174, with the controls from UC-3.11 #196) and the
 * morning plan (UC-3.10b, #195).
 *
 * ── The OS prompt: here, and after the first timed confirm ──────
 *
 * iOS allows one permission prompt per install. It is asked at the moment the
 * user turns something that rings **on** — the version of the question a
 * person is most likely to say yes to, because they have just asked for the
 * thing it is about. Onboarding deliberately does not ask
 * (`onboardingFlow.test.tsx` asserts it at the source), and nothing asks at
 * cold start. The one other place is `notifications/firstMomentPrompt.ts`,
 * right after the first confirmed commitment with a time — reminders default
 * on, so this switch alone was never touched. And when something rings but
 * the phone was never asked, this screen asks in the app; "Open phone
 * settings" is shown only after a no, the one answer only Settings can undo.
 *
 * A denial is not an error and is not a rollback. The setting is what the user
 * wants; the permission is what the phone currently allows. So the switch
 * stays where they put it, the row says the phone is set to show nothing, and
 * `Linking.openSettings()` — which this screen has offered since #174 — is the
 * only place that answer can be changed. The answer is read on mount and on
 * every return to the foreground (#475), and when ringing is chosen but the
 * phone cannot ring, the Must control says so itself.
 *
 * ── Both switches ask, and that is not two prompts ───────────────
 *
 * #195 asked that turning the morning plan on route an *undetermined*
 * permission to UC-3.11 (#196)'s flow. When #195 was written that flow did not
 * exist — there was no `src/notifications` — so the switch changed the
 * server-side setting and nothing about the OS permission. It exists now, and
 * the morning plan is a **push**: `planMorningBody` promises "one note when
 * it's ready", the server sends it, and `routeFromNotification` already routes
 * a `plan_ready` payload to `maybesitter://plan/<date>`. A user who turned the
 * morning plan on without ever being asked would have been promised a note
 * their phone was never allowed to show. So `askForPermission` is called from
 * this switch too, on the way on, exactly as the reminders switch calls it.
 *
 * That does not spend a second prompt. `requestNotificationPermission` reads
 * the current status first and returns it unchanged unless it is
 * `undetermined`, so whichever of the two switches the user reaches first is
 * the one that asks, and the other one silently learns the answer. Which is
 * the routing #195 wanted: one prompt, spent by whichever thing the user
 * actually asked for.
 *
 * The plan itself does not depend on it. A plan is still built, still shown on
 * this screen, and still reachable through `maybesitter://plan/<date>` and the
 * "see today's plan" row; what a denied permission costs is the tap-the-
 * notification path, which is why the denial line is a statement of fact and
 * not a rollback.
 *
 * ── Quiet hours are the routine survey's, on purpose ─────────────
 *
 * The same four windows, the same store. See `quietWindowFor` in
 * `features/routine/routineProfile.ts`.
 */
const LEAD_MINUTES = [60, 30, 15] as const;
const CEILINGS: readonly EscalationCeiling[] = ['soft', 'followUp', 'hard'];
const QUIET_CHOICES: readonly QuietChoice[] = ['none', 'early', 'standard', 'late'];

export function NotificationsSettingsScreen({ onBack }: { onBack: () => void }) {
  const { t, p, lang, actions } = useApp();
  const device = useTimeZone();
  const settings = useReminderSettings();
  const profile = useProfile();
  const save = useSaveReminderSettings();
  const planSettings = usePlanSettings();
  const savePlan = useSavePlanSettings();
  // What the phone allows, as last read. `null` until the first read lands.
  const [osPermission, setOsPermission] = useState<NotificationPermission | null>(null);
  // Every read and every ask takes a number; only the newest may write, so a
  // mount read that resolves after the prompt cannot overwrite its answer.
  const permissionRead = useRef(0);
  const [failed, setFailed] = useState(false);
  const [picking, setPicking] = useState(false);
  const [explainingHard, setExplainingHard] = useState(false);
  // Bumped when the app comes back to the foreground, so the exact-alarm note
  // re-reads a permission the user may just have granted in system settings.
  const [foregrounded, setForegrounded] = useState(0);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') setForegrounded(value => value + 1);
    });
    return () => subscription.remove();
  }, []);

  /*
   * #475: the phone's answer is read on mount and on every return to the
   * foreground, not only when this session fired the prompt. Someone who said
   * no last week, or who has just allowed notifications in phone settings,
   * sees what the phone allows now.
   */
  useEffect(() => {
    const read = ++permissionRead.current;
    void getNotificationPermission().then(status => {
      if (read === permissionRead.current) setOsPermission(status);
    });
  }, [foregrounded]);
  const current = settings.data?.reminderSettings;
  const quietChoice = quietChoiceFor(current?.quietHours ?? null) ?? 'none';
  /*
   * The Must-reminder controls as the engine will read them — through the same
   * function, so a server that has not sent the fields yet shows the survey's
   * legacy answer here and schedules by it there, rather than the screen and
   * the phone disagreeing about whether this account rings (#197).
   */
  const engine = current
    ? toEngineSettings(current, profile.data?.routine?.preferredReminderIntensity ?? 'softAwareness')
    : null;
  const ceiling: EscalationCeiling = engine?.escalationCeiling ?? 'soft';
  const ringing = engine !== null && engine.hardEnabled && engine.escalationCeiling === 'hard';
  // Read at render, and re-read on `foregrounded`. It is one synchronous
  // native call; only Android can ever answer no.
  const exactDenied = ringing && Platform.OS === 'android' && foregrounded >= 0 && !canScheduleExactAlarms();
  const killed = !softRemindersEnabled();
  /*
   * Ringing is chosen but the phone will not ring (#475). The saved choice is
   * left alone, so allowing notifications later simply works; the Must
   * control says what is in the way. `provisional` is not `denied`, but it
   * delivers quietly to Notification Centre, which cannot ring either.
   */
  const mustSectionShown = !killed && current?.softEnabled === true;
  const ringBlocked =
    mustSectionShown && ringing && (osPermission === 'denied' || osPermission === 'provisional')
      ? osPermission
      : null;
  // The general line at the bottom, for every other denied case. When the
  // Must warning is up it already says notifications are off, so the same
  // fact is not stated twice on one screen.
  const permissionDenied = osPermission === 'denied' && ringBlocked === null;
  // Something that rings is on and the phone has never been asked (first
  // iPhone run, L7): soft reminders default on at the server, so the switch
  // that asks was never touched. The app asks here, in the app — phone
  // settings is only for undoing a no, and has no switch to show before one.
  const needsAsking = osPermission === 'undetermined' && !killed
    && (current?.softEnabled === true || planSettings.data?.enabled === true);

  const plan = planSettings.data ?? null;
  const zone = plan?.timezone ?? device;
  const deliveryLocalTime = plan?.deliveryLocalTime ?? null;

  const next = plan?.nextRunAt
    ? `${formatRelativeDay(new Date(plan.nextRunAt), { locale: lang, timeZone: zone })} · ${formatTime(new Date(plan.nextRunAt), { locale: lang, timeZone: zone })}`
    : null;

  const leadLabel: Record<number, string> = {
    60: t.notifLead60,
    30: t.notifLead30,
    15: t.notifLead15,
  };
  const ceilingLabel: Record<EscalationCeiling, string> = {
    soft: t.notifCeilingSoft,
    followUp: t.notifCeilingFollowUp,
    hard: t.notifCeilingHard,
  };
  // Built from the window the chip saves, so the label cannot drift from it,
  // and in the app's one time-range style: Latin digits, one left-to-right
  // unit. The copy used to spell these out per language, and Arabic's said
  // «٢٢:٣٠ – ٠٧:٣٠» beside every other time's «09:00» (UAT 2026-09-26).
  const quietLabel = (choice: QuietChoice): string => {
    const window = quietWindowFor(choice);
    return window ? formatClockRange(window.start, window.end) : t.notifQuietNone;
  };

  /**
   * The one prompt, asked on the way *on* and from nowhere else.
   *
   * Shared by both switches rather than written twice: two copies of "ask,
   * then decide what a denial means" is two rules that drift, and the rule is
   * the same either way — the phone's answer is reported, never acted on.
   */
  const askForPermission = async (): Promise<void> => {
    const read = ++permissionRead.current;
    const before = osPermission;
    const status = await requestNotificationPermission();
    if (read === permissionRead.current) setOsPermission(status);
    // A yes reaches the server's device row now, not at the next cold launch.
    await refreshPushAfterPrompt(before, status);
  };

  const setEnabled = async (next_: boolean): Promise<boolean> => {
    // Asked before the write, and only on the way on. Turning reminders off
    // needs no permission, and asking then would spend the one prompt on the
    // question nobody wants answered.
    if (next_) await askForPermission();
    try {
      await save.mutateAsync({ softEnabled: next_ });
      setFailed(false);
      return true;
    } catch {
      setFailed(true);
      return false;
    }
  };

  /*
   * The ceiling (#197 step 2).
   *
   * "Ring for Must items" is never one tap. It opens the explainer, and only
   * its confirm writes — so the one choice here that can make a phone ring is
   * the one choice made with the rules in front of the person. Anything gentler
   * writes straight away and turns ringing off in the same write: the opt-in
   * and the ceiling travel together, so there is no state in which the screen
   * shows "Gentle only" and a Must commitment still rings.
   */
  const chooseCeiling = (choice: EscalationCeiling) => {
    setFailed(false);
    if (choice === 'hard') {
      if (!ringing) setExplainingHard(true);
      return;
    }
    setExplainingHard(false);
    save.mutate({ escalationCeiling: choice, hardEnabled: false }, { onError: () => setFailed(true) });
  };

  const confirmHard = async () => {
    setExplainingHard(false);
    setFailed(false);
    // Ringing is a thing that rings: the same one prompt, on the way on.
    await askForPermission();
    try {
      await save.mutateAsync({ escalationCeiling: 'hard', hardEnabled: true });
    } catch {
      setFailed(true);
    }
  };

  const setLead = (minutes: number) => {
    setFailed(false);
    save.mutate({ softLeadMinutes: minutes }, { onError: () => setFailed(true) });
  };

  /*
   * The zone a quiet window is wall-clock in.
   *
   * The routine profile's, when there is one: a user who answered the survey
   * in Tel Aviv and opened the app in Berlin still means 22:30 Tel Aviv until
   * they redo the survey, which is the rule `quietTimeZone` states in
   * `features/reminders/reminderInputs.ts`.
   *
   * When there is *no* profile, `GET /api/mobile/settings/reminders` answers
   * `timezone: "UTC"` — a fallback the server invented because nobody has told
   * it anything, not an answer anyone gave. Echoing it back was this screen's
   * bug: the first person to set quiet hours without having done the survey
   * had "22:30–07:30" stored as UTC, so in Israel the app went quiet from
   * 01:30 to 10:30 and spoke at 23:00 — on the phone *and* in every server
   * push, because the write-through makes this the profile's zone too. The
   * zone somebody setting quiet hours means is the one they are standing in,
   * which is what `device` holds — `useTimeZone` re-reads it when the app
   * comes back to the foreground, so a traveller who has not redone the survey
   * still gets the zone they are in now.
   *
   * The window's own zone is the middle fallback for the one frame before the
   * profile query resolves; in the app it has already resolved, because
   * `RemindersMount` holds `useProfile` open for the whole session.
   */
  const quietTimeZone = (): string =>
    profile.data?.routine?.timezone ?? current?.quietHours?.timezone ?? device;

  const setQuiet = (choice: QuietChoice) => {
    setFailed(false);
    const window = quietWindowFor(choice);
    save.mutate(
      {
        quietHours: window
          ? { start: window.start, end: window.end, timezone: quietTimeZone() }
          : null,
      },
      { onError: () => setFailed(true) },
    );
  };

  return (
    <Screen pinned={<SettingsHeader title={t.notifTitle} onBack={onBack} />}>
      <ScreenScroll>
        <Card pad={18}>
          <Txt size={15} color={p.mu} lh={1.5}>{t.obNotifBody}</Txt>
        </Card>

        {/* The kill switch is a fact about this build, not a control: when it
            is thrown the section is not there to be argued with, and the
            engine has already cancelled everything pending. It is the soft
            reminder engine's switch and nothing else — the morning plan is
            built and sent by the server, so it stays below either way. */}
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
                  label={quietLabel(choice)}
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

        {/* ── Must reminders (UC-3.12a, #197) ─────────────────────────
            Inside the same gate as the gentle controls: the reminders switch
            governs every stage the phone schedules, the Must one included, so
            a ceiling shown while the switch is off would be a control that
            does nothing. */}
        {killed || !current?.softEnabled ? null : (
          <Card pad={18} testID="must-reminders" style={{ gap: 10 }}>
            <Txt size={15}>{t.notifMustTitle}</Txt>
            <Txt size={13} color={p.mu} lh={1.5}>{t.notifMustBody}</Txt>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {CEILINGS.map(choice => {
                // A `hard` ceiling without the opt-in — the survey's "be firm"
                // answer — schedules exactly what "Gentle + follow-up" does, so
                // that is the chip that reads as chosen until the user confirms
                // ringing.
                const effective = ceiling === 'hard' ? 'followUp' : ceiling;
                const selected = choice === 'hard' ? ringing : !ringing && effective === choice;
                return (
                  <Pill
                    key={choice}
                    label={ceilingLabel[choice]}
                    // Chosen but blocked by the phone (#475) must not look
                    // like chosen and working: warm, not the accent.
                    kind={selected ? (choice === 'hard' && ringBlocked ? 'warm' : 'accent') : 'outline'}
                    size={14}
                    pad={12}
                    testID={`must-ceiling-${choice}`}
                    onPress={() => chooseCeiling(choice)}
                  />
                );
              })}
            </View>

            {explainingHard ? (
              <View testID="must-hard-explainer" style={{ gap: 10, paddingTop: 6 }}>
                <Txt size={15}>{t.notifHardExplainTitle}</Txt>
                <Txt size={13} color={p.mu} lh={1.5}>{t.notifHardExplainBody}</Txt>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Pill
                    label={t.notifHardExplainConfirm}
                    kind="accent"
                    size={14}
                    pad={12}
                    style={{ flex: 1 }}
                    testID="must-hard-confirm"
                    onPress={() => void confirmHard()}
                  />
                  <Pill
                    label={t.notifHardExplainCancel}
                    kind="outline"
                    size={14}
                    pad={12}
                    style={{ flex: 1 }}
                    testID="must-hard-cancel"
                    onPress={() => setExplainingHard(false)}
                  />
                </View>
              </View>
            ) : null}

            {ringBlocked ? (
              <View style={{ gap: 8 }} testID="must-ring-blocked">
                <Txt size={13} color={p.wm} lh={1.5} testID={`must-ring-${ringBlocked}`}>
                  {ringBlocked === 'denied' ? t.notifMustRingDenied : t.notifMustRingProvisional}
                </Txt>
                <Pill
                  label={t.notifOpenSettings}
                  kind="outline"
                  size={14}
                  pad={12}
                  testID="must-ring-open-settings"
                  onPress={() => void Linking.openSettings()}
                />
              </View>
            ) : null}

            {ringing ? (
              <ServerToggle
                title={t.notifMustQuiet}
                body={t.notifMustQuietBody}
                value={engine?.mustThroughQuietHours === true}
                onChange={async next_ => {
                  try {
                    const saved = await save.mutateAsync({ mustThroughQuietHours: next_ });
                    return saved.reminderSettings.mustThroughQuietHours === next_;
                  } catch {
                    return false;
                  }
                }}
                testID="must-through-quiet-switch"
              />
            ) : null}

            {/* Calm, and not an error: the reminder is still scheduled, and
                expo-notifications falls back to an inexact alarm. */}
            {exactDenied ? (
              <View style={{ gap: 8 }}>
                <Txt size={13} color={p.mu} lh={1.5} testID="must-exact-denied">{t.notifExactDenied}</Txt>
                <Pill
                  label={t.notifExactOpen}
                  kind="outline"
                  size={14}
                  pad={12}
                  testID="must-exact-open"
                  onPress={() => {
                    if (!openExactAlarmSettings()) void Linking.openSettings();
                  }}
                />
              </View>
            ) : null}
          </Card>
        )}

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
              // The plan arrives as a push, so the permission is asked here on
              // the way on for the same reason the reminders switch asks — and
              // a denial does not stop the write. See the note at the top.
              if (next_) await askForPermission();
              try {
                const saved = await savePlan.mutateAsync({
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
          {/* ── Continuous replanning (#523, AC 9) ─────────────────────
              Its own field on the same record, so it lives on the same card —
              and nowhere near the calendar connections, because switching it
              off must not read as disconnecting one (it does not).

              The write names this field and nothing else. The route accepts a
              PUT without `enabled` for exactly this case, so the phone never
              re-sends a morning value it only has cached — which, after another
              device turned the morning plan on, would turn it back off. */}
          <ServerToggle
            testID="plan-replan-toggle"
            title={t.planReplanTitle}
            body={t.planReplanBody}
            value={plan?.continuousReplanEnabled === true}
            disabled={plan === null}
            onChange={async next_ => {
              try {
                const saved = await savePlan.mutateAsync({ continuousReplanEnabled: next_ });
                return saved.continuousReplanEnabled === next_;
              } catch {
                return false;
              }
            }}
          />
          <View style={{ paddingHorizontal: 18, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: p.ln }}>
            {/* Said whichever way the switch sits: the moment it matters is
                before somebody turns it off, not after. Disabling drains the
                pending changes, so re-enabling cannot replay them. */}
            <Txt size={13} color={p.mu} lh={1.5} testID="plan-replan-no-backfill">{t.planReplanNoBackfill}</Txt>
          </View>
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
              savePlan.mutate({ enabled: plan?.enabled === true, deliveryLocalTime: chosen });
            }}
          />
        ) : null}

        {permissionDenied ? (
          <Txt size={13} color={p.mu} lh={1.5} testID="notifications-denied">{t.notifDenied}</Txt>
        ) : null}
        {failed ? (
          <Txt size={13} color={p.wm} testID="notifications-save-failed">{t.notifSaveFailed}</Txt>
        ) : null}

        {needsAsking ? (
          <Card pad={18} style={{ gap: 12 }} testID="notifications-not-asked">
            <Txt size={13} color={p.mu} lh={1.5}>{t.notifAllowBody}</Txt>
            <Btn
              label={t.notifAllowAction}
              testID="notifications-allow"
              onPress={() => void askForPermission()}
              style={{ borderRadius: 16, minHeight: 52, alignItems: 'center', justifyContent: 'center', backgroundColor: p.ac }}
            >
              <Txt size={15} weight={600} color={p.onAccent}>{t.notifAllowAction}</Txt>
            </Btn>
          </Card>
        ) : null}

        {/* Only for a no: it is the one place a no can be undone. Before the
            phone has been asked there is no switch there to find. */}
        {osPermission === 'denied' ? (
          <Btn
            label={t.notifOpenSettings}
            testID="notifications-open-settings"
            onPress={() => void Linking.openSettings()}
            style={{ borderRadius: 16, minHeight: 52, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: p.ln }}
          >
            <Txt size={15} color={p.ac}>{t.notifOpenSettings}</Txt>
          </Btn>
        ) : null}
      </ScreenScroll>
    </Screen>
  );
}
