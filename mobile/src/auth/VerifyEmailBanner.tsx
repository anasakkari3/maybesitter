import React, { useCallback, useContext, useEffect, useState } from 'react';
import { AppState, ScrollView, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import { useAuth } from './AuthProvider';
import { Btn, Pill, Txt } from '../ui/primitives';
import { useSoftKeyboardShown } from '../ui/keyboard';
import { layoutModeFor } from '../theme/textScale';
import { ScreenTopInsetConsumedContext } from '../ui/screen';

/** Firebase rate-limits verification mail; the UI says so rather than failing. */
export const RESEND_COOLDOWN_SECONDS = 60;

/** The sentence's size, in points before the reader's scale. */
const TEXT_SIZE = 13;
/** The most of the window the unfolded sentence may take; past it the sentence scrolls. */
export const EXPANDED_SHARE = 0.25;

/**
 * Enlarged text uses a short visible label and a full accessible sentence.
 * The full sentence opens on press, within a bounded scroll area.
 */
export function bannerTextLines({ fontScale }: { windowHeight: number; fontScale: number | undefined }): number | undefined {
  if (layoutModeFor(fontScale) === 'normal') return undefined;
  return 1;
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
export function VerifyEmailBanner({ children }: React.PropsWithChildren) {
  const { t, tr, p } = useApp();
  const { user, reloadUser, repository } = useAuth();
  // Rendered once at the root, above every screen (#495). While visible it
  // owns the status-bar clearance; the screen below must not add it again.
  const insets = useSafeAreaInsets();
  // The offline banner above may already have cleared the status bar.
  const consumedAbove = useContext(ScreenTopInsetConsumedContext);
  const topInset = consumedAbove ? 0 : insets.top;
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

  const renderBanner = () => {
    // Hidden, not unmounted, while the software keyboard is up: nothing here
    // is reachable mid-sentence, and the room is the field's and «فهمها»'s
    // (UAT round 6, batch 9). The cooldown survives it.
    if (!needsVerification || keyboardShown) return null;

    const message = sent && cooldown > 0 ? t.authVerifyResent : t.authVerifyBanner;
    const lines = bannerTextLines({ windowHeight, fontScale });
    const resendButton = (
      <Pill
        label={cooldown > 0 ? (lines === undefined ? tr('authVerifyCooldown', { s: cooldown }) : tr('authVerifyCooldownShort', { s: cooldown })) : t.authVerifyResend}
        accessibilityLabel={cooldown > 0 ? tr('authVerifyCooldown', { s: cooldown }) : t.authVerifyResend}
        kind="warm"
        size={13}
        pad={8}
        disabled={cooldown > 0}
        onPress={() => void resend()}
        // Stitch `01c`: the action outlined in the banner's own amber.
        style={{ borderWidth: 1, borderColor: p.prop, minHeight: 44 }}
      />
    );

    if (lines === undefined) {
      return (
        <View
          testID="verify-email-banner"
          style={{
            backgroundColor: p.wms,
            borderBottomWidth: 1,
            borderBottomColor: p.prop,
            paddingTop: topInset + 12,
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

    // Keep the folded strip short at enlarged sizes; the full sentence remains
    // available by touch and to screen readers.
    const visibleMessage = sent && cooldown > 0 ? t.authVerifySentShort : t.authVerifyShort;
    const sentence = (
      <Btn
        label={message}
        accessibilityState={{ expanded }}
        scaleTo={0.99}
        onPress={() => setExpanded(open => !open)}
        style={{ flexShrink: 1, minWidth: 0 }}
      >
        <Txt size={TEXT_SIZE} color={p.wm} lines={expanded ? undefined : lines} style={{ flexShrink: 1 }}>
          {expanded ? message : visibleMessage}
        </Txt>
      </Btn>
    );
    return (
      <View
        testID="verify-email-banner"
        style={{
          backgroundColor: p.wms,
          borderBottomWidth: 1,
          borderBottomColor: p.prop,
          paddingTop: topInset + 6,
          paddingBottom: 6,
          paddingHorizontal: 16,
          flexDirection: expanded ? 'column' : 'row',
          alignItems: 'center',
          gap: 8,
        }}
      >
        {expanded
          ? <ScrollView testID="verify-email-banner-full" style={{ maxHeight: Math.round(windowHeight * EXPANDED_SHARE), flexGrow: 0 }}>{sentence}</ScrollView>
          : sentence}
        <View style={{ flexShrink: 0 }}>{resendButton}</View>
      </View>
    );
  };

  return (
    <>
      {renderBanner()}
      {/* Keep the provider mounted while verification or keyboard state changes:
          the screen, its scroll position and any draft belong to the user. */}
      <ScreenTopInsetConsumedContext.Provider value={consumedAbove || (needsVerification && !keyboardShown)}>
        {children}
      </ScreenTopInsetConsumedContext.Provider>
    </>
  );
}
