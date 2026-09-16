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
 * ── Why the document id is a hash of `taskRefId`, not `taskRefId` itself ──
 * `taskRefId` (`${provider}:${providerMatchId}`, #417's rule) is free text a vendor
 * handed us -- `fixtureDoc` in `lib/storage/paths.ts` makes the identical
 * argument for `FIXTURES` and is why `docIdForKey` exists at all. Hashing it
 * into the document id, rather than concatenating it into a path, means a
 * stray `/` in a provider's match id cannot split `externalTaskRefs/{a}/{b}`
 * out from under this collection. The raw id is not lost: it lives in
 * `ref.taskRefId`, which is what every reader actually keys off, and the
 * vendor's own id is `ref.identity.externalId`.
 *
 * ── Why `putRef` takes the whole ref rather than `(uid, taskRefId, ref)` ──
 * The document's address is derived from `ref.taskRefId`, so a
 * second `taskRefId` argument could disagree with the one inside the ref it
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
function refDocId(taskRefId: string): string {
  return docIdForKey(taskRefId);
}

/**
 * The full document path for `(uid, taskRefId)`'s ref. Exported (unlike
 * `refDocId` above) so `projectFixtures.ts` can `tx.get`/`tx.set`/`tx.merge`
 * this exact document from inside its own storage transaction -- see that
 * module's header ("the projection must never write `detachedAt`", Task 11's
 * race fix) for why the create/update paths now read this path a second
 * time, transactionally, rather than trusting the plain `getRef` read
 * `projectOneFixture` already did before opening a transaction at all.
 */
export function refDocPath(uid: string, taskRefId: string): string {
  return userSubDoc(uid, EXTERNAL_TASK_REFS, refDocId(taskRefId));
}

/**
 * The stored ref for `(uid, taskRefId)`, or `null` if this match has never
 * been projected for this user -- never an error. A missing ref is the
 * ordinary state for a fixture nobody has synced yet.
 */
export async function getRef<T extends ExternalTaskReference = ExternalTaskReference>(
  uid: string,
  taskRefId: string,
  deps: ExternalTaskRefStoreDeps = {},
): Promise<T | null> {
  return storageOf(deps).get<T>(refDocPath(uid, taskRefId));
}

/**
 * Writes (creates or replaces) the ref for `ref.taskRefId`.
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
  await storageOf(deps).set(refDocPath(uid, ref.taskRefId), ref);
}

/**
 * Writes `ref` the way `putRef` does, except it re-reads whatever is
 * actually stored -- inside the same storage transaction as the write --
 * and carries that row's `detachedAt`/`linkState` forward instead of
 * trusting the caller's own (necessarily earlier) copy of them.
 *
 * `projectOneFixture`'s design rule, verbatim: "a dismissal a sync can undo
 * is worse than no dismissal at all." Every one of this module's callers
 * builds its next `ref` by spreading an `ExternalTaskReference` it read
 * before doing anything else (a full sync loop's worth of work, in
 * `projectFixturesForUser`'s case) -- so by the time it is ready to write,
 * that copy's `detachedAt` may already be stale. `putRef`'s plain overwrite
 * would then re-assert `detachedAt: null` over a dismissal
 * `dismissFixtureCommitment` recorded in the meantime. This function is the
 * fix for the one caller left that still needs a write of its own (as
 * opposed to `projectFixtures.ts`'s create/update paths, which fold their
 * ref write into a transaction they already have open for the matching
 * commitment write): `projectOneFixture`'s branch 2, dropping a commitment
 * for a fixture that stopped holding time.
 *
 * ── Round 1: this used to be a plain `get` then `set`, and that gap was
 *    real, not hypothetical ──────────────────────────────────────────────
 * The first version of this function re-read the ref immediately before
 * writing but did the read and the write as two separate, unsynchronised
 * calls -- narrowing the clobber window from "the whole rest of a sync run"
 * (`putRef`'s stale-spread problem) down to "the gap between this
 * function's own `get` and `set`", but not closing it: a dismissal landing
 * in that gap was still silently overwritten, the identical failure the
 * transactional guard on the create/update paths exists to prevent, just
 * moved to a smaller window. A same-storage-transaction `tx.get` then
 * `tx.set` closes it the same way those paths do: `runTransaction` records
 * every path a callback reads and refuses to commit if any of them moved,
 * retrying instead (`memoryAdapter.ts`'s `readsStillValid`) -- so a
 * concurrent write to this exact ref, at any point between this
 * transaction's read and its commit, forces a retry that reads the
 * dismissal fresh rather than committing over it.
 * `tests/football/projectFixtures.test.ts`'s `'a dismissal landing
 * mid-write on the drop path is not undone'` proves this deterministically,
 * the same way the create/update paths' own race test does.
 *
 * `storageOf(deps)`, not the module-level `getStorage()`: this function
 * (like every other one here) must reach the storage a caller injected via
 * `deps.storage` -- a test that constructs its own adapter and passes it in
 * would otherwise have this transaction silently run against the real
 * default backend instead.
 */
export async function putRefCarryingForwardDetachment<T extends ExternalTaskReference>(
  uid: string,
  ref: T,
  deps: ExternalTaskRefStoreDeps = {},
): Promise<void> {
  const storage = storageOf(deps);
  const path = refDocPath(uid, ref.taskRefId);
  await storage.runTransaction(async (tx) => {
    const current = await tx.get<T>(path);
    const next = current?.detachedAt
      ? { ...ref, detachedAt: current.detachedAt, linkState: current.linkState }
      : ref;
    tx.set(path, next);
  });
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
