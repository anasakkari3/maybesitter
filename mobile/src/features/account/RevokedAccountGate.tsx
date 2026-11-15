import React, { useEffect, useSyncExternalStore } from 'react';
import { useAuth } from '../../auth/AuthProvider';
import { clearRevoked, onRevokedChange, revokedAccount } from '../../api/auth';
import { RevokedAccountScreen } from '../../screens/RevokedAccountScreen';

/**
 * The revoked screen in place of the app, for the account that got the 403
 * (C12.1, owner option (a)).
 *
 * Above `OnboardingGate` and `Root`, so nothing that fires the app's queries
 * is mounted while it shows; below `AccountDeletedGate`, so a deletion made
 * from it still ends on the receipt.
 *
 * Scoped to one uid. It shows only while the signed-in account is the one the
 * client held as revoked, and the hold is dropped the moment the uid changes —
 * a sign-out, or another account signing in — so account B never sees A's
 * revoked state.
 */
export function RevokedAccountGate({ children }: { children: React.ReactNode }) {
  const uid = useAuth().user?.uid ?? null;
  const held = useSyncExternalStore(onRevokedChange, revokedAccount);

  useEffect(() => {
    if (held !== null && held !== uid) clearRevoked();
  }, [held, uid]);

  if (held !== null && held === uid) return <RevokedAccountScreen />;
  return <>{children}</>;
}
