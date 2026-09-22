import React from 'react';
import { View } from 'react-native';
import { useApp } from '../state/AppContext';
import { useAuth } from '../auth/AuthProvider';
import { useMemory, usePlanSettings, useTrust } from '../api/queries';
import { LANGUAGE_ENDONYM } from '../i18n/language';
import { fill, ltr } from '../i18n/strings';
import { icsFeedsEnabled } from '../config/env';
import { Card, Txt } from '../ui/primitives';
import { ScreenHeader, SectionLabel } from '../ui/chrome';
import { Screen, ScreenScroll } from '../ui/screen';
import { SettingsRow } from '../features/settings/SettingsChrome';

/**
 * Settings (Round 2, Phase I): four groups, each row saying what is behind
 * it before it is opened.
 *
 * Round 1 was a flat list of thirteen rows in the order the features were
 * built, two of which cycled a value on tap. Round 2 groups them by what the
 * person is thinking about — themselves, what the app is connected to, how
 * it speaks to them, and what it holds about them — and every row goes to a
 * screen. Language and appearance are pickers now; the account is a screen;
 * the two "sources" that add commitments on their own (calendar links,
 * matches) share a hub.
 *
 * The row names are the user-facing ones from the concept map in
 * docs/design/round-2-feature-matrix.md; the screen names underneath did not
 * change.
 */
export function SettingsScreen() {
  const { t, tr, p, langPref, themePref, actions } = useApp();
  const { user } = useAuth();
  const trust = useTrust();
  const memory = useMemory();
  const planSettings = usePlanSettings();

  const themeValue = themePref === 'system' ? t.vSystem : themePref === 'light' ? t.vLight : t.vDark;
  // A language is named in itself, never translated — so "English" stays
  // "English" on an Arabic screen. "System" is the one word that is copy.
  const languageValue = langPref === 'system' ? t.vSystem : LANGUAGE_ENDONYM[langPref];
  const calendarOn = trust.data?.trust.calendarConsent === true;
  const morning = planSettings.data;
  const memoryCount = memory.data?.items.length;

  return (
    <Screen>
      <ScreenScroll bottom={130} gap={24} topGap={8}>
        <ScreenHeader title={t.settingsTitle} />

        <Group title={t.settingsGroupYou}>
          <SettingsRow first label={t.settingsRoutine} sub={t.settingsRoutineSub} onPress={() => actions.go('routineSettings')} testID="settings-routine" />
          <SettingsRow label={t.settingsEnergy} sub={t.settingsEnergySub} onPress={() => actions.go('readinessSettings')} testID="settings-readiness" />
          <SettingsRow label={t.settingsParts} sub={t.settingsPartsSub} onPress={() => actions.go('categorySettings')} testID="settings-categories" />
          <SettingsRow label={t.settingsLangAppearance} value={`${languageValue} · ${themeValue}`} onPress={() => actions.go('langAppearance')} testID="settings-language" />
        </Group>

        <Group title={t.settingsGroupConnections}>
          <SettingsRow first label={t.calendarWriteTitle} sub={calendarOn ? t.settingsCalendarSubOn : t.settingsCalendarSubOff} onPress={() => actions.go('calendarSettings')} testID="settings-calendar" />
          <SettingsRow label={t.settingsSources} sub={t.settingsSourcesSub} onPress={() => actions.go('sources')} testID="settings-sources" />
        </Group>

        <Group title={t.settingsGroupReminders}>
          <SettingsRow first label={t.notifTitle} sub={t.settingsRemindersSub} onPress={() => actions.go('notificationsSettings')} testID="settings-notifications" />
          <SettingsRow
            label={t.settingsMorning}
            sub={morning ? (morning.enabled ? fill(t.settingsMorningSub, { t: ltr(morning.deliveryLocalTime) }) : t.settingsMorningOff) : undefined}
            onPress={() => actions.go('notificationsSettings')}
            testID="settings-morning"
          />
          <SettingsRow label={t.settingsWidget} sub={t.settingsWidgetSub} onPress={() => actions.go('widgetSettings')} testID="settings-widget" />
        </Group>

        <Group title={t.settingsGroupTrust}>
          <SettingsRow first label={t.settingsKnows} sub={memoryCount === undefined ? undefined : tr('settingsKnowsSub', { n: memoryCount })} onPress={() => actions.go('knows')} testID="settings-knows" />
          <SettingsRow label={t.sTrust} onPress={() => actions.go('trust')} testID="settings-trust" />
          <SettingsRow label={t.activityTitle} onPress={() => actions.go('activity')} testID="settings-activity" />
          {user ? <SettingsRow label={t.accountTitle} sub={user.email ? fill(t.settingsAccountSub, { email: ltr(user.email) }) : t.authSignedInPrivateApple} onPress={() => actions.go('account')} testID="settings-account" /> : null}
          <SettingsRow label={t.settingsAbout} onPress={() => actions.go('about')} testID="settings-about" />
        </Group>

        {/* Only when the feature is compiled in and a feed hub exists: a row
            that leads nowhere is worse than none. */}
        {icsFeedsEnabled() ? null : null}
        <View style={{ paddingHorizontal: 12 }}>
          {user?.email ? <Txt size={12} color={p.mu} align="center">{fill(t.authSignedInAs, { email: ltr(user.email) })}</Txt> : null}
        </View>
      </ScreenScroll>
    </Screen>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      <SectionLabel>{title}</SectionLabel>
      <Card pad={0} style={{ paddingHorizontal: 16 }}>{children}</Card>
    </View>
  );
}
