import React, { useState } from 'react';
import { Platform, View, type LayoutChangeEvent, type TextLayoutEventData, type NativeSyntheticEvent } from 'react-native';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import type { Screen } from '../state/types';
import { accentGlow, barShadow } from '../theme/tokens';
import { useLayoutMode, useTextScale, type LayoutMode } from '../theme/textScale';
import { Btn, Txt } from '../ui/primitives';
import { CalendarIcon, MicIcon, SettingsIcon, TodayIcon } from '../ui/icons';

/**
 * Floating pill tab bar: Today · Calendar · Say it · Settings.
 *
 * ── Labels come off when there is genuinely no room ──────────────
 *
 * The reader's text is never capped, so at some size the four painted labels
 * stop fitting the pill. Two things decide when:
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
 * and a device flow all find the same four controls whether or not a word is
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

  const reportLabel = (slotWidth: number) => (e: NativeSyntheticEvent<TextLayoutEventData>) => {
    if (labelOverflows(e.nativeEvent.lines, slotWidth)) setOverflowAt(key);
  };

  const Tab = ({ screen, label, testID, icon }: { screen: Screen; label: string; testID: string; icon: (c: string) => React.ReactNode }) => {
    const on = s.screen === screen;
    const color = on ? p.ac : p.tx;
    const [slot, setSlot] = useState(0);
    return (
      <Btn
        onPress={() => actions.go(screen)}
        label={label}
        testID={testID}
        scaleTo={0.92}
        accessibilityState={{ selected: on }}
        style={{ flex: 1, borderRadius: 999, backgroundColor: on ? p.sf2 : 'transparent', alignItems: 'center', gap: 3, paddingVertical: 6, minHeight: 48 }}
      >
        <View onLayout={(e: LayoutChangeEvent) => setSlot(e.nativeEvent.layout.width)} style={{ alignItems: 'center', gap: 3, alignSelf: 'stretch' }}>
          {icon(color)}
          {iconsOnly ? null : (
            <Txt size={11} weight={on ? 600 : 500} color={color} align="center" lh={1.3} onTextLayout={reportLabel(slot)}>
              {label}
            </Txt>
          )}
        </View>
      </Btn>
    );
  };

  return (
    <View
      testID="floating-tab-bar"
      onLayout={(e) => {
        setBarWidth(e.nativeEvent.layout.width);
        onClearanceChange?.(e.nativeEvent.layout.height + Math.max(insets.bottom, 12) + 4 + 8);
      }}
      style={[
        {
          position: 'absolute', left: 14, right: 14, bottom: Math.max(insets.bottom, 12) + 4, zIndex: 20,
          borderRadius: 999, borderWidth: 1, borderColor: p.ln, overflow: 'hidden',
        },
        barShadow(p),
      ]}
    >
      {Platform.OS === 'ios' && !reduceTransparency ? (
        <BlurView intensity={40} tint={scheme === 'dark' ? 'dark' : 'light'} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} />
      ) : null}
      <View style={{ backgroundColor: p.sfBar, padding: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Tab screen="today" label={t.tabToday} testID="tab-today" icon={c => <TodayIcon color={c} />} />
        <Tab screen="calendar" label={t.tabCalendar} testID="tab-calendar" icon={c => <CalendarIcon color={c} />} />
        <Btn
          testID="tab-capture"
          onPress={() => actions.goCapture('tab', 'text')}
          label={t.tabCapture}
          scaleTo={0.94}
          style={[
            {
              backgroundColor: p.ac, borderRadius: 999, minHeight: 56, minWidth: 56,
              paddingHorizontal: iconsOnly ? 18 : 22, paddingVertical: 8,
              flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
            },
            accentGlow(p, 0.3),
          ]}
        >
          <MicIcon size={20} color={p.onAccent} />
          {iconsOnly ? null : (
            <Txt size={15} weight={600} color={p.onAccent} onTextLayout={reportLabel(barWidth * 0.4)}>{t.tabCapture}</Txt>
          )}
        </Btn>
        {/* The knob punched out of the settings icon is the bar's own solid
            colour, not the card surface: the bar is what sits behind it. */}
        <Tab screen="settings" label={t.tabSettings} testID="tab-settings" icon={c => <SettingsIcon color={c} knob={p.sfBarSolid} />} />
      </View>
    </View>
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
