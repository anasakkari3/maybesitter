/**
 * The in-memory storage adapter (UC-1.0b, #141).
 *
 * Not a stub. It exists so the durability rules Firestore enforces at runtime
 * are enforced in `npm test` too, on a machine with no emulator:
 *
 *   - reads are deep copies, so a caller mutating what it read changes nothing;
 *   - a read after a write inside a transaction throws `StorageUsageError`;
 *   - transactions record the version of every document *and every collection*
 *     they read, and refuse to commit if any of them moved underneath them.
 *
 * ── How contention is modelled ───────────────────────────────────
 *
 * Attempts are serialised through a FIFO lock **and** each attempt validates
 * the versions it read before it commits. That is the shape of Firestore's own
 * read-write transactions: the server takes pessimistic locks on what a
 * transaction reads, so a crowd of writers queues instead of livelocking, and
 * the retry budget is there for genuine conflicts rather than for congestion.
 *
 * An earlier draft here left the first attempt unlocked so transactions would
 * race each other directly. It made `tests/pilot/participantIsolation` fail:
 * a transaction that lost once was starved by the newly arriving writers that
 * had not yet queued, and blew its five-attempt budget. That is a property of
 * the harness, not of the code under test, and Firestore would not have
 * behaved that way.
 *
 * The version check is what still bites, and it is not decoration: a write
 * that lands from outside a transaction — a second Cloud Run instance, or
 * `setBeforeCommitHookForTests` — moves a version the in-flight transaction
 * recorded, and that transaction aborts and retries rather than overwriting
 * it. That window, between a transaction's last read and its commit, is
 * exactly where the old file-backed store lost writes, and the hook is how a
 * test reaches it.
 *
 * ── Deliberate difference from Firestore ─────────────────────────
 *
 * `merge` here is a shallow merge of top-level fields. Firestore's
 * `set(..., { merge: true })` merges nested maps too. Nothing in this repo
 * merges into a nested map; if something ever does, this is the line to change.
 */
import {
  MAX_TRANSACTION_ATTEMPTS,
  StorageContentionError,
  StorageUsageError,
  type ListOptions,
  type StorageAdapter,
  type StorageTransaction,
  type StoredDoc,
  type WhereOperator,
} from './storageAdapter';
import {
  collectionIdOf,
  documentIdOf,
  parentCollectionOf,
  requireCollectionPath,
  requireDocumentPath,
  segmentsOf,
} from './paths';

type Row = Record<string, unknown>;

/**
 * `data: null` is a tombstone, not an absence. Keeping the slot means a
 * delete still moves the version, so create → delete → create cannot look to a
 * concurrent reader like nothing happened.
 */
interface Entry {
  version: number;
  data: Row | null;
}

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function asRow(value: unknown, operation: string): Row {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new StorageUsageError(`${operation} takes an object; a document is a map of fields`);
  }
  // Matches Firestore's `ignoreUndefinedProperties`: an undefined field is not written.
  return clone(value) as Row;
}

function fieldValue(row: Row, field: string): unknown {
  let current: unknown = row;
  for (const part of field.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Row)[part];
  }
  return current;
}

function rank(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'boolean') return 1;
  if (typeof value === 'number') return 2;
  if (typeof value === 'string') return 3;
  return 4;
}

function compareValues(a: unknown, b: unknown): number {
  const rankA = rank(a);
  const rankB = rank(b);
  if (rankA !== rankB) return rankA < rankB ? -1 : 1;
  if (typeof a === 'number' && typeof b === 'number') return a === b ? 0 : a < b ? -1 : 1;
  if (typeof a === 'string' && typeof b === 'string') return a === b ? 0 : a < b ? -1 : 1;
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : a ? 1 : -1;
  const left = JSON.stringify(a ?? null);
  const right = JSON.stringify(b ?? null);
  return left === right ? 0 : left < right ? -1 : 1;
}

function matches(row: Row, where: NonNullable<ListOptions['where']>): boolean {
  return where.every(([field, op, value]) => {
    const actual = fieldValue(row, field);
    // A document that does not carry the field at all matches **no** filter on
    // it. Firestore indexes a field per document, so a document missing it is
    // not in that index and no query on it can return the document — while
    // `rank` below puts `undefined` beneath every string, which made
    // `nextRunAt <= now` true for every account that had no `nextRunAt`. That
    // divergence is exactly the kind a memory adapter is for catching, and it
    // hid one: an account disarmed by removing the field stayed in every sweep
    // here and in no sweep in production. An explicit `null` is a value, is
    // indexed, and still compares.
    if (actual === undefined) return false;
    const comparison = compareValues(actual, value);
    return applyOperator(op, comparison);
  });
}

function applyOperator(op: WhereOperator, comparison: number): boolean {
  switch (op) {
    case '==': return comparison === 0;
    case '<': return comparison < 0;
    case '<=': return comparison <= 0;
    case '>': return comparison > 0;
    case '>=': return comparison >= 0;
    default: throw new StorageUsageError(`unsupported where operator: ${String(op)}`);
  }
}

class MemoryStore {
  readonly docs = new Map<string, Entry>();
  /** Bumped when any document directly inside the collection is written. */
  readonly collectionVersions = new Map<string, number>();
  /** The same, keyed by the last path segment, for collection-group reads. */
  readonly groupVersions = new Map<string, number>();

  versionOf(path: string): number {
    return this.docs.get(path)?.version ?? 0;
  }

  collectionVersion(collectionPath: string): number {
    return this.collectionVersions.get(collectionPath) ?? 0;
  }

  groupVersion(collectionId: string): number {
    return this.groupVersions.get(collectionId) ?? 0;
  }

  read(path: string): Row | null {
    const entry = this.docs.get(path);
    return entry && entry.data !== null ? clone(entry.data) : null;
  }

  write(path: string, data: Row | null): void {
    const previous = this.docs.get(path);
    this.docs.set(path, { version: (previous?.version ?? 0) + 1, data });
    const collection = parentCollectionOf(path);
    this.collectionVersions.set(collection, this.collectionVersion(collection) + 1);
    const id = collectionIdOf(collection);
    this.groupVersions.set(id, this.groupVersion(id) + 1);
  }

  entriesIn(collectionPath: string): Array<[string, Row]> {
    const rows: Array<[string, Row]> = [];
    this.docs.forEach((entry, path) => {
      if (entry.data === null) return;
      if (parentCollectionOf(path) === collectionPath) rows.push([path, clone(entry.data)]);
    });
    return rows;
  }

  entriesInGroup(collectionId: string): Array<[string, Row]> {
    const rows: Array<[string, Row]> = [];
    this.docs.forEach((entry, path) => {
      if (entry.data === null) return;
      if (collectionIdOf(parentCollectionOf(path)) === collectionId) rows.push([path, clone(entry.data)]);
    });
    return rows;
  }

  /** Every path currently holding data, in path order. */
  livePaths(): string[] {
    const paths: string[] = [];
    this.docs.forEach((entry, path) => {
      if (entry.data !== null) paths.push(path);
    });
    return paths.sort();
  }
}

function selectRows(rows: Array<[string, Row]>, options: ListOptions | undefined): Array<[string, Row]> {
  let selected = options?.where ? rows.filter(([, row]) => matches(row, options.where!)) : rows;
  const orderBy = options?.orderBy;
  const direction = orderBy?.direction === 'desc' ? -1 : 1;
  selected = [...selected].sort(([pathA, rowA], [pathB, rowB]) => {
    if (orderBy) {
      const byField = compareValues(fieldValue(rowA, orderBy.field), fieldValue(rowB, orderBy.field));
      if (byField !== 0) return byField * direction;
    }
    // A stable, reproducible tiebreak: the document id, as Firestore uses.
    const byId = compareValues(documentIdOf(pathA), documentIdOf(pathB));
    return orderBy ? byId * direction : byId;
  });
  if (typeof options?.limit === 'number') {
    if (!Number.isInteger(options.limit) || options.limit < 0) throw new StorageUsageError('limit must be a non-negative integer');
    selected = selected.slice(0, options.limit);
  }
  return selected;
}

type PendingOp =
  | { kind: 'set'; path: string; value: Row }
  | { kind: 'merge'; path: string; value: Row }
  | { kind: 'create'; path: string; value: Row }
  | { kind: 'delete'; path: string };

class MemoryTransaction implements StorageTransaction {
  private readonly docReads = new Map<string, number>();
  private readonly collectionReads = new Map<string, number>();
  private readonly groupReads = new Map<string, number>();
  private readonly ops: PendingOp[] = [];
  private wrote = false;

  constructor(private readonly store: MemoryStore) {}

  private assertReadable(operation: string): void {
    if (this.wrote) {
      throw new StorageUsageError(
        `${operation} was called after a write in the same transaction; Firestore requires all reads before any write`,
      );
    }
  }

  async get<T>(path: string): Promise<T | null> {
    this.assertReadable('get');
    const documentPath = requireDocumentPath(path);
    this.docReads.set(documentPath, this.store.versionOf(documentPath));
    return this.store.read(documentPath) as T | null;
  }

  async list<T>(collectionPath: string, o?: ListOptions): Promise<StoredDoc<T>[]> {
    this.assertReadable('list');
    const path = requireCollectionPath(collectionPath);
    this.collectionReads.set(path, this.store.collectionVersion(path));
    return selectRows(this.store.entriesIn(path), o).map(([documentPath, row]) => ({
      id: documentIdOf(documentPath),
      data: row as T,
    }));
  }

  async listGroup<T>(collectionId: string, o?: ListOptions): Promise<Array<StoredDoc<T> & { path: string }>> {
    this.assertReadable('listGroup');
    this.groupReads.set(collectionId, this.store.groupVersion(collectionId));
    return selectRows(this.store.entriesInGroup(collectionId), o).map(([documentPath, row]) => ({
      id: documentIdOf(documentPath),
      path: documentPath,
      data: row as T,
    }));
  }

  set<T>(path: string, value: T): void {
    this.wrote = true;
    this.ops.push({ kind: 'set', path: requireDocumentPath(path), value: asRow(value, 'set') });
  }

  merge<T>(path: string, value: Partial<T>): void {
    this.wrote = true;
    this.ops.push({ kind: 'merge', path: requireDocumentPath(path), value: asRow(value, 'merge') });
  }

  create<T>(path: string, value: T): void {
    this.wrote = true;
    this.ops.push({ kind: 'create', path: requireDocumentPath(path), value: asRow(value, 'create') });
  }

  delete(path: string): void {
    this.wrote = true;
    this.ops.push({ kind: 'delete', path: requireDocumentPath(path) });
  }

  /** Nothing this transaction read has moved since it read it. */
  readsStillValid(): boolean {
    let valid = true;
    this.docReads.forEach((version, path) => {
      if (this.store.versionOf(path) !== version) valid = false;
    });
    this.collectionReads.forEach((version, path) => {
      if (this.store.collectionVersion(path) !== version) valid = false;
    });
    this.groupReads.forEach((version, id) => {
      if (this.store.groupVersion(id) !== version) valid = false;
    });
    return valid;
  }

  /** Synchronous from first op to last: no other caller can observe a half-commit. */
  commit(): void {
    for (const op of this.ops) {
      if (op.kind === 'create' && this.store.read(op.path) !== null) {
        throw new Error(`document already exists: ${op.path}`);
      }
    }
    for (const op of this.ops) {
      if (op.kind === 'delete') {
        this.store.write(op.path, null);
      } else if (op.kind === 'merge') {
        const existing = this.store.read(op.path);
        this.store.write(op.path, { ...(existing ?? {}), ...op.value });
      } else {
        this.store.write(op.path, op.value);
      }
    }
  }
}

export type BeforeCommitHook = (info: { attempt: number }) => void | Promise<void>;

export class MemoryStorageAdapter implements StorageAdapter {
  private readonly store = new MemoryStore();
  private beforeCommit: BeforeCommitHook | null = null;
  private queue: Promise<void> = Promise.resolve();

  async get<T>(path: string): Promise<T | null> {
    return this.store.read(requireDocumentPath(path)) as T | null;
  }

  async list<T>(collectionPath: string, o?: ListOptions): Promise<StoredDoc<T>[]> {
    const path = requireCollectionPath(collectionPath);
    return selectRows(this.store.entriesIn(path), o).map(([documentPath, row]) => ({
      id: documentIdOf(documentPath),
      data: row as T,
    }));
  }

  async listGroup<T>(collectionId: string, o?: ListOptions): Promise<Array<StoredDoc<T> & { path: string }>> {
    return selectRows(this.store.entriesInGroup(collectionId), o).map(([documentPath, row]) => ({
      id: documentIdOf(documentPath),
      path: documentPath,
      data: row as T,
    }));
  }

  async set<T>(path: string, value: T): Promise<void> {
    this.store.write(requireDocumentPath(path), asRow(value, 'set'));
  }

  async delete(path: string): Promise<void> {
    const documentPath = requireDocumentPath(path);
    if (this.store.read(documentPath) !== null) this.store.write(documentPath, null);
  }

  async deleteTree(path: string): Promise<number> {
    const documentPath = requireDocumentPath(path);
    const prefix = `${documentPath}/`;
    let deleted = 0;
    for (const candidate of this.store.livePaths()) {
      if (candidate === documentPath || candidate.startsWith(prefix)) {
        this.store.write(candidate, null);
        deleted += 1;
      }
    }
    return deleted;
  }

  async runTransaction<R>(fn: (tx: StorageTransaction) => Promise<R>): Promise<R> {
    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      // Serialised like Firestore's server-side locks, then version-checked:
      // see the header on why the lock is taken on every attempt.
      const release = await this.acquire();
      try {
        const tx = new MemoryTransaction(this.store);
        const result = await fn(tx);
        if (this.beforeCommit) await this.beforeCommit({ attempt });
        if (tx.readsStillValid()) {
          tx.commit();
          return result;
        }
      } finally {
        release?.();
      }
      // Let the winning commit land before re-reading.
      await Promise.resolve();
    }
    throw new StorageContentionError(
      `transaction could not commit after ${MAX_TRANSACTION_ATTEMPTS} attempts`,
      MAX_TRANSACTION_ATTEMPTS,
    );
  }

  /**
   * Runs between a transaction's last read and its commit check. A write made
   * from here is exactly the competing write a concurrent instance would make.
   */
  setBeforeCommitHookForTests(fn: BeforeCommitHook | null): void {
    this.beforeCommit = fn;
  }

  /** Every document path currently holding data. Test-only introspection. */
  pathsForTests(): string[] {
    return this.store.livePaths();
  }

  private async acquire(): Promise<() => void> {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.queue;
    this.queue = previous.then(() => held);
    await previous;
    return release;
  }
}

export function createMemoryStorage(): MemoryStorageAdapter {
  return new MemoryStorageAdapter();
}

/** Re-exported so a test can assert a path is well formed without a second import. */
export { segmentsOf };
