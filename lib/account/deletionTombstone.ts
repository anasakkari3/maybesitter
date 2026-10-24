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
 * ── Rotation (Q794-002, #798) ────────────────────────────────────
 *
 * Every tombstone written before a pepper rotation sits under the old pepper's
 * hash. `MAYBESITTER_DELETION_RECEIPT_PEPPER_PREVIOUS` names that old pepper,
 * and while it is set the lookup reads both paths in the same transaction.
 * Unset, it costs nothing: one point read, as before.
 *
 * Reading both keys is not enough on its own. During a deploy two revisions
 * serve at once, and a revision that knows only the old key misses a tombstone
 * a revision on the new key wrote. So the key that *names new jobs* is chosen
 * separately, by `MAYBESITTER_DELETION_RECEIPT_PEPPER_WRITE` (`current`, the
 * default, or `previous`), and a rotation is two deploys:
 *
 *   phase 1  PEPPER=new, PREVIOUS=old, WRITE=previous: this revision reads both
 *            keys and still writes the old one, which every older revision reads;
 *   phase 2  WRITE=current, deployed only once no phase-0 revision serves: every
 *            live revision now reads both keys, so writing the new one is safe.
 *
 * The invariant is that the key any live revision writes is a key every live
 * revision reads. `infra/cloudrun/flags.sh` emits exactly these phases from
 * `infra/cloudrun/pepper-rotation.env`, and the runbook is
 * `docs/operations/GCP_BOOTSTRAP.md`, "Rotating the deletion-receipt pepper".
 *
 * A job is found by every configured key before a new one is minted
 * (`deletionJobLocations`), and a stalled job is resumed at the path it is
 * stored at, never at one re-derived from its uid, so a job begun under the old
 * key is finished under the old key.
 */
import { createHmac } from 'node:crypto';
import { resolveStorageBackend } from '../storage';
import { requireUserId } from '../storage/paths';

export const ACCOUNT_DELETIONS = 'accountDeletions';

const PEPPER_ENV_VAR = 'MAYBESITTER_DELETION_RECEIPT_PEPPER';
/** The pepper before the last rotation, kept for the tombstone TTL after it. */
const PREVIOUS_PEPPER_ENV_VAR = 'MAYBESITTER_DELETION_RECEIPT_PEPPER_PREVIOUS';
/** Which of the two names new deletion jobs: `current` (default) or `previous`. */
const WRITE_ENV_VAR = 'MAYBESITTER_DELETION_RECEIPT_PEPPER_WRITE';
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
 * the tombstone TTL), the key new records are written under first (#798).
 * Empty only where `storageMayHoldSharedTombstones` says no other process's
 * deletion can be stored and this process has no pepper.
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
 * `subjectHashFor` under every configured pepper (the current one, and the
 * previous one while a rotation is within the tombstone TTL), the key new
 * records are written under first (#798): `MAYBESITTER_DELETION_RECEIPT_PEPPER_WRITE`
 * decides which, so a writer that takes the first entry writes the key every
 * live revision reads during either phase of a rotation. Empty only
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
  return orderedPeppers(current, env, { strict: false }).map((pepper) => subjectHashFor(subject, pepper));
}

export type DeletionPepperWrite = 'current' | 'previous';

/**
 * The configured peppers, each once, the one new records are written under
 * first (#798). Readers do not care about the order; a writer that takes the
 * first entry (a deletion job, an OAuth cleanup obligation's `accountKey`)
 * then writes the key every live revision reads during phase 1.
 *
 * `strict` is for writers: a selector that cannot be honoured throws. A reader
 * never throws over the selector -- it reads every key either way, and refusing
 * a first request over a writer setting would turn a typo into an outage.
 */
function orderedPeppers(current: string, env: NodeJS.ProcessEnv, options: { readonly strict: boolean }): string[] {
  const previous = env[PREVIOUS_PEPPER_ENV_VAR] || undefined;
  let write: DeletionPepperWrite = 'current';
  try {
    write = deletionPepperWrite(env);
  } catch (error) {
    if (options.strict) throw error;
  }
  if (write === 'previous' && !previous) {
    if (options.strict) throw new Error(`${WRITE_ENV_VAR}=previous needs ${PREVIOUS_PEPPER_ENV_VAR}`);
    write = 'current';
  }
  const ordered = write === 'previous' ? [previous!, current] : previous ? [current, previous] : [current];
  return ordered.filter((pepper, index) => ordered.indexOf(pepper) === index);
}

/**
 * Which configured pepper names a new deletion job (#798). Anything but the two
 * known values is refused rather than read as the default: a typo here during
 * phase 1 would otherwise write the new key while older revisions read only the
 * old one.
 */
export function deletionPepperWrite(env: NodeJS.ProcessEnv = process.env): DeletionPepperWrite {
  const value = env[WRITE_ENV_VAR];
  if (value === undefined || value === '' || value === 'current') return 'current';
  if (value === 'previous') return 'previous';
  throw new Error(`${WRITE_ENV_VAR} must be "current" or "previous"`);
}

/** Where a deletion job record lives, and the subject hash that is its id. */
export interface DeletionJobLocation {
  readonly path: string;
  readonly subjectHash: string;
}

/** The location of a job already stored at `accountDeletions/{id}`. No pepper is needed. */
export function storedDeletionJobLocation(id: string): DeletionJobLocation {
  if (!/^[0-9a-f]{64}$/.test(id)) throw new Error('a deletion job id is not a subject hash');
  return { path: deletionJobPath(id), subjectHash: id };
}

/**
 * Every place a deletion job for this uid can be, the one a new job is written
 * at first (#798). A deletion request reads all of them before it mints a job,
 * so a repeat request during or after a rotation finds the job or tombstone the
 * other key wrote instead of starting a second deletion.
 *
 * `WRITE=previous` without a previous pepper is refused: there is no old key to
 * keep writing, and guessing the current one is the #794 gap this exists for.
 */
export function deletionJobLocations(uid: string, env: NodeJS.ProcessEnv = process.env): DeletionJobLocation[] {
  requireUserId(uid);
  const current = requireDeletionPepper(env);
  return orderedPeppers(current, env, { strict: true }).map((pepper) => {
    const subjectHash = subjectHashFor(uid, pepper);
    return { path: deletionJobPath(subjectHash), subjectHash };
  });
}
