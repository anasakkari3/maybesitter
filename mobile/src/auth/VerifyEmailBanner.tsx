import React, { useCallback, useEffect, useState } from 'react';
import { AppState, ScrollView, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import { useAuth } from './AuthProvider';
import { Btn, Pill, Txt } from '../ui/primitives';
import { useSoftKeyboardShown } from '../ui/keyboard';
import { LINE_HEIGHT } from '../theme/fonts';
import { layoutModeFor, textScaleOf } from '../theme/textScale';

/** Firebase rate-limits verification mail; the UI says so rather than failing. */
export const RESEND_COOLDOWN_SECONDS = 60;

/** The sentence's size, in points before the reader's scale. */
const TEXT_SIZE = 13;
/** The most of the window the folded sentence may take at the accessibility sizes. */
export const TEXT_SHARE = 0.12;
/** The most of the window the unfolded sentence may take; past it the sentence scrolls. */
export const EXPANDED_SHARE = 0.25;

/**
 * How many lines the sentence may paint, or undefined for no cap.
 *
 * UAT round 6, batch 9 (D-g remainder): the banner sits above every screen,
 * and at the accessibility sizes it was a row of a pill and a sentence a few
 * letters wide, 74–862pt tall at AX5 — it swallowed the capture composer,
 * Today, Calendar and Settings alike. So from the first accessibility size
 * (the boundary where the rest of the chrome changes structure) the sentence
 * gets the lines that fit `TEXT_SHARE` of the window, never fewer than one:
 * two on the UAT iPhone at AX1–AX3, one at AX4–AX5. Below that nothing is
 * capped and the default row is unchanged. The line box is the one `Txt`
 * paints: 13pt × the tallest script ratio, which React Native scales by the
 * reader's size.
 */
export function bannerTextLines({ windowHeight, fontScale }: { windowHeight: number; fontScale: number | undefined }): number | undefined {
  if (layoutModeFor(fontScale) !== 'xl') return undefined;
  const line = Math.round(TEXT_SIZE * Math.max(...Object.values(LINE_HEIGHT))) * textScaleOf(fontScale);
  return Math.max(1, Math.floor((windowHeight * TEXT_SHARE) / line));
}

/**
 * "Confirm your email" — a banner, not a wall.
 *
 * Product access does not wait on verification (UC-1.3 #147): a person who
 * captured a commitment in the shop and cannot reach their inbox still gets
 * their commitment. What verification buys is account recovery, which is what
 * the copy says.
 *
 * The reload runs when the app comes back to the foreground, because the
 * user's next move after tapping the link in their mail is to switch back to
 * MaybeSitter, and the banner should already be gone when they do.
 */
export function VerifyEmailBanner() {
  const { t, tr, p } = useApp();
  const { user, reloadUser, repository } = useAuth();
  // Rendered once at the root, above every screen (#495): the screens add
  // `insets.top` to their own content, so clearing the status bar is the
  // banner's own job — without it the banner is drawn under the clock.
  const insets = useSafeAreaInsets();
  const { height: windowHeight, fontScale } = useWindowDimensions();
  const keyboardShown = useSoftKeyboardShown();
  const [cooldown, setCooldown] = useState(0);
  const [sent, setSent] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const needsVerification = user !== null && user.email !== null && !user.emailVerified;

  useEffect(() => {
    if (!needsVerification) return;
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') void reloadUser();
    });
    return () => subscription.remove();
  }, [needsVerification, reloadUser]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown(seconds => seconds - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const resend = useCallback(async () => {
    if (cooldown > 0) return;
    setCooldown(RESEND_COOLDOWN_SECONDS);
    try {
      await repository.sendVerificationEmail();
      setSent(true);
    } catch {
      // The cooldown still runs: a failure here is almost always the rate
      // limit itself, and inviting an immediate retry would only extend it.
      setSent(false);
    }
  }, [cooldown, repository]);

  // Hidden, not unmounted, while the software keyboard is up: nothing here
  // is reachable mid-sentence, and the room is the field's and «فهمها»'s
  // (UAT round 6, batch 9). The cooldown survives it.
  if (!needsVerification || keyboardShown) return null;

  const message = sent && cooldown > 0 ? t.authVerifyResent : t.authVerifyBanner;
  const lines = bannerTextLines({ windowHeight, fontScale });
  const resendButton = (
    <Pill
      label={cooldown > 0 ? tr('authVerifyCooldown', { s: cooldown }) : t.authVerifyResend}
      kind="soft"
      size={13}
      pad={8}
      disabled={cooldown > 0}
      onPress={() => void resend()}
    />
  );

  if (lines === undefined) {
    return (
      <View
        testID="verify-email-banner"
        style={{
          backgroundColor: p.wms,
          paddingTop: insets.top + 12,
          paddingBottom: 12,
          paddingHorizontal: 16,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <Txt size={TEXT_SIZE} color={p.wm} style={{ flex: 1 }}>
          {message}
        </Txt>
        {resendButton}
      </View>
    );
  }

  // The accessibility sizes: the sentence on its own full-width lines, capped,
  // with the button under it. The sentence is a toggle that unfolds it for a
  // reader who wants all of it; a screen reader hears all of it either way.
  const sentence = (
    <Btn
      label={message}
      accessibilityState={{ expanded }}
      scaleTo={0.99}
      onPress={() => setExpanded(open => !open)}
    >
      <Txt size={TEXT_SIZE} color={p.wm} lines={expanded ? undefined : lines}>
        {message}
      </Txt>
    </Btn>
  );
  return (
    <View
      testID="verify-email-banner"
      style={{
        backgroundColor: p.wms,
        paddingTop: insets.top + 12,
        paddingBottom: 12,
        paddingHorizontal: 16,
        flexDirection: 'column',
        alignItems: 'stretch',
        gap: 8,
      }}
    >
      {expanded
        ? <ScrollView testID="verify-email-banner-full" style={{ maxHeight: Math.round(windowHeight * EXPANDED_SHARE), flexGrow: 0 }}>{sentence}</ScrollView>
        : sentence}
      <View style={{ alignItems: 'flex-start' }}>{resendButton}</View>
    </View>
  );
}
