/**
 * Revoking a Sign in with Apple account's tokens before it is deleted.
 *
 * App Store rule 5.1.1(v): an app that offers Sign in with Apple must revoke
 * the user's tokens when the account is deleted. Only a fresh authorisation's
 * one-time `authorizationCode` can do that, so an account that signed in with
 * Apple is asked for one Apple sheet at the start of deletion — which also
 * proves recent identity, so the server's five-minute check passes on the
 * first call.
 *
 * ── A failed revocation does not block the deletion ─────────────
 *
 * Decided deliberately. The person asked to be gone; Apple being unreachable,
 * the Firebase Apple provider being misconfigured, or a code that expired
 * must not keep their data on our servers. The deletion goes ahead and a
 * content-free non-fatal is recorded — a fixed error with a stage name, never
 * the code, never the SDK's message — so an operator can see revocations are
 * failing and fix the console.
 *
 * The code is a function argument here and nothing else: not state, not a
 * ref, not storage, not a log line.
 */
import { recordError } from '../../lib/crash';
import type { AuthUser } from '../../auth/types';

export type AppleRevocationStage = 'no_code' | 'credential_unavailable' | 'revoke_failed';

export class AppleRevocationFailed extends Error {
  constructor(readonly stage: AppleRevocationStage) {
    super(`apple token revocation failed: ${stage}`);
    this.name = 'AppleRevocationFailed';
  }
}

/** Accounts that signed in with Apple, alone or alongside another provider. */
export function signedInWithApple(user: AuthUser | null): boolean {
  // Exact equality per provider id. `providerIds` is a list of Firebase
  // provider ids, and an id that merely contains the text is not Apple's.
  return user?.providerIds.some(providerId => providerId === 'apple.com') ?? false;
}

export function recordAppleRevocationFailure(stage: AppleRevocationStage): void {
  recordError(new AppleRevocationFailed(stage), 'apple_revocation_failed');
}

/**
 * Revokes with this code, and reports rather than throws. Resolves `true` when
 * Apple's tokens were revoked.
 */
export async function revokeAppleTokens(
  authorizationCode: string | null,
  revoke: (code: string) => Promise<void>,
): Promise<boolean> {
  if (!authorizationCode) {
    recordAppleRevocationFailure('no_code');
    return false;
  }
  try {
    await revoke(authorizationCode);
    return true;
  } catch {
    // The SDK error is dropped on purpose: its message is not ours to vouch
    // for, and nothing about this account belongs in a crash report.
    recordAppleRevocationFailure('revoke_failed');
    return false;
  }
}
