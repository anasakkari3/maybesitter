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
 * The full document path for `(uid, externalId)`'s ref. Exported (unlike
 * `refDocId` above) so `projectFixtures.ts` can `tx.get`/`tx.set`/`tx.merge`
 * this exact document from inside its own storage transaction -- see that
 * module's header ("the projection must never write `detachedAt`", Task 11's
 * race fix) for why the create/update paths now read this path a second
 * time, transactionally, rather than trusting the plain `getRef` read
 * `projectOneFixture` already did before opening a transaction at all.
 */
export function refDocPath(uid: string, externalId: string): string {
  return userSubDoc(uid, EXTERNAL_TASK_REFS, refDocId(externalId));
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
  return storageOf(deps).get<T>(refDocPath(uid, externalId));
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
  await storageOf(deps).set(refDocPath(uid, ref.identity.externalId), ref);
}

/**
 * Writes `ref` the way `putRef` does, except it re-reads whatever is
 * actually stored immediately beforehand and carries that row's
 * `detachedAt`/`linkState` forward instead of trusting the caller's own
 * (necessarily earlier) copy of them.
 *
 * `projectOneFixture`'s design rule, verbatim: "a dismissal a sync can undo
 * is worse than no dismissal at all." Every one of this module's callers
 * builds its next `ref` by spreading an `ExternalTaskReference` it read
 * before doing anything else (a full sync loop's worth of work, in
 * `projectFixturesForUser`'s case) -- so by the time it is ready to write,
 * that copy's `detachedAt` may already be stale. `putRef`'s plain overwrite
 * would then re-assert `detachedAt: null` over a dismissal
 * `dismissFixtureCommitment` recorded in the meantime. This function is the
 * fix for the one caller left that still needs a plain (non-transactional)
 * write: `projectOneFixture`'s branch 2, dropping a commitment for a
 * fixture that stopped holding time. See `projectFixtures.ts`'s module
 * header for why the *create/update* branches use a stronger fix instead (a
 * same-transaction re-read, not a same-function-call one) -- dropping never
 * resurrects anything a dismissal did not already want dropped, so a
 * same-call re-read closes the only risk that write still carries.
 *
 * Still not a transaction -- see `putRef`'s own header for the argument that
 * a transaction here would have nothing concurrent to protect against
 * *before* this task; this function narrows the one window that argument no
 * longer covers, without claiming to close it completely (a second dismissal
 * landing in the instant between this function's own read and its write is
 * still possible in principle -- vanishingly narrow, and self-correcting the
 * moment `dismissFixtureCommitment` is called again, the same residual
 * accepted throughout this codebase's non-transactional reads-then-writes).
 */
export async function putRefCarryingForwardDetachment<T extends ExternalTaskReference>(
  uid: string,
  ref: T,
  deps: ExternalTaskRefStoreDeps = {},
): Promise<void> {
  const storage = storageOf(deps);
  const path = refDocPath(uid, ref.identity.externalId);
  const current = await storage.get<T>(path);
  const next = current?.detachedAt
    ? { ...ref, detachedAt: current.detachedAt, linkState: current.linkState }
    : ref;
  await storage.set(path, next);
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
