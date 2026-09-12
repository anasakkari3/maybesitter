import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Linking } from 'react-native';
import { apiBaseUrl, appEnv, devBearerToken } from '../config/env';
import { DEV_BYPASS_USER, devBypassToken } from './devBypass';
import { createFirebaseAuthRepository } from './firebaseAuthRepository';
import type { AuthRepository, AuthStatus, AuthUser, SignOutReason } from './types';

/**
 * Who is signed in, and the one place the rest of the app asks.
 *
 * ── Why the sign-out reason lives in memory ──────────────────────
 *
 * "Please sign in again" after an expired token is a fact about *this* run of
 * the app. Persisting it would mean a user who force-quit during a network
 * blip is told their session expired days later, and it would put an account
 * signal in unencrypted storage for nothing. It is a `useState` and it dies
 * with the process — which is also what makes the RNTL test for it honest.
 */

export interface AuthModel {
  status: AuthStatus;
  user: AuthUser | null;
  /** Why the last session ended, until the next successful sign-in. */
  lastSignOutReason: SignOutReason | null;
  /** Clears the notice once a screen has shown it. */
  acknowledgeSignOutReason(): void;
  signOut(options?: { reason?: SignOutReason }): Promise<void>;
  getIdToken(force?: boolean): Promise<string | null>;
  reloadUser(): Promise<void>;
  /** True while the local dev override is standing in for a real session. */
  devBypass: boolean;
  /** A deep link that arrived while signed out, taken exactly once. */
  takePendingLink(): string | null;
  repository: AuthRepository;
}

const Ctx = createContext<AuthModel | null>(null);

export interface AuthProviderProps {
  children: React.ReactNode;
  /** Tests pass a `FakeAuthRepository`; the app lets this default. */
  repository?: AuthRepository;
  /** Tests force this false to prove the override cannot survive a release bundle. */
  isDevBundle?: boolean;
}

export function AuthProvider({ children, repository, isDevBundle = __DEV__ }: AuthProviderProps) {
  // Created once, by a lazy initialiser: a repository rebuilt on re-render
  // would re-subscribe to the SDK every render and drop the listener the gate
  // is waiting on. Building it costs nothing — it is a closure, and `getAuth()`
  // is only called inside its methods.
  const [defaultRepository] = useState(createFirebaseAuthRepository);
  const repo = repository ?? defaultRepository;

  const bypassToken = useMemo(
    () =>
      devBypassToken({
        isDevBundle,
        appEnv: appEnv(),
        apiBaseUrl: apiBaseUrl(),
        token: devBearerToken(),
      }),
    [isDevBundle],
  );

  const [user, setUser] = useState<AuthUser | null>(bypassToken ? DEV_BYPASS_USER : null);
  const [resolved, setResolved] = useState(bypassToken !== null);
  const [lastSignOutReason, setLastSignOutReason] = useState<SignOutReason | null>(null);
  const pendingLink = useRef<string | null>(null);

  useEffect(() => {
    // The override answers for the whole session; subscribing to Firebase as
    // well would let a stray SDK callback sign the developer back out.
    if (bypassToken) return;
    const unsubscribe = repo.onChange(next => {
      setUser(next);
      setResolved(true);
      // Read from the repository rather than tracked here alone: the API
      // client signs out on a second 401 without going through this provider
      // (UC-1.R4 #157), and that sign-out has to reach the sign-in screen too.
      setLastSignOutReason(next ? null : repo.lastSignOutReason());
    });
    return unsubscribe;
  }, [repo, bypassToken]);

  const status: AuthStatus = !resolved ? 'loading' : user ? 'signedIn' : 'signedOut';

  // A link that arrives while the sign-in screen is up would otherwise be lost:
  // `Root` — which owns link handling — is not mounted yet. Held in memory and
  // replayed once, so it never outlives the session that received it.
  useEffect(() => {
    if (status !== 'signedOut') return;
    const subscription = Linking.addEventListener('url', event => {
      pendingLink.current = event.url;
    });
    return () => subscription.remove();
  }, [status]);

  const signOut = useCallback(
    async (options?: { reason?: SignOutReason }) => {
      await repo.signOut(options);
      // The subscription above normally sets this; setting it here too covers
      // a repository that signs out without emitting.
      setLastSignOutReason(repo.lastSignOutReason());
    },
    [repo],
  );

  const value = useMemo<AuthModel>(
    () => ({
      status,
      user,
      lastSignOutReason,
      acknowledgeSignOutReason: () => setLastSignOutReason(null),
      signOut,
      getIdToken: async (force?: boolean) => (bypassToken ? bypassToken : repo.getIdToken(force)),
      reloadUser: async () => {
        if (bypassToken) return;
        await repo.reloadUser();
        const next = repo.currentUser();
        if (next) setUser(next);
      },
      devBypass: bypassToken !== null,
      takePendingLink: () => {
        const url = pendingLink.current;
        pendingLink.current = null;
        return url;
      },
      repository: repo,
    }),
    [status, user, lastSignOutReason, signOut, bypassToken, repo],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthModel {
  const value = useContext(Ctx);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}
