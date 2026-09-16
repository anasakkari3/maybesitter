/**
 * Where the bearer comes from, and what happens when the server rejects it.
 *
 * ── One refresh, shared ──────────────────────────────────────────
 *
 * Today and Upcoming load together. When a token expires, both 401 within
 * milliseconds of each other, and a naive implementation asks Firebase for a
 * fresh token twice. Worse, on a slow network a second refresh can overtake
 * the first and hand back the *older* token. `refreshIdToken` therefore keeps
 * one in-flight promise and every concurrent caller awaits it.
 *
 * ── Two 401s mean the session is over ────────────────────────────
 *
 * The first 401 is retried once with a forced refresh, because a token that
 * expired mid-flight is ordinary. A second 401 on the retry is not: the
 * credential is genuinely no longer accepted, so the client signs out with
 * `session_expired`, which is what puts "Please sign in again" on the sign-in
 * screen (UC-1.7 #151).
 *
 * Nothing here logs a token, and no caller is ever handed one to log.
 */
import { runBeforeSignOut } from '../auth/beforeSignOut';
import type { AuthRepository } from '../auth/types';

let repository: AuthRepository | null = null;
let inFlightRefresh: Promise<string | null> | null = null;

/** Installed once at start-up by `ApiProvider`, and by tests. */
export function setAuthRepository(next: AuthRepository | null): void {
  repository = next;
  inFlightRefresh = null;
}

export function getAuthRepository(): AuthRepository | null {
  return repository;
}

/** The current token, without forcing a refresh. Null when signed out. */
export async function getIdToken(): Promise<string | null> {
  return (await repository?.getIdToken(false)) ?? null;
}

/**
 * A freshly minted token. Concurrent callers share one request, so three
 * simultaneous 401s cause exactly one refresh.
 */
export async function refreshIdToken(): Promise<string | null> {
  if (inFlightRefresh) return inFlightRefresh;
  const current = repository;
  if (!current) return null;
  inFlightRefresh = current
    .getIdToken(true)
    .finally(() => {
      inFlightRefresh = null;
    });
  return inFlightRefresh;
}

/**
 * Ends the session and tells the sign-in screen why.
 *
 * These two bypass `AuthProvider.signOut` — a 401 or a 403 can land in any
 * request, from anywhere — so they run the before-sign-out tasks themselves.
 * That matters for exactly one of them: the FCM token has to be deleted from
 * the handset however the session ended, or the next person to sign in on this
 * phone receives the last person's notifications. See
 * `notifications/pushRegistration.ts`.
 *
 * A task that throws is already swallowed by `runBeforeSignOut`, so nothing
 * here can leave somebody signed in to a session the server has stopped
 * accepting.
 */
export async function signOutExpired(): Promise<void> {
  await runBeforeSignOut('session_expired');
  await repository?.signOut({ reason: 'session_expired' });
}

/** Ends the session because the account itself was revoked or deleted. */
export async function signOutForbidden(reason: 'revoked' | 'deleted'): Promise<void> {
  await runBeforeSignOut(reason);
  await repository?.signOut({ reason });
}

/** Tests only: forget any refresh still in flight between cases. */
export function resetAuthForTests(): void {
  repository = null;
  inFlightRefresh = null;
}
