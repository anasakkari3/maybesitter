/**
 * The production `IntegrationConnectionStore` (UC-3.3, #187).
 *
 * The canonical connection contract already exists and is provider-neutral.
 * This persists it and nothing more: no provider-specific table, no second
 * registry, no token. `IntegrationConnectionRecord` is documented as never
 * exposing provider secrets, and the only credential-shaped thing it holds is
 * `credentialRef`, a pointer into the vault.
 *
 * ── One connection per account per provider ──────────────────────
 *
 * The connection id is derived from the provider, not generated, so
 * reconnecting Google updates the existing record instead of leaving a second
 * one behind. An orphaned duplicate would be a connection nothing lists and
 * therefore nothing revokes, which is the worst shape for a grant to be in.
 *
 * ── Scope is the account ─────────────────────────────────────────
 *
 * Every document lives under `userSubDoc(uid, …)`, and every method refuses a
 * `scopeId` that is not this store's account. Listing cannot return another
 * account's connection because it reads one account's collection.
 */
import {
  INTEGRATION_CONNECTION_CONTRACT_VERSION,
  INTEGRATION_CONNECTION_SCHEMA_VERSION,
  type IntegrationConnectionQuery,
  type IntegrationConnectionRecord,
  type IntegrationConnectionState,
  type IntegrationConnectionStore,
  type UpsertIntegrationConnectionInput,
  type ContextProviderKind,
} from '../../../../src/contracts/v1/integrationConnectionContracts';
import { PROVIDER_CONNECTIONS, docIdForKey, userCol, userSubDoc } from '../../../storage/paths';
import type { StorageAdapter } from '../../../storage/storageAdapter';

/** Deterministic, so reconnecting replaces rather than duplicates. */
export function connectionIdFor(provider: ContextProviderKind): string {
  return docIdForKey(`provider-connection:${provider}`);
}

export class StoredIntegrationConnectionStore implements IntegrationConnectionStore {
  constructor(
    private readonly uid: string,
    private readonly storage: StorageAdapter,
  ) {}

  private path(connectionId: string): string {
    return userSubDoc(this.uid, PROVIDER_CONNECTIONS, connectionId);
  }

  private requireScope(scopeId: string): void {
    if (scopeId !== this.uid) throw new Error('connection scope does not match the account');
  }

  async upsert(
    input: UpsertIntegrationConnectionInput,
    now: string,
  ): Promise<IntegrationConnectionRecord> {
    this.requireScope(input.scopeId);
    const connectionId = connectionIdFor(input.identity.provider);
    const path = this.path(connectionId);
    return this.storage.runTransaction(async (tx) => {
      const existing = await tx.get<IntegrationConnectionRecord>(path);
      const record: IntegrationConnectionRecord = {
        version: INTEGRATION_CONNECTION_CONTRACT_VERSION,
        schemaVersion: INTEGRATION_CONNECTION_SCHEMA_VERSION,
        connectionId,
        scopeId: input.scopeId,
        identity: input.identity,
        state: input.state,
        capabilities: input.capabilities,
        grantedScopes: input.grantedScopes ?? [],
        // A reconnect keeps the original connection date; the grant is the
        // same relationship, re-authorized.
        connectedAt: input.connectedAt ?? existing?.connectedAt ?? null,
        lastSyncedAt: input.lastSyncedAt ?? existing?.lastSyncedAt ?? null,
        expiresAt: input.expiresAt ?? null,
        revokedAt: input.revokedAt ?? null,
        credentialRef: input.credentialRef ?? null,
        sync: input.sync ?? existing?.sync ?? { cursor: null, checkpointAt: null },
        featureFlag: input.featureFlag ?? existing?.featureFlag ?? null,
        provenance: input.provenance ?? existing?.provenance ?? null,
        ...(input.errorCode ? { errorCode: input.errorCode } : {}),
        updatedAt: now,
      } as IntegrationConnectionRecord;
      tx.set(path, record);
      return record;
    });
  }

  async get(connectionId: string): Promise<IntegrationConnectionRecord | null> {
    return (await this.storage.get<IntegrationConnectionRecord>(this.path(connectionId))) ?? null;
  }

  async list(query: IntegrationConnectionQuery): Promise<readonly IntegrationConnectionRecord[]> {
    this.requireScope(query.scopeId);
    const stored = await this.storage.list<IntegrationConnectionRecord>(
      userCol(this.uid, PROVIDER_CONNECTIONS),
    );
    return stored.map((entry) => entry.data).filter((record) => {
      if (query.provider && record.identity.provider !== query.provider) return false;
      if (query.state && record.state !== query.state) return false;
      if (query.capability && !record.capabilities.includes(query.capability)) return false;
      return true;
    });
  }

  async markState(
    connectionId: string,
    state: IntegrationConnectionState,
    now: string,
    errorCode?: string,
  ): Promise<IntegrationConnectionRecord | null> {
    const path = this.path(connectionId);
    return this.storage.runTransaction(async (tx) => {
      const existing = await tx.get<IntegrationConnectionRecord>(path);
      if (!existing) return null;
      const next: IntegrationConnectionRecord = {
        ...existing,
        state,
        // A revoked connection records when, so "revoked" is a fact with a
        // time rather than only a label.
        revokedAt: state === 'revoked' ? (existing.revokedAt ?? now) : existing.revokedAt,
        ...(errorCode ? { errorCode } : {}),
        updatedAt: now,
      } as IntegrationConnectionRecord;
      tx.set(path, next);
      return next;
    });
  }

  async deleteById(connectionId: string): Promise<boolean> {
    const path = this.path(connectionId);
    return this.storage.runTransaction(async (tx) => {
      const existing = await tx.get<IntegrationConnectionRecord>(path);
      if (!existing) return false;
      tx.delete(path);
      return true;
    });
  }

  async deleteScope(scopeId: string): Promise<number> {
    this.requireScope(scopeId);
    return this.storage.deleteTree(userCol(this.uid, PROVIDER_CONNECTIONS));
  }
}
