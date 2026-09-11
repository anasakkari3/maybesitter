/**
 * Which storage this process uses, decided in one place (UC-1.0b, #141).
 *
 * The default is the memory adapter, because the default caller is a test or a
 * developer's laptop. Cloud Run is the exception and it is detected rather than
 * configured: `K_SERVICE` is set by Cloud Run itself, so a deployment that
 * forgot `MAYBESITTER_STORAGE_BACKEND` still gets Firestore instead of quietly
 * writing every user's commitments into a process that is about to be recycled.
 *
 * The converse is a throw, not a warning: `K_SERVICE` set with any backend
 * other than `firestore` is a deployment that will lose data, and it fails on
 * first use rather than after the first user has typed something.
 */
import { createFirestoreStorage } from './firestoreAdapter';
import { createMemoryStorage } from './memoryAdapter';
import type { StorageAdapter } from './storageAdapter';

export * from './storageAdapter';
export * from './paths';
export { createMemoryStorage, MemoryStorageAdapter, type BeforeCommitHook } from './memoryAdapter';
export { createFirestoreStorage, FirestoreStorageAdapter, resetFirestoreForTests } from './firestoreAdapter';

export type StorageBackend = 'firestore' | 'memory';

export const STORAGE_BACKEND_ENV_VAR = 'MAYBESITTER_STORAGE_BACKEND';
/** Set by Cloud Run on every revision. Not something a deployment configures. */
export const CLOUD_RUN_ENV_VAR = 'K_SERVICE';

export function resolveStorageBackend(env: NodeJS.ProcessEnv = process.env): StorageBackend {
  const onCloudRun = Boolean(env[CLOUD_RUN_ENV_VAR]);
  const raw = env[STORAGE_BACKEND_ENV_VAR]?.trim();
  const backend = raw ? raw : onCloudRun ? 'firestore' : 'memory';
  if (backend !== 'firestore' && backend !== 'memory') {
    throw new Error(`${STORAGE_BACKEND_ENV_VAR} must be "firestore" or "memory", not ${JSON.stringify(raw)}`);
  }
  if (onCloudRun && backend !== 'firestore') {
    throw new Error(
      `${STORAGE_BACKEND_ENV_VAR}=${backend} on Cloud Run (${CLOUD_RUN_ENV_VAR} is set): in-memory storage is lost on every instance restart and is not shared between instances`,
    );
  }
  return backend;
}

let override: StorageAdapter | null = null;
let cached: StorageAdapter | null = null;
let cachedBackend: StorageBackend | null = null;

export function getStorage(): StorageAdapter {
  if (override) return override;
  const backend = resolveStorageBackend();
  if (!cached || cachedBackend !== backend) {
    cached = backend === 'firestore' ? createFirestoreStorage() : createMemoryStorage();
    cachedBackend = backend;
  }
  return cached;
}

export function setStorageForTests(adapter: StorageAdapter): void {
  override = adapter;
}

export function resetStorageForTests(): void {
  override = null;
  cached = null;
  cachedBackend = null;
}
