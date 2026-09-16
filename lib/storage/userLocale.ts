/**
 * Records the language the user chose in the app on `users/{uid}.locale`.
 *
 * Server-side work that runs with no request of its own -- the nightly
 * football projection titling matches -- reads this to speak the user's
 * language. Without it, a language sent on one request was used for that
 * request only, and the next night's run fell back to a device record (which a
 * user without push has none of) or English.
 *
 * A merge into an existing document, or a fresh `newUserDocument` when there
 * is none, in one transaction -- the shape `pilotTrustStore.ts` uses -- so it
 * never erases the trust record, consents or `domainVersion` beside it. The
 * field is part of `users/{uid}`, which account deletion removes as a whole
 * tree.
 */
import { getStorage, userDoc, type StorageAdapter } from './index';
import { newUserDocument, type UserDocument, type UserLocale } from './userDocument';

export async function setUserLocale(
  uid: string,
  locale: UserLocale,
  at: string,
  deps: { readonly storage?: StorageAdapter } = {},
): Promise<void> {
  const storage = deps.storage ?? getStorage();
  await storage.runTransaction(async (tx) => {
    const user = await tx.get<UserDocument>(userDoc(uid));
    if (user?.locale === locale) return;
    if (user) tx.merge<UserDocument>(userDoc(uid), { locale, updatedAt: at });
    else tx.set<UserDocument>(userDoc(uid), { ...newUserDocument(at), locale });
  });
}
