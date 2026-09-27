/**
 * A fake of the six Google endpoints the CL6a chain calls, behind `fetch`.
 *
 * Token, revoke, userinfo, Calendar freeBusy, Gmail list/get and Drive
 * metadata/content. It holds real state — codes are single-use, a revoked
 * refresh token stops refreshing, an access token carries the scopes its grant
 * had — so a route test exercises the real service code against something
 * that can say no in the ways Google says no. Shapes follow Google's documented
 * responses; nothing here is a contract of its own.
 *
 * ── One authorization per Google account, as Google keeps it ─────
 *
 * With `include_granted_scopes=true` every consent for the same account adds
 * to one combined authorization, and each code exchange issues another refresh
 * token *for that authorization*. Google's revocation acts on the
 * authorization, not on the token string: "If you revoke a token that
 * represents a combined authorization, access to all of that authorization's
 * scopes on behalf of the associated user are revoked simultaneously"
 * (developers.google.com/identity/protocols/oauth2/web-server, incremental
 * authorization). So here, revoking any refresh or access token of an account
 * kills every token that account's authorization ever issued. The first draft
 * of this fake kept each refresh token independent, which is exactly why a
 * "revoke the superseded token" step looked safe in the suite (CL6a review C1).
 */
import { createHash } from 'node:crypto';

export const FAKE_CLIENT_ID = '123456789012-fakeclient.apps.googleusercontent.com';
export const FAKE_CLIENT_SECRET = 'fake-client-secret-not-real';
export const FAKE_PICKER_KEY = 'fake-picker-key-not-real';
export const FAKE_REDIRECT = 'http://localhost:3000/api/oauth/google/callback';

export interface FakeGoogleAccount {
  readonly sub: string;
  readonly email: string;
}

/** The user↔client authorization Google keeps: one per account until revoked. */
interface Authorization {
  readonly account: FakeGoogleAccount;
  /** Everything ever granted on it. */
  scopes: string[];
  revoked: boolean;
}

/** One token (refresh or access), and what it may do. */
interface Grant {
  readonly authorization: Authorization;
  readonly scopes: string[];
}

export interface FakeGmailMessage {
  readonly id: string;
  readonly subject: string;
  readonly body: string;
  readonly receivedAt: string;
}

export interface FakeDriveFile {
  readonly id: string;
  readonly mimeType: string;
  readonly content: Uint8Array | string;
}

export interface FakeGoogleCall {
  readonly method: string;
  readonly url: string;
  readonly body: string | null;
  readonly authorization: string | null;
}

export class FakeGoogle {
  readonly calls: FakeGoogleCall[] = [];
  /** What the consent screen will grant for the next code, per requested scope. */
  account: FakeGoogleAccount = { sub: '1000000000001', email: 'Person@Example.com' };
  /** Scopes the person unticks on the granular consent screen. */
  refusedScopes: string[] = [];
  busy: { start: string; end: string }[] = [];
  gmail: FakeGmailMessage[] = [];
  lastGmailQuery: string | null = null;
  drive = new Map<string, FakeDriveFile>();
  /** Force the next refresh to answer `invalid_grant` (the Testing-mode day-eight expiry). */
  refreshDead = false;
  revokeStatus = 200;
  /** Every resource call answers this status when set. */
  resourceStatus: number | null = null;
  accessTtlSeconds = 3600;

  private readonly codes = new Map<string, { account: FakeGoogleAccount; scopes: string[]; verifier: string | null; redirect: string }>();
  private readonly authorizations: Authorization[] = [];
  private readonly grants = new Map<string, Grant>();
  private readonly access = new Map<string, Grant>();

  /** The account's authorization Google still honours, if any. */
  private liveAuthorization(sub: string): Authorization | null {
    return this.authorizations.find((entry) => !entry.revoked && entry.account.sub === sub) ?? null;
  }
  private counter = 0;

  /**
   * Plays the person on Google's consent screen: takes the authorization URL
   * the server built and returns the `code`/`state` Google would redirect with.
   */
  consent(authorizationUrl: string): { code: string; state: string } {
    const url = new URL(authorizationUrl);
    const requested = (url.searchParams.get('scope') ?? '').split(' ').filter(Boolean);
    const already = url.searchParams.get('include_granted_scopes') === 'true'
      ? this.liveAuthorization(this.account.sub)?.scopes ?? []
      : [];
    const scopes = Array.from(new Set([...already, ...requested.filter((scope) => !this.refusedScopes.includes(scope))]));
    const code = `code-${++this.counter}`;
    this.codes.set(code, {
      account: this.account,
      scopes,
      verifier: url.searchParams.get('code_challenge'),
      redirect: url.searchParams.get('redirect_uri') ?? '',
    });
    return { code, state: url.searchParams.get('state') ?? '' };
  }

  /** Every live grant's refresh token dies, as Google's 7-day Testing expiry does. */
  expireGrants(): void {
    this.refreshDead = true;
    this.access.clear();
  }

  /** An hour later: every access token has expired, so the next call must refresh. */
  expireAccessTokens(): void {
    this.access.clear();
  }

  /** How many accounts still hold an authorization Google honours. */
  liveGrants(): number {
    return this.authorizations.filter((entry) => !entry.revoked).length;
  }

  /** Revocation requests, whatever they named. */
  revokeCalls(): number {
    return this.calls.filter((call) => call.url === 'https://oauth2.googleapis.com/revoke').length;
  }

  readonly fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' ? init.body : null;
    this.calls.push({ method, url: url.toString(), body, authorization: headers.get('authorization') });

    if (url.origin === 'https://oauth2.googleapis.com' && url.pathname === '/token') return this.token(new URLSearchParams(body ?? ''));
    if (url.origin === 'https://oauth2.googleapis.com' && url.pathname === '/revoke') return this.revoke(new URLSearchParams(body ?? ''));

    const grant = this.bearer(headers.get('authorization'));
    if (this.resourceStatus !== null) return json({ error: { code: this.resourceStatus } }, this.resourceStatus);
    if (!grant) return json({ error: { code: 401, status: 'UNAUTHENTICATED' } }, 401);

    if (url.origin === 'https://openidconnect.googleapis.com' && url.pathname === '/v1/userinfo') {
      return json({ sub: grant.account.sub, email: grant.account.email, email_verified: true });
    }
    if (url.origin === 'https://www.googleapis.com' && url.pathname === '/calendar/v3/freeBusy') {
      if (!grant.scopes.includes('https://www.googleapis.com/auth/calendar.freebusy')) return json({ error: { code: 403 } }, 403);
      return json({ kind: 'calendar#freeBusy', calendars: { primary: { busy: this.busy } } });
    }
    if (url.origin === 'https://gmail.googleapis.com') return this.gmailCall(url, grant);
    if (url.origin === 'https://www.googleapis.com' && url.pathname.startsWith('/drive/v3/files/')) return this.driveCall(url, grant);
    return json({ error: { code: 404 } }, 404);
  };

  private bearer(header: string | null): { account: FakeGoogleAccount; scopes: string[] } | null {
    if (!header?.startsWith('Bearer ')) return null;
    const grant = this.access.get(header.slice(7));
    if (!grant || grant.authorization.revoked) return null;
    return { account: grant.authorization.account, scopes: grant.scopes };
  }

  private mint(grant: Grant): Record<string, unknown> {
    const accessToken = `access-${++this.counter}`;
    this.access.set(accessToken, grant);
    return { access_token: accessToken, expires_in: this.accessTtlSeconds, scope: grant.scopes.join(' '), token_type: 'Bearer' };
  }

  private token(form: URLSearchParams): Response {
    if (form.get('client_id') !== FAKE_CLIENT_ID || form.get('client_secret') !== FAKE_CLIENT_SECRET) {
      return json({ error: 'invalid_client' }, 401);
    }
    if (form.get('grant_type') === 'authorization_code') {
      const code = form.get('code') ?? '';
      const issued = this.codes.get(code);
      this.codes.delete(code);
      if (!issued) return json({ error: 'invalid_grant', error_description: 'Bad Request' }, 400);
      const verifier = form.get('code_verifier') ?? '';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (issued.verifier !== challenge) return json({ error: 'invalid_grant' }, 400);
      if (issued.redirect !== form.get('redirect_uri')) return json({ error: 'redirect_uri_mismatch' }, 400);
      // Another refresh token on the account's one authorization, or the
      // first one of a new authorization after a revoke.
      let authorization = this.liveAuthorization(issued.account.sub);
      if (!authorization) {
        authorization = { account: issued.account, scopes: [], revoked: false };
        this.authorizations.push(authorization);
      }
      authorization.scopes = Array.from(new Set([...authorization.scopes, ...issued.scopes]));
      const grant: Grant = { authorization, scopes: issued.scopes };
      const refreshToken = `refresh-${++this.counter}`;
      this.grants.set(refreshToken, grant);
      return json({ ...this.mint(grant), refresh_token: refreshToken });
    }
    if (form.get('grant_type') === 'refresh_token') {
      const grant = this.grants.get(form.get('refresh_token') ?? '');
      if (!grant || grant.authorization.revoked || this.refreshDead) {
        return json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400);
      }
      return json(this.mint(grant));
    }
    return json({ error: 'unsupported_grant_type' }, 400);
  }

  private revoke(form: URLSearchParams): Response {
    if (this.revokeStatus !== 200) return json({ error: 'server_error' }, this.revokeStatus);
    const token = form.get('token') ?? '';
    const grant = this.grants.get(token) ?? this.access.get(token);
    if (!grant || grant.authorization.revoked) return json({ error: 'invalid_token' }, 400);
    // The whole authorization, not the one token: every refresh and access
    // token it ever issued dies with it (see the header).
    const { authorization } = grant;
    authorization.revoked = true;
    for (const [key, value] of Array.from(this.access.entries())) {
      if (value.authorization === authorization) this.access.delete(key);
    }
    return new Response(null, { status: 200 });
  }

  private gmailCall(url: URL, grant: { scopes: string[] }): Response {
    if (!grant.scopes.includes('https://www.googleapis.com/auth/gmail.readonly')) return json({ error: { code: 403 } }, 403);
    if (url.pathname === '/gmail/v1/users/me/messages') {
      this.lastGmailQuery = url.searchParams.get('q');
      const max = Number(url.searchParams.get('maxResults') ?? '100');
      const listed = [...this.gmail]
        .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt))
        .slice(0, max)
        .map((message) => ({ id: message.id, threadId: message.id }));
      return json(listed.length === 0 ? { resultSizeEstimate: 0 } : { messages: listed, resultSizeEstimate: listed.length });
    }
    const match = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(url.pathname);
    const message = match ? this.gmail.find((candidate) => candidate.id === decodeURIComponent(match[1]!)) : undefined;
    if (!message) return json({ error: { code: 404 } }, 404);
    return json({
      id: message.id,
      threadId: message.id,
      historyId: '9001',
      internalDate: String(Date.parse(message.receivedAt)),
      labelIds: ['INBOX', 'CATEGORY_PERSONAL'],
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'Subject', value: message.subject },
          { name: 'From', value: 'School Office <office@school.example>' },
        ],
        body: { size: message.body.length, data: Buffer.from(message.body, 'utf8').toString('base64url') },
      },
    });
  }

  private driveCall(url: URL, grant: { scopes: string[] }): Response {
    if (!grant.scopes.includes('https://www.googleapis.com/auth/drive.file')) return json({ error: { code: 403 } }, 403);
    const match = /^\/drive\/v3\/files\/([^/]+)(\/export)?$/.exec(url.pathname);
    const file = match ? this.drive.get(decodeURIComponent(match[1]!)) : undefined;
    if (!file) return json({ error: { code: 404, message: 'File not found' } }, 404);
    const bytes = typeof file.content === 'string' ? Buffer.from(file.content, 'utf8') : Buffer.from(file.content);
    if (match![2]) return new Response(bytes, { status: 200, headers: { 'content-type': 'text/plain' } });
    if (url.searchParams.get('alt') === 'media') return new Response(bytes, { status: 200, headers: { 'content-type': file.mimeType } });
    return json({ mimeType: file.mimeType, ...(file.mimeType.startsWith('application/vnd.google-apps') ? {} : { size: String(bytes.byteLength) }) });
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
