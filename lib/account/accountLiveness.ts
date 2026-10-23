/**
 * Whether a `users/{uid}` document still describes a live account (#772).
 *
 * Account deletion marks `trust.deletedAt` and later sweeps the whole user
 * tree. A request that authenticated before either step can still be on its
 * way to a write, and a write that lands afterwards re-creates documents under
 * an account the person deleted. Every user-content writer therefore reads the
 * user document inside its own transaction and refuses when this answers false:
 * a document that is gone (swept) or one that carries `trust.deletedAt`.
 *
 * A missing document is not "a new user". Authentication creates the trust
 * record on a uid's first request (`lib/auth/mobileAuth.ts`), so every
 * legitimate write finds the document already there.
 */
import { userDoc } from '../storage/paths';
import type { StorageReader } from '../storage/storageAdapter';

/** The account is gone or being deleted; nothing may be written under it. */
export class AccountUnavailableError extends Error {
  constructor() {
    super('account_unavailable');
    this.name = 'AccountUnavailableError';
  }
}

export function liveAccount(user: unknown): boolean {
  return user !== null && user !== undefined
    && !(user as { trust?: { deletedAt?: unknown } | null }).trust?.deletedAt;
}

/** Throws `AccountUnavailableError` unless `user` is a live account's document. */
export function assertLiveAccount(user: unknown): void {
  if (!liveAccount(user)) throw new AccountUnavailableError();
}

/** One point read of `users/{uid}`, refused unless the account is live. */
export async function requireLiveAccount(reader: StorageReader, uid: string): Promise<unknown> {
  const user = await reader.get(userDoc(uid));
  assertLiveAccount(user);
  return user;
}

/**
 * What a deleted account is answered today (`requireMobileUser`): 403 with
 * `reason: 'deleted'`. A write refused by the fence gets the same answer, so
 * the client cannot tell which of the two checks caught it.
 */
export function accountUnavailableResponse(): Response {
  return Response.json(
    { success: false, error: 'this account was deleted', reason: 'deleted' },
    { status: 403 },
  );
}
