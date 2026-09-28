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
