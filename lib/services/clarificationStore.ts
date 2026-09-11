/**
 * Pending clarifications, on durable storage (UC-1.0c, #142).
 *
 * ── What this replaced ───────────────────────────────────────────
 *
 * One `clarifications.json` holding every pending question, rewritten whole on
 * each create. On Cloud Run that file is per-instance: the user answered "9am"
 * and the instance that received the answer had never heard the question, so
 * the reply came back as "that clarification expired" and their sentence was
 * dropped. It is the most visible per-instance bug in the whole audit, because
 * the user sees it happen mid-conversation.
 *
 * Clarifications now live at `users/{uid}/clarifications/{id}`.
 *
 * ── Two expiries, and they are not the same thing ────────────────
 *
 * `record.expiresAt` is the *business* expiry — ten minutes by default, after
 * which answering is refused because the context has moved on. `expiresAt` on
 * the envelope is the *retention* stamp Firestore's TTL reads, 24 hours out
 * (the issue's figure), which sweeps documents nobody ever came back to.
 *
 * They are deliberately separate fields at separate levels: collapsing them
 * would either let Firestore delete a question the user is still answering, or
 * keep half-finished sentences for a day longer than the product promises. The
 * clarification is nested under `record` so the two `expiresAt` values cannot
 * collide, and the TTL field is a `Date` because a TTL policy only applies to
 * a timestamp field.
 */
import { randomUUID } from 'crypto';
import type { ExtractionResult } from '../../src/extraction/extractionTypes';
import {
  CLARIFICATIONS,
  createMemoryStorage,
  getStorage,
  requireDocId,
  userCol,
  userIdForKey,
  type StorageAdapter,
} from '../storage';

export interface PendingClarification {
  id: string;
  scopeId: string;
  originalInput: string;
  partialExtraction: ExtractionResult;
  createdAt: string;
  expiresAt: string;
}

export interface PendingClarificationInput {
  scopeId: string;
  originalInput: string;
  partialExtraction: ExtractionResult;
  now: Date;
  ttlMs: number;
}

/** Async since UC-1.0c (#142): every method is a storage round trip. */
export interface ClarificationStore {
  create(input: PendingClarificationInput): Promise<PendingClarification>;
  getAndClear(scopeId: string, id: string, now: Date): Promise<PendingClarification | null>;
  clear(scopeId: string, id: string): Promise<void>;
  clearScope(scopeId: string): Promise<void>;
  pruneExpired(now: Date): Promise<void>;
}

/** How long Firestore keeps a clarification nobody returned to. */
export const CLARIFICATION_RETENTION_MS = 24 * 60 * 60 * 1000;

/** The clarification plus the retention stamp the TTL policy reads. */
interface StoredClarification {
  record: PendingClarification;
  scopeId: string;
  expiresAt: Date;
}

export function scopeClarification(options: {
  sessionId?: string;
  userId?: string;
  conversationId?: string;
}): string | null {
  const scope = options.conversationId || options.sessionId || options.userId;
  return typeof scope === 'string' && scope.trim() ? scope.trim() : null;
}

function collectionFor(scopeId: string): string {
  return userCol(userIdForKey(scopeId), CLARIFICATIONS);
}

function documentPath(scopeId: string, id: string): string {
  return `${collectionFor(scopeId)}/${requireDocId(id)}`;
}

function isExpired(record: PendingClarification, now: Date): boolean {
  return Date.parse(record.expiresAt) <= now.getTime();
}

export class StorageClarificationStore implements ClarificationStore {
  constructor(private readonly injected?: StorageAdapter) {}

  /** Resolved per call so a test may swap the adapter after construction. */
  private get storage(): StorageAdapter {
    return this.injected ?? getStorage();
  }

  async create(input: PendingClarificationInput): Promise<PendingClarification> {
    const record: PendingClarification = {
      id: randomUUID(),
      scopeId: input.scopeId,
      originalInput: input.originalInput,
      partialExtraction: input.partialExtraction,
      createdAt: input.now.toISOString(),
      expiresAt: new Date(input.now.getTime() + input.ttlMs).toISOString(),
    };
    await this.storage.set<StoredClarification>(documentPath(record.scopeId, record.id), {
      record,
      scopeId: record.scopeId,
      expiresAt: new Date(input.now.getTime() + CLARIFICATION_RETENTION_MS),
    });
    return record;
  }

  /**
   * Reads and removes in one step, whatever the outcome.
   *
   * The clearing is unconditional — an expired clarification is deleted and
   * still reported as absent — because a question the user has already been
   * told is stale must not be answerable by a retry.
   */
  async getAndClear(scopeId: string, id: string, now: Date): Promise<PendingClarification | null> {
    const path = documentPath(scopeId, id);
    const stored = await this.storage.get<StoredClarification>(path);
    if (stored) await this.storage.delete(path);
    if (!stored || stored.record.scopeId !== scopeId) return null;
    return isExpired(stored.record, now) ? null : stored.record;
  }

  async clear(scopeId: string, id: string): Promise<void> {
    await this.storage.delete(documentPath(scopeId, id));
  }

  async clearScope(scopeId: string): Promise<void> {
    const collection = collectionFor(scopeId);
    const rows = await this.storage.list<StoredClarification>(collection);
    for (const row of rows) await this.storage.delete(`${collection}/${row.id}`);
  }

  /**
   * Belt-and-braces against the TTL policy, which is eventual: Firestore
   * deletes an expired document within 24 hours of its stamp, not at the
   * instant it passes. This removes anything already past its business expiry
   * so a stale question cannot be read back in the meantime.
   */
  async pruneExpired(now: Date): Promise<void> {
    const rows = await this.storage.listGroup<StoredClarification>(CLARIFICATIONS);
    for (const row of rows) {
      if (row.data.record && isExpired(row.data.record, now)) await this.storage.delete(row.path);
    }
  }
}

/**
 * The same implementation over a private in-memory adapter, so a test cannot
 * exercise semantics production does not have.
 */
export class MemoryClarificationStore extends StorageClarificationStore {
  constructor() {
    super(createMemoryStorage());
  }
}

export function createDefaultClarificationStore(): ClarificationStore {
  return new StorageClarificationStore();
}
