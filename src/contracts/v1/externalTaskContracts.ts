/**
 * External task abstraction.
 *
 * Todoist, Microsoft To Do, and Notion all expose task-like records, but the
 * rest of the system should not care which API produced one. This contract
 * records provider identity, stable external ids, sync/link state, content
 * fingerprints for dedupe, and conflict state without becoming a task store.
 */

import { MODULE_CONTRACT_VERSION } from './moduleContracts';
import type { ContextProviderKind, IntegrationProviderIdentity } from './integrationConnectionContracts';

export const EXTERNAL_TASK_CONTRACT_VERSION = MODULE_CONTRACT_VERSION;
export const EXTERNAL_TASK_SCHEMA_VERSION = 'external-task-v1' as const;

export const EXTERNAL_TASK_PROVIDER_KINDS = Object.freeze([
  'todoist',
  'microsoft',
  'notion',
] as const);

export type KnownExternalTaskProviderKind = (typeof EXTERNAL_TASK_PROVIDER_KINDS)[number];
export type ExternalTaskProviderKind = KnownExternalTaskProviderKind | (string & {});

export type ExternalTaskLinkState =
  | 'linked'
  | 'detached'
  | 'ignored'
  | 'candidate';

export type ExternalTaskSyncState =
  | 'never_synced'
  | 'in_sync'
  | 'local_pending'
  | 'remote_pending'
  | 'sync_failed'
  | 'archived_remote';

export type ExternalTaskConflictState =
  | 'none'
  | 'local_changed'
  | 'remote_changed'
  | 'both_changed'
  | 'deleted_remote'
  | 'duplicate_candidate';

export interface ExternalTaskIdentity {
  readonly provider: ExternalTaskProviderKind;
  readonly providerIdentity: IntegrationProviderIdentity;
  readonly connectionId: string;
  readonly externalId: string;
  readonly externalUrl: string | null;
}

export interface ExternalTaskContentFingerprint {
  /** Hash over the normalized provider payload used to detect remote changes. */
  readonly contentHash: string;
  /** Hash over task meaning, used to detect duplicates across providers. */
  readonly dedupeHash: string;
  readonly fingerprintedAt: string;
  readonly dedupeKeys: readonly string[];
}

export interface ExternalTaskConflict {
  readonly state: ExternalTaskConflictState;
  readonly detectedAt: string | null;
  readonly localVersionHash: string | null;
  readonly remoteVersionHash: string | null;
  readonly resolution: 'unresolved' | 'keep_local' | 'keep_remote' | 'merged' | 'ignored';
}

export interface ExternalTaskReference {
  readonly version: typeof EXTERNAL_TASK_CONTRACT_VERSION;
  readonly schemaVersion: typeof EXTERNAL_TASK_SCHEMA_VERSION;
  readonly scopeId: string;
  readonly taskRefId: string;
  readonly identity: ExternalTaskIdentity;
  readonly linkState: ExternalTaskLinkState;
  readonly syncState: ExternalTaskSyncState;
  readonly fingerprint: ExternalTaskContentFingerprint;
  readonly conflict: ExternalTaskConflict;
  readonly linkedCommitmentId: string | null;
  readonly lastSyncedAt: string | null;
  readonly detachedAt: string | null;
  readonly updatedAt: string;
}

export interface ExternalTaskSyncInput {
  readonly scopeId: string;
  readonly identity: ExternalTaskIdentity;
  readonly fingerprint: ExternalTaskContentFingerprint;
  readonly linkState: ExternalTaskLinkState;
  readonly syncState: ExternalTaskSyncState;
  readonly conflict?: ExternalTaskConflict;
  readonly linkedCommitmentId?: string | null;
  readonly lastSyncedAt?: string | null;
  readonly detachedAt?: string | null;
}

export const EXTERNAL_TASK_BOUNDARY_POLICY = Object.freeze({
  providerSpecificTaskFieldsAllowed: false,
  persistenceImplementationOwnedHere: false,
  conflictStateRequired: true,
});

export function isKnownExternalTaskProviderKind(
  provider: ContextProviderKind,
): provider is KnownExternalTaskProviderKind {
  return (EXTERNAL_TASK_PROVIDER_KINDS as readonly string[]).includes(provider);
}
