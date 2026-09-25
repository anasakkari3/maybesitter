import React, { useCallback, useState } from 'react';
import { Alert, ScrollView, TextInput, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { useApp } from '../state/AppContext';
import { useAuth } from '../auth/AuthProvider';
import { useSingleFlight } from '../auth/useSingleFlight';
import { useAccountDeletion } from '../features/account/AccountDeletionProvider';
import { ReauthCancelled } from '../features/account/reauthenticate';
import type { AppleReauthentication } from '../auth/types';
import { useIsOnline } from '../api/ui/OfflineBanner';
import { accountDeletionUrl } from '../config/env';
import { Card, Pill, Txt } from '../ui/primitives';
import { TaskHeader } from '../ui/taskHeader';

/**
 * Delete account (UC-1.5 #149).
 *
 * ── Calm, and not manipulative ───────────────────────────────────
 *
 * The copy says what happens and what is kept, then offers one destructive
 * action. There is no type-to-confirm — Apple asks that deletion not be made
 * burdensome — and no guilt, no "are you sure you want to lose everything",
 * no pre-ticked alternative. Cancel is the alert's default.
 *
 * ── Nothing happens before the confirmation ──────────────────────
 *
 * The request is made from inside the alert's destructive handler and nowhere
 * else, so dismissing the alert makes zero network calls. A test asserts it.
 */
export function DeleteAccountScreen({ onBack }: { onBack: () => void }) {
  const { t, p } = useApp();
  const { repository } = useAuth();
  const online = useIsOnline();
  const { phase, requestDeletion, retryAfterReauth, cancelReauth } = useAccountDeletion();
  const { busy, run } = useSingleFlight();
  const [password, setPassword] = useState('');
  const [reauthFailed, setReauthFailed] = useState(false);
  const policyUrl = accountDeletionUrl();

  const confirmThenDelete = useCallback(() => {
    // Cancel first and styled as the cancel button, so the safe path is the
    // one a mis-tap and the hardware back gesture both take.
    Alert.alert(t.accountDeleteConfirmTitle, t.accountDeleteConfirmBody, [
      { text: t.accountDeleteConfirmCancel, style: 'cancel' },
      {
        text: t.accountDeleteConfirmProceed,
        style: 'destructive',
        onPress: () => void run(requestDeletion),
      },
    ]);
  }, [t, run, requestDeletion]);

  const reauthenticate = useCallback(
    (provider: 'password' | 'google.com' | 'apple.com') =>
      run(async () => {
        setReauthFailed(false);
        let apple: AppleReauthentication | undefined;
        try {
          if (provider === 'password') {
            await repository.reauthenticateWithPassword(password);
            // Cleared the instant it has been used. It was never anywhere but
            // this component's state and the credential we just built.
            setPassword('');
          } else if (provider === 'google.com') {
            await repository.reauthenticateWithGoogle();
          } else {
            // Its one-time code goes straight to the retry, which revokes the
            // account's Apple tokens with it. Held for this call only.
            apple = await repository.reauthenticateWithApple();
          }
          // `auth_time` is fresh on the account now, but the cached ID token
          // still carries the old claim until it is re-minted.
          await repository.refreshIdentity();
        } catch (error) {
          // Backing out of a provider sheet is a decision, not a failure: the
          // screen stays exactly as it was, with nothing deleted.
          if (error instanceof ReauthCancelled) return;
          setReauthFailed(true);
          return;
        }
        // One deliberate attempt, from a place the user just acted. Not a
        // retry queue, and not automatic.
        await retryAfterReauth(apple);
      }),
    [run, repository, password, retryAfterReauth],
  );

  if (phase.kind === 'reauth') {
    return (
      <View style={{ flex: 1, backgroundColor: p.bg }}>
        <TaskHeader pill={t.back} onPill={cancelReauth} title={t.accountDeleteTitle} />
        <ScrollView contentContainerStyle={{ padding: 24, gap: 16 }} keyboardShouldPersistTaps="handled">
          <Txt size={22} weight={600}>{t.accountReauthTitle}</Txt>
          <Txt size={15} color={p.mu}>{t.accountReauthBody}</Txt>

          {phase.provider === 'password' ? (
            <View style={{ gap: 8 }}>
              <Txt size={13} color={p.mu}>{t.accountReauthPasswordLabel}</Txt>
              <TextInput
                testID="reauth-password"
                accessibilityLabel={t.accountReauthPasswordLabel}
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                textContentType="password"
                autoComplete="current-password"
                editable={!busy}
                style={{
                  backgroundColor: p.sf,
                  borderWidth: 1,
                  borderColor: p.ln,
                  borderRadius: 16,
                  paddingVertical: 14,
                  paddingHorizontal: 16,
                  fontSize: 16,
                  color: p.tx,
                  minHeight: 52,
                }}
              />
              <Pill
                label={t.accountReauthPasswordAction}
                kind="accent"
                disabled={busy}
                onPress={() => void reauthenticate('password')}
              />
            </View>
          ) : null}

          {phase.provider === 'google.com' ? (
            <Pill
              label={t.accountReauthGoogleAction}
              kind="outline"
              disabled={busy}
              onPress={() => void reauthenticate('google.com')}
            />
          ) : null}

          {phase.provider === 'apple.com' ? (
            <Pill
              label={t.accountReauthAppleAction}
              kind="outline"
              disabled={busy}
              onPress={() => void reauthenticate('apple.com')}
            />
          ) : null}

          {reauthFailed ? <Txt size={13} color={p.wm}>{t.accountReauthFailed}</Txt> : null}
        </ScrollView>
      </View>
    );
  }

  const bullet = (text: string) => (
    <View key={text} style={{ flexDirection: 'row', gap: 8 }}>
      <Txt size={14} color={p.mu}>•</Txt>
      <Txt size={14} color={p.mu} style={{ flex: 1 }}>{text}</Txt>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
      <TaskHeader pill={t.back} onPill={onBack} title={t.settingsAccount} />
      <ScrollView contentContainerStyle={{ padding: 24, gap: 18, paddingBottom: 48 }}>
        <Txt size={24} weight={600}>{t.accountDeleteTitle}</Txt>
        <Txt size={15}>{t.accountDeleteLede}</Txt>

        <Card pad={18} style={{ gap: 10 }}>
          <Txt size={13} weight={600}>{t.accountDeleteWhatGoesHeading}</Txt>
          {[
            t.accountDeleteWhatGoesSignIn,
            t.accountDeleteWhatGoesData,
            t.accountDeleteWhatGoesIntegrations,
          ].map(bullet)}
        </Card>

        <Card pad={18} style={{ gap: 10 }}>
          <Txt size={13} weight={600}>{t.accountDeleteWhatStaysHeading}</Txt>
          {[
            t.accountDeleteWhatStaysCrash,
            t.accountDeleteWhatStaysBackups,
            t.accountDeleteWhatStaysReceipt,
          ].map(bullet)}
        </Card>

        {/* Rendered only when a real https URL is configured (OWNER-A1 #137,
            UC-4.2 #177). A dead link on this screen would be worse than none. */}
        {policyUrl ? (
          <Pill
            label={t.accountDeleteReadMore}
            kind="ghost"
            size={14}
            pad={6}
            onPress={() => void WebBrowser.openBrowserAsync(policyUrl)}
          />
        ) : null}

        {!online ? <Txt size={13} color={p.mu}>{t.accountDeleteOfflineNote}</Txt> : null}

        <Pill
          label={busy || phase.kind === 'deleting' ? t.accountDeleteBusy : t.accountDeleteAction}
          kind="warm"
          disabled={busy || phase.kind === 'deleting' || !online}
          onPress={confirmThenDelete}
        />

        {phase.kind === 'failed' ? (
          <Txt size={13} color={p.wm}>{t[phase.message]}</Txt>
        ) : null}
      </ScrollView>
    </View>
  );
}
