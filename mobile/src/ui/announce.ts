import { useEffect, useRef } from 'react';
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
 * Says a line on both platforms when something new arrives — for words that
 * are drawn outside any live region (#802).
 *
 * The capture chat's reply cannot sit in its live region: its question is
 * dropped once answered, and TalkBack hears any change inside a region as
 * new content, over the move to the next question (#780). A hidden node in
 * the region either is a second swipe stop or is never announced at all
 * (Q-LIVE2-002). So the reply's words are the one element, and its arrival
 * is told here.
 *
 * Keyed on the arrival, not the words or their objects (Q802-REV-001,
 * Q802-R2-002): `arrival` is a count the state moves only when something new
 * was said. What is there when the screen mounts is already heard — even
 * while `paused` (Q802-R2-001) — so reopening a kept conversation says
 * nothing. While `paused` (another page has the screen) nothing is said, and
 * an arrival in the meantime is said once the pause ends.
 */
export function useAnnounceArrival(arrival: number | null, text: string | null, paused = false): void {
  const heard = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    if (heard.current === undefined) {
      heard.current = arrival;
      return;
    }
    if (paused || arrival === null || arrival === heard.current) return;
    heard.current = arrival;
    if (text) AccessibilityInfo.announceForAccessibility(text);
  }, [arrival, text, paused]);
}
