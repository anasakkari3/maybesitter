import { createHash } from 'node:crypto';
import {
  EXTERNAL_TASK_CONTRACT_VERSION,
  EXTERNAL_TASK_SCHEMA_VERSION,
  type ExternalTaskConflict,
  type ExternalTaskLinkState,
  type ExternalTaskProviderKind,
  type ExternalTaskReference,
  type ExternalTaskSyncState,
  type KnownExternalTaskProviderKind,
} from '../../../src/contracts/v1/externalTaskContracts';
import type { IntegrationProviderIdentity } from '../../../src/contracts/v1/integrationConnectionContracts';

export interface ExternalTaskProviderPayload {
  readonly provider: KnownExternalTaskProviderKind;
  readonly scopeId: string;
  readonly connectionId: string;
  readonly providerIdentity: IntegrationProviderIdentity;
  readonly externalId: string;
  readonly externalUrl?: string | null;
  readonly title: string;
  readonly notes?: string | null;
  readonly dueAt?: string | null;
  readonly completed?: boolean | null;
  readonly updatedAt: string;
  readonly linkedCommitmentId?: string | null;
  readonly lastSyncedAt?: string | null;
  readonly detachedAt?: string | null;
  readonly linkState?: ExternalTaskLinkState;
  readonly syncState?: ExternalTaskSyncState;
  readonly conflict?: ExternalTaskConflict;
}

export type TodoistTaskPayload = Omit<ExternalTaskProviderPayload, 'provider'>;
export type MicrosoftTaskPayload = Omit<ExternalTaskProviderPayload, 'provider'>;
export type NotionTaskPayload = Omit<ExternalTaskProviderPayload, 'provider'>;

const DEFAULT_CONFLICT: ExternalTaskConflict = Object.freeze({
  state: 'none',
  detectedAt: null,
  localVersionHash: null,
  remoteVersionHash: null,
  resolution: 'unresolved',
});

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

function compactText(value: string): string {
  return value.trim().toLocaleLowerCase('en-US').replace(/\s+/g, ' ');
}

function dueDay(dueAt: string | null | undefined): string | null {
  if (!dueAt) return null;
  const match = /^\d{4}-\d{2}-\d{2}/.exec(dueAt);
  return match?.[0] ?? null;
}

function dedupeKeys(payload: ExternalTaskProviderPayload): readonly string[] {
  return [
    `title:${compactText(payload.title)}`,
    ...(dueDay(payload.dueAt) ? [`due:${dueDay(payload.dueAt)}`] : []),
  ];
}

function taskRefId(provider: ExternalTaskProviderKind, externalId: string): string {
  return `${provider}:${externalId}`;
}

export function normalizeExternalTaskReference(payload: ExternalTaskProviderPayload): ExternalTaskReference {
  const keys = dedupeKeys(payload);
  const contentShape = {
    provider: payload.provider,
    externalId: payload.externalId,
    title: compactText(payload.title),
    notes: payload.notes?.trim() ?? null,
    dueAt: payload.dueAt ?? null,
    completed: payload.completed ?? null,
    updatedAt: payload.updatedAt,
  };

  return {
    version: EXTERNAL_TASK_CONTRACT_VERSION,
    schemaVersion: EXTERNAL_TASK_SCHEMA_VERSION,
    scopeId: payload.scopeId,
    taskRefId: taskRefId(payload.provider, payload.externalId),
    identity: {
      provider: payload.provider,
      providerIdentity: payload.providerIdentity,
      connectionId: payload.connectionId,
      externalId: payload.externalId,
      externalUrl: payload.externalUrl ?? null,
    },
    linkState: payload.linkState ?? 'candidate',
    syncState: payload.syncState ?? 'remote_pending',
    fingerprint: {
      contentHash: sha256(contentShape),
      dedupeHash: sha256(keys),
      fingerprintedAt: payload.updatedAt,
      dedupeKeys: keys,
    },
    conflict: payload.conflict ?? DEFAULT_CONFLICT,
    linkedCommitmentId: payload.linkedCommitmentId ?? null,
    lastSyncedAt: payload.lastSyncedAt ?? null,
    detachedAt: payload.detachedAt ?? null,
    updatedAt: payload.updatedAt,
  };
}

export function normalizeTodoistTask(payload: TodoistTaskPayload): ExternalTaskReference {
  return normalizeExternalTaskReference({ ...payload, provider: 'todoist' });
}

export function normalizeMicrosoftTask(payload: MicrosoftTaskPayload): ExternalTaskReference {
  return normalizeExternalTaskReference({ ...payload, provider: 'microsoft' });
}

export function normalizeNotionTask(payload: NotionTaskPayload): ExternalTaskReference {
  return normalizeExternalTaskReference({ ...payload, provider: 'notion' });
}
