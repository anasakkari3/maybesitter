/**
 * The Firestore storage adapter (UC-1.0b, #141).
 *
 * Thin by design: every rule this adapter appears to enforce is Firestore's
 * own. The one thing it adds is the read-after-write guard, which Firestore
 * also enforces but only once a request reaches the server — raising it here
 * means the memory adapter can raise the identical error in `npm test`.
 *
 * `ignoreUndefinedProperties` is on, so an optional field left `undefined` is
 * not written rather than rejected. The memory adapter drops `undefined` the
 * same way, through its JSON round-trip.
 */
import {
  getFirestore,
  type DocumentData,
  type Firestore,
  type Query,
  type Transaction,
} from 'firebase-admin/firestore';
import { getAdminApp } from '../firebase/admin';
import {
  MAX_TRANSACTION_ATTEMPTS,
  StorageContentionError,
  StorageUsageError,
  grpcStatusOf,
  type ListOptions,
  type StorageAdapter,
  type StorageTransaction,
  type StoredDoc,
} from './storageAdapter';
import { requireCollectionPath, requireDocumentPath } from './paths';

/** Set per service by infra/cloudrun/flags.sh: `staging` for staging, `(default)` for production. */
export const DATABASE_ENV_VAR = 'MAYBESITTER_FIRESTORE_DATABASE_ID';
export const DEFAULT_DATABASE = '(default)';

/** Firestore's own rule for a named database id: 4-63 chars, lowercase, digits, hyphens. */
const NAMED_DATABASE = /^[a-z][a-z0-9-]{2,61}[a-z0-9]$/;

/** gRPC `ABORTED`: the transaction lost its race and the retry budget is spent. */
const GRPC_ABORTED = 10;

/**
 * Which Firestore database this process uses (UC-1.0a #140, UC-1.0d #143).
 *
 * Staging and production share one project and one Firebase Auth; the only
 * thing keeping staging's test accounts out of production data is the
 * database. A process that ignored this setting would silently read and write
 * `(default)` from staging — and nothing would fail, because `(default)`
 * exists and readiness passes. So the pairing is checked, not assumed:
 * `MAYBESITTER_ENV=staging` on `(default)` is refused, and so is production on
 * anything but `(default)`. The refusal happens on first use, which on Cloud
 * Run is the readiness probe — so a misconfigured revision never takes traffic.
 */
export function resolveFirestoreDatabaseId(env: Record<string, string | undefined> = process.env): string {
  const raw = env[DATABASE_ENV_VAR]?.trim();
  const id = raw ? raw : DEFAULT_DATABASE;
  if (id !== DEFAULT_DATABASE && !NAMED_DATABASE.test(id)) {
    throw new Error(`${DATABASE_ENV_VAR} must be "${DEFAULT_DATABASE}" or a Firestore database id, not ${JSON.stringify(raw)}`);
  }
  const environment = env.MAYBESITTER_ENV?.trim();
  if (environment === 'staging' && id === DEFAULT_DATABASE) {
    throw new Error(`MAYBESITTER_ENV=staging on the ${DEFAULT_DATABASE} database would read and write production data; set ${DATABASE_ENV_VAR}=staging`);
  }
  if (environment === 'production' && id !== DEFAULT_DATABASE) {
    throw new Error(`MAYBESITTER_ENV=production must use the ${DEFAULT_DATABASE} database, not ${JSON.stringify(id)}`);
  }
  return id;
}

let cached: Firestore | null = null;

/**
 * `getFirestore(app, id)` hands back the same instance for a given database,
 * and Firestore throws if `settings()` is called on it twice. Remember which
 * instances are configured, so rebinding after `resetFirestoreForTests` —
 * switching databases and back — does not configure one a second time.
 */
const configured = new WeakSet<Firestore>();

function firestore(): Firestore {
  if (cached) return cached;
  const databaseId = resolveFirestoreDatabaseId();
  const app = getAdminApp();
  const db = databaseId === DEFAULT_DATABASE ? getFirestore(app) : getFirestore(app, databaseId);
  if (!configured.has(db)) {
    db.settings({ ignoreUndefinedProperties: true });
    configured.add(db);
  }
  cached = db;
  return cached;
}

/** Drops the memoised client so a test can rebind `FIRESTORE_EMULATOR_HOST`. */
export function resetFirestoreForTests(): void {
  cached = null;
}

function withOptions(query: Query, o: ListOptions | undefined): Query {
  let built = query;
  for (const [field, op, value] of o?.where ?? []) {
    built = built.where(field, op, value);
  }
  if (o?.orderBy) built = built.orderBy(o.orderBy.field, o.orderBy.direction ?? 'asc');
  if (typeof o?.limit === 'number') built = built.limit(o.limit);
  return built;
}

function toDocs<T>(snapshot: { docs: Array<{ id: string; ref: { path: string }; data(): DocumentData }> }): Array<StoredDoc<T> & { path: string }> {
  return snapshot.docs.map((doc) => ({ id: doc.id, path: doc.ref.path, data: doc.data() as T }));
}

class FirestoreTransaction implements StorageTransaction {
  private wrote = false;

  constructor(private readonly db: Firestore, private readonly tx: Transaction) {}

  private assertReadable(operation: string): void {
    if (this.wrote) {
      throw new StorageUsageError(
        `${operation} was called after a write in the same transaction; Firestore requires all reads before any write`,
      );
    }
  }

  async get<T>(path: string): Promise<T | null> {
    this.assertReadable('get');
    const snapshot = await this.tx.get(this.db.doc(requireDocumentPath(path)));
    return snapshot.exists ? (snapshot.data() as T) : null;
  }

  async list<T>(collectionPath: string, o?: ListOptions): Promise<StoredDoc<T>[]> {
    this.assertReadable('list');
    const snapshot = await this.tx.get(withOptions(this.db.collection(requireCollectionPath(collectionPath)), o));
    return toDocs<T>(snapshot).map(({ id, data }) => ({ id, data }));
  }

  async listGroup<T>(collectionId: string, o?: ListOptions): Promise<Array<StoredDoc<T> & { path: string }>> {
    this.assertReadable('listGroup');
    const snapshot = await this.tx.get(withOptions(this.db.collectionGroup(collectionId), o));
    return toDocs<T>(snapshot);
  }

  set<T>(path: string, value: T): void {
    this.wrote = true;
    this.tx.set(this.db.doc(requireDocumentPath(path)), value as unknown as DocumentData);
  }

  merge<T>(path: string, value: Partial<T>): void {
    this.wrote = true;
    this.tx.set(this.db.doc(requireDocumentPath(path)), value as unknown as DocumentData, { merge: true });
  }

  create<T>(path: string, value: T): void {
    this.wrote = true;
    this.tx.create(this.db.doc(requireDocumentPath(path)), value as unknown as DocumentData);
  }

  delete(path: string): void {
    this.wrote = true;
    this.tx.delete(this.db.doc(requireDocumentPath(path)));
  }
}

export class FirestoreStorageAdapter implements StorageAdapter {
  private get db(): Firestore {
    return firestore();
  }

  async get<T>(path: string): Promise<T | null> {
    const snapshot = await this.db.doc(requireDocumentPath(path)).get();
    return snapshot.exists ? (snapshot.data() as T) : null;
  }

  async list<T>(collectionPath: string, o?: ListOptions): Promise<StoredDoc<T>[]> {
    const snapshot = await withOptions(this.db.collection(requireCollectionPath(collectionPath)), o).get();
    return toDocs<T>(snapshot).map(({ id, data }) => ({ id, data }));
  }

  async listGroup<T>(collectionId: string, o?: ListOptions): Promise<Array<StoredDoc<T> & { path: string }>> {
    const snapshot = await withOptions(this.db.collectionGroup(collectionId), o).get();
    return toDocs<T>(snapshot);
  }

  async set<T>(path: string, value: T): Promise<void> {
    await this.db.doc(requireDocumentPath(path)).set(value as unknown as DocumentData);
  }

  async delete(path: string): Promise<void> {
    await this.db.doc(requireDocumentPath(path)).delete();
  }

  async deleteTree(path: string): Promise<number> {
    const writer = this.db.bulkWriter();
    let deleted = 0;
    writer.onWriteResult(() => {
      deleted += 1;
    });
    await this.db.recursiveDelete(this.db.doc(requireDocumentPath(path)), writer);
    return deleted;
  }

  async runTransaction<R>(fn: (tx: StorageTransaction) => Promise<R>): Promise<R> {
    const db = this.db;
    try {
      return await db.runTransaction(
        async (tx) => fn(new FirestoreTransaction(db, tx)),
        { maxAttempts: MAX_TRANSACTION_ATTEMPTS },
      );
    } catch (error) {
      /*
       * Contention says so, in the same words the memory adapter uses (#419).
       *
       * `StorageContentionError` has existed since the seam was written, and
       * until now only `memoryAdapter` ever threw it: Firestore let its raw
       * gRPC `ABORTED` escape instead. So the two adapters disagreed about
       * what a lost race looks like, and every caller that meant to handle
       * contention only handled it in tests — the #252 shape of bug, where the
       * in-memory path accepts what the real one does not.
       *
       * `ABORTED` after the attempt budget is spent is exactly that: the
       * transaction read documents another one committed first, five times
       * over. It is the database working, not failing, and it is a different
       * event from a write that was refused.
       */
      if (grpcStatusOf(error) === GRPC_ABORTED) {
        throw new StorageContentionError(
          `Firestore aborted the transaction after ${MAX_TRANSACTION_ATTEMPTS} attempts: ${(error as Error).message}`,
          MAX_TRANSACTION_ATTEMPTS,
        );
      }
      throw error;
    }
  }
}

export function createFirestoreStorage(): FirestoreStorageAdapter {
  return new FirestoreStorageAdapter();
}
