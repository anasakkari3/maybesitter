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
import { PROVIDER_CONNECTIONS, docIdForKey, userCol, userDoc, userSubDoc } from '../../../storage/paths';
import type { StorageAdapter } from '../../../storage/storageAdapter';
import { AccountUnavailableError, requireLiveAccount } from '../../../account/accountLiveness';

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
      // The account deletion fence (#772): a connection completed after the
      // account was deleted is refused before it is stored. `markState` is
      // fenced the same way; account deletion's own Google revocation hook,
      // which runs after `markDeleted`, has its own narrower method
      // (`markRevokedForAccountDeletion`).
      await requireLiveAccount(tx, this.uid);
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

  /**
   * Behind the account deletion fence (#772, Q772C-004). A refresh, a resource
   * call or a disconnect that began before the deletion reaches this after
   * `markDeleted`: unfenced, it would overwrite the deletion hook's `revoked`
   * with `error` or `needs_reauth`. Refused (`AccountUnavailableError`) unless
   * the account is live, in the transaction that writes.
   */
  async markState(
    connectionId: string,
    state: IntegrationConnectionState,
    now: string,
    errorCode?: string,
  ): Promise<IntegrationConnectionRecord | null> {
    const path = this.path(connectionId);
    return this.storage.runTransaction(async (tx) => {
      await requireLiveAccount(tx, this.uid);
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

  /**
   * The one connection write account deletion makes (#772, Q772C-004): the
   * Google revocation hook marks the record `revoked` after `markDeleted` and
   * before the sweep. Only that: the root must be there and marked deleted
   * (`trust.deletedAt` set) — a live account disconnects through `markState`
   * — and the record must still exist, so nothing is re-created after the
   * sweep. The transition is monotonic: a record already `revoked` is left as
   * it is, its first `revokedAt` the auditable one. Null when there is no
   * record; `AccountUnavailableError` when the root is not marked deleted.
   */
  async markRevokedForAccountDeletion(
    connectionId: string,
    now: string,
  ): Promise<IntegrationConnectionRecord | null> {
    const path = this.path(connectionId);
    return this.storage.runTransaction(async (tx) => {
      const user = await tx.get<{ trust?: { deletedAt?: unknown } }>(userDoc(this.uid));
      const deletedAt = user?.trust?.deletedAt;
      if (typeof deletedAt !== 'string' || deletedAt === '') throw new AccountUnavailableError();
      const existing = await tx.get<IntegrationConnectionRecord>(path);
      if (!existing) return null;
      if (existing.state === 'revoked') return existing;
      const next: IntegrationConnectionRecord = {
        ...existing,
        state: 'revoked',
        revokedAt: existing.revokedAt ?? now,
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
