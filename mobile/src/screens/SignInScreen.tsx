import React from 'react';
import { ScrollView, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import { useAuth } from '../auth/AuthProvider';
import { ProviderButton } from '../auth/ProviderButton';
import { openLegal, privacyPolicyUrl, termsUrl } from '../config/legalLinks';
import { BrandChip } from '../features/onboarding/OnboardingChrome';
import { LanguageSwitch } from '../features/language/LanguageSwitch';
import { useLayoutMode } from '../theme/textScale';
import { Btn, Txt } from '../ui/primitives';

/**
 * The first screen of the app (Stitch `08-sign-in`). There is no
 * pasted-access-code field here and there never will be: the retired client's
 * «الصق رمز التجربة» step is gone, and `src/auth/__tests__/authSafety.test.ts`
 * keeps every name it went by out of `mobile/src`.
 *
 * The three provider buttons render in the design's order — Google, Apple,
 * email — then the way to a new account. A slot the build cannot offer (Apple
 * off Apple hardware, Google before its client id exists) renders nothing
 * rather than a button that fails, so the screen is honest about what it can
 * actually do.
 *
 * The language switch is here as well as on the first-launch screen: somebody
 * who picked the wrong one should not have to sign in to find the way back.
 */
export function SignInScreen({
  appleSlot,
  googleSlot,
  onEmail,
  onSignUp,
}: {
  appleSlot?: React.ReactNode;
  googleSlot?: React.ReactNode;
  onEmail: () => void;
  /** Opens the email flow on "create an account". Absent, the link is not drawn. */
  onSignUp?: (() => void) | undefined;
}) {
  const { t, p, lang } = useApp();
  const { lastSignOutReason, devBypass } = useAuth();
  const insets = useSafeAreaInsets();
  const stacked = useLayoutMode() !== 'normal';
  // Routed by the language the screen is actually rendering in, not by the
  // device's: somebody reading an Arabic sign-in screen gets the Arabic policy.
  const legal = { privacy: privacyPolicyUrl(lang), terms: termsUrl(lang) };

  const notice =
    lastSignOutReason === 'session_expired'
      ? t.authSessionExpired
      : lastSignOutReason === 'revoked'
        ? t.authSignedOutRevoked
        : lastSignOutReason === 'deleted'
          ? t.authSignedOutDeleted
          : null;

  return (
    <ScrollView
      testID="signin-root"
      style={{ flex: 1, backgroundColor: p.bg }}
      contentContainerStyle={{
        paddingTop: insets.top + 12,
        paddingBottom: insets.bottom + 16,
        paddingHorizontal: 16,
        flexGrow: 1,
        gap: 0,
      }}
    >
      <View style={{ flexDirection: stacked ? 'column' : 'row', alignItems: stacked ? 'flex-start' : 'center', justifyContent: 'space-between', gap: 12 }}>
        <BrandChip />
        <LanguageSwitch testID="signin-language" />
      </View>

      <View style={{ flex: 1, justifyContent: 'center', paddingVertical: 24 }}>
        <View style={{ gap: 8, marginBottom: 24, alignItems: 'flex-start' }}>
          <Txt role="page" size={26} weight={700}>{t.authTitle}</Txt>
          <Txt size={15} color={p.mu}>{t.authSubtitle}</Txt>
        </View>

        {notice ? (
          <View testID="signin-notice" style={{ marginBottom: 16, borderRadius: 16, backgroundColor: p.wms, paddingVertical: 12, paddingHorizontal: 14 }}>
            <Txt size={14} color={p.wm}>{notice}</Txt>
          </View>
        ) : null}

        <View style={{ gap: 12 }}>
          {googleSlot}
          {appleSlot}
          <ProviderButton look="app" label={t.authContinueEmail} onPress={onEmail} testID="signin-email" mark={fg => <MailGlyph color={fg} />} />
        </View>

        {onSignUp ? (
          <Btn testID="signin-create-account" label={t.authSwitchToSignUp} onPress={onSignUp} scaleTo={0.97}
            style={{ minHeight: 44, marginTop: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 }}>
            <Txt size={15} weight={600} color={p.acd} align="center">{t.authSwitchToSignUp}</Txt>
          </Btn>
        ) : null}

        {devBypass ? (
          <Txt size={13} color={p.mu} align="center" style={{ marginTop: 16 }}>{t.authDevMode}</Txt>
        ) : null}
      </View>

      {/* A notice, not a checkbox: continuing implies the terms, and the one
          thing that needs an explicit yes — sending words to a model — is told
          separately in onboarding. Each link is its own pressable rather than a
          span inside the sentence, so nothing has to be concatenated across a
          bidi run. */}
      <View testID="signin-legal-notice" style={{ alignItems: 'center', borderTopWidth: 1, borderTopColor: p.ln, paddingTop: 12 }}>
        <Txt size={13} color={p.mu} align="center">{t.authLegalNote}</Txt>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 16, marginTop: 4 }}>
          {legal.terms ? (
            <Btn
              label={t.authTerms}
              accessibilityRole="link"
              onPress={() => void openLegal(legal.terms)}
              hitSlop={8}
              style={{ minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' }}
            >
              <Txt size={13} weight={600} color={p.tx} style={{ textDecorationLine: 'underline' }}>{t.authTerms}</Txt>
            </Btn>
          ) : null}
          {legal.privacy ? (
            <Btn
              label={t.authPrivacy}
              accessibilityRole="link"
              onPress={() => void openLegal(legal.privacy)}
              hitSlop={8}
              style={{ minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' }}
            >
              <Txt size={13} weight={600} color={p.tx} style={{ textDecorationLine: 'underline' }}>{t.authPrivacy}</Txt>
            </Btn>
          ) : null}
        </View>
      </View>
    </ScrollView>
  );
}

function MailGlyph({ color }: { color: string }) {
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24">
      <Path d="M3 6h18v12H3ZM3 7l9 6 9-6" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}
