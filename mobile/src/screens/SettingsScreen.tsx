import React from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import { Btn, Card, Txt } from '../ui/primitives';
import { ScreenIn } from '../ui/motion';

export function SettingsScreen() {
  const { t, p, themePref, actions } = useApp();
  const insets = useSafeAreaInsets();
  const themeValue = themePref === 'system' ? t.vSystem : themePref === 'light' ? t.vLight : t.vDark;

  // Appearance and Language work now; the rest are designed in the next round.
  const rows: { label: string; value: string; onPress?: () => void }[] = [
    { label: t.sAppearance, value: themeValue, onPress: actions.cycleTheme },
    { label: t.sLanguage, value: t.vLang, onPress: actions.toggleLang },
    { label: t.sNotif, value: t.vQuiet },
    { label: t.sBudget, value: t.vBudget },
    { label: t.sTrust, value: '' },
    { label: t.sHistory, value: '' },
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
              <Txt size={15}>{r.label}</Txt>
              <Txt size={13} color={p.mu}>{r.value}</Txt>
            </Btn>
          ))}
        </Card>
        <View style={{ paddingHorizontal: 6 }}>
          <Txt size={12} color={p.mu}>{t.settingsNote}</Txt>
        </View>
      </ScrollView>
    </ScreenIn>
  );
}
