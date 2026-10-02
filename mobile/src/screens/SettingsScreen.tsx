import React from 'react';
import { View } from 'react-native';
import { useApp } from '../state/AppContext';
import { Card } from '../ui/primitives';
import { BackHeader } from '../ui/chrome';
import { Screen, ScreenScroll } from '../ui/screen';
import { SettingsRow } from '../features/settings/SettingsChrome';
import { useNotificationPermission } from '../notifications/useNotificationPermission';

/**
 * Five clear destinations; the detailed controls live one level down.
 *
 * Since the Stitch redesign (2026-10-02) Settings is opened from the avatar in
 * a tab root's header, not from the bar. It is pushed onto that tab, so it
 * renders without the bar and the «احكيها» pill, and its back — this header's
 * and Android's — returns to the tab it was opened from.
 */
export function SettingsScreen() {
  const { t, actions } = useApp();
  const notificationPermission = useNotificationPermission();
  const categories = [
    { screen: 'settingsDay', label: t.settingsCategoryDay, icon: 'calendar', id: 'settings-category-day' },
    { screen: 'settingsConnections', label: t.settingsCategoryConnections, icon: 'link', id: 'settings-category-connections' },
    { screen: 'settingsAlerts', label: t.settingsCategoryAlerts, icon: 'watch', id: 'settings-category-alerts' },
    { screen: 'settingsPrivacy', label: t.settingsCategoryPrivacy, icon: 'shield', id: 'settings-category-privacy' },
    { screen: 'settingsApp', label: t.settingsCategoryApp, icon: 'person', id: 'settings-category-app' },
  ] as const;

  return <Screen testID="settings-root" pinned={<BackHeader title={t.settingsTitle} onBack={() => actions.back()} />}>
    <ScreenScroll testID="settings-scroll" gap={12} topGap={14}>
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
