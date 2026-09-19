/**
 * "Give me a usable bearer token for this connection" (Gmail Phase B).
 *
 * This seam did not exist. The only ways to obtain a token were
 * `ProviderCredentialVault.loadOAuthTokenSet` and `refreshProviderAccessToken`,
 * and both hand the caller a `ProviderOAuthTokenSet` — which carries the
 * plaintext **refresh** token. A transport needs one string, the bearer, and
 * has no business holding the credential that can mint new ones. Every extra
 * object that has seen a refresh token is another place it can be logged,
 * serialised into an error, or captured in a heap dump.
 *
 * So this returns only the access token, and the transport never touches the
 * vault.
 *
 * ── Why the decision is `providerTokenState`, not "refresh every time" ──
 *
 * Refreshing unconditionally would work and would be wrong: it burns a token
 * request per sync, it rotates the credential far more often than the grant
 * needs, and it turns a provider's token endpoint into a dependency of every
 * read. `providerTokenState` already encodes when a refresh is actually due,
 * including the skew window, and it is the same function `planProviderSync`
 * consults — so the transport and the sync planner cannot disagree about
 * whether a grant is usable.
 *
 * ── Why this cannot be a singleton ───────────────────────────────
 *
 * `EncryptedProviderCredentialVault` is constructed per-uid and throws
 * ("credential scope does not match the vault account") when asked for a
 * credential outside its own scope. That is a deliberate isolation boundary,
 * so a token provider is built per scope, per request — never cached in a
 * module-level variable where one account's vault could serve another's read.
 */
import {
  providerTokenState,
  type ProviderCredentialVault,
  type ProviderOAuthTokenMetadata,
} from '../providerRuntime';
import { ProviderOAuthError, type ProviderOAuthClient } from '../providerOAuthLifecycle';
import { refreshProviderAccessToken } from './refreshProviderAccessToken';
import type { IntegrationConnectionStore } from '../../../../src/contracts/v1/integrationConnectionContracts';

export interface ProviderAccessTokenDeps {
  readonly vault: ProviderCredentialVault;
  readonly connections: IntegrationConnectionStore;
  /** Optional: a grant with no refresh token can still be read until it expires. */
  readonly client?: ProviderOAuthClient;
}

export interface ProviderAccessTokenInput {
  readonly scopeId: string;
  readonly connectionId: string;
  readonly now: string;
}

/**
 * A bearer token and nothing else.
 *
 * No refresh token, no credential reference, no token set. `expiresAt` is
 * metadata a caller may legitimately need to pace itself; it is not a secret.
 */
export interface ProviderAccessToken {
  readonly accessToken: string;
  readonly expiresAt: string | null;
  /** Whether this call performed a refresh. Useful for metrics, never for auth. */
  readonly refreshed: boolean;
}

/**
 * Why a token could not be produced.
 *
 * A closed set of codes with a fixed message each, in the manner of
 * `SafeFetchError` — never the token, the vault key, or the provider's reply.
 */
export type ProviderAccessTokenErrorCode =
  | 'connection_missing'
  | 'scope_mismatch'
  | 'credential_missing'
  | 'token_revoked'
  | 'reauth_required';

export class ProviderAccessTokenError extends Error {
  readonly code: ProviderAccessTokenErrorCode;

  constructor(code: ProviderAccessTokenErrorCode) {
    super(`provider access token unavailable: ${code}`);
    this.name = 'ProviderAccessTokenError';
    this.code = code;
  }
}

/** The metadata `providerTokenState` reads, assembled without exposing the secrets. */
function metadataOf(
  tokenSet: {
    readonly accessTokenExpiresAt: string | null;
    readonly refreshTokenExpiresAt: string | null;
    readonly grantedScopes: readonly string[];
    readonly refreshToken: string | null;
  },
  revokedAt: string | null,
): ProviderOAuthTokenMetadata {
  return {
    accessTokenExpiresAt: tokenSet.accessTokenExpiresAt,
    refreshTokenExpiresAt: tokenSet.refreshTokenExpiresAt,
    grantedScopes: tokenSet.grantedScopes,
    hasRefreshToken: tokenSet.refreshToken !== null && tokenSet.refreshToken.trim() !== '',
    revokedAt,
  };
}

export async function loadProviderAccessToken(
  deps: ProviderAccessTokenDeps,
  input: ProviderAccessTokenInput,
): Promise<ProviderAccessToken> {
  const connection = await deps.connections.get(input.connectionId);
  if (!connection) throw new ProviderAccessTokenError('connection_missing');
  // The same check the vault makes, made earlier so a cross-scope read fails
  // before a credential is ever loaded rather than after.
  if (connection.scopeId !== input.scopeId) throw new ProviderAccessTokenError('scope_mismatch');

  const credentialRef = connection.credentialRef ?? null;
  if (!credentialRef) throw new ProviderAccessTokenError('credential_missing');

  const current = await deps.vault.loadOAuthTokenSet(credentialRef);
  if (!current) throw new ProviderAccessTokenError('credential_missing');

  const state = providerTokenState(
    metadataOf(current, connection.revokedAt ?? null),
    input.now,
  );

  if (state === 'revoked') throw new ProviderAccessTokenError('token_revoked');
  // `expired` means the access token is past its life *and* there is no
  // refresh token to trade in. Nothing to do but reconnect.
  if (state === 'expired' || state === 'missing') {
    throw new ProviderAccessTokenError('reauth_required');
  }

  if (state === 'active') {
    if (!current.accessToken.trim()) throw new ProviderAccessTokenError('credential_missing');
    return {
      accessToken: current.accessToken,
      expiresAt: current.accessTokenExpiresAt,
      refreshed: false,
    };
  }

  // state === 'refresh_due'
  if (!deps.client) throw new ProviderAccessTokenError('reauth_required');
  try {
    const { tokenSet } = await refreshProviderAccessToken(
      deps.vault,
      deps.connections,
      deps.client,
      { scopeId: input.scopeId, connectionId: input.connectionId, now: input.now },
    );
    return {
      accessToken: tokenSet.accessToken,
      expiresAt: tokenSet.accessTokenExpiresAt,
      refreshed: true,
    };
  } catch (error) {
    // `refreshProviderAccessToken` has already moved the connection to the
    // right state and thrown a `ProviderOAuthError` whose code is a fixed
    // string. Translate rather than re-wrap, so nothing the provider said
    // travels any further.
    if (error instanceof ProviderOAuthError) throw new ProviderAccessTokenError('reauth_required');
    throw error;
  }
}

/**
 * A `() => Promise<string>` for a transport, bound to one scope and one
 * connection.
 *
 * Built per request, for the reason in the module comment: the vault it closes
 * over belongs to exactly one account.
 */
export function createProviderAccessTokenProvider(
  deps: ProviderAccessTokenDeps,
  input: Omit<ProviderAccessTokenInput, 'now'> & { readonly now: () => string },
): () => Promise<string> {
  return async () => {
    const token = await loadProviderAccessToken(deps, {
      scopeId: input.scopeId,
      connectionId: input.connectionId,
      now: input.now(),
    });
    return token.accessToken;
  };
}
