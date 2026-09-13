import React from 'react';
import { Linking, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../../state/AppContext';
import { Btn, Card, Txt } from '../../ui/primitives';
import { ScreenIn } from '../../ui/motion';
import { SettingsHeader } from './SettingsChrome';

/**
 * Reminders (UC-2.R4, #174).
 *
 * Education and a deep link to the OS settings, and nothing else. This screen
 * deliberately does **not** request the notification permission: scheduling is
 * S3's, and iOS only lets an app ask once — spending that prompt from a
 * settings screen, before the user has asked for a reminder, is spending it on
 * the version of the question most likely to be denied.
 *
 * `Linking.openSettings()` sends them to the place where the answer can always
 * be changed, which is the honest thing to offer until the feature exists.
 */
export function NotificationsSettingsScreen({ onBack }: { onBack: () => void }) {
  const { t, p } = useApp();
  const insets = useSafeAreaInsets();
  return (
    <ScreenIn style={{ backgroundColor: p.bg }}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 8, paddingHorizontal: 20, paddingBottom: 60, gap: 14 }}>
        <SettingsHeader title={t.notifTitle} onBack={onBack} />
        <Card pad={18}>
          <Txt size={15} color={p.mu} lh={1.5}>{t.obNotifBody}</Txt>
        </Card>
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
