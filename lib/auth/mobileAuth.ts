/**
 * The one guard every mobile route runs (UC-1.0e, #144).
 *
 * ── There is no anonymous path ───────────────────────────────────
 *
 * The guard this replaces had two entry points, and the optional one
 * returned `null` when no pilot environment was configured, so the routes
 * then ran as the literal participant `'anonymous'` against one shared global
 * state — so an unauthenticated caller read and wrote a scope every other
 * unauthenticated caller also held. `requireMobileUser` is the only entry
 * point now, it is `await`ed before anything else in every route, and it
 * either returns a uid or throws.
 *
 * ── The uid is the scope, and the body never is ──────────────────
 *
 * Whatever the caller put in `participantId`, `scopeId` or `anonymousUserId`
 * is ignored. The scope is the uid out of the verified token, so spoofing the
 * field is not refused so much as it is not read.
 *
 * ── First sight of a uid ─────────────────────────────────────────
 *
 * A uid nobody has seen gets `users/{uid}` created transactionally, with the
 * default trust record and nothing else. No email and no display name are
 * written: those live in Firebase Auth, and a copy here would be a second
 * place to leak them from and a second place to forget to delete them.
 */
import { requireUserId } from '../storage/paths';
import { getOrCreateTrust } from '../pilot/pilotTrustStore';
import { getTokenVerifier, TokenVerificationError, type TokenVerificationCode } from './tokenVerifier';

export interface MobileUser {
  uid: string;
  /** Seconds since the epoch: when this session last actually authenticated. */
  authTime: number;
}

export interface RequireMobileUserOptions {
  /**
   * Read the user's revocation state now rather than off the 60 s cache. For
   * the destructive paths — account deletion (UC-1.5, #149) and trust revoke —
   * where "at most a minute stale" is not good enough.
   */
  forceRevocationCheck?: boolean;
}

export class MobileAuthError extends Error {
  constructor(message: string, readonly status: 401 | 403 | 503, readonly reason: string) {
    super(message);
    this.name = 'MobileAuthError';
  }
}

/**
 * The error table UC-1.0e fixed, as data.
 *
 * `user_disabled` is 403 rather than 401 because the credential is valid and
 * re-authenticating will not help; the rest are 401 because signing in again
 * is exactly what the client should do. `auth_unavailable` is 503 so that a
 * Google outage is a retry rather than a mass sign-out.
 */
const STATUS_FOR: Readonly<Record<TokenVerificationCode, 401 | 403 | 503>> = Object.freeze({
  invalid_token: 401,
  token_expired: 401,
  token_revoked: 401,
  user_disabled: 403,
  auth_unavailable: 503,
});

export function mobileAuthErrorResponse(error: unknown): Response {
  if (error instanceof MobileAuthError) {
    return Response.json(
      { success: false, error: error.message, reason: error.reason },
      { status: error.status },
    );
  }
  // Anything unrecognised refuses rather than admits. The defect this whole
  // change exists to close was an unrecognised failure that fell through to
  // "valid".
  return Response.json(
    { success: false, error: 'unauthorized', reason: 'unauthorized' },
    { status: 401 },
  );
}

/** `Authorization: Bearer <jwt>`, or nothing this function will accept. */
function bearerTokenFrom(request: Request): string {
  const header = request.headers.get('authorization');
  if (!header || !header.trim()) {
    throw new MobileAuthError('an Authorization header is required', 401, 'missing_token');
  }
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match) {
    throw new MobileAuthError('the Authorization header must be a Bearer token', 401, 'invalid_token');
  }
  return match[1];
}

export async function requireMobileUser(
  request: Request,
  options: RequireMobileUserOptions = {},
): Promise<MobileUser> {
  const token = bearerTokenFrom(request);

  let verified;
  try {
    verified = await getTokenVerifier().verify(token, {
      forceRevocationCheck: options.forceRevocationCheck === true,
    });
  } catch (error) {
    if (error instanceof TokenVerificationError) {
      throw new MobileAuthError(error.message, STATUS_FOR[error.code], error.code);
    }
    throw new MobileAuthError('the token could not be verified', 503, 'auth_unavailable');
  }

  // A uid that cannot be a path segment cannot be a scope either. Firebase
  // never mints one, so this is a guard against a verifier that is not
  // Firebase rather than against a user.
  try {
    requireUserId(verified.uid);
  } catch {
    throw new MobileAuthError('the token subject is not a usable user id', 401, 'invalid_token');
  }

  const trust = await readOrCreateTrust(verified.uid);
  // Order matters: a deleted account reads `deleted` even though deleting also
  // revokes, because that is the more explanatory of the two for a support
  // conversation and for what UC-1.R4 (#157) renders.
  if (trust.deletedAt) throw new MobileAuthError('this account was deleted', 403, 'deleted');
  if (trust.revokedAt) throw new MobileAuthError('this account was revoked', 403, 'revoked');

  return { uid: verified.uid, authTime: verified.authTime };
}

/**
 * The trust record, created on first sight of the uid.
 *
 * A storage failure here is 503 and never an admission. The predecessor
 * swallowed exactly this error and continued as if the caller were trusted.
 */
async function readOrCreateTrust(uid: string) {
  try {
    return await getOrCreateTrust(uid, new Date().toISOString());
  } catch {
    throw new MobileAuthError('the account record could not be read', 503, 'auth_unavailable');
  }
}
