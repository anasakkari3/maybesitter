import React from 'react';
import { AccountDeletedScreen } from '../../screens/AccountDeletedScreen';
import { useAccountDeletion } from './AccountDeletionProvider';

/**
 * Shows the deletion receipt over everything else, until the user dismisses it
 * (UC-1.5 #149).
 *
 * This exists because of an ordering problem with no other clean answer: the
 * server deletes the Firebase user, the client signs out, and `AuthGate`
 * immediately renders sign-in. Anything drawn *inside* the gate — including a
 * receipt screen — is gone in that same frame.
 *
 * So the receipt is held in `AccountDeletionProvider` and rendered here,
 * above the gate. The sign-out is not delayed to make this work; only the
 * final screen outlives it.
 */
export function AccountDeletedGate({ children }: { children: React.ReactNode }) {
  const { receipt } = useAccountDeletion();
  if (receipt) return <AccountDeletedScreen />;
  return <>{children}</>;
}
