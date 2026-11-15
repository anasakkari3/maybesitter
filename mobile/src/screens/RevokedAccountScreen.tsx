import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useApp } from '../state/AppContext';
import { useAuth } from '../auth/AuthProvider';
import { exportPhaseCopy, useExportMyData } from '../features/account/useExportMyData';
import { DeleteAccountScreen } from './DeleteAccountScreen';
import { LiveRegion } from '../ui/liveRegion';
import { Pill, Txt } from '../ui/primitives';

/**
 * What a revoked account sees instead of the app (C12.1, owner option (a)).
 *
 * The server refuses every route to a revoked account except the two that
 * serve the person's rights over their own data, so this screen offers those
 * two and a way out — nothing else. It mounts no query: the rest of the app,
 * whose every request would answer 403, is not rendered behind it.
 *
 * Both actions are the app's existing flows. Export is the Settings row's
 * hook, one press and the share sheet. Delete opens the same
 * `DeleteAccountScreen`, with its explanation, its re-authentication and its
 * confirmation alert; a deletion ends on the receipt, which
 * `AccountDeletedGate` shows above this.
 */
export function RevokedAccountScreen() {
  const { t, p } = useApp();
  const { signOut } = useAuth();
  const { phase, start } = useExportMyData();
  const [deleting, setDeleting] = useState(false);

  if (deleting) return <DeleteAccountScreen onBack={() => setDeleting(false)} />;

  return (
    <View testID="revoked-account" style={{ flex: 1, backgroundColor: p.bg }}>
      <ScrollView contentContainerStyle={{ padding: 24, gap: 16, flexGrow: 1, justifyContent: 'center' }}>
        <Txt role="page" size={22} weight={700} lh={1.5}>{t.revokedAccountLine}</Txt>

        <View style={{ gap: 8, marginTop: 8 }}>
          <Pill
            label={t.revokedAccountExport}
            kind="accent"
            radius={16}
            style={{ minHeight: 52 }}
            disabled={phase === 'preparing'}
            onPress={() => void start()}
          />
          {/* The export's progress and failures, said as words and announced. */}
          <LiveRegion>
            {phase === 'idle' ? null : <Txt size={14} color={p.mu}>{exportPhaseCopy(phase, t)}</Txt>}
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
