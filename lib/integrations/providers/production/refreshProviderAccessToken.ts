/**
 * Refreshing an access token (UC-3.3, #187).
 *
 * `providerTokenState` already decides *when* a token needs refreshing. This
 * does it, and its only real problem is ordering: the vault and the connection
 * record are two writes, and a failure between them leaves the account holding
 * a token that the record disagrees with.
 *
 * ── Why the vault is written first ───────────────────────────────
 *
 * The vault holds the truth; the connection record holds a description of it
 * (`expiresAt`, and the fact that a credential exists). If the vault write
 * lands and the record write does not, the account has a working token
 * described as expiring sooner than it does — the next call refreshes again,
 * which is wasteful and harmless. The other order loses the new token while
 * claiming it was stored, and the grant then fails until the user reconnects.
 *
 * So: wrong-but-recoverable is chosen over lost-and-silent.
 *
 * ── A refresh that fails is not an error to retry forever ────────
 *
 * A provider refusing a refresh token means the grant is gone: revoked in the
 * provider's console, expired, or withdrawn. The connection moves to
 * `needs_reauth` rather than `error`, because what the user has to do is
 * connect again, and `error` reads as "try later".
 */
import {
  classifyProviderFailure,
  type ProviderCredentialVault,
  type ProviderOAuthTokenSet,
} from '../providerRuntime';
import { ProviderOAuthError, type ProviderOAuthClient } from '../providerOAuthLifecycle';
import type {
  IntegrationConnectionRecord,
  IntegrationConnectionStore,
} from '../../../../src/contracts/v1/integrationConnectionContracts';

export interface RefreshProviderAccessTokenInput {
  readonly scopeId: string;
  readonly connectionId: string;
  readonly now: string;
}

export interface RefreshProviderAccessTokenResult {
  readonly tokenSet: ProviderOAuthTokenSet;
  readonly connection: IntegrationConnectionRecord;
}

export async function refreshProviderAccessToken(
  vault: ProviderCredentialVault,
  connections: IntegrationConnectionStore,
  client: ProviderOAuthClient,
  input: RefreshProviderAccessTokenInput,
): Promise<RefreshProviderAccessTokenResult> {
  const connection = await connections.get(input.connectionId);
  if (!connection) throw new ProviderOAuthError('invalid_request');
  if (connection.scopeId !== input.scopeId) throw new ProviderOAuthError('state_scope_mismatch');
  if (connection.identity.provider !== client.provider) throw new ProviderOAuthError('provider_mismatch');

  const credentialRef = connection.credentialRef ?? null;
  if (!credentialRef) throw new ProviderOAuthError('invalid_request');

  const current = await vault.loadOAuthTokenSet(credentialRef);
  // A record that points at a credential the vault does not have is a grant
  // that cannot be used. Reconnecting is the only way out, so say so.
  if (!current) {
    await connections.markState(connection.connectionId, 'needs_reauth', input.now, 'credential_missing');
    throw new ProviderOAuthError('invalid_request');
  }
  if (!current.refreshToken || !client.refreshAccessToken) {
    await connections.markState(connection.connectionId, 'needs_reauth', input.now, 'refresh_unsupported');
    throw new ProviderOAuthError('invalid_request');
  }

  let refreshed: ProviderOAuthTokenSet;
  try {
    refreshed = await client.refreshAccessToken(current);
  } catch (error) {
    const httpStatus = typeof (error as { httpStatus?: unknown }).httpStatus === 'number'
      ? (error as { httpStatus: number }).httpStatus
      : null;
    const failure = classifyProviderFailure({ httpStatus });
    // The canonical classifier decides what the connection becomes, so a
    // refused refresh and a refused read agree about what happened.
    await connections.markState(
      connection.connectionId,
      failure.connectionState === 'connected' ? 'error' : failure.connectionState,
      input.now,
      failure.safeErrorCode,
    );
    throw new ProviderOAuthError('invalid_request');
  }

  if (!refreshed.accessToken.trim()) throw new ProviderOAuthError('invalid_request');
  // A provider that returns no refresh token means "keep the one you have".
  // Reading it as a loss would throw away a working grant.
  const merged: ProviderOAuthTokenSet = Object.freeze({
    ...refreshed,
    refreshToken: refreshed.refreshToken ?? current.refreshToken,
    grantedScopes: refreshed.grantedScopes.length > 0 ? refreshed.grantedScopes : current.grantedScopes,
  });

  const nextRef = await vault.storeOAuthTokenSet({
    scopeId: input.scopeId,
    provider: connection.identity.provider,
    tokenSet: merged,
  });

  const updated = await connections.upsert(
    {
      scopeId: connection.scopeId,
      identity: connection.identity,
      state: 'connected',
      capabilities: connection.capabilities,
      grantedScopes: merged.grantedScopes,
      connectedAt: connection.connectedAt,
      lastSyncedAt: connection.lastSyncedAt,
      expiresAt: merged.accessTokenExpiresAt,
      credentialRef: nextRef,
      sync: connection.sync,
      featureFlag: connection.featureFlag,
      provenance: connection.provenance,
    },
    input.now,
  );

  return { tokenSet: merged, connection: updated };
}
