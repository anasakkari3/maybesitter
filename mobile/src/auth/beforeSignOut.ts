/**
 * Work that has to happen while the session is still valid (UC-3.0b, #184).
 *
 * ── Why a registry and not a call in `signOut` ───────────────────
 *
 * The one task today is deleting this account's device document, and it can
 * only be done *before* `signOut()`: an expired token cannot authorise a
 * `DELETE` on its own row. Calling the push registration from `AuthProvider`
 * directly would pull `src/api` — the client, the endpoints, the schemas —
 * into the auth tree, so every auth test would mount the networking layer to
 * assert something about a password field.
 *
 * So the feature registers itself and `signOut` runs whatever is registered.
 * The dependency points the way it should: notifications know about auth, auth
 * does not know about notifications.
 *
 * ── Only a sign-out the user asked for ───────────────────────────
 *
 * `session_expired`, `revoked` and `deleted` all mean the credential is
 * already gone, so a task that needs it would fail anyway — and
 * `signOutExpired` in `src/api/auth.ts` reaches the repository directly
 * without passing here at all. `AuthProvider` therefore runs these only for a
 * sign-out the person pressed.
 *
 * ── A task that fails never blocks the sign-out ──────────────────
 *
 * Signing out is the user asking to leave. Nothing here is important enough to
 * keep them in, so every task is awaited and every failure is swallowed.
 */
import type { SignOutReason } from './types';

export type BeforeSignOutTask = (reason: SignOutReason) => Promise<void>;

const tasks = new Set<BeforeSignOutTask>();

/** Registers a task and returns the unsubscribe, for an effect's cleanup. */
export function onBeforeSignOut(task: BeforeSignOutTask): () => void {
  tasks.add(task);
  return () => {
    tasks.delete(task);
  };
}

export async function runBeforeSignOut(reason: SignOutReason): Promise<void> {
  for (const task of [...tasks]) {
    try {
      await task(reason);
    } catch {
      // See the header: leaving is the user's decision, not ours.
    }
  }
}

/** Tests only: forget every registered task between cases. */
export function resetBeforeSignOutForTests(): void {
  tasks.clear();
}
