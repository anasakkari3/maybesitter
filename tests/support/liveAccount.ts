/**
 * The `users/{uid}` document a live account has (#772).
 *
 * Every domain write now re-reads the user document in its own transaction and
 * refuses when it is gone or marked deleted (`lib/account/accountLiveness.ts`).
 * In production the document always exists before a write: authentication
 * creates the trust record on a uid's first request. A test that drives a
 * service directly skips that step, so it seeds the document here instead —
 * the same shape the first domain write used to create on its own.
 *
 * An existing document is left alone, so a test that already wrote locale,
 * timezone or a trust record keeps them.
 */
import { getStorage, userDoc } from '../../lib/storage/index.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import { newUserDocument } from '../../lib/storage/userDocument.ts';

export async function seedLiveAccount(
  uid: string,
  storage: StorageAdapter = getStorage(),
  at: string = new Date().toISOString(),
): Promise<void> {
  const path = userDoc(uid);
  if (await storage.get(path)) return;
  await storage.set(path, newUserDocument(at));
}
