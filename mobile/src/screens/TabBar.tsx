import React from 'react';
import { Platform, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import type { Tab as NavTab } from '../state/navigation';
import { accentGlow, barShadow, type Palette } from '../theme/tokens';
import { Btn, Txt } from '../ui/primitives';
import { ReferenceIcon } from '../ui/referenceIcons';
import { useLayoutMode } from '../theme/textScale';

/**
 * The bottom bar (Stitch redesign, 2026-10-02): Today · Plan · My things ·
 * Watching, with the «احكيها» action centred above it.
 *
 * Settings is not in the bar any more; it opens from the avatar in each tab
 * root's header (`ui/chrome.tsx` `AvatarButton`) and renders without the bar.
 * The pill keeps the `tab-capture` testID and opens the capture flow exactly
 * as the old centre button did.
 *
 * The whole control occupies normal layout space. It never sits over the
 * active screen, including at accessibility text sizes.
 */
export function TabBar({ onClearanceChange }: { onClearanceChange?: (height: number) => void } = {}) {
  const { s, t, p, scheme, reduceTransparency, actions } = useApp();
  const insets = useSafeAreaInsets();
  const enlarged = useLayoutMode() !== 'normal';

  const tabs: { screen: NavTab; label: string; testID: string; icon: string }[] = [
    { screen: 'today', label: t.tabToday, testID: 'tab-today', icon: 'today' },
    { screen: 'calendar', label: t.tabPlan, testID: 'tab-calendar', icon: 'calendar' },
    { screen: 'things', label: t.tabThings, testID: 'tab-things', icon: 'shapes' },
    { screen: 'watching', label: t.tabWatching, testID: 'tab-watching', icon: 'radar' },
  ];

  return (
    <View
      testID="floating-tab-bar"
      onLayout={(e) => {
        // Toasts still need the real, text-scaled height of the whole block.
        onClearanceChange?.(e.nativeEvent.layout.height + 12);
      }}
      style={{ flexShrink: 0 }}
    >
      <View style={{ alignItems: 'center', paddingVertical: enlarged ? 6 : 10 }}>
        <Btn
          testID="tab-capture"
          onPress={() => actions.goCapture('tab', 'text')}
          label={t.tabCapture}
          scaleTo={0.94}
          style={[
            {
              backgroundColor: p.ac, borderRadius: 999, minHeight: 52, minWidth: 52,
              paddingHorizontal: enlarged ? 18 : 24, paddingVertical: enlarged ? 7 : 10,
              flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
            },
            accentGlow(p, 0.3),
          ]}
        >
          <ReferenceIcon name="mic" size={20} color={p.onAccent} />
          <Txt size={16} weight={700} color={p.onAccent}>{t.tabCapture}</Txt>
        </Btn>
      </View>
      <View testID="tab-bar" style={[{ borderTopWidth: 1, borderColor: p.ln, overflow: 'hidden' }, barShadow(p)]}>
        {Platform.OS === 'ios' && !reduceTransparency ? (
          <BlurView intensity={40} tint={scheme === 'dark' ? 'dark' : 'light'} style={{ position: 'absolute', top: 0, start: 0, end: 0, bottom: 0 }} />
        ) : null}
        <View style={{ backgroundColor: p.sfBar, paddingTop: 6, paddingBottom: Math.max(insets.bottom, 8), paddingHorizontal: 6, flexDirection: 'row', alignItems: 'stretch', gap: 2 }}>
          {tabs.map(tab => (
            <TabItem key={tab.screen} {...tab} p={p} on={s.screen === tab.screen} enlarged={enlarged}
              onPress={() => actions.switchTab(tab.screen)} />
          ))}
        </View>
      </View>
    </View>
  );
}

function TabItem({ label, testID, icon, on, p, enlarged, onPress }: {
  label: string; testID: string; icon: string; on: boolean; p: Palette; enlarged: boolean;
  onPress: () => void;
}) {
  // Selected is the coral tint with the solid pressed-coral label on it, the
  // contrast-tested pair (`brandPressed` on `brandContainer`); the rest are muted.
  const color = on ? p.acd : p.mu;
  return (
    <Btn
      onPress={onPress}
      label={label}
      testID={testID}
      scaleTo={0.92}
      accessibilityState={{ selected: on }}
      style={{ flex: 1, minWidth: 0, minHeight: 52, alignItems: 'center', justifyContent: 'center' }}
    >
      <View style={{ flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2, alignSelf: 'stretch', minHeight: 48, paddingVertical: 3, paddingHorizontal: 2, borderRadius: 14, overflow: 'hidden', backgroundColor: on ? p.acs : 'transparent' }}>
        <ReferenceIcon name={icon} size={enlarged ? 20 : 22} color={color} />
        <Txt size={enlarged ? 10 : 12} weight={on ? 700 : 500} color={color} align="center" lh={1.2} lines={2} style={{ flexShrink: 1 }}>{label}</Txt>
      </View>
    </Btn>
  );
}
