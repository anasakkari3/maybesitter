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
  StorageUsageError,
  type ListOptions,
  type StorageAdapter,
  type StorageTransaction,
  type StoredDoc,
} from './storageAdapter';
import { requireCollectionPath, requireDocumentPath } from './paths';

let cached: Firestore | null = null;

function firestore(): Firestore {
  if (cached) return cached;
  const db = getFirestore(getAdminApp());
  db.settings({ ignoreUndefinedProperties: true });
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
    return db.runTransaction(
      async (tx) => fn(new FirestoreTransaction(db, tx)),
      { maxAttempts: MAX_TRANSACTION_ATTEMPTS },
    );
  }
}

export function createFirestoreStorage(): FirestoreStorageAdapter {
  return new FirestoreStorageAdapter();
}
