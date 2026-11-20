import React, { useState, useSyncExternalStore } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQueryClient } from '@tanstack/react-query';
import { useApp } from '../state/AppContext';
import { useAuth } from '../auth/AuthProvider';
import { exportPhaseCopy, useExportMyData } from '../features/account/useExportMyData';
import { DeleteAccountScreen } from './DeleteAccountScreen';
import { LiveRegion } from '../ui/liveRegion';
import { useAnnounceOnIos } from '../ui/announce';
import { resumeAccount } from '../api/endpoints/account';
import { clearRevoked, markRevokedByOperator, onRevokedChange, revokedAccountByOperator } from '../api/auth';
import { ForbiddenError } from '../api/errors';
import { Pill, Txt } from '../ui/primitives';

/**
 * What a revoked account sees instead of the app (C12.1, owner option (a)).
 *
 * The server refuses every route to a revoked account except the two that
 * serve the person's rights over their own data and the way back, so this
 * screen offers those three and a way out — nothing else. It mounts no query:
 * the rest of the app, whose every request would answer 403, is not rendered
 * behind it.
 *
 * «رجّع حسابي» (QA v3) is first: the lock came from the old «وقّف» (before
 * #873), whose words only promised to stop suggestions and learning. It clears
 * the lock on the server, marks the cached answers stale, and drops the hold,
 * so the app mounts and asks again. Suggestions and learning stay off, and the
 * line above the button says so before it is pressed.
 *
 * Both actions are the app's existing flows. Export is the Settings row's
 * hook, one press and the share sheet. Delete opens the same
 * `DeleteAccountScreen`, with its explanation, its re-authentication and its
 * confirmation alert; a deletion ends on the receipt, which
 * `AccountDeletedGate` shows above this.
 */
export function RevokedAccountScreen() {
  const { t, p } = useApp();
  const { signOut, user } = useAuth();
  // The team's stop (review of #883) is not the person's to lift: no way back
  // is offered, and the line says who stopped it and to contact us.
  const byOperator = useSyncExternalStore(onRevokedChange, revokedAccountByOperator);
  const { phase, start } = useExportMyData();
  const [deleting, setDeleting] = useState(false);
  // No header or tab bar here to hold the edges, so the insets go in the
  // padding: large Dynamic Type never runs under the status bar or the
  // home indicator.
  const insets = useSafeAreaInsets();
  const failed = phase === 'failed' || phase === 'tooLarge' || phase === 'rateLimited';
  const queryClient = useQueryClient();
  const [resume, setResume] = useState<'idle' | 'resuming' | 'failed'>('idle');
  const resumeLine = resume === 'resuming' ? t.revokedAccountResuming
    : resume === 'failed' ? t.revokedAccountResumeFailed : null;
  // A live region for TalkBack; VoiceOver is told outright.
  useAnnounceOnIos(resumeLine);

  const bringBack = async () => {
    setResume('resuming');
    try {
      await resumeAccount();
    } catch (error) {
      // The server says the team stopped it: the way back goes, the line says so.
      if (error instanceof ForbiddenError && error.reason === 'operator_revoked' && user) {
        setResume('idle');
        markRevokedByOperator(user.uid);
        return;
      }
      // A deleted account is answered by the client's own 403 handling (the
      // receipt gate); anything else is said here, and the button is back.
      setResume('failed');
      return;
    }
    // Every answer cached before the lock lifted is stale now.
    void queryClient.invalidateQueries();
    clearRevoked();
  };

  if (deleting) return <DeleteAccountScreen onBack={() => setDeleting(false)} />;

  return (
    <View testID="revoked-account" style={{ flex: 1, backgroundColor: p.bg }}>
      <ScrollView
        contentContainerStyle={{
          padding: 24,
          paddingTop: 24 + insets.top,
          paddingBottom: 24 + insets.bottom,
          gap: 16,
          flexGrow: 1,
          justifyContent: 'center',
        }}
      >
        <Txt role="page" size={22} weight={700} lh={1.5}>{byOperator ? t.revokedAccountOperatorLine : t.revokedAccountLine}</Txt>

        {byOperator ? null : <View style={{ gap: 8, marginTop: 8 }}>
          <Txt size={14} color={p.mu} lh={1.5}>{t.revokedAccountResumeBody}</Txt>
          <Pill
            label={t.revokedAccountResume}
            testID="revoked-resume"
            kind="accent"
            radius={16}
            style={{ minHeight: 52 }}
            disabled={resume === 'resuming'}
            onPress={() => void bringBack()}
          />
          <LiveRegion testID="revoked-resume-status" assertive={resume === 'failed'} alert={resume === 'failed'}>
            {resumeLine === null ? null : (
              <Txt size={14} weight={resume === 'failed' ? 600 : undefined} color={resume === 'failed' ? p.acd : p.mu}>
                {resumeLine}
              </Txt>
            )}
          </LiveRegion>
        </View>}

        <View style={{ gap: 8, marginTop: 8 }}>
          <Pill
            label={t.revokedAccountExport}
            kind="outline"
            radius={16}
            style={{ minHeight: 52 }}
            disabled={phase === 'preparing'}
            onPress={() => void start()}
          />
          {/* The export's progress and failures, said as words and announced:
              progress politely, a failure as an alert in the failure colour. */}
          <LiveRegion testID="revoked-export-status" assertive={failed} alert={failed}>
            {phase === 'idle' ? null : (
              <Txt size={14} weight={failed ? 600 : undefined} color={failed ? p.acd : p.mu}>
                {exportPhaseCopy(phase, t)}
              </Txt>
            )}
          </LiveRegion>
        </View>

        <Pill
          label={t.revokedAccountDelete}
          kind="warm"
          radius={16}
          style={{ minHeight: 52 }}
          onPress={() => setDeleting(true)}
        />

        {/* `revoked`, so the sign-in screen says why this account is out. */}
        <Pill
          label={t.revokedAccountSignOut}
          kind="outline"
          radius={16}
          style={{ minHeight: 52 }}
          onPress={() => void signOut({ reason: 'revoked' })}
        />
      </ScrollView>
    </View>
  );
}
