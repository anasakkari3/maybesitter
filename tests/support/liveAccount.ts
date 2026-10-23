/**
 * The `users/{uid}` document a live account has (#772).
 *
 * Every domain write now re-reads the user document in its own transaction and
 * refuses unless it is there with a valid trust record that is not marked
 * deleted (`lib/account/accountLiveness.ts`). In production that is always so
 * before a write: authentication creates the trust record on a uid's first
 * request and re-reads it on every request (`getOrCreateTrust`). A test that
 * drives a service directly skips that step, so it seeds the document here
 * instead, with the trust record authentication would have written
 * (`createPilotTrustState`).
 *
 * An existing document keeps everything it holds, so a test that already wrote
 * locale or timezone keeps them; one without a trust record gets one merged in,
 * the way `getOrCreateTrust` does it. An existing trust record is left alone.
 *
 * Without an explicit `at`, the trust record is dated before anything a test
 * does (`TRUST_CREATED_AT`): authentication wrote it on the account's first
 * request, and a test's own trust actions (consents, first value) must not be
 * refused as backdated against a record stamped with today's wall clock.
 */
import { getStorage, userDoc } from '../../lib/storage/index.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import { newUserDocument, type UserDocument } from '../../lib/storage/userDocument.ts';
import { createPilotTrustState } from '../../lib/pilot/closedPilotControls.ts';

export const TRUST_CREATED_AT = '2020-01-01T00:00:00.000Z';

export async function seedLiveAccount(
  uid: string,
  storage: StorageAdapter = getStorage(),
  at?: string,
): Promise<void> {
  const path = userDoc(uid);
  await storage.runTransaction(async (tx) => {
    const user = await tx.get<UserDocument>(path);
    if (user?.trust) return;
    const trust = createPilotTrustState(uid, at ?? TRUST_CREATED_AT);
    if (user) tx.merge<UserDocument>(path, { trust });
    else tx.set<UserDocument>(path, { ...newUserDocument(at ?? new Date().toISOString()), trust });
  });
}
