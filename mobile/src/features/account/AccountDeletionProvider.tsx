import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useApp } from '../../state/AppContext';
import { useAuth } from '../../auth/AuthProvider';
import { forgetValidators } from '../../api/queries';
import { deleteAccount } from '../../api/endpoints/account';
import { RecentLoginRequiredError } from '../../api/errors';
import type { DeletionReceipt } from '../../api/schemas/account';
import { reauthProviderFor, type ReauthProvider } from './reauthenticate';

/**
 * Deleting the account, and holding the receipt long enough for the user to
 * read it (UC-1.5 #149).
 *
 * ── Why the receipt lives above the auth gate ────────────────────
 *
 * The server deletes the Firebase user, so the moment the client signs out
 * `AuthGate` swaps to the sign-in screen — and the receipt, the one thing the
 * user is owed, would vanish in the same frame. So the receipt is held here,
 * and `App.tsx` renders it *outside* the gate. The sign-out still happens
 * immediately; only the last screen outlives it.
 *
 * ── Memory only ──────────────────────────────────────────────────
 *
 * Nothing is persisted. A receipt on disk would be the one artefact of a
 * deleted account still on the device, and the user asked for the opposite.
 * A force-quit loses it, which is the correct trade: the proof also exists
 * server-side, and the operator runbook can retrieve it.
 */

export type DeletionPhase =
  | { kind: 'idle' }
  | { kind: 'deleting' }
  /** The server wants proof of recent identity before it will delete. */
  | { kind: 'reauth'; provider: ReauthProvider | null }
  | { kind: 'failed'; message: 'accountDeleteFailed' | 'accountDeleteUnavailable' };

export interface AccountDeletionModel {
  phase: DeletionPhase;
  /** Non-null only between a successful deletion and the user tapping Done. */
  receipt: DeletionReceipt | null;
  /**
   * Deletes the account. Call only after the user accepted the confirmation
   * alert — this function makes the request immediately.
   */
  requestDeletion(): Promise<void>;
  /** After a successful re-authentication, ask again. Deliberate, not a retry. */
  retryAfterReauth(): Promise<void>;
  /** The user backed out of re-authentication. Nothing was deleted. */
  cancelReauth(): void;
  /** Dismisses the receipt; the app is already signed out behind it. */
  acknowledgeReceipt(): void;
  reset(): void;
}

const Ctx = createContext<AccountDeletionModel | null>(null);

export function AccountDeletionProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const { user, signOut } = useAuth();
  const { resetForNewUser } = useApp().actions;
  const [phase, setPhase] = useState<DeletionPhase>({ kind: 'idle' });
  const [receipt, setReceipt] = useState<DeletionReceipt | null>(null);

  /**
   * Everything this account left in memory, in one place.
   *
   * Called on success *before* the sign-out, rather than relying on the
   * uid-change effect in `ApiProvider` to do it afterwards. Two reasons: the
   * window between the two is a window in which a render could read deleted
   * data, and a privacy invariant should not depend on an effect ordering.
   * `ApiProvider` still clears on the uid change, as a second line.
   */
  const purgeEverything = useCallback(() => {
    queryClient.clear();
    forgetValidators();
    resetForNewUser();
  }, [queryClient, resetForNewUser]);

  const run = useCallback(async () => {
    setPhase({ kind: 'deleting' });
    try {
      const result = await deleteAccount();

      // Order matters. The account is already gone server-side, so nothing
      // here may make another authenticated request — the token in hand is
      // dead and the generic 401 path would read it as an expired session.
      purgeEverything();
      setReceipt(result);
      setPhase({ kind: 'idle' });
      // Last: this flips the gate, and the receipt above it is what the user
      // keeps looking at.
      await signOut({ reason: 'deleted' });
    } catch (error) {
      if (error instanceof RecentLoginRequiredError) {
        // Not a failure and emphatically not a sign-out: the session is fine,
        // and the user can prove who they are in a couple of taps.
        const provider = reauthProviderFor(user);
        setPhase(provider ? { kind: 'reauth', provider } : { kind: 'failed', message: 'accountDeleteUnavailable' });
        return;
      }
      // Everything else leaves the user signed in with their data intact. A
      // partial deletion is resumed server-side by the maintenance job, so
      // trying again is safe and is what the copy asks for.
      setPhase({ kind: 'failed', message: 'accountDeleteFailed' });
    }
  }, [purgeEverything, signOut, user]);

  const value = useMemo<AccountDeletionModel>(
    () => ({
      phase,
      receipt,
      requestDeletion: run,
      retryAfterReauth: run,
      cancelReauth: () => setPhase({ kind: 'idle' }),
      acknowledgeReceipt: () => setReceipt(null),
      reset: () => {
        setPhase({ kind: 'idle' });
        setReceipt(null);
      },
    }),
    [phase, receipt, run],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAccountDeletion(): AccountDeletionModel {
  const value = useContext(Ctx);
  if (!value) throw new Error('useAccountDeletion must be used inside <AccountDeletionProvider>');
  return value;
}
