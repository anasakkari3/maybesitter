/**
 * The durable fact that an account was deleted, outside the account (#794).
 *
 * ── The race this closes ─────────────────────────────────────────
 *
 * A uid's very first request finds no trust record, asks Firebase Auth whether
 * the account exists, and then creates `users/{uid}` with a fresh trust record
 * (`requireMobileUser` -> `getOrCreateTrust`). A whole deletion can complete
 * between the Auth answer and the create: `markDeleted` finds no document to
 * mark, the sweep finds nothing to remove, and the create then writes a live
 * root that the #772 liveness fence accepts. Nothing inside `users/{uid}` can
 * remember the deletion, because the sweep removes all of it. The memory has to
 * live beside the tree.
 *
 * ── Why it is the deletion job record ────────────────────────────
 *
 * `accountDeletions/{subjectHash}` already has every property a tombstone
 * needs, so a second collection would only be a second thing to keep in step:
 *
 *   - it is written by the claim transaction, the first write of a deletion,
 *     before `markDeleted`, so a crash at any later point leaves it in place;
 *   - it is never swept (`TOP_LEVEL_COLLECTIONS_WITHOUT_USER_DATA`, held there by
 *     `tests/account/topLevelDeletionCoverage.test.ts`), and `deleteTree` cannot
 *     reach it because it is not under `users/{uid}`;
 *   - once the deletion is done it names nobody: its id is
 *     `HMAC-SHA256(pepper, uid)` and its `uid` field is dropped, which is the
 *     promise `docs/operations/ACCOUNT_DELETION.md` makes about what is kept. A
 *     tombstone keyed by the raw uid would break that promise;
 *   - it already carries a 30-day Firestore TTL (`infra/firestore-ttl.sh`). An
 *     ID token lives an hour and the race needs one in flight, so 30 days
 *     covers it with room to spare.
 *
 * A new account never meets an old tombstone: Firebase mints a fresh uid for
 * every account it creates, and nothing in this repository creates one with a
 * chosen uid.
 *
 * ── When a missing pepper is allowed (Q794-003) ──────────────────
 *
 * The id needs the deletion pepper, and a process without it cannot tell a
 * deleted uid from a new one. That is harmless only where no other process's
 * deletion can have written a tombstone, and that is a property of the storage
 * backend, not of the host: the in-memory backend (one process's private store,
 * which is every unit test and the default off Cloud Run), or Firestore bound to
 * the local emulator (`FIRESTORE_EMULATOR_HOST`). With the Firestore backend on
 * a real project — Cloud Run, or an operator shell with
 * `MAYBESITTER_STORAGE_BACKEND=firestore` like the one
 * `docs/operations/ACCOUNT_DELETION.md` runs — a missing pepper is refused.
 *
 * ── Rotation (Q794-002) ──────────────────────────────────────────
 *
 * Every tombstone written before a pepper rotation sits under the old pepper's
 * hash. `MAYBESITTER_DELETION_RECEIPT_PEPPER_PREVIOUS` names that old pepper,
 * and while it is set the lookup reads both paths in the same transaction. The
 * runbook (`docs/operations/GCP_BOOTSTRAP.md`) keeps it set for at least the
 * tombstone's 30-day TTL after a rotation. Unset, it costs nothing: one point
 * read, as before.
 */
import { createHmac } from 'node:crypto';
import { resolveStorageBackend } from '../storage';
import { requireUserId } from '../storage/paths';

export const ACCOUNT_DELETIONS = 'accountDeletions';

const PEPPER_ENV_VAR = 'MAYBESITTER_DELETION_RECEIPT_PEPPER';
/** The pepper before the last rotation, kept for the tombstone TTL after it. */
const PREVIOUS_PEPPER_ENV_VAR = 'MAYBESITTER_DELETION_RECEIPT_PEPPER_PREVIOUS';
const FIRESTORE_EMULATOR_ENV_VAR = 'FIRESTORE_EMULATOR_HOST';

/** The pepper, or a clear failure. Never logged, never defaulted. */
export function requireDeletionPepper(env: NodeJS.ProcessEnv = process.env): string {
  const pepper = env[PEPPER_ENV_VAR];
  if (!pepper) {
    throw new Error(`${PEPPER_ENV_VAR} is not set, so no deletion receipt can be proved`);
  }
  return pepper;
}

/** The pseudonymous subject of a deletion. Stable for a uid, useless without the pepper. */
export function subjectHashFor(uid: string, pepper = requireDeletionPepper()): string {
  return createHmac('sha256', pepper).update(requireUserId(uid)).digest('hex');
}

/** The deletion job record for a subject hash. */
export function deletionJobPath(subjectHash: string): string {
  return `${ACCOUNT_DELETIONS}/${subjectHash}`;
}

/**
 * Whether this process's storage backend can hold a tombstone some other
 * process wrote.
 *
 * Only two answers are "no", and both are named: the in-memory backend and
 * Firestore bound to the emulator. The Firestore backend on a real project is
 * shared wherever the process runs. A backend setting `resolveStorageBackend`
 * refuses (memory on Cloud Run) throws here too, and the caller refuses.
 */
export function storageMayHoldSharedTombstones(env: NodeJS.ProcessEnv = process.env): boolean {
  if (resolveStorageBackend(env) === 'memory') return false;
  return !env[FIRESTORE_EMULATOR_ENV_VAR];
}

/**
 * Every path a deletion of this uid could have left its tombstone at: one per
 * configured pepper (current, and the previous one while a rotation is within
 * the tombstone TTL). Empty only where `storageMayHoldSharedTombstones` says no
 * other process's deletion can be stored and this process has no pepper.
 *
 * Any one of them existing is the whole answer: in progress, done or stuck, the
 * account is going or gone.
 */
export function deletionTombstonePaths(
  uid: string,
  options: { readonly sharedStorage: boolean; readonly env?: NodeJS.ProcessEnv },
): string[] {
  return pepperedSubjectHashes(uid, options).map(deletionJobPath);
}

/**
 * `subjectHashFor` under every configured pepper: the current one first, then
 * the previous one while a rotation is within the tombstone TTL. Empty only
 * where `storageMayHoldSharedTombstones` says no other process can have
 * written under a pepper and this process has none; against shared storage a
 * missing pepper is refused.
 *
 * Also the pseudonymous key an OAuth cleanup obligation (#800) carries for the
 * provider account it would revoke, so a later connect of that account can
 * find and clear it without anything storing the account id in plaintext.
 */
export function pepperedSubjectHashes(
  subject: string,
  options: { readonly sharedStorage: boolean; readonly env?: NodeJS.ProcessEnv },
): string[] {
  requireUserId(subject);
  const env = options.env ?? process.env;
  const current = env[PEPPER_ENV_VAR];
  if (!current) {
    if (options.sharedStorage) {
      throw new Error(`${PEPPER_ENV_VAR} is not set against shared storage, so a deleted account cannot be told apart from a new one`);
    }
    return [];
  }
  const peppers = [current];
  const previous = env[PREVIOUS_PEPPER_ENV_VAR];
  if (previous && previous !== current) peppers.push(previous);
  return peppers.map((pepper) => subjectHashFor(subject, pepper));
}
