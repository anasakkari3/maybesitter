import { useEffect } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';

/**
 * Tells VoiceOver a status line that changed after an action, away from the
 * control the person touched (FY3 review m4, FZ2 review M5).
 *
 * The line itself sits in a view with `accessibilityLiveRegion="polite"`,
 * which is how TalkBack hears it. iOS has no live regions, so VoiceOver is told
 * here — on iOS only, so Android does not hear it twice. The pattern
 * `SetupChatStep`'s too-long line set. Null says nothing.
 */
export function useAnnounceOnIos(text: string | null): void {
  useEffect(() => {
    if (text && Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(text);
  }, [text]);
}

/**
 * Says a line on both platforms, once each time it changes — for words that
 * are drawn outside any live region (#802).
 *
 * The capture chat's reply cannot sit in its live region: its question is
 * dropped once answered, and TalkBack hears any change inside a region as
 * new content, over the move to the next question (#780). A hidden node in
 * the region either is a second swipe stop or is never announced at all
 * (Q-LIVE2-002). So the reply's words are the one element, and its arrival
 * is told here. Null says nothing.
 */
export function useAnnounce(text: string | null): void {
  useEffect(() => {
    if (text) AccessibilityInfo.announceForAccessibility(text);
  }, [text]);
}
