import React from 'react';
import { Platform, View, type ViewStyle } from 'react-native';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import type { Tab as NavTab } from '../state/navigation';
import { barShadow, type Palette } from '../theme/tokens';
import { Btn, Txt } from '../ui/primitives';
import { ReferenceIcon } from '../ui/referenceIcons';
import { BrandMark } from '../ui/brand';
import { useLayoutMode } from '../theme/textScale';

/**
 * The bottom bar: «احكيها» · Today · Plan · My things · Watching.
 *
 * Until 2026-10-06 «احكيها» was a red pill floating above a four-item bar
 * (Stitch redesign, 2026-10-02). The owner moved it into the bar as its first
 * item and replaced its text with the app's mark, so the bar is five equal
 * items and nothing floats over the screen. It keeps the `tab-capture` testID,
 * says «احكيها» to a screen reader, and opens the capture flow exactly as the
 * pill did. It is an action, not a screen, so it is never shown as selected.
 *
 * Settings is not in the bar; it opens from the avatar in each tab root's
 * header (`ui/chrome.tsx` `AvatarButton`) and renders without the bar.
 *
 * The whole control occupies normal layout space. It never sits over the
 * active screen, including at accessibility text sizes.
 */
export function TabBar({ onClearanceChange }: { onClearanceChange?: (height: number) => void } = {}) {
  const { s, t, p, scheme, reduceTransparency, actions } = useApp();
  const insets = useSafeAreaInsets();
  const mode = useLayoutMode();
  const enlarged = mode !== 'normal';
  const twoRows = mode === 'xl';
  // Every item the same width in both rows: a third of the bar, never grown,
  // with the second row's two centred (inspection M1A-R4-004).
  const slot = twoRows ? { width: '32%' as const, minWidth: 0 } : { flex: 1, minWidth: 0 };

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
      <View testID="tab-bar" style={[{ borderTopWidth: 1, borderColor: p.ln, overflow: 'hidden' }, barShadow(p)]}>
        {Platform.OS === 'ios' && !reduceTransparency ? (
          <BlurView intensity={40} tint={scheme === 'dark' ? 'dark' : 'light'} style={{ position: 'absolute', top: 0, start: 0, end: 0, bottom: 0 }} />
        ) : null}
        {/* At the accessibility (xl) sizes five slots are too narrow for a
            one-word label at its full size («الي / وم», device 2026-10-06), and
            labels are never capped (IMPLEMENTATION_SPEC). So the bar becomes
            two rows, three and two, each slot wide enough for its word. */}
        <View testID="tab-bar-row" style={{ backgroundColor: p.sfBar, paddingTop: 6, paddingBottom: Math.max(insets.bottom, 8), paddingHorizontal: 6, flexDirection: 'row', flexWrap: twoRows ? 'wrap' : 'nowrap', justifyContent: 'center', alignItems: 'stretch', gap: 2 }}>
          <Btn
            testID="tab-capture"
            label={t.tabCapture}
            onPress={() => actions.goCapture('tab', 'text')}
            scaleTo={0.92}
            style={[slot, { minHeight: 52, alignItems: 'center', justifyContent: 'center' }]}
          >
            <View style={{ alignItems: 'center', justifyContent: 'center', alignSelf: 'stretch', minHeight: 48, borderRadius: 14 }}>
              <BrandMark size={enlarged ? 32 : 36} />
            </View>
          </Btn>
          {tabs.map(tab => (
            <TabItem key={tab.screen} {...tab} p={p} on={s.screen === tab.screen} enlarged={enlarged} slot={slot}
              onPress={() => actions.switchTab(tab.screen)} />
          ))}
        </View>
      </View>
    </View>
  );
}

function TabItem({ label, testID, icon, on, p, enlarged, slot, onPress }: {
  label: string; testID: string; icon: string; on: boolean; p: Palette; enlarged: boolean;
  /** The slot's share of the bar: a fifth, or a third of a row at the xl sizes. */
  slot: ViewStyle;
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
      style={[slot, { minHeight: 52, alignItems: 'center', justifyContent: 'center' }]}
    >
      <View style={{ flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2, alignSelf: 'stretch', minHeight: 48, paddingVertical: 3, paddingHorizontal: 2, borderRadius: 14, overflow: 'hidden', backgroundColor: on ? p.acs : 'transparent' }}>
        <ReferenceIcon name={icon} size={enlarged ? 20 : 22} color={color} />
        <Txt testID={`${testID}-label`} size={enlarged ? 12 : 13} weight={on ? 700 : 500} color={color} align="center" lh={1.2} lines={2} style={{ flexShrink: 1 }}>{label}</Txt>
      </View>
    </Btn>
  );
}
