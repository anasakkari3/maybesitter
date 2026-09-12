import React, { useCallback, useEffect, useState } from 'react';
import { AppState, View } from 'react-native';
import { useApp } from '../state/AppContext';
import { useAuth } from './AuthProvider';
import { fill } from '../i18n/strings';
import { Pill, Txt } from '../ui/primitives';

/** Firebase rate-limits verification mail; the UI says so rather than failing. */
export const RESEND_COOLDOWN_SECONDS = 60;

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
  const { t, p } = useApp();
  const { user, reloadUser, repository } = useAuth();
  const [cooldown, setCooldown] = useState(0);
  const [sent, setSent] = useState(false);

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

  if (!needsVerification) return null;

  return (
    <View
      style={{
        backgroundColor: p.wms,
        paddingVertical: 12,
        paddingHorizontal: 16,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <Txt size={13} color={p.wm} style={{ flex: 1 }}>
        {sent && cooldown > 0 ? t.authVerifyResent : t.authVerifyBanner}
      </Txt>
      <Pill
        label={cooldown > 0 ? fill(t.authVerifyCooldown, { s: cooldown }) : t.authVerifyResend}
        kind="soft"
        size={13}
        pad={8}
        disabled={cooldown > 0}
        onPress={() => void resend()}
      />
    </View>
  );
}
