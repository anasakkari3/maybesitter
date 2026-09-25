import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useApp } from '../../state/AppContext';
import { useAuth } from '../../auth/AuthProvider';
import { forgetValidators } from '../../api/queries';
import { deleteAccount } from '../../api/endpoints/account';
import { RecentLoginRequiredError } from '../../api/errors';
import type { DeletionReceipt } from '../../api/schemas/account';
import { ReauthCancelled, reauthProviderFor, type ReauthProvider } from './reauthenticate';
import type { AppleReauthentication } from '../../auth/types';
import { recordAppleRevocationFailure, revokeAppleTokens, signedInWithApple } from './appleRevocation';
import { clearHealthConnection } from '../../lib/deviceSettings/healthConnection';

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
  /**
   * After a successful re-authentication, ask again. Deliberate, not a retry.
   * An Apple re-authentication passes its result, so its one-time code can
   * revoke the account's Apple tokens without a second sheet.
   */
  retryAfterReauth(apple?: AppleReauthentication): Promise<void>;
  /** The user backed out of re-authentication. Nothing was deleted. */
  cancelReauth(): void;
  /** Dismisses the receipt; the app is already signed out behind it. */
  acknowledgeReceipt(): void;
  reset(): void;
}

const Ctx = createContext<AccountDeletionModel | null>(null);

export function AccountDeletionProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const { user, signOut, repository } = useAuth();
  const { resetForNewUser } = useApp().actions;
  const [phase, setPhase] = useState<DeletionPhase>({ kind: 'idle' });
  const [receipt, setReceipt] = useState<DeletionReceipt | null>(null);
  /** Whether this account's Apple tokens are already revoked in this flow. */
  const appleRevoked = useRef(false);

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

  /**
   * Revokes Sign in with Apple before the server deletes the Firebase user,
   * which is the last moment Firebase can still act for it (see
   * `appleRevocation.ts`). Answers `false` only when the user backed out of
   * the Apple sheet: that is a decision not to go on, and nothing is deleted.
   * Every other failure is recorded and the deletion continues.
   */
  const revokeAppleIfNeeded = useCallback(async (apple?: AppleReauthentication): Promise<boolean> => {
    if (!signedInWithApple(user) || appleRevoked.current) return true;
    let grant = apple;
    if (!grant) {
      try {
        grant = await repository.reauthenticateWithApple();
      } catch (error) {
        if (error instanceof ReauthCancelled) return false;
        // No Apple sheet here (Android has no Apple flow) or it failed: the
        // deletion still goes ahead, without a revocation.
        recordAppleRevocationFailure('credential_unavailable');
        return true;
      }
      // The sheet was also a fresh sign-in; re-mint the token so the deletion
      // call carries the new `auth_time`. Outside the try above on purpose: a
      // refresh that fails must not cost the revocation, because the code in
      // hand is still good. If the server then asks for a recent login, the
      // prompt handles it as it does for every account.
      await repository.refreshIdentity().catch(() => undefined);
    }
    appleRevoked.current = await revokeAppleTokens(grant.authorizationCode, code => repository.revokeAppleToken(code));
    return true;
  }, [repository, user]);

  const run = useCallback(async (apple?: AppleReauthentication) => {
    setPhase({ kind: 'deleting' });
    try {
      if (!(await revokeAppleIfNeeded(apple))) {
        setPhase({ kind: 'idle' });
        return;
      }
      const result = await deleteAccount();

      // Order matters. The account is already gone server-side, so nothing
      // here may make another authenticated request — the token in hand is
      // dead and the generic 401 path would read it as an expired session.
      purgeEverything();
      // This device's own per-account key: whether Health was connected here.
      // A deleted account's uid must not stay on the phone in a key name.
      // Awaited before the sign-out; it never throws.
      if (user) await clearHealthConnection(user.uid);
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
  }, [purgeEverything, revokeAppleIfNeeded, signOut, user]);

  const value = useMemo<AccountDeletionModel>(
    () => ({
      phase,
      receipt,
      requestDeletion: () => {
        appleRevoked.current = false;
        return run();
      },
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
