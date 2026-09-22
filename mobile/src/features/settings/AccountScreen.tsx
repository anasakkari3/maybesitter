import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { useAuth } from '../../auth/AuthProvider';
import { fill } from '../../i18n/strings';
import { Card, Pill, Txt } from '../../ui/primitives';
import { Dialog } from '../../ui/dialog';
import { ScreenIn } from '../../ui/motion';
import { SettingsHeader, SettingsRow } from './SettingsChrome';
import { LegalLinks } from '../legal/LegalLinks';

/**
 * The account (Round 2, Phase I / L): who is signed in, the way out, and
 * the one-way door.
 *
 * Sign out asks first — it is not destructive, but it is a surprise when a
 * thumb lands on it — through the same dialog every hard-to-undo action
 * uses. Delete leads to its own flow, which asks again in its own words.
 * An Apple private-relay address is not the user's email and is not shown
 * as one (UC-1.1 #145).
 */
export function AccountScreen({ onBack }: { onBack: () => void }) {
  const { t, p, actions } = useApp();
  const { user, signOut } = useAuth();
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  return (
    <ScreenIn style={{ backgroundColor: p.bg }}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 60, gap: 16 }}>
        <SettingsHeader title={t.accountTitle} onBack={onBack} />
        {user ? (
          <Card pad={18} style={{ gap: 14 }}>
            <Txt size={14} color={p.mu} testID="account-identity">
              {user.email ? fill(t.authSignedInAs, { email: user.email }) : t.authSignedInPrivateApple}
            </Txt>
            <Pill label={t.authSignOut} kind="outline" size={15} testID="account-sign-out" onPress={() => setConfirmSignOut(true)} />
          </Card>
        ) : null}
        {/* Only rendered once a legal site is configured (UC-4.2 #177). */}
        <LegalLinks />
        {user ? (
          <Card pad={0} style={{ paddingHorizontal: 16 }}>
            {/* Destructive, but not shouting: warm rather than a red the design
                does not have, and last so it is never the thing a thumb lands
                on by accident (UC-1.5 #149). */}
            <SettingsRow first label={t.accountDelete} tone="warn" onPress={() => actions.go('deleteAccount')} testID="account-delete" />
          </Card>
        ) : null}
        <View />
      </ScrollView>
      {confirmSignOut ? (
        <Dialog
          testID="sign-out-dialog"
          title={t.authSignOutConfirm}
          body={t.authSignOutBody}
          confirmLabel={t.authSignOut}
          cancelLabel={t.cancel}
          tone="ink"
          onConfirm={() => { setConfirmSignOut(false); void signOut({ reason: 'user' }); }}
          onCancel={() => setConfirmSignOut(false)}
          confirmTestID="sign-out-confirm"
          cancelTestID="sign-out-cancel"
        />
      ) : null}
    </ScreenIn>
  );
}
