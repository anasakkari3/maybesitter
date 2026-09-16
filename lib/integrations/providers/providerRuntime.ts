import type {
  ContextProviderKind,
  IntegrationCapability,
  IntegrationConnectionRecord,
  IntegrationCredentialReference,
} from '../../../src/contracts/v1/integrationConnectionContracts';

export type ProviderTokenState = 'missing' | 'active' | 'refresh_due' | 'expired' | 'revoked';

export interface ProviderOAuthTokenMetadata {
  readonly accessTokenExpiresAt: string | null;
  readonly refreshTokenExpiresAt: string | null;
  readonly grantedScopes: readonly string[];
  readonly hasRefreshToken: boolean;
  readonly revokedAt: string | null;
}

/** Secrets cross this port, but never enter connection records, logs, or sync results. */
export interface ProviderOAuthTokenSet {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly accessTokenExpiresAt: string | null;
  readonly refreshTokenExpiresAt: string | null;
  readonly grantedScopes: readonly string[];
}

export interface ProviderCredentialVault {
  storeOAuthTokenSet(input: {
    readonly scopeId: string;
    readonly provider: ContextProviderKind;
    readonly tokenSet: ProviderOAuthTokenSet;
  }): Promise<IntegrationCredentialReference>;
  loadOAuthTokenSet(reference: IntegrationCredentialReference): Promise<ProviderOAuthTokenSet | null>;
  delete(reference: IntegrationCredentialReference): Promise<void>;
}

export type ProviderSyncBlockReason =
  | 'ready'
  | 'wrong_provider'
  | 'not_connected'
  | 'missing_capability'
  | 'token_missing'
  | 'token_refresh_required'
  | 'token_revoked';

export interface ProviderSyncPlan {
  readonly connectionId: string;
  readonly scopeId: string;
  readonly provider: ContextProviderKind;
  readonly shouldSync: boolean;
  readonly reason: ProviderSyncBlockReason;
  readonly cursor: string | null;
}

export interface ProviderSyncPlanInput {
  readonly provider: ContextProviderKind;
  readonly requiredCapabilities: readonly IntegrationCapability[];
  readonly token: ProviderOAuthTokenMetadata | null;
}

export type ProviderFailureKind =
  | 'authentication_revoked'
  | 'permission_lost'
  | 'rate_limited'
  | 'stale_cursor'
  | 'duplicate'
  | 'malformed_response'
  | 'provider_unavailable'
  | 'unknown';

export interface ProviderFailure {
  readonly kind: ProviderFailureKind;
  readonly retryable: boolean;
  readonly connectionState: 'connected' | 'needs_reauth' | 'permission_limited' | 'error';
  readonly safeErrorCode: string;
}

export interface ProviderFailureInput {
  readonly httpStatus?: number | null;
  readonly staleCursor?: boolean;
  readonly duplicate?: boolean;
  readonly malformedResponse?: boolean;
}

export interface ProviderDisconnectRequest {
  readonly provider: ContextProviderKind;
  readonly connectionId: string;
  readonly revokeProviderCredential: true;
  readonly deleteVaultCredential: true;
  readonly markConnectionState: 'revoked';
  readonly requestedAt: string;
}

const DEFAULT_REFRESH_SKEW_MS = 10 * 60_000;
const MAX_RETRY_DELAY_MS = 15 * 60_000;

function timestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function providerTokenState(
  token: ProviderOAuthTokenMetadata | null,
  now: string,
  refreshSkewMs = DEFAULT_REFRESH_SKEW_MS,
): ProviderTokenState {
  if (!token) return 'missing';
  if (token.revokedAt) return 'revoked';
  const nowMs = timestamp(now);
  if (nowMs === null) return 'missing';
  const refreshExpiresAt = timestamp(token.refreshTokenExpiresAt);
  if (refreshExpiresAt !== null && refreshExpiresAt <= nowMs) return 'revoked';
  const accessExpiresAt = timestamp(token.accessTokenExpiresAt);
  if (accessExpiresAt === null) return token.hasRefreshToken ? 'refresh_due' : 'expired';
  if (accessExpiresAt <= nowMs) return token.hasRefreshToken ? 'refresh_due' : 'expired';
  if (accessExpiresAt - nowMs <= refreshSkewMs) return token.hasRefreshToken ? 'refresh_due' : 'expired';
  return 'active';
}

export function planProviderSync(
  connection: IntegrationConnectionRecord,
  input: ProviderSyncPlanInput,
  now: string,
): ProviderSyncPlan {
  if (connection.identity.provider !== input.provider) return blocked(connection, input.provider, 'wrong_provider');
  if (connection.state !== 'connected') return blocked(connection, input.provider, 'not_connected');
  if (input.requiredCapabilities.some((capability) => !connection.capabilities.includes(capability))) {
    return blocked(connection, input.provider, 'missing_capability');
  }
  const tokenState = providerTokenState(input.token, now);
  if (tokenState === 'missing' || tokenState === 'expired') {
    return blocked(connection, input.provider, 'token_missing');
  }
  if (tokenState === 'refresh_due') {
    return blocked(connection, input.provider, 'token_refresh_required');
  }
  if (tokenState === 'revoked') {
    return blocked(connection, input.provider, 'token_revoked');
  }
  return {
    connectionId: connection.connectionId,
    scopeId: connection.scopeId,
    provider: input.provider,
    shouldSync: true,
    reason: 'ready',
    cursor: connection.sync?.cursor ?? null,
  };
}

export function classifyProviderFailure(input: ProviderFailureInput): ProviderFailure {
  if (input.malformedResponse) return failure('malformed_response', false, 'error');
  if (input.staleCursor || input.httpStatus === 410) return failure('stale_cursor', false, 'connected');
  if (input.duplicate || input.httpStatus === 409) return failure('duplicate', false, 'connected');
  if (input.httpStatus === 401) return failure('authentication_revoked', false, 'needs_reauth');
  if (input.httpStatus === 403) return failure('permission_lost', false, 'permission_limited');
  if (input.httpStatus === 429) return failure('rate_limited', true, 'connected');
  if (typeof input.httpStatus === 'number' && input.httpStatus >= 500) {
    return failure('provider_unavailable', true, 'error');
  }
  return failure('unknown', false, 'error');
}

export function providerRetryDelayMs(retryAfterSeconds: number | null, attempt: number): number {
  if (typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return Math.min(MAX_RETRY_DELAY_MS, Math.round(retryAfterSeconds * 1000));
  }
  const safeAttempt = Number.isInteger(attempt) && attempt > 0 ? attempt : 1;
  return Math.min(MAX_RETRY_DELAY_MS, 1000 * (2 ** Math.min(safeAttempt - 1, 9)));
}

export function buildProviderDisconnectRequest(
  provider: ContextProviderKind,
  connectionId: string,
  requestedAt: string,
): ProviderDisconnectRequest {
  return {
    provider,
    connectionId,
    revokeProviderCredential: true,
    deleteVaultCredential: true,
    markConnectionState: 'revoked',
    requestedAt,
  };
}

export const PROVIDER_RUNTIME_SECURITY_POLICY = Object.freeze({
  rawCredentialsInConnectionRecord: false,
  rawCredentialsInLogs: false,
  providerPayloadInGenericLogs: false,
  cursorIsOpaque: true,
});

function blocked(
  connection: IntegrationConnectionRecord,
  provider: ContextProviderKind,
  reason: Exclude<ProviderSyncBlockReason, 'ready'>,
): ProviderSyncPlan {
  return {
    connectionId: connection.connectionId,
    scopeId: connection.scopeId,
    provider,
    shouldSync: false,
    reason,
    cursor: null,
  };
}

function failure(
  kind: ProviderFailureKind,
  retryable: boolean,
  connectionState: ProviderFailure['connectionState'],
): ProviderFailure {
  return {
    kind,
    retryable,
    connectionState,
    safeErrorCode: `provider_${kind}`,
  };
}
