/**
 * The Google OAuth 2.0 client (Gmail Phase B, connect flow).
 *
 * The first implementation of `ProviderOAuthClient` in this repository. It
 * implements that interface and nothing wider: `beginProviderOAuth` /
 * `completeProviderOAuth` already own the state and PKCE lifecycle,
 * `StoredProviderOAuthStateStore` owns the state at rest, and the credential
 * vault owns the tokens. This file owns exactly one thing — speaking HTTP to
 * Google's token and revocation endpoints, and saying who the grant belongs to.
 *
 * Verified against Google's current identity documentation, fetched
 * 2026-09-19:
 *
 *  - G1 https://developers.google.com/identity/protocols/oauth2/web-server
 *  - G2 https://developers.google.com/identity/protocols/oauth2
 *
 * From G1: the authorization endpoint is
 * `https://accounts.google.com/o/oauth2/v2/auth` and the token endpoint is
 * `https://oauth2.googleapis.com/token`. An authorization-code exchange POSTs
 * `client_id`, `client_secret`, `code`, `grant_type=authorization_code` and
 * `redirect_uri`; `client_secret` is required for a web-server (confidential)
 * client. A success returns `access_token`, `expires_in`, `scope`,
 * `token_type` and — **only if `access_type=offline` was sent** —
 * `refresh_token`. A refresh POSTs `grant_type=refresh_token`,
 * `refresh_token`, `client_id` and `client_secret`. Revocation is
 * `POST https://oauth2.googleapis.com/revoke` with a form-encoded `token`.
 *
 * ── `access_type=offline` is not optional, and the shared lifecycle
 *    cannot express it ───────────────────────────────────────────
 *
 * Without `access_type=offline` Google returns **no refresh token at all**
 * (G1), so a connection would work for the life of one access token and then
 * be dead with no way back — `providerTokenState` would report `expired` and
 * the user would be asked to reconnect roughly hourly. `prompt=consent` is
 * what makes Google re-issue a refresh token on a repeat authorization rather
 * than silently omitting it.
 *
 * `beginProviderOAuth` sets seven query parameters and has no way to add an
 * eighth. Rather than fork it or write a second lifecycle, the two
 * Google-specific parameters are carried on the authorization *endpoint* URL
 * it is given: it parses that with `new URL()` and only ever `set`s its own
 * keys, so pre-existing query parameters survive intact. That is what
 * `GOOGLE_AUTHORIZATION_ENDPOINT` below is. If a second provider ever needs
 * the same, the honest fix is an `extraAuthorizationParams` field on
 * `BeginProviderOAuthInput`, and this comment is the argument for it.
 *
 * ── Nothing here may be logged ───────────────────────────────────
 *
 * The authorization code, the PKCE verifier, the client secret, the access
 * token and the refresh token all pass through this file and none of them may
 * reach a log, an error message or a response. The precedent is
 * `SafeFetchError`: a fixed message per code, never the URL and never the
 * body. `GoogleOAuthError` below carries an OAuth error *code* and a status,
 * both drawn from closed sets, and never `error_description`, which is
 * free-form text from Google that has been observed to echo request content.
 */
import { createGmailTransport } from './gmailTransport';
import type { ProviderOAuthClient } from '../../providers/providerOAuthLifecycle';
import type { ProviderOAuthTokenSet } from '../../providers/providerRuntime';
import type { IntegrationProviderIdentity } from '../../../../src/contracts/v1/integrationConnectionContracts';

export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOCATION_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

/**
 * The authorization endpoint, carrying the two parameters `beginProviderOAuth`
 * cannot add. See the module comment: without `access_type=offline` there is
 * no refresh token, and the flow is then broken in a way that only shows up an
 * hour after a successful connect.
 */
export const GOOGLE_AUTHORIZATION_ENDPOINT =
  'https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&prompt=consent';

/** How long one call to Google may take before it is aborted. */
export const GOOGLE_OAUTH_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Google's OAuth error codes, as a closed set.
 *
 * Anything Google sends that is not in this set becomes `unknown_error`, so a
 * value we have never seen cannot travel into a log or a response as-is.
 */
export type GoogleOAuthErrorCode =
  | 'invalid_grant'
  | 'invalid_client'
  | 'invalid_request'
  | 'invalid_scope'
  | 'unauthorized_client'
  | 'unsupported_grant_type'
  | 'admin_policy_enforced'
  | 'rate_limit_exceeded'
  | 'server_error'
  | 'unknown_error';

const KNOWN_OAUTH_ERRORS: ReadonlySet<string> = new Set([
  'invalid_grant', 'invalid_client', 'invalid_request', 'invalid_scope',
  'unauthorized_client', 'unsupported_grant_type', 'admin_policy_enforced',
  'rate_limit_exceeded', 'server_error',
]);

/**
 * A refusal from Google's token or revocation endpoint.
 *
 * ── Why `httpStatus` is not always the status on the wire ────────
 *
 * The token endpoint speaks a different error language from the resource
 * endpoints: it reports a dead grant as **HTTP 400 `invalid_grant`**, not 401
 * (G1; and CONTRACT.md §8.4 records the same split). But
 * `refreshProviderAccessToken` classifies purely on `httpStatus` through
 * `classifyProviderFailure`, where 400 falls through to `unknown` —
 * non-retryable, connection state **`error`**. That is the wrong outcome and
 * it is not a cosmetic one: `error` reads as "try later", while a dead refresh
 * token means "reconnect", and the user would be left with a connection that
 * silently never recovers.
 *
 * And a dead refresh token is *ordinary*, not exceptional. G2 lists six ways
 * one dies, including a password change while the grant holds Gmail scopes,
 * six months of disuse, and — for a consent screen still in Testing — a
 * **seven-day** expiry.
 *
 * So `httpStatus` is the *canonical* status for the classifier, translated at
 * this edge exactly as `toProbeError` and `toGmailProviderError` translate at
 * theirs: `invalid_grant` becomes 401, which is what "this credential is no
 * longer good" means everywhere else in the system, and which AIP-193 maps to
 * UNAUTHENTICATED. `responseStatus` keeps the untranslated truth for anyone
 * who needs it.
 */
export class GoogleOAuthError extends Error {
  constructor(
    readonly code: GoogleOAuthErrorCode,
    /** The status actually returned by Google. */
    readonly responseStatus: number,
    /** The canonical status for `classifyProviderFailure`. See the class comment. */
    readonly httpStatus: number,
  ) {
    // Fixed per code and status. Never `error_description`, never the URL,
    // never the body, never a token.
    super(`google oauth refused: ${code} (${responseStatus})`);
    this.name = 'GoogleOAuthError';
  }
}

function canonicalStatusFor(code: GoogleOAuthErrorCode, responseStatus: number): number {
  // A grant that is gone is an authentication failure whatever number the
  // OAuth spec puts on it.
  if (code === 'invalid_grant' || code === 'admin_policy_enforced') return 401;
  if (code === 'invalid_scope' || code === 'unauthorized_client') return 403;
  if (code === 'rate_limit_exceeded') return 429;
  return responseStatus;
}

export interface GoogleOAuthClientDeps {
  readonly clientId: string;
  /** Read from the injected environment by the caller. Never a literal, never from a request. */
  readonly clientSecret: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
  /**
   * When set, `loadIdentity` refuses a grant for any other mailbox.
   *
   * This is what makes "a mismatched account is refused and stores nothing"
   * true rather than hopeful: `completeProviderOAuth` calls `loadIdentity`
   * *before* it writes to the vault or the connection store, so a throw here
   * happens while nothing has been persisted.
   */
  readonly requireAccountId?: string;
}

/** The token-endpoint success body (G1). */
interface WireTokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
  scope?: unknown;
  token_type?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

/**
 * Normalizes an email for comparison only.
 *
 * Case-folding only. Google does not document whether `getProfile` canonicalises
 * case, dots or `googlemail.com` (CONTRACT.md §9.5), so this does the one
 * transformation that is safe in every direction and treats anything else as a
 * genuine difference. Stripping dots would silently merge two addresses that
 * Google may consider distinct, which is the more dangerous mistake.
 */
export function normalizeGoogleAccount(email: string): string {
  return email.trim().toLowerCase();
}

export function createGoogleOAuthClient(deps: GoogleOAuthClientDeps): ProviderOAuthClient {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? GOOGLE_OAUTH_REQUEST_TIMEOUT_MS;
  const now = deps.now ?? (() => new Date());

  if (!deps.clientId.trim() || !deps.clientSecret.trim()) {
    // Named here rather than left to a generic 401 from Google: whoever reads
    // this next is a person debugging a missing secret, not Google's API.
    throw new Error('google oauth client is not configured: client id and secret are both required');
  }

  /** One form POST, with a timeout that actually cancels the request. */
  async function form(endpoint: string, body: URLSearchParams): Promise<Response> {
    // Not `AbortSignal.timeout`: its timer does not hold the event loop open,
    // so a process whose only pending work is this request can exit before the
    // abort fires. Same reasoning as the Gmail transport.
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new DOMException('google oauth request timed out', 'TimeoutError')),
      timeoutMs,
    );
    try {
      return await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: body.toString(),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Reads an error body far enough to name it, and no further. */
  async function refusal(response: Response): Promise<GoogleOAuthError> {
    let raw: unknown = null;
    try {
      raw = await response.json();
    } catch {
      // Google's front end does not always return JSON on a 5xx. A parse
      // failure inside the error path must not become the reported error.
      raw = null;
    }
    const reported = isRecord(raw) && typeof raw.error === 'string' ? raw.error : '';
    const code: GoogleOAuthErrorCode = KNOWN_OAUTH_ERRORS.has(reported)
      ? (reported as GoogleOAuthErrorCode)
      : 'unknown_error';
    // `error_description` is deliberately not read. It is free-form text from
    // Google and is the one field in the envelope that can echo request
    // content back at us.
    return new GoogleOAuthError(code, response.status, canonicalStatusFor(code, response.status));
  }

  /** Turns a token-endpoint success body into the canonical token set. */
  async function tokenSetFrom(
    response: Response,
    previous: ProviderOAuthTokenSet | null,
  ): Promise<ProviderOAuthTokenSet> {
    if (!response.ok) throw await refusal(response);

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      throw new GoogleOAuthError('unknown_error', response.status, response.status);
    }
    if (!isRecord(raw)) throw new GoogleOAuthError('unknown_error', response.status, response.status);
    const body = raw as WireTokenResponse;

    if (!nonEmptyString(body.access_token)) {
      throw new GoogleOAuthError('unknown_error', response.status, response.status);
    }

    // `expires_in` is seconds from now (G1). Google does not return an absolute
    // time, so it is computed against an injected clock rather than read.
    const expiresInSeconds = typeof body.expires_in === 'number' && Number.isFinite(body.expires_in)
      ? body.expires_in
      : null;
    const accessTokenExpiresAt = expiresInSeconds === null
      ? null
      : new Date(now().getTime() + expiresInSeconds * 1000).toISOString();

    // On a refresh Google commonly omits `refresh_token`, meaning "keep the one
    // you have". `refreshProviderAccessToken` reads `null` that way, so it must
    // never be read here as "the grant lost its refresh token".
    const refreshToken = nonEmptyString(body.refresh_token)
      ? body.refresh_token
      : previous?.refreshToken ?? null;

    const grantedScopes = nonEmptyString(body.scope)
      ? Object.freeze(Array.from(new Set(body.scope.split(/\s+/).filter(Boolean))).sort())
      : previous?.grantedScopes ?? Object.freeze([]);

    return Object.freeze({
      accessToken: body.access_token,
      refreshToken,
      accessTokenExpiresAt,
      // Google never returns a refresh-token expiry. It is genuinely unknown,
      // and `null` is the honest value — notably it is *not* null because the
      // token lasts forever: a consent screen in Testing gets seven days (G2),
      // which nothing in the response says.
      refreshTokenExpiresAt: null,
      grantedScopes,
    });
  }

  return {
    provider: 'google',

    async exchangeAuthorizationCode(input) {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: input.code,
        client_id: deps.clientId,
        client_secret: deps.clientSecret,
        redirect_uri: input.redirectUri,
        // PKCE. `beginProviderOAuth` always sends an S256 challenge, so the
        // verifier is not optional here — omitting it would make every
        // exchange fail as `invalid_grant`. G1 does not document PKCE for the
        // web-server flow, but Google honours a challenge when one is sent,
        // and sending it costs nothing and binds the callback to the redirect
        // that started it.
        code_verifier: input.codeVerifier,
      });
      return tokenSetFrom(await form(GOOGLE_TOKEN_ENDPOINT, body), null);
    },

    async refreshAccessToken(tokenSet) {
      if (!nonEmptyString(tokenSet.refreshToken)) {
        // No refresh token is not a network condition and must not be retried.
        throw new GoogleOAuthError('invalid_grant', 400, 401);
      }
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokenSet.refreshToken,
        client_id: deps.clientId,
        client_secret: deps.clientSecret,
      });
      return tokenSetFrom(await form(GOOGLE_TOKEN_ENDPOINT, body), tokenSet);
    },

    async loadIdentity(tokenSet): Promise<IntegrationProviderIdentity> {
      // The same Gmail transport production reads with — same HTTP path, same
      // retries, same bounds, same redaction. Not a second client.
      const profile = await createGmailTransport({
        accessToken: async () => tokenSet.accessToken,
        fetchImpl: deps.fetchImpl,
        timeoutMs: deps.timeoutMs,
      }).getProfile();

      const account = normalizeGoogleAccount(profile.emailAddress);
      if (!account) throw new GoogleOAuthError('invalid_grant', 400, 401);

      // Refused *before* `completeProviderOAuth` reaches the vault or the
      // connection store, which is what makes a mismatch store nothing.
      if (deps.requireAccountId !== undefined
        && normalizeGoogleAccount(deps.requireAccountId) !== account) {
        throw new GoogleOAuthError('invalid_grant', 400, 401);
      }

      return Object.freeze({
        provider: 'google',
        // The mailbox address, and deliberately so. It is the only field any
        // Gmail response carries that names the account (CONTRACT.md §2). A
        // stable opaque id would need an OpenID `sub`, which needs the
        // `openid` scope on the consent screen — more than a read-only mail
        // integration should ask for. The cost is recorded rather than hidden:
        // if a user's address changes, this reads as a different account.
        providerAccountId: account,
        providerSpaceId: null,
        displayName: profile.emailAddress,
      });
    },

    async revoke(tokenSet) {
      // Revoking the refresh token kills the whole grant; the access token
      // alone would leave the refresh token live.
      const token = nonEmptyString(tokenSet.refreshToken) ? tokenSet.refreshToken : tokenSet.accessToken;
      const response = await form(GOOGLE_REVOCATION_ENDPOINT, new URLSearchParams({ token }));
      if (response.ok) return;

      // A token Google has already invalidated is the end state we wanted, and
      // it answers 400 for one. Treating that as a failure would leave the
      // connection stuck `connected` with a dead grant and no way for the user
      // to clear it. Anything else — a 5xx, a refused client — is a real
      // failure, and `disconnectProviderOAuth` turns it into `revocation_failed`
      // rather than deleting a credential Google still honours.
      if (response.status === 400) return;
      throw await refusal(response);
    },
  };
}
