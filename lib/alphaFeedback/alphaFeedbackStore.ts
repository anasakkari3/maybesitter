/**
 * SYNTHETIC — ENG/QA INFRA ONLY
 *
 * Alpha feedback flags, in the participant's own tree (UC-1.0c, #142).
 *
 * ── What this replaced ───────────────────────────────────────────
 *
 * One `<dataDir>/alpha-feedback/<flagId>.flag.json` per flag on the local
 * filesystem — and an export that made it worse:
 *
 *     export { createInMemoryStore as createFileAlphaFeedbackStore };
 *
 * The factory every caller reached for was named "File" and was the *internal*
 * store, so nobody reading a call site could tell which backend they had. That
 * name is gone: the storage-backed factory says storage, the in-memory one
 * says in-memory, and neither pretends to be the other.
 *
 * Flags now live at `users/{uid}/alphaFeedback/{flagId}`, so a flag goes with
 * the account it belongs to and account deletion reaches it.
 *
 * ── Session-scoped deletion crosses users ───────────────────────
 *
 * `deleteBySession` is addressed by session alone, so it resolves through a
 * collection-group query rather than asking a caller for an owner it does not
 * have. `firestore.indexes.json` carries the matching index.
 */
import { randomUUID } from 'node:crypto';
import {
  ALPHA_FEEDBACK_FLAG_VERSION,
  FLAG_NOTE_MAX_LENGTH,
  type AlphaFeedbackFlag,
  type AlphaFeedbackFlagInput,
} from '../../src/contracts/v1/feedbackFlagContracts';
import {
  ALPHA_FEEDBACK,
  createMemoryStorage,
  getStorage,
  requireDocId,
  userCol,
  userIdForKey,
  type StorageAdapter,
} from '../storage';

export interface AlphaFeedbackStoreOptions {
  storage?: StorageAdapter;
  retentionTtlMs?: number;
}

/** Async since UC-1.0c (#142): every method is a storage round trip. */
export interface AlphaFeedbackStore {
  record(input: AlphaFeedbackFlagInput): Promise<AlphaFeedbackFlag>;
  list(options?: { participantId?: string; sessionId?: string; since?: string }): Promise<AlphaFeedbackFlag[]>;
  count(options?: { participantId?: string }): Promise<number>;
  deleteBySession(sessionId: string): Promise<number>;
  deleteByParticipant(participantId: string): Promise<number>;
  prune(): Promise<number>;
}

export const DEFAULT_RETENTION_TTL_MS = 30 * 24 * 60 * 60 * 1_000; // 30 days

function newFlag(input: AlphaFeedbackFlagInput): AlphaFeedbackFlag {
  const note = input.note ?? null;
  return {
    version: ALPHA_FEEDBACK_FLAG_VERSION,
    flagId: randomUUID(),
    participantId: input.participantId,
    sessionId: input.sessionId ?? `alpha-${input.participantId}-${Date.now().toString(36)}`,
    proposalId: input.proposalId,
    commitmentId: input.commitmentId ?? null,
    category: input.category,
    note: typeof note === 'string' ? note.slice(0, FLAG_NOTE_MAX_LENGTH) : null,
    createdAt: new Date().toISOString(),
  };
}

function isFlag(value: unknown): value is AlphaFeedbackFlag {
  if (!value || typeof value !== 'object') return false;
  const raw = value as Partial<AlphaFeedbackFlag>;
  return raw.version === ALPHA_FEEDBACK_FLAG_VERSION && typeof raw.flagId === 'string';
}

function oldestFirst(a: AlphaFeedbackFlag, b: AlphaFeedbackFlag): number {
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
}

function collectionFor(participantId: string): string {
  return userCol(userIdForKey(participantId), ALPHA_FEEDBACK);
}

export class StorageAlphaFeedbackStore implements AlphaFeedbackStore {
  private readonly retentionTtlMs: number;

  constructor(private readonly options: AlphaFeedbackStoreOptions = {}) {
    this.retentionTtlMs = options.retentionTtlMs ?? DEFAULT_RETENTION_TTL_MS;
  }

  /** Resolved per call so a test may swap the adapter after construction. */
  private get storage(): StorageAdapter {
    return this.options.storage ?? getStorage();
  }

  /** Every flag with its path, for the cross-participant reads. */
  private async all(): Promise<Array<{ path: string; flag: AlphaFeedbackFlag }>> {
    const rows = await this.storage.listGroup<AlphaFeedbackFlag>(ALPHA_FEEDBACK);
    return rows
      .filter((row) => isFlag(row.data))
      .map((row) => ({ path: row.path, flag: row.data }))
      .sort((a, b) => oldestFirst(a.flag, b.flag));
  }

  async record(input: AlphaFeedbackFlagInput): Promise<AlphaFeedbackFlag> {
    const flag = newFlag(input);
    await this.storage.set<AlphaFeedbackFlag>(
      `${collectionFor(flag.participantId)}/${requireDocId(flag.flagId)}`,
      flag,
    );
    return flag;
  }

  async list(filter?: { participantId?: string; sessionId?: string; since?: string }): Promise<AlphaFeedbackFlag[]> {
    // One participant is a single-collection read; everything else is a group
    // read, so an operator review is not one query per account.
    const held = filter?.participantId
      ? (await this.storage.list<AlphaFeedbackFlag>(collectionFor(filter.participantId)))
        .filter((row) => isFlag(row.data))
        .map((row) => row.data)
        .sort(oldestFirst)
      : (await this.all()).map(({ flag }) => flag);

    return held.filter((flag) => {
      if (filter?.sessionId && flag.sessionId !== filter.sessionId) return false;
      if (filter?.since && flag.createdAt < filter.since) return false;
      return true;
    });
  }

  async count(filter?: { participantId?: string }): Promise<number> {
    return (await this.list(filter)).length;
  }

  async deleteBySession(sessionId: string): Promise<number> {
    const rows = await this.storage.listGroup<AlphaFeedbackFlag>(ALPHA_FEEDBACK, {
      where: [['sessionId', '==', sessionId]],
    });
    for (const row of rows) await this.storage.delete(row.path);
    return rows.length;
  }

  async deleteByParticipant(participantId: string): Promise<number> {
    const collection = collectionFor(participantId);
    const rows = await this.storage.list<AlphaFeedbackFlag>(collection);
    for (const row of rows) await this.storage.delete(`${collection}/${row.id}`);
    return rows.length;
  }

  async prune(): Promise<number> {
    const cutoff = new Date(Date.now() - this.retentionTtlMs).toISOString();
    let pruned = 0;
    for (const { path, flag } of await this.all()) {
      if (flag.createdAt < cutoff) {
        await this.storage.delete(path);
        pruned += 1;
      }
    }
    return pruned;
  }
}

/**
 * The same implementation over a private in-memory adapter, so a test cannot
 * exercise semantics production does not have — and, unlike the export this
 * replaced, the name says which backend you get.
 */
export function createInMemoryAlphaFeedbackStore(flags?: AlphaFeedbackFlag[]): AlphaFeedbackStore {
  const storage = createMemoryStorage();
  const store = new StorageAlphaFeedbackStore({ storage });
  const seeded = (async () => {
    for (const flag of flags ?? []) {
      await storage.set<AlphaFeedbackFlag>(
        `${collectionFor(flag.participantId)}/${requireDocId(flag.flagId)}`,
        flag,
      );
    }
  })();

  return {
    record: async (...args) => { await seeded; return store.record(...args); },
    list: async (...args) => { await seeded; return store.list(...args); },
    count: async (...args) => { await seeded; return store.count(...args); },
    deleteBySession: async (...args) => { await seeded; return store.deleteBySession(...args); },
    deleteByParticipant: async (...args) => { await seeded; return store.deleteByParticipant(...args); },
    prune: async () => { await seeded; return store.prune(); },
  };
}

export function createStorageAlphaFeedbackStore(options?: AlphaFeedbackStoreOptions): AlphaFeedbackStore {
  return new StorageAlphaFeedbackStore(options);
}
