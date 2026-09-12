/**
 * How the suite authenticates, now that identity is a Google signature
 * (UC-1.0e, #144).
 *
 * Route tests used to mint a real HMAC pilot token, because the token was
 * ours and minting one in a test was a two-line call. A Firebase ID token is
 * not ours to mint, so the seam is the verifier: `setTokenVerifierForTests`
 * installs the fake below, and a test authenticates by naming a uid.
 *
 * This exists only under `tests/`. There is no environment variable and no
 * production code path that swaps the verifier, which is the point — a
 * development bypass reachable from configuration would be one variable away
 * from uid impersonation in a public repository.
 */
import { setAccountDirectoryForTests } from '../../lib/auth/accountDirectory.ts';
import {
  TokenVerificationError,
  resetTokenVerifierForTests,
  setTokenVerifierForTests,
  type TokenVerificationCode,
  type TokenVerifier,
  type VerifyOptions,
} from '../../lib/auth/tokenVerifier.ts';

/** The prefix a test token carries, so a real JWT can never be confused for one. */
const PREFIX = 'test-token:';

/** A Firebase uid's real shape: 28 mixed-case alphanumerics. */
export function uidFor(seed: string): string {
  const base = seed.replace(/[^A-Za-z0-9]/g, '');
  return `${base}${'x'.repeat(Math.max(0, 28 - base.length))}`.slice(0, 28);
}

/** The Authorization header value a request for this uid should carry. */
export function tokenFor(uid: string): string {
  return `${PREFIX}${uid}`;
}

export interface FakeAuthControls {
  /** Refuse this uid's next verification with the given code. */
  refuse(uid: string, code: TokenVerificationCode): void;
  /** Stop refusing this uid. */
  allow(uid: string): void;
  /** Whether the last verification asked for a fresh revocation read. */
  lastForceRevocationCheck(): boolean | null;
  /**
   * How long ago this uid's session actually authenticated, in seconds.
   *
   * Account deletion (UC-1.5, #149) refuses a session that signed in more than
   * five minutes ago, and a fixed `auth_time` cannot express "stale".
   */
  setAuthAge(uid: string, seconds: number): void;
  restore(): void;
}

/**
 * Installs a verifier that accepts `test-token:<uid>` and nothing else.
 *
 * Anything that is not one of those tokens is refused as `invalid_token`,
 * exactly as a real verifier refuses a forged JWT — so a test that forgets
 * the header, or sends a leftover `p-token.…`, fails rather than passing
 * against a permissive stub.
 */
export function installFakeAuth(): FakeAuthControls {
  const refusals = new Map<string, TokenVerificationCode>();
  const authAges = new Map<string, number>();
  let lastForce: boolean | null = null;

  const verifier: TokenVerifier = {
    async verify(idToken: string, options: VerifyOptions) {
      lastForce = options.forceRevocationCheck;
      if (!idToken.startsWith(PREFIX)) {
        throw new TokenVerificationError('invalid_token', 'not a test token');
      }
      const uid = idToken.slice(PREFIX.length);
      const refusal = refusals.get(uid);
      if (refusal) throw new TokenVerificationError(refusal, `refused: ${refusal}`);
      const age = authAges.get(uid);
      return {
        uid,
        // Recent by default, because most routes do not care. A test that does
        // care sets the age explicitly. The revocation comparison against
        // `auth_time` is the real verifier's job and is covered against the
        // emulator.
        authTime: age === undefined
          ? Math.floor(Date.now() / 1000)
          : Math.floor(Date.now() / 1000) - age,
        signInProvider: 'password',
        emailVerified: false,
      };
    },
  };

  setTokenVerifierForTests(verifier);
  // A uid this fake mints is an account that exists. Since UC-1.5 (#149) the
  // auth path asks Firebase before creating a tree for a uid it has never seen,
  // so without this every first request in the suite would try to reach the
  // real Firebase and fail as `auth_unavailable`. A test about a *deleted*
  // account overrides this with its own directory.
  setAccountDirectoryForTests({ async exists() { return true; } });
  return {
    refuse: (uid, code) => refusals.set(uid, code),
    allow: (uid) => refusals.delete(uid),
    lastForceRevocationCheck: () => lastForce,
    setAuthAge: (uid, seconds) => authAges.set(uid, seconds),
    restore: () => {
      setAccountDirectoryForTests(null);
      resetTokenVerifierForTests();
    },
  };
}
