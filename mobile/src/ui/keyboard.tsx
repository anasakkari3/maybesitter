import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Keyboard,
  Platform,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { measureWindowFrame, type WindowFrame } from './windowFrame';

/** Past `ScreenIn`'s 340ms entrance, so the second measurement sees the settled frame. */
export const ENTRANCE_SETTLE_MS = 400;

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
 * iOS only, like the `behavior="padding"` it replaces. On Android the old
 * component did nothing either, and whether the window still resizes for the
 * keyboard under SDK 57's edge-to-edge is **unverified on a device** — this is
 * where an Android fix goes. (Because the padding is the real overlap in
 * window space, turning it on there would not double-pad a resized window.)
 *
 * The container fills its parent (`flex: 1` first, the caller's style over
 * it): padding a content-sized view grows it, which grows the overlap it
 * measures next — a loop.
 *
 * Every screen with a keyboard uses this; a census test refuses a bare
 * KeyboardAvoidingView.
 */
export function AvoidKeyboard({
  children,
  style,
  testID,
  pointerEvents,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  pointerEvents?: 'auto' | 'none';
}) {
  const ref = useRef<View>(null);
  const [inset, setInset] = useState(0);
  const insetRef = useRef(0);
  // Where the keyboard's top edge is, or null while it is down.
  const keyboardTop = useRef<number | null>(null);
  const live = useRef(true);

  // No `LayoutAnimation`: it animates the next commit anywhere in the app, and
  // a keyboard hiding as a screen signs in hands it that screen's removal. On
  // Fabric an animated removal is the known way a deleted native view lingers
  // — which is what the device showed for D4. The lift is immediate.
  const update = useCallback(async () => {
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
    setInset(next);
  }, []);

  useEffect(() => {
    live.current = true;
    if (Platform.OS !== 'ios') return () => { live.current = false; };
    // Opened with the keyboard already up — a screen swapped in under a
    // focused field — so there is no show event to wait for. Only when a field
    // *is* focused: a keyboard iOS still reports after its field went away
    // (a screen that unmounted a focused input) is not one this screen has,
    // and padding for it would lift the footer away from where it is drawn.
    const metrics = Keyboard.isVisible() && TextInput.State.currentlyFocusedInput() != null
      ? Keyboard.metrics()
      : undefined;
    if (metrics) keyboardTop.current = metrics.screenY;
    // A show usually lands inside the screen's entrance (`ScreenIn`, 340ms of
    // translate and scale). A transform fires no layout, so the first
    // measurement would stand until the next keyboard event; measure again
    // once the entrance is over.
    let settle: ReturnType<typeof setTimeout> | null = null;
    const measureAgainLater = () => {
      if (settle) clearTimeout(settle);
      settle = setTimeout(() => { settle = null; if (keyboardTop.current !== null) void update(); }, ENTRANCE_SETTLE_MS);
    };
    const moved = (event: { endCoordinates: { screenY: number } }) => {
      keyboardTop.current = event.endCoordinates.screenY;
      void update();
      measureAgainLater();
    };
    // `WillChangeFrame` too: the keyboard changes height while it stays up
    // (emoji, QuickType, the hardware keyboard's bar), and iOS does not
    // always post another `WillShow` for it.
    const show = Keyboard.addListener('keyboardWillShow', moved);
    const change = Keyboard.addListener('keyboardWillChangeFrame', (event) => {
      if (keyboardTop.current !== null) moved(event);
    });
    const hide = Keyboard.addListener('keyboardWillHide', () => {
      keyboardTop.current = null;
      if (settle) { clearTimeout(settle); settle = null; }
      void update();
    });
    if (metrics) measureAgainLater();
    return () => {
      live.current = false;
      if (settle) clearTimeout(settle);
      show.remove();
      change.remove();
      hide.remove();
    };
  }, [update]);

  return (
    <View
      ref={ref}
      testID={testID}
      pointerEvents={pointerEvents}
      // A banner appearing or going away moves this view; measure again.
      onLayout={() => { if (keyboardTop.current !== null) void update(); }}
      style={[{ flex: 1 }, style, { paddingBottom: inset }]}
    >
      {children}
    </View>
  );
}
