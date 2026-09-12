/**
 * Firebase auth failures, turned into copy a user can act on — and nothing
 * more than that.
 *
 * ── Why the sign-in failures collapse to one message ─────────────
 *
 * "No account with that email" and "wrong password" are the same screen to a
 * person who mistyped, and two different answers to someone probing which of
 * our users exist. They collapse into `authErrorSignIn`, and a password reset
 * reports success whether or not the address has an account, so neither path
 * confirms membership.
 *
 * The one place this cannot be made perfect is account creation: Firebase
 * refuses a duplicate address before anything is created, and there is no
 * response that both refuses and hides it. `authErrorEmailInUse` therefore
 * says the address cannot be used to create an account and points at sign-in.
 *
 * `error.message` is never rendered: it is written for developers, it changes
 * between SDK versions, and it can carry the address that was submitted.
 */
import type en from '../i18n/locales/en.json';

export type AuthErrorKey = Extract<keyof typeof en, `authError${string}`>;

/** The SDK's `code` on a thrown auth error, when it has one. */
function codeOf(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return '';
}

export function authErrorKey(error: unknown): AuthErrorKey {
  switch (codeOf(error)) {
    case 'auth/invalid-email':
      return 'authErrorInvalidEmail';
    case 'auth/email-already-in-use':
      return 'authErrorEmailInUse';
    case 'auth/weak-password':
      return 'authErrorWeakPassword';
    case 'auth/too-many-requests':
      return 'authErrorTooManyRequests';
    case 'auth/network-request-failed':
      return 'authErrorNetwork';
    case 'auth/user-disabled':
      return 'authErrorUserDisabled';
    // Every credential mismatch, whatever the SDK calls it this release.
    case 'auth/user-not-found':
    case 'auth/wrong-password':
    case 'auth/invalid-credential':
    case 'auth/invalid-login-credentials':
      return 'authErrorSignIn';
    default:
      return 'authErrorGeneric';
  }
}
