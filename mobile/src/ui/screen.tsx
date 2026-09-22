import React from 'react';
import { ScrollView, View, type RefreshControlProps, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import { ScreenIn } from './motion';

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
  return (
    <ScreenIn style={[{ backgroundColor: p.bg }, style]}>
      {decoration ?? null}
      {/* The inset lives here, on the frame, so the scroller below it is
          already clear of the island and every child inherits the clearance
          rather than re-deriving it. */}
      <View testID={testID} style={{ flex: 1, paddingTop: insets.top }}>
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
 * `bottom` defaults to a pushed screen's 60. A tab root passes 130, because
 * the floating tab bar is drawn over the screen and the last row has to clear
 * it.
 */
export function ScreenScroll({ children, gap = 14, bottom = 60, grow = false, testID, refreshControl, topGap = 14, keyboardShouldPersistTaps }: {
  children: React.ReactNode;
  gap?: number;
  bottom?: number;
  /** `flexGrow: 1`, for a body that has to push a footer to the bottom. */
  grow?: boolean;
  testID?: string | undefined;
  refreshControl?: React.ReactElement<RefreshControlProps> | undefined;
  /** The space between a pinned header and the first row beneath it. */
  topGap?: number;
  keyboardShouldPersistTaps?: 'always' | 'never' | 'handled' | undefined;
}) {
  return (
    <ScrollView
      testID={testID}
      {...(refreshControl ? { refreshControl } : {})}
      {...(keyboardShouldPersistTaps ? { keyboardShouldPersistTaps } : {})}
      contentContainerStyle={{
        paddingHorizontal: 16,
        paddingTop: topGap,
        paddingBottom: bottom,
        gap,
        ...(grow ? { flexGrow: 1 } : {}),
      }}
    >
      {children}
    </ScrollView>
  );
}
