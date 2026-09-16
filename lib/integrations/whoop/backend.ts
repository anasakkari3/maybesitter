import type {
  IntegrationCapability,
  IntegrationConnectionRecord,
  IntegrationProviderIdentity,
  UpsertIntegrationConnectionInput,
} from '../../../src/contracts/v1/integrationConnectionContracts';
import type { ReadinessSnapshot, ReadinessSourceKind } from '../../../src/contracts/v1/readinessContracts';

export const WHOOP_PROVIDER = 'whoop' as const;

export const WHOOP_READINESS_CAPABILITIES = Object.freeze([
  'readiness_read',
] satisfies readonly IntegrationCapability[]);

export const WHOOP_OAUTH_SCOPES = Object.freeze([
  'read:profile',
  'read:recovery',
  'read:sleep',
  'read:cycles',
] as const);

export type WhoopOAuthScope = (typeof WHOOP_OAUTH_SCOPES)[number];

export type WhoopTokenLifecycleState =
  | 'missing'
  | 'active'
  | 'refresh_due'
  | 'expired'
  | 'revoked';

export interface WhoopTokenSetMetadata {
  readonly accessTokenExpiresAt: string | null;
  readonly refreshTokenExpiresAt: string | null;
  readonly grantedScopes: readonly WhoopOAuthScope[];
  readonly hasRefreshToken: boolean;
}

export interface WhoopProviderProfile {
  readonly whoopUserId: string;
  readonly displayName: string | null;
}

export interface WhoopReadinessSyncCursor {
  readonly connectionId: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly lastSyncedAt: string | null;
}

export interface WhoopReadinessSyncPlan {
  readonly provider: typeof WHOOP_PROVIDER;
  readonly connectionId: string;
  readonly scopeId: string;
  readonly shouldSync: boolean;
  readonly reason:
    | 'ready'
    | 'wrong_provider'
    | 'not_connected'
    | 'missing_readiness_capability'
    | 'token_inactive';
  readonly cursor: WhoopReadinessSyncCursor | null;
}

export interface WhoopDisconnectRequest {
  readonly provider: typeof WHOOP_PROVIDER;
  readonly connectionId: string;
  readonly revokeProviderToken: true;
  readonly markConnectionState: 'revoked';
  readonly requestedAt: string;
}

export interface WhoopReadinessProvenance {
  readonly provider: typeof WHOOP_PROVIDER;
  readonly connectionId: string | null;
  readonly sourcePrecedence: readonly ReadinessSourceKind[];
  readonly duplicatePolicy: 'prefer_connected_whoop_recovery_then_native_sleep';
}

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function buildWhoopProviderIdentity(profile: WhoopProviderProfile): IntegrationProviderIdentity {
  return {
    provider: WHOOP_PROVIDER,
    providerAccountId: profile.whoopUserId,
    providerSpaceId: null,
    displayName: profile.displayName,
  };
}

export function buildWhoopConnectionInput(
  scopeId: string,
  profile: WhoopProviderProfile,
  token: WhoopTokenSetMetadata,
  now: string,
): UpsertIntegrationConnectionInput {
  return {
    scopeId,
    identity: buildWhoopProviderIdentity(profile),
    state: tokenState(token, now) === 'active' ? 'connected' : 'needs_reauth',
    capabilities: WHOOP_READINESS_CAPABILITIES,
    grantedScopes: token.grantedScopes,
    expiresAt: token.accessTokenExpiresAt,
  };
}

export function tokenState(token: WhoopTokenSetMetadata | null, now: string): WhoopTokenLifecycleState {
  if (!token) return 'missing';
  if (!token.hasRefreshToken) return 'revoked';

  const nowMs = parseTime(now);
  const accessExpiresMs = parseTime(token.accessTokenExpiresAt);
  const refreshExpiresMs = parseTime(token.refreshTokenExpiresAt);
  if (nowMs === null) return 'missing';
  if (refreshExpiresMs !== null && refreshExpiresMs <= nowMs) return 'revoked';
  if (accessExpiresMs === null) return 'refresh_due';
  if (accessExpiresMs <= nowMs) return 'expired';
  if (accessExpiresMs - nowMs <= 10 * 60_000) return 'refresh_due';
  return 'active';
}

export function planWhoopReadinessSync(
  connection: IntegrationConnectionRecord,
  token: WhoopTokenSetMetadata | null,
  windowStart: string,
  windowEnd: string,
  now: string,
): WhoopReadinessSyncPlan {
  if (connection.identity.provider !== WHOOP_PROVIDER) {
    return blockedPlan(connection, 'wrong_provider');
  }
  if (connection.state !== 'connected') {
    return blockedPlan(connection, 'not_connected');
  }
  if (!connection.capabilities.includes('readiness_read')) {
    return blockedPlan(connection, 'missing_readiness_capability');
  }
  if (tokenState(token, now) !== 'active') {
    return blockedPlan(connection, 'token_inactive');
  }

  return {
    provider: WHOOP_PROVIDER,
    connectionId: connection.connectionId,
    scopeId: connection.scopeId,
    shouldSync: true,
    reason: 'ready',
    cursor: {
      connectionId: connection.connectionId,
      windowStart,
      windowEnd,
      lastSyncedAt: connection.lastSyncedAt,
    },
  };
}

export function buildWhoopDisconnectRequest(connectionId: string, requestedAt: string): WhoopDisconnectRequest {
  return {
    provider: WHOOP_PROVIDER,
    connectionId,
    revokeProviderToken: true,
    markConnectionState: 'revoked',
    requestedAt,
  };
}

export function withWhoopReadinessProvenance(
  snapshot: ReadinessSnapshot,
  connectionId: string | null,
): ReadinessSnapshot & { readonly provenance: WhoopReadinessProvenance } {
  return {
    ...snapshot,
    provenance: {
      provider: WHOOP_PROVIDER,
      connectionId,
      sourcePrecedence: ['subjective', 'whoop', 'healthkit', 'health_connect'],
      duplicatePolicy: 'prefer_connected_whoop_recovery_then_native_sleep',
    },
  };
}

function blockedPlan(
  connection: IntegrationConnectionRecord,
  reason: WhoopReadinessSyncPlan['reason'],
): WhoopReadinessSyncPlan {
  return {
    provider: WHOOP_PROVIDER,
    connectionId: connection.connectionId,
    scopeId: connection.scopeId,
    shouldSync: false,
    reason,
    cursor: null,
  };
}
