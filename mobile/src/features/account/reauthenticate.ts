/**
 * Proving who you are, again, just before something irreversible
 * (UC-1.5 #149).
 *
 * The server refuses `DELETE /api/mobile/account` when Firebase's `auth_time`
 * is more than five minutes old. That is not a bug to route around: a phone
 * left unlocked on a table should not be enough to delete somebody's account.
 *
 * ── The provider is read, never guessed ──────────────────────────
 *
 * Which credential can prove recent identity is a fact about the account, and
 * `providerData` already states it. Asking the user "how did you sign in?"
 * would be asking them to recall something the app can see — and getting it
 * wrong would mean a reauthentication that cannot succeed.
 *
 * ── Nothing is stored ────────────────────────────────────────────
 *
 * A password is a function argument and nothing else: not state that outlives
 * the call, not a ref, not storage. Nothing here logs anything at all.
 */
import type { AuthUser } from '../../auth/types';

/** The providers this app can actually re-authenticate with. */
export type ReauthProvider = 'password' | 'google.com' | 'apple.com';

const SUPPORTED: readonly ReauthProvider[] = ['password', 'google.com', 'apple.com'];

/**
 * Which provider to re-authenticate with.
 *
 * Order matters when an account has several linked. `password` first because
 * it needs no network round trip through another app and cannot be cancelled
 * by a system sheet; then Google, then Apple. Any of them proves recent
 * identity, so the cheapest reliable one wins.
 */
export function reauthProviderFor(user: AuthUser | null): ReauthProvider | null {
  if (!user) return null;
  for (const candidate of SUPPORTED) {
    if (user.providerIds.includes(candidate)) return candidate;
  }
  return null;
}

/** The user backed out of a provider sheet. A decision, not a failure. */
export class ReauthCancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'ReauthCancelled';
  }
}

/**
 * No credential on this account can prove recent identity here — an
 * Apple-only account on Android, for instance, where the web flow is not
 * implemented. The screen says so and points at the support route rather than
 * looping the user through a sheet that cannot work.
 */
export class ReauthUnavailable extends Error {
  constructor(readonly provider: ReauthProvider | null) {
    super('reauthentication is not available for this account here');
    this.name = 'ReauthUnavailable';
  }
}
