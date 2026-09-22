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

/**
 * gRPC status names, so a storage failure can say which one it was (#419).
 *
 * Firestore reports every failure as a numeric `code` on the error, and `10`
 * on its own tells a reader nothing. The distinction that matters when a write
 * fails is whether the cause is transient — `ABORTED` and `UNAVAILABLE` are a
 * loaded database, `DEADLINE_EXCEEDED` is a slow one — or a defect:
 * `PERMISSION_DENIED` is a rules or credential regression,
 * `FAILED_PRECONDITION` a missing index, `INVALID_ARGUMENT` a bad write.
 * Those need opposite responses, and a single `persistence_failed` asks the
 * next person to re-run the job to find out which they have.
 */
const GRPC_STATUS_NAMES: Readonly<Record<number, string>> = Object.freeze({
  1: 'CANCELLED',
  2: 'UNKNOWN',
  3: 'INVALID_ARGUMENT',
  4: 'DEADLINE_EXCEEDED',
  5: 'NOT_FOUND',
  6: 'ALREADY_EXISTS',
  7: 'PERMISSION_DENIED',
  8: 'RESOURCE_EXHAUSTED',
  9: 'FAILED_PRECONDITION',
  10: 'ABORTED',
  11: 'OUT_OF_RANGE',
  12: 'UNIMPLEMENTED',
  13: 'INTERNAL',
  14: 'UNAVAILABLE',
  15: 'DATA_LOSS',
  16: 'UNAUTHENTICATED',
});

/** The numeric gRPC status on a Firestore error, if it carries one. */
export function grpcStatusOf(error: unknown): number | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'number' && code in GRPC_STATUS_NAMES ? code : null;
}

/**
 * Failure messages whose status alone is misleading, and the word for what
 * they actually were (#419).
 *
 * `INVALID_ARGUMENT` normally means a write the database refused and will
 * refuse again — a bad field value, an oversized document. But Firestore also
 * reports a transaction it closed underneath a caller that way, and that is a
 * busy database, not a bad argument. The two need opposite responses and carry
 * the same status, so the distinction has to come from the message.
 *
 * Matched as a fixed shape and reported as a fixed label: the raw message is
 * still never returned, because it quotes document paths and those carry uids.
 */
const RECOGNISED_MESSAGES: ReadonlyArray<readonly [RegExp, string]> = Object.freeze([
  [/transaction is invalid or closed/i, 'transaction closed'],
  [/deadline exceeded|timeout/i, 'timed out'],
] as const);

/**
 * A short, safe name for why a storage write failed (#419).
 *
 * Deliberately a name and never the underlying message: a Firestore error
 * quotes the document path it failed on, and those paths carry uids. The
 * caller logs the full error where operators can read it and puts only this on
 * anything a client or a test assertion sees.
 */
export function storageFailureCause(error: unknown): string {
  if (error instanceof StorageContentionError) return `contention after ${error.attempts} attempts`;
  if (error instanceof StorageUsageError) return 'storage misuse';
  const code = grpcStatusOf(error);
  const name = code !== null ? GRPC_STATUS_NAMES[code]! : error instanceof Error ? error.name : 'unknown';
  const message = error instanceof Error ? error.message : '';
  const recognised = RECOGNISED_MESSAGES.find(([shape]) => shape.test(message));
  return recognised ? `${name} (${recognised[1]})` : name;
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
