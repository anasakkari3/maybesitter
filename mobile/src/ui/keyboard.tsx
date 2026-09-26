import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Keyboard,
  LayoutAnimation,
  Platform,
  View,
  type KeyboardEvent,
  type LayoutAnimationType,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { measureWindowFrame, type WindowFrame } from './windowFrame';

/**
 * How far the keyboard reaches into a view, both in window coordinates.
 *
 * A keyboard that reports no position (iOS with Prefer Cross-Fade
 * Transitions) is treated as not covering anything, as React Native's own
 * KeyboardAvoidingView does.
 */
export function keyboardOverlap(frame: WindowFrame, keyboardTop: number): number {
  if (keyboardTop <= 0) return 0;
  return Math.max(0, Math.round(frame.y + frame.height - keyboardTop));
}

/**
 * The one keyboard-avoiding container (UAT 2026-09-26, complaint #6).
 *
 * React Native's KeyboardAvoidingView compares its frame *relative to its
 * parent* with the keyboard's *screen* position, so anything above the parent
 * — the «أكّد إيميلك» banner is 134pt — made it under-pad by that height and
 * the pinned footer went under the keyboard. This measures the view in the
 * window, the space the keyboard reports in, so the padding is the real
 * overlap with or without chrome above it.
 *
 * iOS only, like the `behavior="padding"` it replaces: Android resizes the
 * window for the keyboard itself. Every screen with a keyboard uses this; a
 * census test refuses a bare KeyboardAvoidingView.
 */
export function AvoidKeyboard({
  children,
  style,
  testID,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const ref = useRef<View>(null);
  const [inset, setInset] = useState(0);
  const insetRef = useRef(0);
  // Where the keyboard's top edge is, or null while it is down.
  const keyboardTop = useRef<number | null>(null);
  const live = useRef(true);

  const update = useCallback(async (animation?: { duration: number; easing: LayoutAnimationType }) => {
    const top = keyboardTop.current;
    let next = 0;
    if (top !== null) {
      const frame = await measureWindowFrame(ref.current);
      // A newer keyboard event superseded this one while it was measuring.
      if (!live.current || !frame || keyboardTop.current !== top) return;
      next = keyboardOverlap(frame, top);
    }
    if (next === insetRef.current) return;
    insetRef.current = next;
    if (animation && animation.duration > 0) {
      const duration = Math.max(animation.duration, 10);
      LayoutAnimation.configureNext({ duration, update: { duration, type: animation.easing } });
    }
    setInset(next);
  }, []);

  useEffect(() => {
    live.current = true;
    if (Platform.OS !== 'ios') return () => { live.current = false; };
    // Opened with the keyboard already up — a screen swapped in under a
    // focused field — so there is no show event to wait for.
    const metrics = Keyboard.isVisible() ? Keyboard.metrics() : undefined;
    if (metrics) keyboardTop.current = metrics.screenY;
    const animationOf = (event: KeyboardEvent) => ({
      duration: event.duration ?? 0,
      easing: (event.easing && event.easing in LayoutAnimation.Types ? event.easing : 'keyboard') as LayoutAnimationType,
    });
    const show = Keyboard.addListener('keyboardWillShow', (event) => {
      keyboardTop.current = event.endCoordinates.screenY;
      void update(animationOf(event));
    });
    const hide = Keyboard.addListener('keyboardWillHide', (event) => {
      keyboardTop.current = null;
      void update(event ? animationOf(event) : undefined);
    });
    return () => {
      live.current = false;
      show.remove();
      hide.remove();
    };
  }, [update]);

  return (
    <View
      ref={ref}
      testID={testID}
      // A banner appearing or going away moves this view; measure again.
      onLayout={() => { if (keyboardTop.current !== null) void update(); }}
      style={[style, { paddingBottom: inset }]}
    >
      {children}
    </View>
  );
}
