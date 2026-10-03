import React, { createContext, useContext } from 'react';
import { ScrollView, View, type RefreshControlProps, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import { ScreenIn } from './motion';

/** A banner above the screen may have already cleared the status bar. This
 * only changes the screen frame; full-window overlays keep the device inset. */
export const ScreenTopInsetConsumedContext = createContext(false);

/**
 * What a tab root's last row has to clear before the bar has measured itself:
 * the bar, the «احكيها» pill floating above it, and the home indicator
 * (Stitch redesign, 2026-10-02). `Root` replaces it with the bar's measured
 * height as soon as there is one.
 */
export const TAB_CLEARANCE = 170;

/** The gap between a tab root's last row and the pill: part of the measured clearance (`TabBar`'s +12). */
export const FLOATING_GAP = 12;

/**
 * The screen shell — one owner of the top of the display (F1/F2, found on
 * device 2026-09-22).
 *
 * ── What went wrong ──────────────────────────────────────────────
 *
 * Round 2 gave the app one screen *grammar* (`chrome.tsx`) but no screen
 * *frame*, so twenty-one screens each hand-rolled the same three lines:
 *
 *     <ScreenIn style={{ backgroundColor: p.bg }}>
 *       <ScrollView contentContainerStyle={{ paddingHorizontal: 16, … }}>
 *         <SettingsHeader … />        ← the way back, inside the scroller
 *
 * Two defects fell out of that one shape:
 *
 *   F1  The way back is the scroller's first child, so on any screen longer
 *       than the display it scrolls off the top and the only way back is a
 *       swipe the app never taught. A pushed screen's exit must not be
 *       content.
 *
 *   F2  The safe-area inset was applied to the *content*: either inside
 *       `BackHeader` itself (`paddingTop: insets.top + 8`) or on a tab root's
 *       `contentContainerStyle`. Padding the content only moves the first
 *       thing down — everything after it still travels up under the Dynamic
 *       Island as the reader scrolls.
 *
 * ── The rule ─────────────────────────────────────────────────────
 *
 * The **frame** owns the inset, never the content. The scroller's viewport
 * begins below the island, so nothing can reach it — there is no overlap to
 * mask and no blur to fake. A pinned header sits above that viewport, outside
 * the scroller, so it cannot move.
 *
 * `insets.top` is read here and in no screen; `chrome.tsx`'s headers no
 * longer read it at all. `src/ui/__tests__/screenShellCensus.test.ts` keeps
 * both of those true.
 */
export function Screen({ pinned, children, footer, decoration, overlay, style, testID }: {
  /** The header, above the scroller and outside it — it never moves. */
  pinned?: React.ReactNode;
  /** The screen's own scroller (`ScreenScroll`, a `SectionList`, a form). */
  children: React.ReactNode;
  /** A bar at the bottom, above the home indicator, pinned like the header. */
  footer?: React.ReactNode;
  /** A background flourish, positioned in the frame's own space, unpadded. */
  decoration?: React.ReactNode;
  /**
   * A dialog or anything else that covers the whole screen. It goes outside
   * the padded frame on purpose: a scrim that started below the island would
   * leave a lit strip above itself.
   */
  overlay?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string | undefined;
}) {
  const { p } = useApp();
  const insets = useSafeAreaInsets();
  const topInsetConsumed = useContext(ScreenTopInsetConsumedContext);
  return (
    <ScreenIn style={[{ backgroundColor: p.bg }, style]}>
      {decoration ?? null}
      {/* The inset lives here, on the frame, so the scroller below it is
          already clear of the island and every child inherits the clearance
          rather than re-deriving it. */}
      <View testID={testID} style={{ flex: 1, paddingTop: topInsetConsumed ? 0 : insets.top }}>
        {pinned ? <View style={{ paddingHorizontal: 16, paddingTop: 8 }}>{pinned}</View> : null}
        {children}
        {footer ?? null}
      </View>
      {overlay ?? null}
    </ScreenIn>
  );
}

/**
 * The ordinary scrolling body: the gutter, the gap and the bottom clearance
 * every screen was repeating, in one place.
 *
 * `bottom` defaults to a pushed screen's 60. A tab root passes the measured
 * clearance (`TAB_CLEARANCE` until it is measured), because the bar and the
 * pill are drawn over the screen and the last row has to clear them.
 */
export function ScreenScroll({ children, gap = 14, bottom = 60, floating, grow = false, testID, refreshControl, topGap = 14, keyboardShouldPersistTaps, automaticallyAdjustKeyboardInsets, style, scrollRef }: {
  children: React.ReactNode;
  /**
   * A tab root's measured clearance for the bar and the «احكيها» pill drawn
   * over it (Root's `tabClearance`). The *viewport* stops above them, so the
   * pill covers no row — not at the end of the scroll and not at rest either
   * (audit 2026-10-03 #9: at text size 1.3 the pill sat on «ليش هاي بالذات»,
   * at 1.5 on «…», on the first frame). The clearance is measured from the
   * real, text-scaled pill and bar, so it grows with the reader's text.
   * With it, `bottom` is ignored: the last row needs only the gap above the pill.
   */
  floating?: number | undefined;
  /** For a screen that has to bring something it opened into view. */
  scrollRef?: React.Ref<ScrollView> | undefined;
  gap?: number;
  bottom?: number;
  /** `flexGrow: 1`, for a body that has to push a footer to the bottom. */
  grow?: boolean;
  testID?: string | undefined;
  refreshControl?: React.ReactElement<RefreshControlProps> | undefined;
  /** The space between a pinned header and the first row beneath it. */
  topGap?: number;
  keyboardShouldPersistTaps?: 'always' | 'never' | 'handled' | undefined;
  /**
   * iOS insets the scroller by the keyboard. Only for a screen that is not
   * inside an `AvoidKeyboard` (which lifts the whole body instead): both
   * would pad twice.
   */
  automaticallyAdjustKeyboardInsets?: boolean | undefined;
  /** Viewport layout, distinct from the padding of its scrolling content. */
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <ScrollView
      ref={scrollRef}
      testID={testID}
      style={floating === undefined ? style : [{ marginBottom: Math.max(0, floating - FLOATING_GAP) }, style]}
      {...(refreshControl ? { refreshControl } : {})}
      {...(keyboardShouldPersistTaps ? { keyboardShouldPersistTaps } : {})}
      {...(automaticallyAdjustKeyboardInsets ? { automaticallyAdjustKeyboardInsets } : {})}
      contentContainerStyle={{
        paddingHorizontal: 16,
        paddingTop: topGap,
        paddingBottom: floating === undefined ? bottom : FLOATING_GAP,
        gap,
        ...(grow ? { flexGrow: 1 } : {}),
      }}
    >
      {children}
    </ScrollView>
  );
}
