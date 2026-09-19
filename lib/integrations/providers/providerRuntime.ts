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
  | 'transport_failure'
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
  /** The request never completed: a timeout, a refused or reset socket, DNS. */
  readonly transportFailure?: boolean;
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

/**
 * Error codes that mean the request never completed. Node's own socket and DNS
 * errors, and undici's — which is what `fetch` throws under the hood.
 */
const TRANSPORT_FAILURE_CODES: ReadonlySet<string> = new Set([
  'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE',
  'EHOSTUNREACH', 'EHOSTDOWN', 'ENETUNREACH', 'ENETDOWN', 'ENETRESET',
  'ENOTFOUND', 'EAI_AGAIN', 'EPROTO', 'ECANCELED',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET', 'UND_ERR_CLOSED', 'UND_ERR_DESTROYED', 'UND_ERR_ABORTED',
]);

/** Error names that mean the same thing without carrying a code. */
const TRANSPORT_FAILURE_NAMES: ReadonlySet<string> = new Set([
  'AbortError', 'TimeoutError', 'ConnectTimeoutError', 'HeadersTimeoutError',
  'BodyTimeoutError', 'SocketError',
]);

/**
 * Whether a thrown value means the call never completed.
 *
 * Deliberately narrow. Anything unrecognised is left to classify as `unknown`
 * rather than being assumed retryable, because a bug in our own code is not a
 * network blip and must not be retried forever. Only the shape of the error is
 * read — never its message — so nothing here can carry a URL, a host, a
 * request body or a token into a classification.
 */
export function isProviderTransportFailure(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== 'object' || error === null) return false;
  const candidate = error as { name?: unknown; code?: unknown; cause?: unknown };
  if (typeof candidate.code === 'string') {
    // `SafeFetchError` uses the same field for its own fixed reason codes.
    if (candidate.code === 'timeout' || candidate.code === 'network') return true;
    if (TRANSPORT_FAILURE_CODES.has(candidate.code)) return true;
  }
  if (typeof candidate.name === 'string' && TRANSPORT_FAILURE_NAMES.has(candidate.name)) return true;
  // `fetch` reports a bare `TypeError: fetch failed` and nests the real reason.
  return isProviderTransportFailure(candidate.cause, depth + 1);
}

export function classifyProviderFailure(input: ProviderFailureInput): ProviderFailure {
  // A payload we received and could not parse is stronger evidence than the
  // absence of one, so it is checked first and is never softened into a retry.
  if (input.malformedResponse) return failure('malformed_response', false, 'error');
  // Nothing about a call that did not complete says the grant is bad or that
  // the user must act, so the connection stays `connected` — the same
  // reasoning that keeps a rate-limited connection usable below.
  if (input.transportFailure) return failure('transport_failure', true, 'connected');
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
