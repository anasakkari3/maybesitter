import React from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as WebBrowser from 'expo-web-browser';
import { useApp } from '../state/AppContext';
import { useAuth } from '../auth/AuthProvider';
import { legalUrls } from '../config/env';
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
  const { t, p } = useApp();
  const { lastSignOutReason, devBypass } = useAuth();
  const insets = useSafeAreaInsets();
  const legal = legalUrls();

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

      <View style={{ marginTop: 28, alignItems: 'center' }}>
        <Txt size={12} color={p.mu} align="center">{t.authLegalNote}</Txt>
        <View style={{ flexDirection: 'row', gap: 20, marginTop: 10 }}>
          {legal.privacy ? (
            <Btn label={t.authPrivacy} onPress={() => void WebBrowser.openBrowserAsync(legal.privacy as string)}>
              <Txt size={13} weight={600} color={p.ac}>{t.authPrivacy}</Txt>
            </Btn>
          ) : null}
          {legal.terms ? (
            <Btn label={t.authTerms} onPress={() => void WebBrowser.openBrowserAsync(legal.terms as string)}>
              <Txt size={13} weight={600} color={p.ac}>{t.authTerms}</Txt>
            </Btn>
          ) : null}
        </View>
      </View>
    </ScrollView>
  );
}
