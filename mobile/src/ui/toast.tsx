import React, { useEffect, useRef, useState } from 'react';
import { Animated, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import { Btn, Txt } from './primitives';
import { UndoRing } from './icons';
import { useReducedMotion } from './motion';

export const TOAST_SECONDS = 5;

/**
 * The calm confirmation of a write that worked (Round 2).
 *
 * Round 1 confirmed a write with a sheet that had one button, OK, whose
 * only effect was to throw the user back to Today. Round 2 says the same
 * sentence at the bottom of whatever screen they are on and gets out of the
 * way: it fades after five seconds, a ring counts them down, and a tap
 * dismisses it sooner. When the write can be taken back within that window,
 * the same pill carries «تراجع»; when it cannot — the server has no way to
 * un-complete a commitment — it says only what happened.
 */
export function ToastHost() {
  const { s, t, tr, p, actions } = useApp();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  // The countdown is keyed to the toast it counts for, so a new toast starts
  // at five without the effect having to reset state during render.
  const [count, setCount] = useState<{ id: number; left: number } | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const toast = s.toast;
  const left = toast && count?.id === toast.id ? count.left : TOAST_SECONDS;

  useEffect(() => {
    if (!toast) return;
    const id = toast.id;
    Animated.timing(opacity, { toValue: 1, duration: reduced ? 0 : 180, useNativeDriver: true }).start();
    const tick = setInterval(() => setCount((c) => ({ id, left: Math.max(0, (c?.id === id ? c.left : TOAST_SECONDS) - 1) })), 1000);
    const hide = setTimeout(() => actions.dismissToast(id), TOAST_SECONDS * 1000);
    return () => { clearInterval(tick); clearTimeout(hide); opacity.setValue(0); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast?.id]);

  // The host stays mounted with nothing in it: its live region has to exist
  // before a toast arrives, or TalkBack is not told (review I1).
  return (
    <Animated.View
      testID="toast-live"
      pointerEvents="box-none"
      accessibilityLiveRegion="polite"
      style={{ position: 'absolute', left: 16, right: 16, bottom: Math.max(insets.bottom, 12) + 84, zIndex: 35, alignItems: 'center', opacity }}
    >
      {toast ? <Btn
        testID="toast"
        // The undo window is said once, here; the ticking digits are hidden
        // from screen readers, or the live region would change every second
        // and TalkBack could say the toast again each time (review n6).
        label={toast.undo ? `${toast.text}. ${tr('toastUndoWithin', { s: TOAST_SECONDS })}` : toast.text}
        onPress={() => { if (toast.undo) toast.undo(); actions.dismissToast(toast.id); }}
        scaleTo={0.98}
        style={{ backgroundColor: p.ink, borderRadius: 999, paddingVertical: 12, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 12, maxWidth: '100%', shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 20, shadowOffset: { width: 0, height: 10 }, elevation: 10 }}
      >
        <Txt size={14} weight={500} color={p.onInk} style={{ flexShrink: 1 }} testID="toast-text">{toast.text}</Txt>
        {toast.undo ? <Txt size={13} weight={600} color={p.acOnInk} testID="toast-undo">{t.undo}</Txt> : null}
        <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={{ width: 26, height: 26, alignItems: 'center', justifyContent: 'center' }}>
          <UndoRing left={left} track="rgba(255,255,255,0.25)" color={p.acOnInk} />
          <Txt size={10} weight={600} color={p.onInk} align="center" lh={1.2} latin>{String(left)}</Txt>
        </View>
      </Btn> : null}
    </Animated.View>
  );
}
