/**
 * Who is asking, decided by Google's signature rather than by our own (UC-1.0e, #144).
 *
 * ── What this replaces ───────────────────────────────────────────
 *
 * The retired pilot token service minted `p-token.<id>.<nonce>.<hmac>` by hand.
 * That token carried no issue time and no expiry, so a leaked one was
 * permanent access, and its validator ended in a `try` whose non-allowlist
 * failures fell through to `return { valid: true }` — a trust-store outage
 * *admitted* the caller. Both properties are gone: identity is now a Firebase
 * ID token, signed by Google, valid for an hour, and every failure below is an
 * explicit refusal.
 *
 * ── Why revocation is cached, and why that is still a revocation ─
 *
 * `verifyIdToken(token, true)` asks Firebase about the user on every single
 * request. Instead this verifies the signature offline and compares the
 * token's `auth_time` against the user's `tokensValidAfterTime`, read through
 * a 60 s per-instance cache. The answer is identical to `checkRevoked` with at
 * most 60 s of staleness, which is the bound UC-1.0e accepted — and
 * `forceRevocationCheck` bypasses the cache entirely, so the destructive paths
 * (account deletion, trust revoke) see a revocation the instant it lands.
 *
 * The cache holds `{tokensValidAfterTime, disabled}` per uid. It holds no
 * token, and it is per-process: it cannot make a revoked user look live for
 * longer than its own 60 s, and it is dropped on restart.
 *
 * ── Never log a token ────────────────────────────────────────────
 *
 * Nothing here prints the token or the uid. A caller that needs to correlate
 * logs should log a `sha256(uid)` prefix, never either value.
 */
import { getAuth } from 'firebase-admin/auth';
import { getAdminApp } from '../firebase/admin';

/** How long a uid's revocation state is reused before it is read again. */
export const REVOCATION_CACHE_TTL_MS = 60_000;

export interface VerifiedUser {
  uid: string;
  /** Seconds since the epoch, as Firebase states it in the token's `auth_time`. */
  authTime: number;
  signInProvider: string;
  emailVerified: boolean;
}

export type TokenVerificationCode =
  | 'invalid_token'
  | 'token_expired'
  | 'token_revoked'
  | 'user_disabled'
  | 'auth_unavailable';

/** Every way verification can refuse, in the vocabulary the routes answer in. */
export class TokenVerificationError extends Error {
  constructor(readonly code: TokenVerificationCode, message: string = code) {
    super(message);
    this.name = 'TokenVerificationError';
  }
}

export interface VerifyOptions {
  /** Skip the 60 s cache and read the user's revocation state now. */
  forceRevocationCheck: boolean;
}

export interface TokenVerifier {
  verify(idToken: string, options: VerifyOptions): Promise<VerifiedUser>;
}

interface RevocationState {
  /** Milliseconds since the epoch, or 0 when the user has never been revoked. */
  validAfterMs: number;
  disabled: boolean;
  readAtMs: number;
}

/**
 * A thrown value's Firebase error code, if it has one.
 *
 * Read defensively: this runs on whatever the SDK threw, which on a network
 * failure is not necessarily a `FirebaseAuthError` at all.
 */
function firebaseErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return '';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '');
}

/**
 * A failure that is about the network or Google's signing keys rather than
 * about this token.
 *
 * It matters because the two answer differently: a bad token is 401 and the
 * client should sign in again, while an unreachable key endpoint is 503 and
 * the client should retry. Answering 401 to an outage would sign every user
 * out of the product because Google had a bad minute.
 */
function isAvailabilityFailure(error: unknown): boolean {
  const code = firebaseErrorCode(error);
  if (code === 'auth/internal-error' || code === 'auth/network-request-failed') return true;
  if (/^(ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN)$/.test(code)) return true;
  return /network|socket|fetch failed|timed? ?out|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|certificate|public key|key fetch/i
    .test(messageOf(error));
}

/** A `verifyIdToken` rejection, in this module's vocabulary. */
function verificationCodeFor(error: unknown): TokenVerificationCode {
  const code = firebaseErrorCode(error);
  if (code === 'auth/id-token-expired') return 'token_expired';
  if (code === 'auth/id-token-revoked' || code === 'auth/session-cookie-revoked') return 'token_revoked';
  if (code === 'auth/user-disabled') return 'user_disabled';
  if (isAvailabilityFailure(error)) return 'auth_unavailable';
  // auth/argument-error, auth/invalid-id-token, a malformed JWT, a bad
  // signature, the wrong audience: all of them are "this token is not one we
  // accept", and none of them is worth telling the caller apart.
  return 'invalid_token';
}

export class FirebaseTokenVerifier implements TokenVerifier {
  private readonly cache = new Map<string, RevocationState>();

  constructor(private readonly ttlMs: number = REVOCATION_CACHE_TTL_MS) {}

  async verify(idToken: string, options: VerifyOptions): Promise<VerifiedUser> {
    const auth = getAuth(getAdminApp());

    let decoded;
    try {
      // `false`: the revocation question is answered below, off the cache.
      decoded = await auth.verifyIdToken(idToken, false);
    } catch (error) {
      throw new TokenVerificationError(verificationCodeFor(error), 'id token rejected');
    }

    const authTime = typeof decoded.auth_time === 'number' ? decoded.auth_time : 0;
    const state = await this.revocationState(decoded.uid, options.forceRevocationCheck);

    if (state.disabled) throw new TokenVerificationError('user_disabled', 'user is disabled');
    // Strictly before: a token issued in the same second as the revocation is
    // refused, which is the safe side of a one-second tie.
    if (state.validAfterMs > 0 && authTime * 1000 < state.validAfterMs) {
      throw new TokenVerificationError('token_revoked', 'id token was revoked');
    }

    return {
      uid: decoded.uid,
      authTime,
      signInProvider: decoded.firebase?.sign_in_provider ?? 'unknown',
      emailVerified: decoded.email_verified === true,
    };
  }

  private async revocationState(uid: string, force: boolean): Promise<RevocationState> {
    const cached = this.cache.get(uid);
    const now = Date.now();
    if (!force && cached && now - cached.readAtMs < this.ttlMs) return cached;

    let record;
    try {
      record = await getAuth(getAdminApp()).getUser(uid);
    } catch (error) {
      if (firebaseErrorCode(error) === 'auth/user-not-found') {
        // A validly signed token for an account that no longer exists. The
        // credential is dead, and saying so is the only correct answer; it is
        // not an availability problem and it must not be cached.
        throw new TokenVerificationError('token_revoked', 'user no longer exists');
      }
      if (isAvailabilityFailure(error)) {
        throw new TokenVerificationError('auth_unavailable', 'could not read the user record');
      }
      throw new TokenVerificationError('auth_unavailable', 'could not read the user record');
    }

    const state: RevocationState = {
      validAfterMs: record.tokensValidAfterTime ? Date.parse(record.tokensValidAfterTime) : 0,
      disabled: record.disabled === true,
      readAtMs: now,
    };
    this.cache.set(uid, state);
    return state;
  }
}

let override: TokenVerifier | null = null;
let cached: TokenVerifier | null = null;

export function getTokenVerifier(): TokenVerifier {
  if (override) return override;
  if (!cached) cached = new FirebaseTokenVerifier();
  return cached;
}

/**
 * The seam the whole suite authenticates through.
 *
 * There is deliberately no environment variable that swaps the verifier: this
 * is reachable only from a test process that imports it, so no deployment —
 * and no reader of this public repository — can turn identity off with a
 * config value.
 */
export function setTokenVerifierForTests(verifier: TokenVerifier): void {
  override = verifier;
}

export function resetTokenVerifierForTests(): void {
  override = null;
  cached = null;
}
