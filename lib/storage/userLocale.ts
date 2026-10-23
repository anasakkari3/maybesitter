/**
 * Records the language the user chose in the app on `users/{uid}.locale`.
 *
 * Server-side work that runs with no request of its own -- the nightly
 * football projection titling matches -- reads this to speak the user's
 * language. Without it, a language sent on one request was used for that
 * request only, and the next night's run fell back to a device record (which a
 * user without push has none of) or English.
 *
 * A merge into the existing document, in one transaction, so it never erases
 * the trust record, consents or `domainVersion` beside it. The field is part
 * of `users/{uid}`, which account deletion removes as a whole tree.
 *
 * ── Never a new root (Q772-001) ─────────────────────────────────
 * This used to create `users/{uid}` from `newUserDocument` when it was
 * missing. Authentication creates the document with its trust record before
 * any request reaches here, so a missing root means account deletion swept it
 * while this request was in flight -- and the re-created root, `trust: null`,
 * no `deletedAt`, undid the deletion. The transaction now reads the account's
 * liveness first and refuses (`AccountUnavailableError`) a root that is gone,
 * has no trust record, or is marked deleted; nothing is written.
 */
import { assertLiveAccount } from '../account/accountLiveness';
import { getStorage, userDoc, type StorageAdapter } from './index';
import type { UserDocument, UserLocale } from './userDocument';

export async function setUserLocale(
  uid: string,
  locale: UserLocale,
  at: string,
  deps: { readonly storage?: StorageAdapter } = {},
): Promise<void> {
  const storage = deps.storage ?? getStorage();
  await storage.runTransaction(async (tx) => {
    const user = await tx.get<UserDocument>(userDoc(uid));
    assertLiveAccount(user);
    if (user!.locale === locale) return;
    tx.merge<UserDocument>(userDoc(uid), { locale, updatedAt: at });
  });
}
