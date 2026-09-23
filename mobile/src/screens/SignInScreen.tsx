import React from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../state/AppContext';
import { useAuth } from '../auth/AuthProvider';
import { openLegal, privacyPolicyUrl, termsUrl } from '../config/legalLinks';
import { BrandMark } from '../ui/brand';
import { Btn, Card, Pill, Txt } from '../ui/primitives';

/**
 * The first screen of the app. There is no pasted-access-code field here and
 * there never will be: the retired client's «الصق رمز التجربة» step is gone,
 * and `src/auth/__tests__/authSafety.test.ts` keeps every name it went by out
 * of `mobile/src`.
 *
 * The three provider slots render in the design's order — Apple, Google,
 * email. A slot the build cannot offer (Apple off Apple hardware, Google
 * before its client id exists) renders nothing rather than a button that
 * fails, so the screen is honest about what it can actually do.
 */
export function SignInScreen({
  appleSlot,
  googleSlot,
  onEmail,
}: {
  appleSlot?: React.ReactNode;
  googleSlot?: React.ReactNode;
  onEmail: () => void;
}) {
  const { t, p, lang } = useApp();
  const { lastSignOutReason, devBypass } = useAuth();
  const insets = useSafeAreaInsets();
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
      style={{ flex: 1, backgroundColor: p.bg }}
      contentContainerStyle={{
        paddingTop: insets.top + 48,
        paddingBottom: insets.bottom + 32,
        paddingHorizontal: 24,
        flexGrow: 1,
        justifyContent: 'center',
      }}
    >
      <View style={{ alignItems: 'center', marginBottom: 24 }}><BrandMark size={76} /></View>
      <Txt size={26} weight={600} align="center">{t.authTitle}</Txt>
      <Txt size={15} color={p.mu} align="center" style={{ marginTop: 10 }}>{t.authSubtitle}</Txt>

      {notice ? (
        <Card pad={14} style={{ marginTop: 20, backgroundColor: p.sf2 }}>
          <Txt size={14} align="center">{notice}</Txt>
        </Card>
      ) : null}

      <View style={{ marginTop: 28, gap: 12 }}>
        {appleSlot}
        {googleSlot}
        <Pill label={t.authContinueEmail} kind="accent" onPress={onEmail} />
      </View>

      {devBypass ? (
        <Txt size={12} color={p.mu} align="center" style={{ marginTop: 20 }}>{t.authDevMode}</Txt>
      ) : null}

      {/* A notice, not a checkbox: continuing implies the terms, and the one
          thing that needs an explicit yes — sending words to a model — is asked
          separately in onboarding (UC-2.1 #161). Each link is its own pressable
          rather than a span inside the sentence, so nothing has to be
          concatenated across a bidi run. */}
      <View testID="signin-legal-notice" style={{ marginTop: 28, alignItems: 'center' }}>
        <Txt size={12} color={p.mu} align="center">{t.authLegalNote}</Txt>
        <View style={{ flexDirection: 'row', gap: 20, marginTop: 10 }}>
          {legal.privacy ? (
            <Btn label={t.authPrivacy} onPress={() => void openLegal(legal.privacy)}>
              <Txt size={13} weight={600} color={p.ac}>{t.authPrivacy}</Txt>
            </Btn>
          ) : null}
          {legal.terms ? (
            <Btn label={t.authTerms} onPress={() => void openLegal(legal.terms)}>
              <Txt size={13} weight={600} color={p.ac}>{t.authTerms}</Txt>
            </Btn>
          ) : null}
        </View>
      </View>
    </ScrollView>
  );
}
