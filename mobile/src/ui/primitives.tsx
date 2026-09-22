import React, { useRef } from 'react';
import {
  Animated, Pressable, Text, View,
  type GestureResponderEvent, type NativeSyntheticEvent, type StyleProp, type TextLayoutEventData, type TextStyle, type ViewStyle,
} from 'react-native';
import { useApp } from '../state/AppContext';
import { family, LINE_HEIGHT, type Weight } from '../theme/fonts';
import { useTextScale } from '../theme/textScale';
import { cardShadow, type Palette } from '../theme/tokens';

type Align = 'start' | 'center' | 'end';

export function Txt({
  children, size = 15, weight = 400, color, align = 'start', style, lines, lh, latin, selectable, testID, onTextLayout,
}: {
  children: React.ReactNode;
  size?: number | undefined;
  weight?: Weight | undefined;
  color?: string | undefined;
  align?: Align | undefined;
  style?: StyleProp<TextStyle> | undefined;
  lines?: number | undefined;
  lh?: number | undefined;
  /** Set digits and Latin-only labels in Outfit even inside Arabic or Hebrew UI. */
  latin?: boolean | undefined;
  /** For an opaque id the user may need to read out or paste (#149). */
  selectable?: boolean | undefined;
  testID?: string | undefined;
  /** For chrome that has to know whether this label still fits its slot (TabBar). */
  onTextLayout?: ((e: NativeSyntheticEvent<TextLayoutEventData>) => void) | undefined;
}) {
  const { rtl, script, p } = useApp();
  const textScale = useTextScale();
  // `latin` is the AGENTS.md escape hatch: a digit or a Latin-only label in a
  // tight box, set in Outfit whatever the UI language is. Everything else is
  // set in the script of the language — which for Hebrew is a different face
  // from Arabic's, not a different direction.
  const runScript = latin ? 'latin' : script;
  const textAlign = align === 'center' ? 'center' : (align === 'start') === rtl ? 'right' : 'left';
  // React Native scales `fontSize` for us but leaves `lineHeight` alone, so a
  // fixed line box clips its own text the moment the reader enlarges it —
  // worst in Arabic, whose face asks for 1.6 and whose glyphs are tall. The
  // line box is therefore computed at the size the text will actually render
  // at. There is no ceiling: a reader at 2× reads at 2×, and it is the chrome
  // around the text that adapts (src/theme/textScale.ts).
  const rendered = size * textScale;
  return (
    <Text
      numberOfLines={lines}
      selectable={selectable}
      testID={testID}
      onTextLayout={onTextLayout}
      style={[
        {
          fontFamily: family(weight, runScript),
          fontSize: size,
          lineHeight: Math.round(rendered * (lh ?? LINE_HEIGHT[runScript])),
          color: color ?? p.tx,
          textAlign,
          writingDirection: rtl ? 'rtl' : 'ltr',
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
  accessibilityRole = 'button', accessibilityActions, onAccessibilityAction,
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
  /**
   * Overrides the default `button` role.
   *
   * UC-2.5 (#165)'s clarification options are a single choice, and a screen
   * reader announcing four buttons does not say that only one may be picked.
   */
  accessibilityRole?: 'button' | 'radio' | 'checkbox' | 'link';
  /**
   * Actions a screen reader or switch control can perform on this row.
   *
   * A swipe is invisible to both (UC-2.R3 #173 step 8), so anything reachable
   * by swiping has to be reachable here too — declared from the same list, so
   * the two cannot drift.
   */
  accessibilityActions?: readonly { name: string; label: string }[];
  onAccessibilityAction?: (event: { nativeEvent: { actionName: string } }) => void;
}) {
  const v = useRef(new Animated.Value(1)).current;
  const spring = (to: number) => Animated.spring(v, { toValue: to, useNativeDriver: true, speed: 40, bounciness: 0 }).start();
  return (
    <AnimatedPressable
      accessibilityRole={accessibilityRole}
      accessibilityLabel={label}
      {...(accessibilityActions ? { accessibilityActions: [...accessibilityActions] } : {})}
      {...(onAccessibilityAction ? { onAccessibilityAction } : {})}
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

type PillKind = 'accent' | 'soft' | 'outline' | 'warm' | 'warmSolid' | 'ink' | 'ghost';

export function Pill({
  label, onPress, kind = 'accent', style, size = 16, weight = 600, disabled, pad = 16, radius = 999, testID,
}: {
  label: string;
  onPress?: (() => void) | undefined;
  kind?: PillKind | undefined;
  style?: StyleProp<ViewStyle> | undefined;
  size?: number | undefined;
  weight?: Weight | undefined;
  disabled?: boolean | undefined;
  pad?: number | undefined;
  radius?: number | undefined;
  /** See `Btn`. Two pills legitimately read the same on the details screen. */
  testID?: string | undefined;
}) {
  const { p } = useApp();
  const look: Record<PillKind, { bg: string; fg: string; border?: string }> = {
    accent: { bg: p.ac, fg: p.onAccent },
    soft: { bg: p.sf2, fg: p.tx },
    outline: { bg: p.sf, fg: p.tx, border: p.ln },
    warm: { bg: p.wms, fg: p.wm },
    warmSolid: { bg: p.wm, fg: p.onAccent },
    ink: { bg: p.ink, fg: p.onInk },
    ghost: { bg: 'transparent', fg: p.mu },
  };
  // A control that cannot be pressed yet is drawn in the disabled roles —
  // `dis` / `disTx`, which Round 2 names and which measure ≥ 4.5:1 in both
  // schemes — rather than by fading the whole control to 40 % opacity, which
  // took the label with it and left the reason for the fade unreadable.
  const l = disabled ? { bg: p.dis, fg: p.disTx, border: kind === 'outline' ? p.ln : undefined } : look[kind];
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
          borderWidth: l.border ? 1 : 0, borderColor: l.border,
        },
        style,
      ]}
    >
      <Txt size={size} weight={weight} color={l.fg} align="center">{label}</Txt>
    </Btn>
  );
}

export function Card({ children, style, pad = 18, testID }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; pad?: number; testID?: string | undefined }) {
  const { p } = useApp();
  return <View testID={testID} style={[{ backgroundColor: p.sf, borderRadius: 24, padding: pad }, cardShadow(p), style]}>{children}</View>;
}

export function Divider({ p }: { p: Palette }) {
  return <View style={{ height: 1, backgroundColor: p.ln }} />;
}
