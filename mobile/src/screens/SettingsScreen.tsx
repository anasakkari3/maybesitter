import React from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import { useAuth } from '../auth/AuthProvider';
import { LANGUAGE_ENDONYM } from '../i18n/language';
import { fill } from '../i18n/strings';
import { Btn, Card, Pill, Txt } from '../ui/primitives';
import { LegalLinks } from '../features/legal/LegalLinks';
import { ScreenIn } from '../ui/motion';

export function SettingsScreen() {
  const { t, p, langPref, themePref, actions } = useApp();
  const { user, signOut } = useAuth();
  const insets = useSafeAreaInsets();
  const themeValue = themePref === 'system' ? t.vSystem : themePref === 'light' ? t.vLight : t.vDark;
  // A language is named in itself, never translated — so "English" stays
  // "English" on an Arabic screen. "System" is the one word that is copy.
  const languageValue = langPref === 'system' ? t.vSystem : LANGUAGE_ENDONYM[langPref];

  // Every row now goes somewhere (UC-2.R4 #174). `sBudget` is deliberately
  // absent: it was a pilot-era spend display, and #181 moved the cost guard to
  // the server where the user has nothing to decide about it.
  const rows: { label: string; value: string; onPress?: () => void; testID?: string }[] = [
    { label: t.sAppearance, value: themeValue, onPress: actions.cycleTheme, testID: 'settings-appearance' },
    { label: t.sLanguage, value: languageValue, onPress: actions.cycleLanguage, testID: 'settings-language' },
    { label: t.settingsRoutine, value: '', onPress: () => actions.go('routineSettings'), testID: 'settings-routine' },
    { label: t.readinessTitle, value: '', onPress: () => actions.go('readinessSettings'), testID: 'settings-readiness' },
    { label: t.financialTitle, value: '', onPress: () => actions.go('financialContext'), testID: 'settings-financial' },
    { label: t.settingsCategories, value: '', onPress: () => actions.go('categorySettings'), testID: 'settings-categories' },
    { label: t.sNotif, value: '', onPress: () => actions.go('notificationsSettings'), testID: 'settings-notifications' },
    { label: t.calendarWriteTitle, value: '', onPress: () => actions.go('calendarSettings'), testID: 'settings-calendar' },
    { label: t.widgetSettingsTitle, value: '', onPress: () => actions.go('widgetSettings'), testID: 'settings-widget' },
    { label: t.footballTitle, value: '', onPress: () => actions.go('footballSettings'), testID: 'settings-football' },
    { label: t.sTrust, value: '', onPress: () => actions.go('trust'), testID: 'settings-trust' },
    { label: t.activityTitle, value: '', onPress: () => actions.go('activity'), testID: 'settings-activity' },
    { label: t.sHistory, value: '', onPress: () => actions.go('feedbackHistory'), testID: 'settings-history' },
    { label: t.settingsAbout, value: '', onPress: () => actions.go('about'), testID: 'settings-about' },
  ];

  return (
    <ScreenIn style={{ backgroundColor: p.bg }}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 8, paddingHorizontal: 20, paddingBottom: 130, gap: 14 }}>
        <Txt size={28} weight={600} lh={1.3}>{t.settingsTitle}</Txt>
        <Card pad={0} style={{ overflow: 'hidden' }}>
          {rows.map((r, i) => (
            <Btn
              key={r.label}
              onPress={r.onPress}
              disabled={!r.onPress}
              scaleTo={r.onPress ? 0.98 : 1}
              label={r.label}
              style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 16, paddingHorizontal: 18, minHeight: 52, borderBottomWidth: i < rows.length - 1 ? 1 : 0, borderBottomColor: p.ln }}
            >
              <Txt size={15} {...(r.testID ? { testID: r.testID } : {})}>{r.label}</Txt>
              <Txt size={13} color={p.mu}>{r.value}</Txt>
            </Btn>
          ))}
        </Card>
        {/* Only rendered once a legal site is configured — see
            src/config/legalLinks.ts on why a dead policy link is worse than
            none (UC-4.2 #177). */}
        <LegalLinks />

        {user ? (
          <Card pad={18} style={{ gap: 14 }}>
            <Txt size={13} weight={600} color={p.mu}>{t.settingsAccount}</Txt>
            {/* An Apple private-relay address is not the user's email and
                showing it as one is a small lie; UC-1.1 (#145) sets no email
                for that provider, so the absence names itself. */}
            <Txt size={14} color={p.mu}>
              {user.email
                ? fill(t.authSignedInAs, { email: user.email })
                : t.authSignedInPrivateApple}
            </Txt>
            <Pill label={t.authSignOut} kind="outline" size={15} onPress={() => void signOut({ reason: 'user' })} />
            {/* Destructive, but not shouting: warm rather than the red the
                design does not have, and last in the section so it is never
                the thing a thumb lands on by accident (UC-1.5 #149). */}
            <Btn
              label={t.accountDelete}
              onPress={() => actions.go('deleteAccount')}
              style={{ paddingVertical: 10, alignItems: 'flex-start' }}
            >
              <Txt size={15} weight={600} color={p.wm}>{t.accountDelete}</Txt>
            </Btn>
          </Card>
        ) : null}
        <View style={{ paddingHorizontal: 6 }}>
          <Txt size={12} color={p.mu}>{t.settingsNote}</Txt>
        </View>
      </ScrollView>
    </ScreenIn>
  );
}
