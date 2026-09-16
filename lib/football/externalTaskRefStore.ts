/**
 * The store for one user's `ExternalTaskReference` rows (football fixtures
 * MVP, Task 8).
 *
 * ── What this is, and is not ──────────────────────────────────────────────
 * A thin read/write seam over `EXTERNAL_TASK_REFS`
 * (`users/{uid}/externalTaskRefs`), mirroring `lib/services/calendar/
 * deviceCalendarLinks.ts`: a pointer stored *beside* a commitment, addressed
 * by a stable key, never itself a domain aggregate. It holds no policy of its
 * own -- the projection in `projectFixtures.ts` decides what a ref means and
 * when to write one; this module only gets, sets and lists them.
 *
 * ── Why the document id is a hash of `externalId`, not `externalId` itself ─
 * `externalId` (`${provider}:${providerMatchId}`) is free text a vendor
 * handed us -- `fixtureDoc` in `lib/storage/paths.ts` makes the identical
 * argument for `FIXTURES` and is why `docIdForKey` exists at all. Hashing it
 * into the document id, rather than concatenating it into a path, means a
 * stray `/` in a provider's match id cannot split `externalTaskRefs/{a}/{b}`
 * out from under this collection. The raw id is not lost: it lives in
 * `ref.identity.externalId`, which is what every reader actually keys off.
 *
 * ── Why `putRef` takes the whole ref rather than `(uid, externalId, ref)` ──
 * The document's address is derived from `ref.identity.externalId`, so a
 * second `externalId` argument could disagree with the one inside the ref it
 * is about to overwrite -- silently splitting one match's history across two
 * documents. Deriving the path from the ref itself makes that class of bug
 * impossible to construct rather than merely wrong to construct.
 */
import { getStorage, type StorageAdapter } from '../storage';
import { EXTERNAL_TASK_REFS, docIdForKey, userCol, userSubDoc } from '../storage/paths';
import type { ExternalTaskReference } from '../../src/contracts/v1/externalTaskContracts';

export interface ExternalTaskRefStoreDeps {
  readonly storage?: StorageAdapter;
}

function storageOf(deps: ExternalTaskRefStoreDeps): StorageAdapter {
  return deps.storage ?? getStorage();
}

/** The document id for a ref, derived the same way `fixtureDoc` derives one. */
function refDocId(externalId: string): string {
  return docIdForKey(externalId);
}

/**
 * The stored ref for `(uid, externalId)`, or `null` if this match has never
 * been projected for this user -- never an error. A missing ref is the
 * ordinary state for a fixture nobody has synced yet.
 */
export async function getRef<T extends ExternalTaskReference = ExternalTaskReference>(
  uid: string,
  externalId: string,
  deps: ExternalTaskRefStoreDeps = {},
): Promise<T | null> {
  return storageOf(deps).get<T>(userSubDoc(uid, EXTERNAL_TASK_REFS, refDocId(externalId)));
}

/**
 * Writes (creates or replaces) the ref for `ref.identity.externalId`.
 *
 * A plain `set`, not a transaction: the caller (`projectFixtures.ts`) already
 * reads the current ref, decides what the next one should be, and writes it
 * back inside the same single-fixture step it applied the matching domain
 * command in -- there is no concurrent writer of one user's own ref that a
 * transaction here would be protecting against, only the sequencing within a
 * single projection run, which the caller already owns.
 */
export async function putRef<T extends ExternalTaskReference>(
  uid: string,
  ref: T,
  deps: ExternalTaskRefStoreDeps = {},
): Promise<void> {
  await storageOf(deps).set(userSubDoc(uid, EXTERNAL_TASK_REFS, refDocId(ref.identity.externalId)), ref);
}

/**
 * Every ref this user holds, in no particular order.
 *
 * Used by `dismissFixtureCommitment` to find the ref that names a given
 * commitment -- there is no secondary index from commitment id back to ref,
 * because a user follows at most a handful of clubs and a season's worth of
 * fixtures for them is a small list, not one worth indexing for.
 */
export async function listRefs<T extends ExternalTaskReference = ExternalTaskReference>(
  uid: string,
  deps: ExternalTaskRefStoreDeps = {},
): Promise<readonly T[]> {
  const rows = await storageOf(deps).list<T>(userCol(uid, EXTERNAL_TASK_REFS));
  return rows.map((row) => row.data);
}
