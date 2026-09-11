/**
 * The storage seam (UC-1.0b, #141).
 *
 * One narrow interface over Firestore, with an in-memory implementation that
 * obeys the same rules, so a durability bug shows up in `npm test` rather than
 * only in production. Everything a caller can do is here; nothing below this
 * interface leaks a Firestore type upwards.
 *
 * ── Documents are addressed by path ──────────────────────────────
 *
 * `users/{uid}/commitments/{id}`. A document path has an even number of
 * segments and a collection path an odd number, exactly as Firestore counts
 * them, so the same string means the same thing against either adapter.
 *
 * ── Transactions read before they write ──────────────────────────
 *
 * Firestore refuses a read issued after a write inside the same transaction.
 * Both adapters therefore throw `StorageUsageError` on that sequence rather
 * than letting the memory adapter accept code Firestore will reject at
 * runtime: the point of having two implementations is that the cheap one
 * catches the misuse.
 *
 * ── A transaction callback may run more than once ────────────────
 *
 * Contention retries re-run the callback from the top. A callback that emits
 * an analytics event, sends a notification or mutates module state performs
 * that effect once per attempt, not once per commit. Keep callbacks pure and
 * do the side effect after the transaction returns.
 */

/** A read after a write inside one transaction, and other misuse of the seam. */
export class StorageUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageUsageError';
  }
}

/** A transaction that could not commit within its attempt budget. */
export class StorageContentionError extends Error {
  constructor(message: string, readonly attempts: number) {
    super(message);
    this.name = 'StorageContentionError';
  }
}

export interface StoredDoc<T> {
  id: string;
  data: T;
}

export type WhereOperator = '==' | '<' | '<=' | '>' | '>=';

export interface ListOptions {
  limit?: number;
  orderBy?: { field: string; direction?: 'asc' | 'desc' };
  where?: Array<[field: string, op: WhereOperator, value: unknown]>;
}

export interface StorageReader {
  get<T>(path: string): Promise<T | null>;
  list<T>(collectionPath: string, o?: ListOptions): Promise<StoredDoc<T>[]>;
  listGroup<T>(collectionId: string, o?: ListOptions): Promise<Array<StoredDoc<T> & { path: string }>>;
}

export interface StorageTransaction extends StorageReader {
  set<T>(path: string, value: T): void;
  merge<T>(path: string, value: Partial<T>): void;
  create<T>(path: string, value: T): void;
  delete(path: string): void;
}

export interface StorageAdapter extends StorageReader {
  set<T>(path: string, value: T): Promise<void>;
  delete(path: string): Promise<void>;
  /** Retried on contention; `fn` must be pure — see the header. */
  runTransaction<R>(fn: (tx: StorageTransaction) => Promise<R>): Promise<R>;
  /** The document and every document beneath it. Returns how many were deleted. */
  deleteTree(path: string): Promise<number>;
}

/** Firestore's own default, restated here so both adapters retry the same number of times. */
export const MAX_TRANSACTION_ATTEMPTS = 5;
