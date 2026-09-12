/**
 * The `AuthRepository` Jest drives. It is not a stub of Firebase: it is the
 * same state machine with the network removed, so a test can hold the app in
 * `loading`, sign a user in mid-test, and assert what the gate rendered.
 */
import type { AuthRepository, AuthUser, SignOutReason, Unsubscribe } from './types';

export interface FakeAuthOptions {
  /** Undefined keeps the repository in `loading` until `emit` is called. */
  initialUser?: AuthUser | null;
  idToken?: string | null;
}

export interface FakeAuthCall {
  method: 'createAccount' | 'signInWithEmail' | 'sendPasswordReset' | 'sendVerificationEmail' | 'signInWithGoogle';
  /**
   * The address only. Passwords are never recorded, so a failing test cannot
   * print one and no snapshot can accidentally hold one.
   */
  email?: string;
}

export interface FakeAuthRepository extends AuthRepository {
  /** Drives an auth state change, exactly as the SDK would. */
  emit(user: AuthUser | null): void;
  /** How many times `getIdToken(true)` was asked for a fresh token. */
  readonly forcedRefreshes: number;
  readonly signOutReasons: SignOutReason[];
  setIdToken(token: string | null): void;
  /** Every email/password call made, in order. */
  readonly calls: FakeAuthCall[];
  /** Makes the next call of `method` reject with this error. */
  failNext(method: FakeAuthCall['method'], error: unknown): void;
  /** Makes the next Google sign-in behave as the user backing out. */
  cancelNextGoogle(): void;
}

export function createFakeAuthRepository(options: FakeAuthOptions = {}): FakeAuthRepository {
  const listeners = new Set<(user: AuthUser | null) => void>();
  let user: AuthUser | null = options.initialUser ?? null;
  let emitted = options.initialUser !== undefined;
  let idToken: string | null = options.idToken ?? 'fake-id-token';
  let forcedRefreshes = 0;
  const signOutReasons: SignOutReason[] = [];
  let signOutReason: SignOutReason | null = null;
  const calls: FakeAuthCall[] = [];
  const failures = new Map<FakeAuthCall['method'], unknown>();
  let cancelGoogle = false;

  const record = (method: FakeAuthCall['method'], email?: string): void => {
    calls.push(email === undefined ? { method } : { method, email });
    if (failures.has(method)) {
      const error = failures.get(method);
      failures.delete(method);
      throw error;
    }
  };

  const emit = (next: AuthUser | null): void => {
    user = next;
    emitted = true;
    if (next) signOutReason = null;
    for (const listener of [...listeners]) listener(next);
  };

  return {
    onChange(callback) {
      listeners.add(callback);
      // Mirrors the SDK: a subscriber is told the current value immediately,
      // but only once the repository has actually resolved one.
      if (emitted) callback(user);
      const unsubscribe: Unsubscribe = () => listeners.delete(callback);
      return unsubscribe;
    },
    currentUser: () => user,
    async getIdToken(force = false) {
      if (force) forcedRefreshes += 1;
      return user ? idToken : null;
    },
    async reloadUser() {
      if (user) emit({ ...user });
    },
    async signOut(opts) {
      signOutReason = opts?.reason ?? 'user';
      signOutReasons.push(signOutReason);
      emit(null);
    },
    lastSignOutReason: () => signOutReason,
    async createAccount(email) {
      record('createAccount', email);
      emit({ uid: 'fake-uid', email, emailVerified: false, displayName: null, providerIds: ['password'] });
    },
    async signInWithEmail(email) {
      record('signInWithEmail', email);
      emit({ uid: 'fake-uid', email, emailVerified: false, displayName: null, providerIds: ['password'] });
    },
    async sendPasswordReset(email) {
      record('sendPasswordReset', email);
    },
    async sendVerificationEmail() {
      record('sendVerificationEmail');
    },
    async signInWithGoogle() {
      record('signInWithGoogle');
      if (cancelGoogle) {
        cancelGoogle = false;
        return;
      }
      emit({
        uid: 'fake-google-uid',
        email: 'someone@gmail.example',
        emailVerified: true,
        displayName: 'Someone',
        providerIds: ['google.com'],
      });
    },
    cancelNextGoogle() {
      cancelGoogle = true;
    },
    calls,
    failNext(method, error) {
      failures.set(method, error);
    },
    emit,
    get forcedRefreshes() {
      return forcedRefreshes;
    },
    signOutReasons,
    setIdToken(token) {
      idToken = token;
    },
  };
}
