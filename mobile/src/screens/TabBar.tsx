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
 * Watching, with the «احكيها» pill floating centred above it.
 *
 * Settings is not in the bar any more; it opens from the avatar in each tab
 * root's header (`ui/chrome.tsx` `AvatarButton`) and renders without the bar.
 * The pill keeps the `tab-capture` testID and opens the capture flow exactly
 * as the old centre button did.
 *
 * At enlarged text sizes, the four tabs form two rows. Each keeps a visible
 * name beside its icon and half the device width for Arabic and Hebrew text.
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
        // The whole block — pill, bar and home-indicator inset — plus the
        // gap a last row needs to read as clear of it.
        onClearanceChange?.(e.nativeEvent.layout.height + 12);
      }}
      style={{ position: 'absolute', start: 0, end: 0, bottom: 0, zIndex: 20, pointerEvents: 'box-none' }}
    >
      {/* The pill floats above the bar, centred; only it takes touches here. */}
      <View style={{ alignItems: 'center', paddingBottom: 10, pointerEvents: 'box-none' }}>
        <Btn
          testID="tab-capture"
          onPress={() => actions.goCapture('tab', 'text')}
          label={t.tabCapture}
          scaleTo={0.94}
          style={[
            {
              backgroundColor: p.ac, borderRadius: 999, minHeight: 52, minWidth: 52,
              paddingHorizontal: 24, paddingVertical: 10,
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
        <View style={{ backgroundColor: p.sfBar, paddingTop: 8, paddingBottom: Math.max(insets.bottom, 8), paddingHorizontal: 8, flexDirection: 'row', flexWrap: enlarged ? 'wrap' : 'nowrap', alignItems: 'stretch', gap: 4 }}>
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
      style={{ flexGrow: 1, flexShrink: 1, flexBasis: enlarged ? '48%' : 0, minHeight: 52, alignItems: 'center', justifyContent: 'center' }}
    >
      <View style={{ flexDirection: enlarged ? 'row' : 'column', alignItems: 'center', justifyContent: 'center', gap: enlarged ? 8 : 2, alignSelf: 'stretch', minHeight: 48, paddingVertical: 4, paddingHorizontal: 4, borderRadius: 16, overflow: 'hidden', backgroundColor: on ? p.acs : 'transparent' }}>
        <ReferenceIcon name={icon} size={22} color={color} />
        <Txt size={12} weight={on ? 700 : 500} color={color} align="center" lh={1.3} style={{ flexShrink: 1 }}>{label}</Txt>
      </View>
    </Btn>
  );
}
