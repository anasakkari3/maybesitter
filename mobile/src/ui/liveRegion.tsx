import React from 'react';
import { Platform, View, type StyleProp, type ViewStyle } from 'react-native';

/** An empty region takes no room: no padding, and no gap in a flex parent. */
const OUT_OF_FLOW: ViewStyle = { position: 'absolute', width: 0, height: 0, overflow: 'hidden' };

/**
 * A polite live region that is always mounted; only what it says comes and
 * goes (POLISH-MOBILE review I1).
 *
 * Android announces a live region when content changes inside a view that
 * already carries the region. `{failed ? <View accessibilityLiveRegion…> : null}`
 * mounts the region and its line in one step — a subtree change of a parent
 * that is no region — and TalkBack says nothing. So render this always and
 * put the condition inside: `<LiveRegion>{failed ? <Txt…/> : null}</LiveRegion>`.
 *
 * iOS has no live regions; pair it with `useAnnounceOnIos` where VoiceOver
 * must hear the line too.
 */
export function LiveRegion({ children, style, testID, alert = false }: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  /** Also marks the region as an alert, for a refusal the person must not miss. */
  alert?: boolean;
}) {
  const empty = children === null || children === undefined || children === false;
  return (
    <View
      accessibilityLiveRegion="polite"
      {...(alert ? { accessibilityRole: 'alert' as const } : {})}
      {...(testID ? { testID } : {})}
      style={empty ? OUT_OF_FLOW : style}
    >
      {children}
    </View>
  );
}

/** A one-point node: Android keeps it on screen, so its region is announced. */
const ANNOUNCEMENT_NODE: ViewStyle = { position: 'absolute', width: 1, height: 1, overflow: 'hidden' };

/**
 * A polite live region that says one line and draws nothing, for a status
 * whose visible card must be measured afresh after a live text-size change
 * (Q-LIVE2-001).
 *
 * A card drawn inside a `LiveRegion` replaces its paragraphs on a text-size
 * change (`SaidWords`, `Btn`), and Android hears any subtree replacement in a
 * region as new content: TalkBack read the refusal again although nothing had
 * changed. So the card sits outside, and this node is the region's only
 * content — a view with a label and no children, which a text-size change
 * leaves alone. It changes only when `text` does. iOS has no live regions;
 * the node is hidden from VoiceOver there, which reads the card.
 */
export function LiveAnnouncement({ text, testID }: { text: string | null; testID?: string }) {
  return (
    <LiveRegion {...(testID ? { testID } : {})} style={ANNOUNCEMENT_NODE}>
      {text ? (
        <View
          accessible
          accessibilityLabel={text}
          accessibilityElementsHidden={Platform.OS === 'ios'}
          {...(testID ? { testID: `${testID}-said` } : {})}
          style={ANNOUNCEMENT_NODE}
        />
      ) : null}
    </LiveRegion>
  );
}
