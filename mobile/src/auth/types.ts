/**
 * The app's view of "who is signed in", and the one seam every sign-in
 * provider and every test goes through.
 *
 * Exactly one module imports the Firebase auth SDK. The reason is not purity:
 * the ID token is the only credential the client holds, and keeping one module
 * able to produce it makes the "never log a token" rule checkable by reading
 * one file.
 */

export type SignOutReason = 'user' | 'session_expired' | 'revoked' | 'deleted';

export type Unsubscribe = () => void;

export interface AuthUser {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  /** 'password', 'google.com', 'apple.com' — or 'dev' for the local override. */
  providerIds: string[];
}

/**
 * The email/password half of the repository (UC-1.3 #147). Kept as its own
 * interface so UC-1.1 (#145) and UC-1.2 (#146) can add theirs beside it
 * without every implementation growing a method it does not support.
 */
export interface EmailPasswordAuth {
  createAccount(email: string, password: string): Promise<void>;
  signInWithEmail(email: string, password: string): Promise<void>;
  /**
   * Always resolves, whether or not the address has an account. Reporting
   * "no such user" here is the enumeration oracle this product will not ship.
   */
  sendPasswordReset(email: string): Promise<void>;
  /** Sends (or resends) the verification mail to the signed-in user. */
  sendVerificationEmail(): Promise<void>;
}

/**
 * The federated providers (UC-1.1 #145, UC-1.2 #146).
 *
 * Each returns void and resolves when the user is signed in, or resolves
 * having done nothing when the user backed out of the provider's own sheet.
 * A cancellation is a decision, not a failure: it must never put an error
 * message on the sign-in screen.
 */
export interface FederatedAuth {
  signInWithGoogle(): Promise<void>;
  signInWithApple(): Promise<void>;
}

/**
 * Proving recent identity before a destructive action (UC-1.5 #149).
 *
 * Each method re-authenticates the **current** user and leaves them signed in
 * as themselves. None of them is a sign-in: a cancelled reauthentication must
 * never end with a different account signed in, or with no account at all.
 *
 * They resolve when `auth_time` is fresh, reject with `ReauthCancelled` when
 * the user backed out, and reject with the provider's own error otherwise.
 */
export interface ReauthenticatingAuth {
  /** The password is an argument. It is never stored and never logged. */
  reauthenticateWithPassword(password: string): Promise<void>;
  reauthenticateWithGoogle(): Promise<void>;
  reauthenticateWithApple(): Promise<void>;
  /**
   * Forces a token refresh so the *next* request carries the fresh
   * `auth_time`. Firebase updates `auth_time` on re-authentication, but the
   * cached ID token still holds the old claim until it is re-minted.
   */
  refreshIdentity(): Promise<void>;
}

export interface AuthRepository extends EmailPasswordAuth, FederatedAuth, ReauthenticatingAuth {
  /**
   * Calls back with the current user (or null) as soon as the SDK knows, and
   * on every change after that. The first call is what moves the app out of
   * `loading`, so an implementation must always emit at least once.
   */
  onChange(callback: (user: AuthUser | null) => void): Unsubscribe;
  currentUser(): AuthUser | null;
  /** The bearer for `/api/mobile/**`. Never log the return value. */
  getIdToken(force?: boolean): Promise<string | null>;
  /** Re-reads the user from the server — how `emailVerified` ever turns true. */
  reloadUser(): Promise<void>;
  signOut(options?: { reason?: SignOutReason }): Promise<void>;
  /**
   * Why the last session ended, or null.
   *
   * It lives here rather than only in `AuthProvider` because the API client
   * signs out on its own (UC-1.R4 #157: a second 401 calls
   * `signOut({ reason: 'session_expired' })`), with no React in scope. The
   * provider reads it when the user goes null, so the sign-in screen can say
   * "Please sign in again" whoever ended the session.
   *
   * In memory only: a force-quit clears it, which is the intent.
   */
  lastSignOutReason(): SignOutReason | null;
}

export type AuthStatus = 'loading' | 'signedOut' | 'signedIn';
