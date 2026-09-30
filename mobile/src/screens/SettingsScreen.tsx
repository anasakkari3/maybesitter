import React from 'react';
import { View } from 'react-native';
import { useApp } from '../state/AppContext';
import { Card } from '../ui/primitives';
import { ScreenHeader } from '../ui/chrome';
import { Screen, ScreenScroll } from '../ui/screen';
import { SettingsRow } from '../features/settings/SettingsChrome';
import { useNotificationPermission } from '../notifications/useNotificationPermission';

/** Five clear destinations; the detailed controls live one level down. */
export function SettingsScreen({ tabClearance = 130 }: { tabClearance?: number } = {}) {
  const { t, actions } = useApp();
  const notificationPermission = useNotificationPermission();
  const categories = [
    { screen: 'settingsDay', label: t.settingsCategoryDay, icon: 'calendar', id: 'settings-category-day' },
    { screen: 'settingsConnections', label: t.settingsCategoryConnections, icon: 'link', id: 'settings-category-connections' },
    { screen: 'settingsAlerts', label: t.settingsCategoryAlerts, icon: 'watch', id: 'settings-category-alerts' },
    { screen: 'settingsPrivacy', label: t.settingsCategoryPrivacy, icon: 'shield', id: 'settings-category-privacy' },
    { screen: 'settingsApp', label: t.settingsCategoryApp, icon: 'person', id: 'settings-category-app' },
  ] as const;

  return <Screen>
    {/* The viewport itself ends above the floating tab bar; rows never sit
        visibly behind a bar that would intercept their taps. */}
    <ScreenScroll testID="settings-scroll" style={{ marginBottom: tabClearance }} bottom={24} gap={12} topGap={8}>
      <ScreenHeader title={t.settingsTitle} />
      <View style={{ gap: 10 }}>
        {categories.map(category => <Card key={category.screen} pad={0} style={{ paddingHorizontal: 16 }}>
          <SettingsRow first label={category.label} icon={category.icon}
            {...(category.screen === 'settingsAlerts' && notificationPermission === 'denied'
              ? { sub: t.notifBlockedByPhone, subTone: 'warn' as const, subTestID: 'settings-alerts-blocked' }
              : {})}
            testID={category.id} onPress={() => actions.go(category.screen)} />
        </Card>)}
      </View>
    </ScreenScroll>
  </Screen>;
}
