import React, { useRef } from 'react';
import {
  Animated, Pressable, Text, View,
  type GestureResponderEvent, type StyleProp, type TextStyle, type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import { family, type Weight } from '../theme/fonts';
import { cardShadow, type Palette } from '../theme/tokens';
import { impColors, impLabel } from '../state/derive';
import type { Imp } from '../state/types';

type Align = 'start' | 'center' | 'end';

export function Txt({
  children, size = 15, weight = 400, color, align = 'start', style, lines, lh, latin, selectable, testID,
}: {
  children: React.ReactNode;
  size?: number;
  weight?: Weight;
  color?: string;
  align?: Align;
  style?: StyleProp<TextStyle>;
  lines?: number;
  lh?: number;
  /** Set digits and Latin-only labels in Outfit even inside Arabic UI. */
  latin?: boolean;
  /** For an opaque id the user may need to read out or paste (#149). */
  selectable?: boolean;
  testID?: string;
}) {
  const { ar, p } = useApp();
  const naskh = ar && !latin;
  const textAlign = align === 'center' ? 'center' : (align === 'start') === ar ? 'right' : 'left';
  return (
    <Text
      numberOfLines={lines}
      selectable={selectable}
      testID={testID}
      style={[
        {
          fontFamily: family(weight, naskh),
          fontSize: size,
          lineHeight: Math.round(size * (lh ?? (naskh ? 1.6 : 1.4))),
          color: color ?? p.tx,
          textAlign,
          writingDirection: ar ? 'rtl' : 'ltr',
        },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * Pressable with the design's press-in scale (button:active scale .95).
 * The style sits on the Pressable itself so flex and percentage widths lay it
 * out like any other view.
 */
export function Btn({
  onPress, onPressIn, onPressOut, style, children, disabled, label, scaleTo = 0.95, hitSlop, testID,
}: {
  // `| undefined` is explicit because the app compiles with
  // exactOptionalPressableTypes: callers pass `onPress={disabled ? undefined : fn}`.
  onPress?: ((e: GestureResponderEvent) => void) | undefined;
  onPressIn?: ((e: GestureResponderEvent) => void) | undefined;
  onPressOut?: ((e: GestureResponderEvent) => void) | undefined;
  style?: StyleProp<ViewStyle> | undefined;
  children: React.ReactNode;
  disabled?: boolean | undefined;
  label?: string | undefined;
  scaleTo?: number | undefined;
  hitSlop?: number | undefined;
  /**
   * For a control a test or a Maestro flow has to find by identity rather than
   * by its label — a row whose copy is translated three ways, or two buttons
   * that legitimately read the same. `label` stays the accessibility label and
   * is what a screen reader announces; this is never shown to anyone.
   */
  testID?: string | undefined;
}) {
  const v = useRef(new Animated.Value(1)).current;
  const spring = (to: number) => Animated.spring(v, { toValue: to, useNativeDriver: true, speed: 40, bounciness: 0 }).start();
  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={hitSlop}
      onPress={onPress}
      onPressIn={e => { spring(scaleTo); onPressIn?.(e); }}
      onPressOut={e => { spring(1); onPressOut?.(e); }}
      style={[style, { transform: [{ scale: v }] }]}
    >
      {children}
    </AnimatedPressable>
  );
}

type PillKind = 'accent' | 'soft' | 'outline' | 'warm' | 'ink' | 'ghost';

export function Pill({
  label, onPress, kind = 'accent', style, size = 16, weight = 600, disabled, pad = 16, radius = 999, testID,
}: {
  label: string;
  onPress?: () => void;
  kind?: PillKind;
  style?: StyleProp<ViewStyle>;
  size?: number;
  weight?: Weight;
  disabled?: boolean;
  pad?: number;
  radius?: number;
  /** See `Btn`. Two pills legitimately read the same on the details screen. */
  testID?: string | undefined;
}) {
  const { p } = useApp();
  const look: Record<PillKind, { bg: string; fg: string; border?: string }> = {
    accent: { bg: p.ac, fg: p.onAccent },
    soft: { bg: p.sf2, fg: p.tx },
    outline: { bg: p.sf, fg: p.tx, border: p.ln },
    warm: { bg: p.wms, fg: p.wm },
    ink: { bg: p.tx, fg: p.bg },
    ghost: { bg: 'transparent', fg: p.mu },
  };
  const l = look[kind];
  return (
    <Btn
      onPress={disabled ? undefined : onPress}
      label={label}
      disabled={disabled}
      testID={testID}
      style={[
        {
          backgroundColor: l.bg, borderRadius: radius, paddingVertical: pad, paddingHorizontal: 18,
          alignItems: 'center', justifyContent: 'center', minHeight: 48,
          borderWidth: l.border ? 1 : 0, borderColor: l.border, opacity: disabled ? 0.4 : 1,
        },
        style,
      ]}
    >
      <Txt size={size} weight={weight} color={l.fg} align="center">{label}</Txt>
    </Btn>
  );
}

/** Small outlined pill used for Back / Cancel in screen headers. */
export function HeaderPill({ label, onPress }: { label: string; onPress: () => void }) {
  const { p } = useApp();
  return (
    <Btn onPress={onPress} label={label} style={{ backgroundColor: p.sf, borderWidth: 1, borderColor: p.ln, borderRadius: 999, paddingVertical: 8, paddingHorizontal: 14, minHeight: 36, justifyContent: 'center' }}>
      <Txt size={13}>{label}</Txt>
    </Btn>
  );
}

export function Card({ children, style, pad = 18, testID }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; pad?: number; testID?: string | undefined }) {
  const { p } = useApp();
  return <View testID={testID} style={[{ backgroundColor: p.sf, borderRadius: 24, padding: pad }, cardShadow(p), style]}>{children}</View>;
}

export function ImpBadge({ imp, style }: { imp: Imp; style?: StyleProp<ViewStyle> }) {
  const { p, t } = useApp();
  const c = impColors(imp, p);
  return (
    <View style={[{ backgroundColor: c.bg, borderRadius: 999, paddingVertical: 4, paddingHorizontal: 10, alignSelf: 'flex-start' }, style]}>
      <Txt size={12} weight={600} color={c.fg}>{impLabel(imp, t)}</Txt>
    </View>
  );
}

/** Top bar for flow screens: a pill on the start side, a muted title on the end side. */
export function FlowHeader({ pill, onPill, title }: { pill: string; onPill: () => void; title: string }) {
  const { p } = useApp();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ paddingTop: insets.top + 8, paddingHorizontal: 20, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
      <HeaderPill label={pill} onPress={onPill} />
      <Txt size={13} color={p.mu}>{title}</Txt>
    </View>
  );
}

export function Divider({ p }: { p: Palette }) {
  return <View style={{ height: 1, backgroundColor: p.ln }} />;
}
