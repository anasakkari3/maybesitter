import React, { useRef } from 'react';
import {
  Animated, Platform, Pressable, Text, View,
  type AccessibilityState, type GestureResponderEvent, type NativeSyntheticEvent, type StyleProp, type TextLayoutEventData, type TextStyle, type ViewStyle,
} from 'react-native';
import { useApp } from '../state/AppContext';
import { family, LINE_HEIGHT, type Weight } from '../theme/fonts';
import { cardShadow, typography, type Palette, type TextRole } from '../theme/tokens';
import { useTextScale } from '../theme/textScale';
import { useReducedMotion } from './motion';
import { firstStrongDirection, firstStrongScript } from '../i18n/bidi';

type Align = 'start' | 'center' | 'end';

/**
 * Inside a `RemeasureOnTextScale`, the live text scale; outside one, null.
 * Each `Txt` keys its paragraph on it (see below).
 */
const RemeasureScaleContext = React.createContext<number | null>(null);

/**
 * Text inside this boundary is measured afresh after a live text-size change
 * (simulator 2026-10-23, follow-up to #740).
 *
 * On a Dynamic Type change Fabric re-measures text in a commit of its own
 * (`SurfaceHandler::constraintLayout` → `dirtyMeasurableNodes`). React's next
 * commit is built from React's own shadow nodes (RN 0.86 does not hand
 * React the native clones: `updateRuntimeShadowNodeReferencesOnCommit` is
 * off), and a paragraph whose props did not change goes back into the tree
 * as React holds it — not dirty, its Yoga measurement from an earlier scale
 * (`ParagraphShadowNode::shouldNewRevisionDirtyMeasurement` dirties only on
 * new props). A view that re-renders on the change, as a card that restacks
 * at large text does, commits in that window: back at the default size
 * «هيك فهمت» kept its AX5 row heights, «اتصل بسامي» drawn over the bubble
 * below and «عدّل» cut off at the start edge, while only the already-keyed
 * «هيك صح» pill resized.
 *
 * Under the boundary every `Txt` keys its paragraph on the live scale, so a
 * change mounts a new paragraph that native measures from scratch — the path
 * of a card opened fresh at that size. Only the text leaves are replaced:
 * the buttons around them, which carry the accessible names and hold a
 * screen reader's focus, stay mounted. A rotation (same scale) replaces
 * nothing. Text outside a boundary is untouched.
 *
 * What a screen reader can focus must therefore not be a bare `Txt`: a
 * paragraph is its own accessible element on iOS, and focus on it would go
 * with it. Inside a boundary, words that stand alone (not inside a button)
 * sit in an accessible `View` that carries them as its label, with the `Txt`
 * itself `accessible={false}` — the wrapper stays, only the drawing changes.
 * Controls must also keep one parent in every layout mode, or the layout
 * change remounts them too.
 */
export function RemeasureOnTextScale({ children }: { children: React.ReactNode }) {
  const scale = useTextScale();
  return <RemeasureScaleContext.Provider value={scale}>{children}</RemeasureScaleContext.Provider>;
}

// Fabric swaps a Text's left/right with the inherited Yoga direction on BOTH
// platforms: iOS in RCTAttributedTextUtils.mm, Android in
// TextLayoutManager.getTextAlignment, which picks ALIGN_NORMAL/OPPOSITE
// against the paragraph's layout direction and then the script's. Supplying a
// physical RTL alignment swaps twice. On Android that put every Arabic date,
// title and section label — and a Latin title like "Dentist" — flush left
// under the RTL layout (UAT 2026-09-30, u11/u32/u51). So 'left' is the
// logical start on both. (A TextInput is not swapped: inputs keep taking the
// physical edge, see rtlInputs.test.) Keep this platform detail in one place.
export function textAlignment(align: Align, rtl: boolean, platform: string) {
  if (align === 'center') return 'center';
  const physicalRTL = platform === 'ios' || platform === 'android' ? false : rtl;
  return (align === 'start') === physicalRTL ? 'right' : 'left';
}

export function Txt({
  children, role = 'body', size = typography[role].size, weight = typography[role].weight, color, align = 'start', style, lines, lh, latin, selectable, testID, onTextLayout, dir, maxScale, accessible,
}: {
  children: React.ReactNode;
  role?: TextRole;
  size?: number | undefined;
  weight?: Weight | undefined;
  color?: string | undefined;
  align?: Align | undefined;
  style?: StyleProp<TextStyle> | undefined;
  lines?: number | undefined;
  lh?: number | undefined;
  /** Set digits and Latin-only labels in the Latin face (Plus Jakarta Sans) even inside Arabic or Hebrew UI. */
  latin?: boolean | undefined;
  /** For an opaque id the user may need to read out or paste (#149). */
  selectable?: boolean | undefined;
  /**
   * Caps text scaling for a glyph that must stay inside a fixed shape — the
   * avatar's initial in its 44-pt circle (M6b BB-09). Never for running text.
   */
  maxScale?: number | undefined;
  testID?: string | undefined;
  /** For chrome that has to know whether this label still fits its slot (TabBar). */
  onTextLayout?: ((e: NativeSyntheticEvent<TextLayoutEventData>) => void) | undefined;
  /**
   * `auto`: the paragraph reads in its own direction, decided by its first
   * strong letter, not the app's — for text the person wrote, which can be in
   * any of the three languages (condition 53). An English fact in the Arabic
   * app is left-to-right and starts at the left, set in the Latin face.
   */
  dir?: 'auto' | undefined;
  /**
   * `false` for the visual copy of words a stable accessible wrapper already
   * says — under a `RemeasureOnTextScale` the paragraph is replaced on a
   * text-size change, and a screen reader's focus must not sit on it.
   */
  accessible?: boolean | undefined;
}) {
  const { rtl: uiRtl, script, p } = useApp();
  const remeasureScale = React.useContext(RemeasureScaleContext);
  const text = typeof children === 'string' ? children : Array.isArray(children) && children.every(c => typeof c === 'string') ? children.join('') : null;
  const contentRtl = dir === 'auto' && text !== null ? firstStrongDirection(text, uiRtl ? 'rtl' : 'ltr') === 'rtl' : uiRtl;
  // Alignment is logical to the layout (see `textAlignment`): a paragraph
  // reading against the layout starts at the layout's end.
  const effectiveAlign: Align = contentRtl === uiRtl || align === 'center' ? align : align === 'start' ? 'end' : 'start';
  const rtl = uiRtl;
  // `latin` is the AGENTS.md escape hatch: a digit or a Latin-only label in a
  // tight box, set in the Latin face whatever the UI language is. Everything else is
  // set in the script of the language — which for Hebrew is a different face
  // from Arabic's, not a different direction.
  // The face follows the words' own script, not only their direction: a
  // Hebrew fact in the Arabic app is set in Noto Sans Hebrew (Noto Kufi has
  // no Hebrew), an Arabic one in the Hebrew app in Noto Kufi.
  const ownScript = dir === 'auto' && text !== null ? firstStrongScript(text) : null;
  const runScript = latin ? 'latin' : ownScript ?? script;
  const textAlign = textAlignment(effectiveAlign, rtl, Platform.OS);
  // RN 0.86 scales BOTH fontSize and lineHeight natively (iOS:
  // RCTAttributedTextUtils; Android: TextAttributes.effectiveLineHeight).
  // Supply the unscaled script ratio once. Multiplying by fontScale here
  // produces a squared line box at accessibility sizes, wasting the viewport.
  return (
    <Text
      key={remeasureScale === null ? undefined : `scale-${remeasureScale}`}
      numberOfLines={lines}
      selectable={selectable}
      {...(accessible !== undefined ? { accessible } : {})}
      {...(maxScale !== undefined ? { maxFontSizeMultiplier: maxScale } : {})}
      testID={testID}
      onTextLayout={onTextLayout}
      accessibilityRole={role === 'page' || role === 'section' ? 'header' : undefined}
      style={[
        {
          fontFamily: family(weight, runScript),
          fontSize: size,
          lineHeight: Math.round(size * (runScript === 'arabic' ? Math.max(lh ?? LINE_HEIGHT.arabic, LINE_HEIGHT.arabic) : (lh ?? LINE_HEIGHT[runScript]))),
          color: color ?? p.tx,
          textAlign,
          writingDirection: contentRtl ? 'rtl' : 'ltr',
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
  onPress, onPressIn, onPressOut, style, children, disabled, label, hint, scaleTo = 0.95, hitSlop, testID,
  accessibilityRole = 'button', accessibilityState, accessibilityActions, onAccessibilityAction, nativeRef,
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
  hint?: string | undefined;
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
  accessibilityState?: AccessibilityState;
  /**
   * Actions a screen reader or switch control can perform on this row.
   *
   * A swipe is invisible to both (UC-2.R3 #173 step 8), so anything reachable
   * by swiping has to be reachable here too — declared from the same list, so
   * the two cannot drift.
   */
  accessibilityActions?: readonly { name: string; label: string }[];
  onAccessibilityAction?: (event: { nativeEvent: { actionName: string } }) => void;
  /** The pressable itself, for a screen reader's focus to return to (the plan editor). */
  nativeRef?: React.Ref<View> | undefined;
}) {
  const v = useRef(new Animated.Value(1)).current;
  const reduced = useReducedMotion();
  const spring = (to: number) => {
    if (reduced) { v.setValue(1); return; }
    Animated.spring(v, { toValue: to, useNativeDriver: true, speed: 40, bounciness: 0 }).start();
  };
  return (
    <AnimatedPressable
      {...(nativeRef ? { ref: nativeRef as never } : {})}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={label}
      accessibilityHint={hint}
      {...(accessibilityActions ? { accessibilityActions: [...accessibilityActions] } : {})}
      {...(onAccessibilityAction ? { onAccessibilityAction } : {})}
      testID={testID}
      accessibilityState={{ ...accessibilityState, disabled }}
      disabled={disabled}
      hitSlop={hitSlop}
      onPress={onPress}
      onPressIn={e => { spring(scaleTo); onPressIn?.(e); }}
      onPressOut={e => { spring(1); onPressOut?.(e); }}
      style={[style, { transform: [{ scale: reduced ? 1 : v }] }]}
    >
      {children}
    </AnimatedPressable>
  );
}

type PillKind = 'accent' | 'soft' | 'outline' | 'warm' | 'warmSolid' | 'ink' | 'ghost';

export function Pill({
  label, onPress, kind = 'accent', style, size = 16, weight = 600, disabled, pad = 16, radius = 999, testID, accessibilityLabel, expanded, nativeRef,
  radio,
}: {
  label: string;
  /** For a pill that opens something below it: said as expanded / collapsed. */
  expanded?: boolean | undefined;
  /**
   * What a screen reader announces when the visible label alone is ambiguous:
   * a list of pills that all read "Remove" says which one each removes.
   */
  accessibilityLabel?: string | undefined;
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
  /** See `Btn`. */
  nativeRef?: React.Ref<View> | undefined;
  /**
   * One choice of a radiogroup (M3b's habit questions): said as a radio with
   * its checked state, instead of a plain button.
   */
  radio?: { checked: boolean } | undefined;
}) {
  const { p } = useApp();
  // The label is keyed to the live text scale (#740). Nothing else in a pill
  // depends on the scale, so a Dynamic Type change made while the app is open
  // re-committed none of its props: the label went on drawing at the new size
  // inside the frame measured at the old one — «هيك صح» an empty 50-pt pill
  // at AX5 — until the screen remounted. A new label at each scale is
  // measured from scratch, the way a pill opened fresh at that size is.
  const scale = useTextScale();
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
      label={accessibilityLabel ?? label}
      disabled={disabled}
      testID={testID}
      nativeRef={nativeRef}
      {...(expanded !== undefined ? { accessibilityState: { expanded } } : {})}
      {...(radio ? { accessibilityRole: 'radio' as const, accessibilityState: { checked: radio.checked, disabled: !!disabled } } : {})}
      style={[
        {
          backgroundColor: l.bg, borderRadius: radius, paddingVertical: pad, paddingHorizontal: 18,
          alignItems: 'center', justifyContent: 'center', minHeight: 48,
          borderWidth: l.border ? 1 : 0, borderColor: l.border,
        },
        style,
      ]}
    >
      <Txt key={`scale-${scale}`} size={size} weight={weight} color={l.fg} align="center">{label}</Txt>
    </Btn>
  );
}

export function Card({ children, style, pad = 18, testID, focus = false }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; pad?: number; testID?: string | undefined; focus?: boolean }) {
  const { p } = useApp();
  return <View testID={testID} style={[{ backgroundColor: p.glass, borderRadius: 20, padding: pad, borderWidth: 1, borderColor: p.ln }, focus ? cardShadow(p) : undefined, style]}>{children}</View>;
}

export function Divider({ p }: { p: Palette }) {
  return <View style={{ height: 1, backgroundColor: p.ln }} />;
}
