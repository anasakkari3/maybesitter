import React, { useState } from 'react';
import { Platform, View, type LayoutChangeEvent, type TextLayoutEventData, type NativeSyntheticEvent } from 'react-native';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import type { Tab as NavTab } from '../state/navigation';
import { accentGlow, barShadow, type Palette } from '../theme/tokens';
import { useLayoutMode, useTextScale, type LayoutMode } from '../theme/textScale';
import { Btn, Txt } from '../ui/primitives';
import { ReferenceIcon } from '../ui/referenceIcons';

/**
 * The bottom bar (Stitch redesign, 2026-10-02): Today · Plan · My things ·
 * Watching, with the «احكيها» pill floating centred above it.
 *
 * Settings is not in the bar any more; it opens from the avatar in each tab
 * root's header (`ui/chrome.tsx` `AvatarButton`) and renders without the bar.
 * The pill keeps the `tab-capture` testID and opens the capture flow exactly
 * as the old centre button did.
 *
 * ── Labels come off when there is genuinely no room ──────────────
 *
 * The reader's text is never capped, so at some size the four painted labels
 * stop fitting. Two things decide when:
 *
 *   1. The layout mode. At `xl` (the platform's first accessibility size)
 *      the bar starts icons-only, the way iOS's own bars do. That is the
 *      structural default and it is right on the first frame.
 *   2. Measurement. Below `xl`, every label reports its own layout; the
 *      moment one wraps or is wider than the slot it sits in, the labels come
 *      off for this text size and width. Change either and they are tried
 *      again. So a long Hebrew or Arabic label on a narrow phone is handled
 *      by what it measures, not by a number chosen in advance.
 *
 * Dropping a label is not dropping a name. Every button keeps its
 * `accessibilityLabel` and its `testID` at every size, so VoiceOver, TalkBack
 * and a device flow all find the same five controls whether or not a word is
 * painted under the icon.
 */
export function TabBar({ onClearanceChange }: { onClearanceChange?: (height: number) => void } = {}) {
  const { s, t, p, scheme, reduceTransparency, actions } = useApp();
  const insets = useSafeAreaInsets();
  const mode = useLayoutMode();
  const scale = useTextScale();

  // The decision is keyed to the text size and bar width it was measured at,
  // so shrinking the text brings the labels back and lets them measure again.
  const [barWidth, setBarWidth] = useState(0);
  const key = `${scale}|${barWidth}`;
  const [overflowAt, setOverflowAt] = useState<string | null>(null);
  const iconsOnly = decideIconsOnly(mode, overflowAt === key);
  const onOverflow = () => setOverflowAt(key);

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
        setBarWidth(e.nativeEvent.layout.width);
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
              paddingHorizontal: iconsOnly ? 16 : 24, paddingVertical: 10,
              flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
            },
            accentGlow(p, 0.3),
          ]}
        >
          <ReferenceIcon name="mic" size={20} color={p.onAccent} />
          {iconsOnly ? null : (
            <Txt size={16} weight={700} color={p.onAccent}
              onTextLayout={(e) => { if (labelOverflows(e.nativeEvent.lines, barWidth * 0.6)) onOverflow(); }}>
              {t.tabCapture}
            </Txt>
          )}
        </Btn>
      </View>
      <View testID="tab-bar" style={[{ borderTopWidth: 1, borderColor: p.ln, overflow: 'hidden' }, barShadow(p)]}>
        {Platform.OS === 'ios' && !reduceTransparency ? (
          <BlurView intensity={40} tint={scheme === 'dark' ? 'dark' : 'light'} style={{ position: 'absolute', top: 0, start: 0, end: 0, bottom: 0 }} />
        ) : null}
        <View style={{ backgroundColor: p.sfBar, paddingTop: 8, paddingBottom: Math.max(insets.bottom, 8), paddingHorizontal: 8, flexDirection: 'row', alignItems: 'stretch', gap: 4 }}>
          {tabs.map(tab => (
            <TabItem key={tab.screen} {...tab} p={p} on={s.screen === tab.screen} iconsOnly={iconsOnly}
              onPress={() => actions.switchTab(tab.screen)} onOverflow={onOverflow} />
          ))}
        </View>
      </View>
    </View>
  );
}

function TabItem({ label, testID, icon, on, iconsOnly, p, onPress, onOverflow }: {
  label: string; testID: string; icon: string; on: boolean; iconsOnly: boolean; p: Palette;
  onPress: () => void; onOverflow: () => void;
}) {
  // Selected is the coral tint with the solid pressed-coral label on it, the
  // contrast-tested pair (`brandPressed` on `brandContainer`); the rest are muted.
  const color = on ? p.acd : p.mu;
  const [slot, setSlot] = useState(0);
  return (
    <Btn
      onPress={onPress}
      label={label}
      testID={testID}
      scaleTo={0.92}
      accessibilityState={{ selected: on }}
      style={{ flex: 1, minHeight: 52, alignItems: 'center', justifyContent: 'center' }}
    >
      <View
        onLayout={(e: LayoutChangeEvent) => setSlot(e.nativeEvent.layout.width)}
        style={{ alignItems: 'center', justifyContent: 'center', gap: 2, alignSelf: 'stretch', minHeight: 48, paddingVertical: 4, paddingHorizontal: 4, borderRadius: 16, backgroundColor: on ? p.acs : 'transparent' }}
      >
        <ReferenceIcon name={icon} size={22} color={color} />
        {iconsOnly ? null : (
          <Txt size={13} weight={on ? 700 : 500} color={color} align="center" lh={1.3}
            onTextLayout={(e: NativeSyntheticEvent<TextLayoutEventData>) => { if (labelOverflows(e.nativeEvent.lines, slot)) onOverflow(); }}>
            {label}
          </Txt>
        )}
      </View>
    </Btn>
  );
}

/** Icons only at the accessibility sizes, or whenever a label has measured itself out of its slot. */
export function decideIconsOnly(mode: LayoutMode, measuredOverflow: boolean): boolean {
  return mode === 'xl' || measuredOverflow;
}

/**
 * A label has no room when it wrapped, or when its one line is wider than the
 * slot it sits in. A slot of 0 has not been laid out yet and says nothing.
 */
export function labelOverflows(lines: readonly { width: number }[], slotWidth: number): boolean {
  if (lines.length > 1) return true;
  if (slotWidth <= 0) return false;
  return (lines[0]?.width ?? 0) > slotWidth;
}
