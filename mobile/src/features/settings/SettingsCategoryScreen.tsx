import React from 'react';
import { useApp } from '../../state/AppContext';
import { useAuth } from '../../auth/AuthProvider';
import { Card } from '../../ui/primitives';
import { Screen, ScreenScroll } from '../../ui/screen';
import { SettingsHeader, SettingsRow } from './SettingsChrome';
import { useSourcesAvailability } from './sourcesAvailability';

export type SettingsCategory = 'day' | 'connections' | 'alerts' | 'privacy' | 'app';

/** Short category pages keep every setting findable without a 20-row index. */
export function SettingsCategoryScreen({ category, onBack }: { category: SettingsCategory; onBack: () => void }) {
  const { t } = useApp();
  const title = {
    day: t.settingsCategoryDay,
    connections: t.settingsCategoryConnections,
    alerts: t.settingsCategoryAlerts,
    privacy: t.settingsCategoryPrivacy,
    app: t.settingsCategoryApp,
  }[category];
  return <Screen pinned={<SettingsHeader title={title} onBack={onBack} />}>
    <ScreenScroll gap={12} bottom={24}>
      <Card pad={0} style={{ paddingHorizontal: 16 }} testID={`settings-group-${category}`}>
        {category === 'day' ? <DayRows /> : null}
        {category === 'connections' ? <ConnectionRows /> : null}
        {category === 'alerts' ? <AlertRows /> : null}
        {category === 'privacy' ? <PrivacyRows /> : null}
        {category === 'app' ? <AppRows /> : null}
      </Card>
    </ScreenScroll>
  </Screen>;
}

function DayRows() {
  const { t, actions } = useApp();
  return <>
    <SettingsRow first label={t.xMy} icon="person" testID="settings-my" onPress={() => actions.go('myMaybeSitter')} />
    <SettingsRow label={t.settingsRoutine} icon="calendar" testID="settings-routine" onPress={() => actions.go('routineSettings')} />
    <SettingsRow label={t.wbTitle} icon="calendar" testID="settings-weekly-blocks" onPress={() => actions.go('weeklyBlocks')} />
    <SettingsRow label={t.settingsEnergy} icon="habit" testID="settings-readiness" onPress={() => actions.go('readinessSettings')} />
    <SettingsRow label={t.settingsParts} icon="goal" testID="settings-categories" onPress={() => actions.go('categorySettings')} />
    <SettingsRow label={t.financialTitle} icon="file" testID="settings-financial" onPress={() => actions.go('financialContext')} />
  </>;
}

function ConnectionRows() {
  const { t, actions } = useApp();
  const sources = useSourcesAvailability();
  return <>
    <SettingsRow first label={t.xIntegrations} icon="link" testID="settings-integrations" onPress={() => actions.go('integrations')} />
    <SettingsRow label={t.aiImportTitle} icon="spark" testID="settings-ai-import" onPress={() => actions.go('aiImport')} />
    <SettingsRow label={t.calendarWriteTitle} icon="calendar" testID="settings-calendar" onPress={() => actions.go('calendarSettings')} />
    {sources.any ? <SettingsRow label={t.settingsSources} icon="link" testID="settings-sources" onPress={() => actions.go('sources')} /> : null}
    <SettingsRow label={t.xBackground} icon="watch" testID="settings-background" onPress={() => actions.go('backgroundActivity')} />
  </>;
}

function AlertRows() {
  const { t, actions } = useApp();
  return <>
    <SettingsRow first label={t.settingsAlertsNotifications} icon="watch" testID="settings-notifications" onPress={() => actions.go('notificationsSettings')} />
    <SettingsRow label={t.settingsWidget} icon="calendar" testID="settings-widget" onPress={() => actions.go('widgetSettings')} />
    <SettingsRow label={t.placesTitle} icon="goal" testID="settings-places" onPress={() => actions.go('places')} />
  </>;
}

function PrivacyRows() {
  const { t, actions } = useApp();
  return <>
    <SettingsRow first label={t.xPersonalization} icon="person" testID="settings-personalization" onPress={() => actions.go('personalization')} />
    <SettingsRow label={t.settingsKnows} icon="habit" testID="settings-knows" onPress={() => actions.go('knows')} />
    <SettingsRow label={t.sTrust} icon="shield" testID="settings-trust" onPress={() => actions.go('trust')} />
    <SettingsRow label={t.activityTitle} icon="file" testID="settings-activity" onPress={() => actions.go('activity')} />
  </>;
}

function AppRows() {
  const { t, actions } = useApp();
  const { user } = useAuth();
  return <>
    <SettingsRow first label={t.settingsLangAppearance} icon="spark" testID="settings-language" onPress={() => actions.go('langAppearance')} />
    {user ? <SettingsRow label={t.accountTitle} icon="person" testID="settings-account" onPress={() => actions.go('account')} /> : null}
    <SettingsRow label={t.settingsAbout} icon="spark" testID="settings-about" onPress={() => actions.go('about')} />
  </>;
}
