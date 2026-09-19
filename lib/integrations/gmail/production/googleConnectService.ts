/**
 * Connecting and disconnecting a Gmail account (Phase B, connect flow).
 *
 * Everything this needs already existed and none of it is re-implemented here:
 * `beginProviderOAuth` / `completeProviderOAuth` own the state and PKCE
 * lifecycle, `StoredProviderOAuthStateStore` owns the state at rest (SHA-256
 * document id, encrypted verifier, transactional consume),
 * `EncryptedProviderCredentialVault` owns the tokens,
 * `StoredIntegrationConnectionStore` owns the record, and
 * `createGoogleOAuthClient` owns the HTTP. This file is the wiring, plus the
 * three decisions that are specific to connecting *Gmail* for *this* account.
 *
 * ── Why the callback is an authenticated POST, not a browser GET ──
 *
 * Google redirects the **browser** to the redirect URI, and a browser redirect
 * carries no Firebase bearer token. A server route that accepted `?code=&state=`
 * from that redirect would have no authenticated uid, and would have to take
 * the account from the state record itself — which would make
 * `completeProviderOAuth`'s `state.scopeId !== input.scopeId` check compare a
 * value against itself and always pass. The replay protection would still work;
 * the *ownership* protection would be gone.
 *
 * So the redirect URI is an https link the mobile app intercepts. The app reads
 * `code` and `state` off it and POSTs them here with its own bearer token, and
 * the uid then comes from Firebase rather than from the attacker-supplied half
 * of the exchange. A stolen code and state cannot be redeemed into somebody
 * else's account, because the state's `scopeId` must equal the authenticated
 * uid.
 *
 * ── Why the redirect URI is never echoed ─────────────────────────
 *
 * It is read from the environment when the flow *begins*, stored in the state
 * record, and read back from that record for the exchange. Nothing the callback
 * sends can influence it. An attacker who could choose the `redirect_uri` on
 * the exchange could not change where Google already sent the code, but could
 * make our request disagree with the authorization — and Google rejects the
 * mismatch, which turns a security property into an outage. Here there is
 * nothing to disagree with.
 */
import {
  beginProviderOAuth,
  completeProviderOAuth,
  disconnectProviderOAuth,
  ProviderOAuthError,
  type ProviderOAuthFailureCode,
} from '../../providers/providerOAuthLifecycle';
import { StoredProviderOAuthStateStore } from '../../providers/production/storedOAuthStateStore';
import { StoredIntegrationConnectionStore } from '../../providers/production/storedConnectionStore';
import { EncryptedProviderCredentialVault } from '../../providers/production/encryptedCredentialVault';
import {
  createGoogleOAuthClient,
  GoogleAccountMismatchError,
  GoogleOAuthError,
  GOOGLE_AUTHORIZATION_ENDPOINT,
} from './googleOAuthClient';
import { gmailScopesForCapabilities, GMAIL_PROVIDER } from '../adapter';
import type { StorageAdapter } from '../../../storage/storageAdapter';
import type { FieldEncryptionOptions } from '../../../security/fieldEncryption';
import type { IntegrationCapability } from '../../../../src/contracts/v1/integrationConnectionContracts';

/**
 * Phase B is a read-only mail integration and asks for exactly one capability.
 *
 * Derived rather than written out, so it cannot drift from what
 * `planProviderSync` will demand or from what the transport proved it uses.
 * The catalogue also knows about `gmail.compose` and `gmail.send`; a connect
 * flow must never request them, and going through
 * `gmailScopesForCapabilities` is what makes that structural instead of a rule
 * somebody has to remember.
 */
export const GOOGLE_CONNECT_CAPABILITIES: readonly IntegrationCapability[] = Object.freeze(['mail_read']);
export const GOOGLE_CONNECT_SCOPES: readonly string[] = gmailScopesForCapabilities(GOOGLE_CONNECT_CAPABILITIES);

/**
 * Why a connect attempt did not finish.
 *
 * `ProviderOAuthFailureCode` is reused wholesale rather than re-expressed —
 * it is already the taxonomy for this flow — and three codes are added for
 * conditions it does not cover.
 */
export type GoogleConnectReason =
  | ProviderOAuthFailureCode
  | 'not_configured'
  | 'account_mismatch'
  | 'reauth_required'
  | 'provider_unavailable';

export class GoogleConnectError extends Error {
  constructor(
    readonly reason: GoogleConnectReason,
    readonly status: number,
  ) {
    // Fixed per reason. Never a code, a verifier, a token or Google's prose.
    super(`google connect failed: ${reason}`);
    this.name = 'GoogleConnectError';
  }
}

/**
 * The three values the owner must supply. None has a default.
 *
 * Typed as the three keys this module reads rather than the whole
 * `ProcessEnv`: this project's Next.js type augmentation makes `NODE_ENV`
 * required, which would force every test building an explicitly empty
 * environment to supply a variable this code never looks at. An index-signature
 * object still satisfies it, so `process.env` remains a valid default.
 */
export interface GoogleOAuthEnv {
  readonly GOOGLE_OAUTH_CLIENT_ID?: string;
  readonly GOOGLE_OAUTH_CLIENT_SECRET?: string;
  readonly GOOGLE_OAUTH_REDIRECT_URI?: string;
}

export interface GoogleConnectDeps {
  readonly storage: StorageAdapter;
  /**
   * Injected the way `footballDataProvider` injects it: an ambient read in
   * production, an explicit object in tests, so "not configured" is a fact
   * about the test's input rather than about whichever machine runs it.
   */
  readonly env?: GoogleOAuthEnv;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
  readonly random?: (size: number) => Buffer;
  readonly encryption?: FieldEncryptionOptions;
}

interface Configured {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}

/**
 * Reads the three secrets, and refuses clearly when they are absent.
 *
 * There is deliberately **no fallback and no development bypass**. A way to
 * connect without a real client would be a way to ship something that has
 * never touched Google while looking as though it has.
 */
function configure(env: GoogleOAuthEnv): Configured {
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID?.trim() ?? '';
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() ?? '';
  const redirectUri = env.GOOGLE_OAUTH_REDIRECT_URI?.trim() ?? '';
  if (!clientId || !clientSecret || !redirectUri) {
    throw new GoogleConnectError('not_configured', 503);
  }
  return { clientId, clientSecret, redirectUri };
}

/** Maps every error this flow can raise onto one reason and one status. */
function asConnectError(error: unknown): GoogleConnectError {
  if (error instanceof GoogleConnectError) return error;

  if (error instanceof GoogleAccountMismatchError) {
    // 409: the request was well formed and authorized, and it conflicts with
    // the account already connected.
    return new GoogleConnectError('account_mismatch', 409);
  }

  if (error instanceof GoogleOAuthError) {
    // `httpStatus` is already the canonical status — the client translates the
    // token endpoint's 400 `invalid_grant` into 401 there, for the reasons in
    // its own comment.
    if (error.httpStatus === 401) return new GoogleConnectError('reauth_required', 401);
    if (error.httpStatus === 403) return new GoogleConnectError('scope_mismatch', 403);
    return new GoogleConnectError('provider_unavailable', 502);
  }

  if (error instanceof ProviderOAuthError) {
    const status = error.code === 'invalid_or_replayed_state'
      || error.code === 'state_scope_mismatch'
      ? 401
      : error.code === 'invalid_request' || error.code === 'provider_mismatch' ? 400 : 409;
    return new GoogleConnectError(error.code, status);
  }

  // Anything unrecognised refuses rather than admits, and says nothing about
  // itself: an unrecognised failure is exactly where a raw provider message
  // would otherwise escape.
  return new GoogleConnectError('provider_unavailable', 502);
}

function stores(uid: string, deps: GoogleConnectDeps) {
  return {
    states: new StoredProviderOAuthStateStore(uid, deps.storage, deps.encryption),
    connections: new StoredIntegrationConnectionStore(uid, deps.storage),
    vault: new EncryptedProviderCredentialVault(uid, deps.storage, deps.encryption, deps.now),
  };
}

export interface BeginGoogleConnectResult {
  readonly authorizationUrl: string;
  readonly expiresAt: string;
  readonly requestedScopes: readonly string[];
}

/**
 * Starts an authorization.
 *
 * The returned URL is opened by the app. The `state` is deliberately **not**
 * returned as a separate field — it is already inside the URL, and echoing it
 * would invite a client to store it somewhere a second copy could leak from.
 */
export async function beginGoogleConnect(
  uid: string,
  deps: GoogleConnectDeps,
): Promise<BeginGoogleConnectResult> {
  const config = configure(deps.env ?? (process.env as GoogleOAuthEnv));
  const now = (deps.now ?? (() => new Date()))().toISOString();

  try {
    const begun = await beginProviderOAuth(
      stores(uid, deps).states,
      {
        scopeId: uid,
        provider: GMAIL_PROVIDER,
        capabilities: GOOGLE_CONNECT_CAPABILITIES,
        requestedScopes: GOOGLE_CONNECT_SCOPES,
        authorizationEndpoint: GOOGLE_AUTHORIZATION_ENDPOINT,
        clientId: config.clientId,
        redirectUri: config.redirectUri,
        now,
      },
      deps.random,
    );
    return Object.freeze({
      authorizationUrl: begun.authorizationUrl,
      expiresAt: begun.expiresAt,
      requestedScopes: GOOGLE_CONNECT_SCOPES,
    });
  } catch (error) {
    throw asConnectError(error);
  }
}

export interface CompleteGoogleConnectInput {
  readonly code: string;
  readonly state: string;
}

export interface CompleteGoogleConnectResult {
  readonly connectionId: string;
  /** The mailbox Google says the grant reaches. Not a token, and not a secret. */
  readonly accountEmail: string | null;
  readonly grantedScopes: readonly string[];
  readonly connectedAt: string;
}

/**
 * Finishes an authorization the app carried back from the redirect.
 *
 * `uid` comes from the verified Firebase token, never from the request body —
 * see the module comment. `completeProviderOAuth` then refuses a state whose
 * `scopeId` is not this uid, which is the check that stops a stolen code being
 * redeemed into another account.
 */
export async function completeGoogleConnect(
  uid: string,
  input: CompleteGoogleConnectInput,
  deps: GoogleConnectDeps,
): Promise<CompleteGoogleConnectResult> {
  const config = configure(deps.env ?? (process.env as GoogleOAuthEnv));
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const { states, connections, vault } = stores(uid, deps);

  try {
    // Reconnecting must land on the same mailbox. Looked up before the
    // exchange so the constraint travels into `loadIdentity`, which
    // `completeProviderOAuth` calls before it writes anything.
    const existing = await connections.list({ scopeId: uid, provider: GMAIL_PROVIDER });
    const requireAccountId = existing
      .map((record) => record.identity.providerAccountId)
      .find((accountId): accountId is string => typeof accountId === 'string' && accountId.trim() !== '');

    const client = createGoogleOAuthClient({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      fetchImpl: deps.fetchImpl,
      now: deps.now,
      requireAccountId,
    });

    const connection = await completeProviderOAuth(states, vault, connections, client, {
      scopeId: uid,
      provider: GMAIL_PROVIDER,
      state: input.state,
      code: input.code,
      now,
    });

    return Object.freeze({
      connectionId: connection.connectionId,
      accountEmail: connection.identity.providerAccountId,
      grantedScopes: connection.grantedScopes,
      connectedAt: connection.connectedAt ?? now,
    });
  } catch (error) {
    throw asConnectError(error);
  }
}

export interface DisconnectGoogleResult {
  readonly connectionId: string;
  readonly state: string;
}

/**
 * Revokes the grant at Google, deletes the credential, and marks the record.
 *
 * In that order, and `disconnectProviderOAuth` is what enforces it: a
 * revocation Google refuses leaves the credential in place and the connection
 * in `error`, because deleting our copy of a token Google still honours would
 * leave an access grant alive that nobody can see any more, let alone revoke.
 */
export async function disconnectGoogle(
  uid: string,
  connectionId: string,
  deps: GoogleConnectDeps,
): Promise<DisconnectGoogleResult | null> {
  const config = configure(deps.env ?? (process.env as GoogleOAuthEnv));
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const { connections, vault } = stores(uid, deps);

  try {
    const client = createGoogleOAuthClient({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      fetchImpl: deps.fetchImpl,
      now: deps.now,
    });
    const record = await disconnectProviderOAuth(vault, connections, client, {
      scopeId: uid,
      connectionId,
      now,
    });
    if (!record) return null;
    return Object.freeze({ connectionId: record.connectionId, state: record.state });
  } catch (error) {
    throw asConnectError(error);
  }
}
