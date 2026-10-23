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
 * ── Why the pepper is optional off Cloud Run ─────────────────────
 *
 * The id needs the deletion pepper. `deleteAccount` computes the subject hash
 * before its first write, so a process without the pepper cannot have started a
 * deletion and there is no tombstone to look for — which is every local and
 * test process that never deletes anything. On Cloud Run the pepper is a
 * deployed secret (`infra/cloudrun/flags.sh`), and its absence there is refused
 * rather than read as "nobody was ever deleted".
 */
import { createHmac } from 'node:crypto';
import { requireUserId } from '../storage/paths';

export const ACCOUNT_DELETIONS = 'accountDeletions';

const PEPPER_ENV_VAR = 'MAYBESITTER_DELETION_RECEIPT_PEPPER';
/** Set by Cloud Run on every revision. */
const CLOUD_RUN_ENV_VAR = 'K_SERVICE';

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
 * Where a deletion of this uid would have left its tombstone, or `null` when
 * this process cannot have deleted anyone (no pepper, not on Cloud Run).
 *
 * The document exists from the moment a deletion is claimed. Its presence is
 * the whole answer: in progress, done or stuck, the account is going or gone.
 */
export function deletionTombstonePath(uid: string, env: NodeJS.ProcessEnv = process.env): string | null {
  requireUserId(uid);
  if (!env[PEPPER_ENV_VAR]) {
    if (env[CLOUD_RUN_ENV_VAR]) {
      throw new Error(`${PEPPER_ENV_VAR} is not set on Cloud Run, so a deleted account cannot be told apart from a new one`);
    }
    return null;
  }
  return deletionJobPath(subjectHashFor(uid, requireDeletionPepper(env)));
}
