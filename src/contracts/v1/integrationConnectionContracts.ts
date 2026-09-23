/**
 * Provider-independent context integration contracts.
 *
 * This file describes the boundary between MaybeSitter and external context
 * sources. It deliberately stops at identity, consent, connection state, and
 * storage verbs. Provider adapters may know OAuth details, APIs, and webhooks;
 * consumers inside the product see only this normalized connection shape.
 */

import { MODULE_CONTRACT_VERSION } from './moduleContracts';

export const INTEGRATION_CONNECTION_CONTRACT_VERSION = MODULE_CONTRACT_VERSION;
export const INTEGRATION_CONNECTION_SCHEMA_VERSION = 'integration-connection-v1' as const;

export const CONTEXT_PROVIDER_KINDS = Object.freeze([
  'google',
  'microsoft',
  'whoop',
  'rescuetime',
  'todoist',
  'notion',
  'meeting',
  'mcp',
  /**
   * A financial data source backed by fixtures, not a bank (#financial-v1).
   *
   * Listed as its own provider rather than borrowed from a real aggregator's
   * name, because a connection record is what the Trust Center shows and what
   * "Disconnect" acts on, and a row that says `plaid` when nothing has ever
   * spoken to Plaid is a lie in the one place a user goes to check.
   */
  'financial_sandbox',
] as const);

export type KnownContextProviderKind = (typeof CONTEXT_PROVIDER_KINDS)[number];

/**
 * Unknown providers remain representable so storage, audit, and UI boundaries
 * do not have to change when a new provider ships. Callers that need a closed
 * provider set should use `KnownContextProviderKind` instead.
 */
export type ContextProviderKind = KnownContextProviderKind | (string & {});

export type IntegrationConnectionState =
  | 'not_connected'
  | 'connecting'
  | 'connected'
  | 'needs_reauth'
  | 'permission_limited'
  | 'paused'
  | 'revoked'
  | 'error';

export type IntegrationCapability =
  | 'calendar_busy'
  | 'calendar_free'
  | 'mail_read'
  | 'mail_draft'
  | 'mail_send'
  | 'task_read'
  | 'task_write'
  | 'note_read'
  | 'note_write'
  | 'readiness_read'
  | 'focus_session_read'
  | 'meeting_read'
  | 'memory_context_read'
  | 'mcp_tool_context'
  /**
   * Read balances, transactions and detected recurring payments.
   *
   * There is deliberately no `financial_write` or `financial_payment` beside
   * it. A capability that does not exist cannot be granted by a bug, requested
   * by a mis-typed scope list, or found by somebody reading this union for
   * something to use.
   */
  | 'financial_read';

export interface IntegrationCredentialReference {
  /** Logical secure-store implementation; never a token or secret value. */
  readonly vault: string;
  /** Opaque key name inside the secure store. */
  readonly keyId: string;
  readonly version: string | null;
}

export interface IntegrationSyncCheckpoint {
  /** Opaque provider cursor. Consumers must not parse provider cursor formats. */
  readonly cursor: string | null;
  readonly checkpointAt: string | null;
}

export interface IntegrationConnectionProvenance {
  readonly source: 'oauth' | 'native' | 'api_key' | 'mcp' | 'manual';
  readonly connectedBy: 'user' | 'system_migration';
  readonly recordedAt: string;
}

export interface IntegrationProviderIdentity {
  readonly provider: ContextProviderKind;
  /** Provider-owned account/user id, when one exists. Never a MaybeSitter uid. */
  readonly providerAccountId: string | null;
  /** Workspace, tenant, team, vault, or server identifier, when relevant. */
  readonly providerSpaceId: string | null;
  /** User-facing label safe for account pickers. */
  readonly displayName: string | null;
}

export interface IntegrationConnectionRecord {
  readonly version: typeof INTEGRATION_CONNECTION_CONTRACT_VERSION;
  readonly schemaVersion: typeof INTEGRATION_CONNECTION_SCHEMA_VERSION;
  readonly connectionId: string;
  readonly scopeId: string;
  readonly identity: IntegrationProviderIdentity;
  readonly state: IntegrationConnectionState;
  readonly reauthRequired?: boolean;
  readonly capabilities: readonly IntegrationCapability[];
  /** Provider permission names as granted, stored for audit rather than planning. */
  readonly grantedScopes: readonly string[];
  readonly connectedAt: string | null;
  readonly lastSyncedAt: string | null;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  /** Reference only. Provider credentials never belong in this record. */
  readonly credentialRef?: IntegrationCredentialReference | null;
  readonly sync?: IntegrationSyncCheckpoint;
  readonly featureFlag?: string | null;
  readonly provenance?: IntegrationConnectionProvenance | null;
  readonly updatedAt: string;
  readonly errorCode?: string;
}

export interface IntegrationConnectionQuery {
  readonly scopeId: string;
  readonly provider?: ContextProviderKind;
  readonly state?: IntegrationConnectionState;
  readonly capability?: IntegrationCapability;
}

export interface UpsertIntegrationConnectionInput {
  readonly scopeId: string;
  readonly identity: IntegrationProviderIdentity;
  readonly state: IntegrationConnectionState;
  readonly capabilities: readonly IntegrationCapability[];
  readonly grantedScopes?: readonly string[];
  readonly connectedAt?: string | null;
  readonly lastSyncedAt?: string | null;
  readonly expiresAt?: string | null;
  readonly revokedAt?: string | null;
  readonly credentialRef?: IntegrationCredentialReference | null;
  readonly sync?: IntegrationSyncCheckpoint;
  readonly featureFlag?: string | null;
  readonly provenance?: IntegrationConnectionProvenance | null;
  readonly errorCode?: string;
}

/**
 * Storage abstraction only. The contract does not pick Firestore, files, a
 * mobile store, or an OAuth token layout, and it never exposes provider secrets.
 */
export interface IntegrationConnectionStore {
  upsert(input: UpsertIntegrationConnectionInput, now: string): Promise<IntegrationConnectionRecord>;
  get(connectionId: string): Promise<IntegrationConnectionRecord | null>;
  list(query: IntegrationConnectionQuery): Promise<readonly IntegrationConnectionRecord[]>;
  markState(
    connectionId: string,
    state: IntegrationConnectionState,
    now: string,
    errorCode?: string,
  ): Promise<IntegrationConnectionRecord | null>;
  deleteById(connectionId: string): Promise<boolean>;
  deleteScope(scopeId: string): Promise<number>;
}

export function isKnownContextProviderKind(
  provider: ContextProviderKind,
): provider is KnownContextProviderKind {
  return (CONTEXT_PROVIDER_KINDS as readonly string[]).includes(provider);
}
