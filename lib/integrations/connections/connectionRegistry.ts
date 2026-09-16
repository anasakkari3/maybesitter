import { createHash } from 'node:crypto';
import {
  INTEGRATION_CONNECTION_CONTRACT_VERSION,
  INTEGRATION_CONNECTION_SCHEMA_VERSION,
  type IntegrationConnectionQuery,
  type IntegrationConnectionRecord,
  type IntegrationConnectionState,
  type IntegrationConnectionStore,
  type IntegrationSyncCheckpoint,
  type UpsertIntegrationConnectionInput,
} from '../../../src/contracts/v1/integrationConnectionContracts';

function connectionIdFor(input: UpsertIntegrationConnectionInput): string {
  const identity = [
    input.scopeId,
    input.identity.provider,
    input.identity.providerAccountId ?? '',
    input.identity.providerSpaceId ?? '',
  ].join('\u0000');
  return `int_${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`;
}

function uniqueSorted<T extends string>(values: readonly T[]): readonly T[] {
  return Object.freeze(Array.from(new Set(values)).sort());
}

function freezeRecord(record: IntegrationConnectionRecord): IntegrationConnectionRecord {
  Object.freeze(record.identity);
  Object.freeze(record.capabilities);
  Object.freeze(record.grantedScopes);
  if (record.credentialRef) Object.freeze(record.credentialRef);
  if (record.sync) Object.freeze(record.sync);
  if (record.provenance) Object.freeze(record.provenance);
  return Object.freeze(record);
}

function requiresReauth(state: IntegrationConnectionState): boolean {
  return state === 'needs_reauth' || state === 'permission_limited';
}

function buildRecord(
  input: UpsertIntegrationConnectionInput,
  now: string,
  existing?: IntegrationConnectionRecord,
): IntegrationConnectionRecord {
  return freezeRecord({
    version: INTEGRATION_CONNECTION_CONTRACT_VERSION,
    schemaVersion: INTEGRATION_CONNECTION_SCHEMA_VERSION,
    connectionId: existing?.connectionId ?? connectionIdFor(input),
    scopeId: input.scopeId,
    identity: Object.freeze({ ...input.identity }),
    state: input.state,
    reauthRequired: requiresReauth(input.state),
    capabilities: uniqueSorted(input.capabilities),
    grantedScopes: uniqueSorted(input.grantedScopes ?? existing?.grantedScopes ?? []),
    connectedAt: input.connectedAt ?? existing?.connectedAt ?? (input.state === 'connected' ? now : null),
    lastSyncedAt: input.lastSyncedAt ?? existing?.lastSyncedAt ?? null,
    expiresAt: input.expiresAt ?? existing?.expiresAt ?? null,
    revokedAt: input.revokedAt ?? existing?.revokedAt ?? null,
    credentialRef: input.credentialRef ?? existing?.credentialRef ?? null,
    sync: input.sync ?? existing?.sync ?? { cursor: null, checkpointAt: null },
    featureFlag: input.featureFlag ?? existing?.featureFlag ?? null,
    provenance: input.provenance ?? existing?.provenance ?? null,
    updatedAt: now,
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
  });
}

/** Test/local implementation of the canonical storage abstraction. */
export class MemoryIntegrationConnectionStore implements IntegrationConnectionStore {
  private readonly records = new Map<string, IntegrationConnectionRecord>();

  async upsert(input: UpsertIntegrationConnectionInput, now: string): Promise<IntegrationConnectionRecord> {
    const id = connectionIdFor(input);
    const record = buildRecord(input, now, this.records.get(id));
    this.records.set(id, record);
    return record;
  }

  async get(connectionId: string): Promise<IntegrationConnectionRecord | null> {
    return this.records.get(connectionId) ?? null;
  }

  async list(query: IntegrationConnectionQuery): Promise<readonly IntegrationConnectionRecord[]> {
    return Array.from(this.records.values())
      .filter((record) => record.scopeId === query.scopeId)
      .filter((record) => query.provider === undefined || record.identity.provider === query.provider)
      .filter((record) => query.state === undefined || record.state === query.state)
      .filter((record) => query.capability === undefined || record.capabilities.includes(query.capability))
      .sort((left, right) => left.connectionId.localeCompare(right.connectionId));
  }

  async markState(
    connectionId: string,
    state: IntegrationConnectionState,
    now: string,
    errorCode?: string,
  ): Promise<IntegrationConnectionRecord | null> {
    const existing = this.records.get(connectionId);
    if (!existing) return null;
    const record = freezeRecord({
      ...existing,
      state,
      reauthRequired: requiresReauth(state),
      revokedAt: state === 'revoked' ? now : existing.revokedAt,
      updatedAt: now,
      ...(errorCode ? { errorCode } : {}),
    });
    this.records.set(connectionId, record);
    return record;
  }

  async deleteById(connectionId: string): Promise<boolean> {
    return this.records.delete(connectionId);
  }

  async deleteScope(scopeId: string): Promise<number> {
    let deleted = 0;
    for (const [id, record] of Array.from(this.records.entries())) {
      if (record.scopeId !== scopeId) continue;
      this.records.delete(id);
      deleted += 1;
    }
    return deleted;
  }
}

export async function recordConnectionSync(
  store: IntegrationConnectionStore,
  connectionId: string,
  checkpoint: IntegrationSyncCheckpoint,
  now: string,
): Promise<IntegrationConnectionRecord | null> {
  const current = await store.get(connectionId);
  if (!current || current.state !== 'connected') return null;
  return store.upsert({
    scopeId: current.scopeId,
    identity: current.identity,
    state: current.state,
    capabilities: current.capabilities,
    grantedScopes: current.grantedScopes,
    connectedAt: current.connectedAt,
    lastSyncedAt: now,
    expiresAt: current.expiresAt,
    revokedAt: current.revokedAt,
    credentialRef: current.credentialRef,
    sync: checkpoint,
    featureFlag: current.featureFlag,
    provenance: current.provenance,
  }, now);
}
