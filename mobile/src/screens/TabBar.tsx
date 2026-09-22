import React from 'react';
import { Platform, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import type { Screen } from '../state/types';
import { accentGlow, barShadow } from '../theme/tokens';
import { useTextStep } from '../theme/textScale';
import { Btn, Txt } from '../ui/primitives';
import { CalendarIcon, MicIcon, SettingsIcon, TodayIcon } from '../ui/icons';

/**
 * Floating pill tab bar: Today · Calendar · Say it · Settings.
 *
 * At the largest text step the four visible labels come off and the bar is
 * icons only, which is what Round 2 specifies (`tabLabels = textSize === 'xl'`
 * in the export). Before this, nothing here read the font scale: the labels
 * simply grew until they no longer fitted the pill, and the row broke.
 *
 * Dropping a label is not dropping a name. Every button's `label` stays its
 * `accessibilityLabel` — see `Btn` — so VoiceOver and TalkBack announce the
 * same four tabs at every text size. What goes is the redundant painted copy
 * of a name the icon already carries, and only at the size where keeping it
 * would cost the reader the bar itself.
 */
export function TabBar() {
  const { s, t, p, scheme, actions } = useApp();
  const insets = useSafeAreaInsets();
  const iconsOnly = useTextStep() === 'xl';

  const Tab = ({ screen, label, icon }: { screen: Screen; label: string; icon: (c: string) => React.ReactNode }) => {
    const on = s.screen === screen;
    const color = on ? p.ac : p.mu;
    return (
      <Btn
        onPress={() => actions.go(screen)}
        label={label}
        scaleTo={0.92}
        style={{ flex: 1, alignItems: 'center', gap: 3, paddingVertical: 6, minHeight: 48 }}
      >
        {icon(color)}
        {iconsOnly ? null : (
          <Txt size={11} weight={on ? 600 : 500} color={color} align="center" lh={1.3}>{label}</Txt>
        )}
      </Btn>
    );
  };

  return (
    <View
      style={[
        {
          position: 'absolute', left: 14, right: 14, bottom: Math.max(insets.bottom, 12) + 4, zIndex: 20,
          borderRadius: 999, borderWidth: 1, borderColor: p.ln, overflow: 'hidden',
        },
        barShadow(p),
      ]}
    >
      {Platform.OS === 'ios' ? (
        <BlurView intensity={40} tint={scheme === 'dark' ? 'dark' : 'light'} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} />
      ) : null}
      <View style={{ backgroundColor: p.sfBar, padding: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Tab screen="today" label={t.tabToday} icon={c => <TodayIcon color={c} />} />
        <Tab screen="calendar" label={t.tabCalendar} icon={c => <CalendarIcon color={c} />} />
        <Btn
          testID="tab-capture"
          onPress={() => actions.goCapture('tab', 'text')}
          label={t.tabCapture}
          scaleTo={0.94}
          style={[
            {
              backgroundColor: p.ac, borderRadius: 999, height: 56, minWidth: 56,
              paddingHorizontal: iconsOnly ? 18 : 22,
              flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
            },
            accentGlow(p, 0.3),
          ]}
        >
          <MicIcon size={20} color={p.onAccent} />
          {iconsOnly ? null : <Txt size={15} weight={600} color={p.onAccent}>{t.tabCapture}</Txt>}
        </Btn>
        {/* The knob punched out of the settings icon is the bar's own solid
            colour, not the card surface: the bar is what sits behind it. */}
        <Tab screen="settings" label={t.tabSettings} icon={c => <SettingsIcon color={c} knob={p.sfBarSolid} />} />
      </View>
    </View>
  );
}
