/**
 * Whether a `users/{uid}` document still describes a live account (#772).
 *
 * Account deletion marks `trust.deletedAt` and later sweeps the whole user
 * tree. A request that authenticated before either step can still be on its
 * way to a write, and a write that lands afterwards re-creates documents under
 * an account the person deleted. Every user-content writer therefore reads the
 * user document inside its own transaction and refuses when this answers false:
 * a document that is gone (swept), one without a valid trust record, or one
 * whose trust record carries `deletedAt`.
 *
 * A missing document is not "a new user". Authentication creates the trust
 * record on a uid's first request and re-reads it on every request
 * (`requireMobileUser` -> `getOrCreateTrust`, which validates it with
 * `requirePilotTrustState`), so every legitimate write finds the document
 * already there, trust record included.
 *
 * ── Why the trust record is required, not just the document (Q772-001) ──
 * Some writers re-create `users/{uid}` without a trust record: a merge into a
 * missing document, or `newUserDocument` (`trust: null`). After a sweep, such
 * a write left a root that carried no `deletedAt` and so looked live, and the
 * next domain write in the same request was accepted under an account the
 * person had deleted. A root no authentication could have produced is not a
 * live account.
 */
import { requirePilotTrustState } from '../pilot/closedPilotControls';
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
  if (!user || typeof user !== 'object') return false;
  let trust;
  try {
    trust = requirePilotTrustState((user as { trust?: unknown }).trust);
  } catch {
    return false;
  }
  return trust.deletedAt === null;
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
