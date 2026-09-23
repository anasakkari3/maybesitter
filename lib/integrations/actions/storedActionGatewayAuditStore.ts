/**
 * Durable, account-scoped action-gateway audit storage.
 *
 * Each append atomically writes an immutable phase event and advances a
 * deterministic current pointer for the idempotency key. `latest` is therefore
 * one document read, while the phase history remains available for audit. The
 * gateway contract contains no provider payload or result body, and this store
 * adds none.
 */
import type {
  ActionGatewayAuditRecord,
  ActionGatewayAuditStore,
} from './actionGateway';
import {
  ACTION_GATEWAY_AUDIT_EVENTS,
  docIdForKey,
  userSubDoc,
} from '../../storage/paths';
import type { StorageAdapter } from '../../storage/storageAdapter';

type StoredGatewayAuditRecord = ActionGatewayAuditRecord & {
  readonly recordKind: 'current' | 'event';
};

function withoutKind(record: StoredGatewayAuditRecord): ActionGatewayAuditRecord {
  const { recordKind: _recordKind, ...audit } = record;
  return audit;
}

export class StoredActionGatewayAuditStore implements ActionGatewayAuditStore {
  constructor(
    private readonly uid: string,
    private readonly storage: StorageAdapter,
  ) {}

  private requireScope(scopeId: string): void {
    if (scopeId !== this.uid) throw new Error('action gateway audit scope does not match the account');
  }

  private currentPath(idempotencyKey: string): string {
    return userSubDoc(
      this.uid,
      ACTION_GATEWAY_AUDIT_EVENTS,
      docIdForKey(`action-gateway-current:${idempotencyKey}`),
    );
  }

  private eventPath(record: ActionGatewayAuditRecord): string {
    return userSubDoc(
      this.uid,
      ACTION_GATEWAY_AUDIT_EVENTS,
      docIdForKey([
        'action-gateway-event',
        record.idempotencyKey,
        record.requestId,
        record.phase,
      ].join('\u0000')),
    );
  }

  async latest(idempotencyKey: string): Promise<ActionGatewayAuditRecord | null> {
    const record = await this.storage.get<StoredGatewayAuditRecord>(this.currentPath(idempotencyKey));
    if (!record) return null;
    this.requireScope(record.scopeId);
    return withoutKind(record);
  }

  async append(record: ActionGatewayAuditRecord): Promise<void> {
    this.requireScope(record.scopeId);
    const eventPath = this.eventPath(record);
    const currentPath = this.currentPath(record.idempotencyKey);

    await this.storage.runTransaction(async (tx) => {
      tx.set<StoredGatewayAuditRecord>(eventPath, { ...record, recordKind: 'event' });
      tx.set<StoredGatewayAuditRecord>(currentPath, { ...record, recordKind: 'current' });
    });
  }
}
