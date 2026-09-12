/**
 * Permanent account deletion (UC-1.5, #149).
 *
 * A person asks to be gone, and afterwards the only thing MaybeSitter keeps is
 * a peppered hash proving a deletion happened — no uid, no email, no content.
 * Both app stores require this; more to the point, an app that holds someone's
 * commitments has no business making them ask twice.
 *
 * ── Why it is a job record and not a function call ───────────────
 *
 * Deleting an account is several destructive steps against different systems:
 * Firestore, Firebase Auth, and whatever integrations hold a grant. A process
 * that dies halfway through — a Cloud Run instance being replaced mid-request —
 * must not leave an account that is half gone and still usable. So every run
 * writes its progress to `accountDeletions/{subjectHash}` first, each step is
 * idempotent, and a resumed run skips what is already done.
 *
 * The order matters for one reason above the rest: `markDeleted` is first, so
 * the moment anything destructive has happened the account can no longer be
 * used normally. A failure after that point leaves a user who cannot sign in
 * and a job that will be resumed — never a user quietly back in the product
 * with half their data missing.
 *
 * ── Why the receipt is pseudonymous ──────────────────────────────
 *
 * The receipt has to outlive the account: it is the answer to "prove you
 * deleted me". Keeping the uid to prove that would defeat the deletion, so the
 * subject is `HMAC-SHA256(pepper, uid)`. The pepper lives only in Secret
 * Manager, which is what stops the hash from being a lookup table over every
 * uid that ever existed — and it is why the pepper is never logged.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { getStorage, requireUserId, userDoc } from '../storage';
import type { StorageAdapter } from '../storage/storageAdapter';
import { deletionHooks, type DeletionHook } from './deletionHooks';
import { TOP_LEVEL_USER_COLLECTIONS } from './topLevelUserData';

export const ACCOUNT_DELETIONS = 'accountDeletions';
export const DELETION_RECEIPTS = 'deletionReceipts';

/** In order. `receipt` is last and closes the job. */
export const DELETION_STEPS = [
  'markDeleted',
  'revokeSessions',
  'externalRevocations',
  'topLevelDocs',
  'userTree',
  'authUser',
  'receipt',
] as const;

export type DeletionStep = (typeof DELETION_STEPS)[number];
export type StepOutcome = 'done' | 'failed' | 'skipped';

/** How long the proof is kept. Long enough to answer a dispute, not forever. */
export const RECEIPT_RETENTION_MS = 400 * 24 * 60 * 60 * 1000;
/**
 * The job record outlives the deletion only long enough to make a repeat call
 * idempotent and to carry the receipt id. It holds no identifier once `done`.
 */
export const JOB_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** A job untouched for this long is assumed to have lost its process. */
export const RESUME_AFTER_MS = 10 * 60 * 1000;
/** After this many attempts a deletion is an operator problem, not a retry. */
export const MAX_DELETION_ATTEMPTS = 5;

export interface DeletionReceipt {
  version: 'v1';
  receiptId: string;
  subjectHash: string;
  deletedAt: string;
  initiatedBy: 'user' | 'operator';
  docsDeleted: number;
  steps: Record<DeletionStep, StepOutcome>;
  /** Firestore TTL (infra/firestore-ttl.sh). */
  expiresAt: Date;
}

export interface DeletionJobRecord {
  version: 'v1';
  /** Present only while the deletion is in progress. Removed when it is done. */
  uid?: string;
  subjectHash: string;
  status: 'in_progress' | 'done' | 'stuck';
  steps: Partial<Record<DeletionStep, StepOutcome>>;
  initiatedBy: 'user' | 'operator';
  startedAt: string;
  updatedAt: string;
  attempts: number;
  docsDeleted: number;
  receiptId?: string;
  expiresAt?: Date;
}

/** The two Firebase Auth calls deletion needs, so tests can supply their own. */
export interface DeletionAuthAdmin {
  revokeRefreshTokens(uid: string): Promise<void>;
  deleteUser(uid: string): Promise<void>;
}

export interface DeleteAccountOptions {
  initiatedBy: 'user' | 'operator';
  now?: Date;
  storage?: StorageAdapter;
  auth?: DeletionAuthAdmin;
  /** Defaults to whatever is registered; tests pass their own. */
  hooks?: readonly DeletionHook[];
}

/** The pepper, or a clear failure. Never logged, never defaulted. */
function requirePepper(): string {
  const pepper = process.env.MAYBESITTER_DELETION_RECEIPT_PEPPER;
  if (!pepper) {
    throw new Error('MAYBESITTER_DELETION_RECEIPT_PEPPER is not set, so no deletion receipt can be proved');
  }
  return pepper;
}

/** The pseudonymous subject of a receipt. Stable for a uid, useless without the pepper. */
export function subjectHashFor(uid: string, pepper = requirePepper()): string {
  return createHmac('sha256', pepper).update(requireUserId(uid)).digest('hex');
}

/** Safe to log: enough to correlate, far too little to reverse. */
export function subjectTag(subjectHash: string): string {
  return subjectHash.slice(0, 12);
}

/**
 * The Auth admin a deletion uses when the caller does not pass one.
 *
 * The same seam `setTokenVerifierForTests` uses, and for the same reason: a
 * route test drives the real handler, and the handler has no parameter to hand
 * a fake through. There is no environment variable and no production path that
 * sets this.
 */
let authForTests: DeletionAuthAdmin | null = null;

export function setDeletionAuthForTests(auth: DeletionAuthAdmin | null): void {
  authForTests = auth;
}

async function defaultAuthAdmin(): Promise<DeletionAuthAdmin> {
  if (authForTests) return authForTests;
  const [{ getAuth }, { getAdminApp }] = await Promise.all([
    import('firebase-admin/auth'),
    import('../firebase/admin'),
  ]);
  const auth = getAuth(getAdminApp());
  return {
    revokeRefreshTokens: (uid) => auth.revokeRefreshTokens(uid),
    async deleteUser(uid) {
      try {
        await auth.deleteUser(uid);
      } catch (error) {
        // Already gone is the state we wanted. Anything else is real.
        if ((error as { code?: string }).code === 'auth/user-not-found') return;
        throw error;
      }
    },
  };
}

/** Deletes every top-level document carrying this uid, in bounded batches. */
async function deleteTopLevelDocs(storage: StorageAdapter, uid: string): Promise<number> {
  let deleted = 0;
  for (const { collection, field } of TOP_LEVEL_USER_COLLECTIONS) {
    // Bounded: a person with thousands of scheduled jobs must not turn one
    // deletion into one unbounded query.
    for (;;) {
      const batch = await storage.list<Record<string, unknown>>(collection, {
        where: [[field, '==', uid]],
        limit: 400,
      });
      if (batch.length === 0) break;
      for (const row of batch) {
        await storage.delete(`${collection}/${row.id}`);
        deleted += 1;
      }
      if (batch.length < 400) break;
    }
  }
  return deleted;
}

/**
 * Denies the account before anything is destroyed.
 *
 * Written straight onto the trust record rather than through
 * `applyPilotTrustAction`, because that refuses to change a deleted state and
 * this must be safe to run again on a resumed deletion.
 */
async function markDeleted(storage: StorageAdapter, uid: string, at: string): Promise<void> {
  const path = userDoc(uid);
  const user = await storage.get<{ trust?: Record<string, unknown> }>(path);
  if (!user) return; // No document: there is nothing to deny access to.
  const trust = user.trust ?? {};
  if (trust.deletedAt) return;
  await storage.runTransaction(async (tx) => {
    const current = await tx.get<{ trust?: Record<string, unknown> }>(path);
    if (!current) return;
    tx.merge<{ trust: Record<string, unknown> }>(path, {
      trust: { ...(current.trust ?? {}), deletedAt: at, updatedAt: at },
    });
  });
}

function jobPath(subjectHash: string): string {
  return `${ACCOUNT_DELETIONS}/${subjectHash}`;
}

function receiptPath(receiptId: string): string {
  return `${DELETION_RECEIPTS}/${receiptId}`;
}

/**
 * Deletes the account, or finishes a deletion that was already started.
 *
 * Safe to call twice, from two instances, or after a crash: the job record is
 * the state, and every step checks before it acts.
 */
export async function deleteAccount(uid: string, options: DeleteAccountOptions): Promise<DeletionReceipt> {
  requireUserId(uid);
  const storage = options.storage ?? getStorage();
  const now = options.now ?? new Date();
  const at = now.toISOString();
  const subjectHash = subjectHashFor(uid);
  const path = jobPath(subjectHash);

  // Claim the job. Two instances arriving together both get a record; the steps
  // below are idempotent, so the second finds the first one's work done.
  const claimed = await storage.runTransaction(async (tx) => {
    const existing = await tx.get<DeletionJobRecord>(path);
    if (existing?.status === 'done') return existing;
    const job: DeletionJobRecord = existing
      ? { ...existing, uid, status: 'in_progress', attempts: existing.attempts + 1, updatedAt: at }
      : {
          version: 'v1',
          uid,
          subjectHash,
          status: 'in_progress',
          steps: {},
          initiatedBy: options.initiatedBy,
          startedAt: at,
          updatedAt: at,
          attempts: 1,
          docsDeleted: 0,
        };
    tx.set<DeletionJobRecord>(path, job);
    return job;
  });

  // Already finished. Hand back the receipt that was written then, rather than
  // deleting an account twice and minting a second proof for one event.
  if (claimed.status === 'done' && claimed.receiptId) {
    const receipt = await storage.get<DeletionReceipt>(receiptPath(claimed.receiptId));
    if (receipt) return receipt;
  }

  const steps: Partial<Record<DeletionStep, StepOutcome>> = { ...claimed.steps };
  let docsDeleted = claimed.docsDeleted ?? 0;
  const auth = options.auth ?? (await defaultAuthAdmin());
  const hooks = options.hooks ?? deletionHooks();

  let reservedReceiptId = claimed.receiptId;

  const persist = async (status: DeletionJobRecord['status'] = 'in_progress'): Promise<void> => {
    await storage.set<DeletionJobRecord>(path, {
      ...claimed,
      uid,
      status,
      steps,
      docsDeleted,
      ...(reservedReceiptId ? { receiptId: reservedReceiptId } : {}),
      updatedAt: new Date().toISOString(),
    });
  };

  const run = async (step: DeletionStep, work: () => Promise<number | void>): Promise<void> => {
    if (steps[step] === 'done' || steps[step] === 'skipped') return;
    const count = await work();
    if (typeof count === 'number') docsDeleted += count;
    steps[step] = 'done';
    await persist();
  };

  await run('markDeleted', () => markDeleted(storage, uid, at));
  await run('revokeSessions', () => auth.revokeRefreshTokens(uid));

  // The only step allowed to fail without stopping the deletion: the user's own
  // data still goes, and the receipt says which external revocation did not.
  if (steps.externalRevocations !== 'done') {
    let anyFailed = false;
    for (const hook of hooks) {
      try {
        await hook.run(uid);
      } catch (error) {
        anyFailed = true;
        console.error(`[account/delete] hook ${hook.name} failed for ${subjectTag(subjectHash)}`, error);
      }
    }
    steps.externalRevocations = anyFailed ? 'failed' : hooks.length === 0 ? 'skipped' : 'done';
    await persist();
  }

  await run('topLevelDocs', () => deleteTopLevelDocs(storage, uid));
  await run('userTree', () => storage.deleteTree(userDoc(uid)));
  await run('authUser', () => auth.deleteUser(uid));

  // The id is reserved in the job record *before* the receipt document exists.
  // Minting it here and writing the receipt first leaves a window: a process
  // that dies between the two writes comes back to a job with no receipt id,
  // mints a second one, and one deletion ends up with two proofs. The
  // acceptance criterion is a single receipt, so the id is written down first.
  if (!reservedReceiptId) {
    reservedReceiptId = randomUUID();
    await persist();
  }
  const receiptId = reservedReceiptId;
  const receipt: DeletionReceipt = {
    version: 'v1',
    receiptId,
    subjectHash,
    deletedAt: at,
    initiatedBy: claimed.initiatedBy,
    docsDeleted,
    steps: DELETION_STEPS.reduce((all, step) => {
      all[step] = step === 'receipt' ? 'done' : steps[step] ?? 'skipped';
      return all;
    }, {} as Record<DeletionStep, StepOutcome>),
    expiresAt: new Date(now.getTime() + RECEIPT_RETENTION_MS),
  };
  await storage.set<DeletionReceipt>(receiptPath(receiptId), receipt);

  // The uid leaves the job record here: from this point the deletion is
  // provable and no longer attributable.
  const finished: DeletionJobRecord = {
    version: 'v1',
    subjectHash,
    status: 'done',
    steps: receipt.steps,
    initiatedBy: claimed.initiatedBy,
    startedAt: claimed.startedAt,
    updatedAt: new Date().toISOString(),
    attempts: claimed.attempts,
    docsDeleted,
    receiptId,
    expiresAt: new Date(now.getTime() + JOB_RETENTION_MS),
  };
  await storage.set<DeletionJobRecord>(path, finished);
  return receipt;
}

/**
 * Finishes deletions whose process went away (the UC-1.0d maintenance sweep).
 *
 * A job that has burned its attempts is marked `stuck` and logged for an
 * operator rather than retried forever — with the subject tag only, which is
 * all anyone needs to find it and all they can be given.
 */
export async function resumeStalledDeletions(options: {
  now?: Date;
  storage?: StorageAdapter;
  auth?: DeletionAuthAdmin;
  limit?: number;
} = {}): Promise<{ resumed: number; stuck: number }> {
  const storage = options.storage ?? getStorage();
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - RESUME_AFTER_MS).toISOString();

  const candidates = await storage.list<DeletionJobRecord>(ACCOUNT_DELETIONS, {
    where: [['status', '==', 'in_progress']],
    limit: options.limit ?? 20,
  });

  let resumed = 0;
  let stuck = 0;
  for (const { data: job } of candidates) {
    if (job.updatedAt > cutoff) continue;
    if (!job.uid) continue; // Nothing to finish: a done job keeps no uid.
    if (job.attempts >= MAX_DELETION_ATTEMPTS) {
      stuck += 1;
      console.error(
        `[account/delete] deletion_stuck subject=${subjectTag(job.subjectHash)} attempts=${job.attempts} steps=${JSON.stringify(job.steps)}`,
      );
      await storage.set<DeletionJobRecord>(jobPath(job.subjectHash), { ...job, status: 'stuck' });
      continue;
    }
    try {
      await deleteAccount(job.uid, {
        initiatedBy: job.initiatedBy,
        now,
        storage,
        ...(options.auth ? { auth: options.auth } : {}),
      });
      resumed += 1;
    } catch (error) {
      console.error(`[account/delete] resume failed for ${subjectTag(job.subjectHash)}`, error);
    }
  }
  return { resumed, stuck };
}
