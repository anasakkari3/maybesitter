/**
 * The scheduler store on durable storage (UC-1.0c, #142).
 *
 * Replaces `SqliteSchedulerStore`, whose database file lived on the local
 * filesystem: on Cloud Run that is per-instance and deleted with the revision,
 * so queued reminders disappeared on every deploy, and a second instance could
 * not see the first one's `BEGIN IMMEDIATE` and would run the same job again.
 *
 * ── Why claiming has to be a transaction ─────────────────────────
 *
 * `claimDueJobs` is the only operation where correctness depends on
 * concurrency. Two runners tick at the same moment, both query the same due
 * jobs, and without isolation both would claim all of them and the user would
 * get every reminder twice. The read and the claim therefore happen inside one
 * transaction: the query's result set is part of what the transaction read, so
 * a competing claim that lands first invalidates it and the loser retries and
 * sees the jobs already taken. `tests/scheduler/schedulerContention.test.ts`
 * runs two concurrent claims over ten due jobs and asserts ten claims total
 * with no duplicates.
 *
 * `claimedBy` is a per-instance id so a claim that gets stuck can be
 * attributed to the runner holding it, and `recoverClaimedJobs` can tell a
 * crashed instance's claim from a live one's.
 *
 * ── Dedupe without a UNIQUE constraint ───────────────────────────
 *
 * SQLite enforced one job per `dedupe_key` with `INSERT OR IGNORE` against a
 * unique index. Firestore has no such constraint, so the check is a query
 * inside the same transaction as the write: two concurrent creates for one key
 * cannot both commit, because the loser's query result moved underneath it.
 *
 * ── Jobs are top-level, not under users/{uid} ────────────────────
 *
 * A job is operational scheduling state, not something the user owns: the
 * runner reads across everyone at once, which a per-user tree would turn into
 * one query per account. The `uid` rides on the document instead. This is why
 * `jobs` is absent from the deletion-coverage test's user-scoped collections —
 * account deletion cancels a user's jobs rather than finding them in a tree.
 */
import { randomUUID } from 'node:crypto';
import {
  getStorage,
  requireDocId,
  type StorageAdapter,
  type StorageTransaction,
} from '../storage';
import {
  makeDedupeKey,
  type JobResult,
  type NewScheduledJob,
  type ScheduledJob,
  type SchedulerStore,
} from '../../src/scheduler/jobRunner';

/** Top-level collection. Deliberately outside every user tree — see the header. */
export const JOBS = 'jobs';

/** How long a claim may sit before a runner is assumed to have died. */
export const DEFAULT_CLAIM_RECOVERY_MS = 5 * 60 * 1000;

/** Matches the old SQLite store: three attempts before a failure is terminal. */
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 60 * 1000;

export function jobDoc(jobId: string): string {
  return `${JOBS}/${requireDocId(jobId)}`;
}

export interface StorageSchedulerStoreOptions {
  storage?: StorageAdapter;
  /**
   * Identifies this runner in `claimedBy`. Defaults to a per-store uuid, which
   * is what a separate process or Cloud Run instance would have.
   */
  instanceId?: string;
  /**
   * The collection to use instead of `jobs`.
   *
   * Exists for the emulator suite, which keeps one database for the whole
   * `firebase emulators:exec` run: `claimDueJobs` claims every due job in the
   * collection, so two test files sharing `jobs` would claim each other's and
   * the contention assertions would be measuring the wrong thing. Production
   * never passes this.
   */
  collection?: string;
}

function newJob(job: NewScheduledJob, now: string): ScheduledJob {
  return {
    id: job.id,
    uid: job.uid ?? null,
    jobType: job.jobType,
    targetType: job.targetType,
    targetId: job.targetId,
    dedupeKey: job.dedupeKey || makeDedupeKey(job),
    runAt: job.runAt,
    status: 'pending',
    result: null,
    claimedAt: null,
    claimedBy: null,
    completedAt: null,
    failedAt: null,
    lastError: null,
    attempts: 0,
    payload: job.payload || {},
    createdAt: now,
    updatedAt: now,
  };
}

export class StorageSchedulerStore implements SchedulerStore {
  private readonly instanceId: string;
  private readonly injected: StorageAdapter | undefined;
  private readonly collection: string;

  constructor(options: StorageSchedulerStoreOptions = {}) {
    this.injected = options.storage;
    this.instanceId = options.instanceId ?? randomUUID();
    this.collection = options.collection ?? JOBS;
  }

  private doc(jobId: string): string {
    return `${this.collection}/${requireDocId(jobId)}`;
  }

  /**
   * Resolved per call rather than captured in the constructor, so a test that
   * swaps the adapter with `setStorageForTests` after building the store still
   * talks to the store it installed.
   */
  private get storage(): StorageAdapter {
    return this.injected ?? getStorage();
  }

  async createJob(job: NewScheduledJob): Promise<ScheduledJob | null> {
    const now = new Date().toISOString();
    const candidate = newJob(job, now);

    return this.storage.runTransaction(async (tx) => {
      // The dedupe check and the write are in one transaction: two concurrent
      // creates for the same key cannot both commit, because the loser's query
      // result moved underneath it.
      const existing = await tx.list<ScheduledJob>(this.collection, {
        where: [['dedupeKey', '==', candidate.dedupeKey]],
        limit: 1,
      });
      const held = existing[0];
      // Matches the old INSERT OR IGNORE + re-select: the key is taken by a
      // different job, so this one is a duplicate and is not created.
      if (held && held.data.id !== candidate.id) return null;
      if (held) return held.data;

      tx.set<ScheduledJob>(this.doc(candidate.id), candidate);
      return candidate;
    });
  }

  async claimDueJobs(now: string, limit = 25): Promise<ScheduledJob[]> {
    return this.storage.runTransaction(async (tx) => {
      const due = await tx.list<ScheduledJob>(this.collection, {
        where: [['status', '==', 'pending'], ['runAt', '<=', now]],
        orderBy: { field: 'runAt', direction: 'asc' },
        limit,
      });

      // Every read happens before any write: Firestore refuses the other order
      // and the memory adapter raises the identical error, so this loop builds
      // the claimed rows first and writes them after.
      const claimed = due.map(({ data }) => ({
        ...data,
        status: 'claimed' as const,
        claimedAt: now,
        claimedBy: this.instanceId,
        attempts: data.attempts + 1,
        updatedAt: now,
      }));
      for (const job of claimed) tx.set<ScheduledJob>(this.doc(job.id), job);
      return claimed;
    });
  }

  async completeJob(id: string, now: string, result: JobResult = 'success'): Promise<void> {
    await this.patch(id, (job) => ({
      ...job,
      status: 'completed',
      result,
      completedAt: now,
      updatedAt: now,
    }));
  }

  async failJob(id: string, now: string, error: string, retry = true): Promise<void> {
    await this.patch(id, (job) => {
      // Retry budget is the attempt count the claim already incremented, so a
      // job that keeps being claimed and failing cannot retry forever.
      if (retry && job.attempts < MAX_ATTEMPTS) {
        return {
          ...job,
          status: 'pending',
          result: null,
          runAt: new Date(Date.parse(now) + RETRY_DELAY_MS).toISOString(),
          claimedAt: null,
          claimedBy: null,
          failedAt: now,
          lastError: error,
          updatedAt: now,
        };
      }
      return {
        ...job,
        status: 'failed',
        result: 'failed',
        failedAt: now,
        lastError: error,
        updatedAt: now,
      };
    });
  }

  async recoverClaimedJobs(now: string, olderThanMs = DEFAULT_CLAIM_RECOVERY_MS): Promise<number> {
    const cutoff = new Date(Date.parse(now) - olderThanMs).toISOString();
    return this.storage.runTransaction(async (tx) => {
      const stuck = await tx.list<ScheduledJob>(this.collection, {
        where: [['status', '==', 'claimed'], ['claimedAt', '<=', cutoff]],
      });
      // Attempts are deliberately not reset: a job that repeatedly kills the
      // runner holding it must still exhaust its budget rather than loop.
      const recovered = stuck.map(({ data }) => ({
        ...data,
        status: 'pending' as const,
        claimedAt: null,
        claimedBy: null,
        updatedAt: now,
      }));
      for (const job of recovered) tx.set<ScheduledJob>(this.doc(job.id), job);
      return recovered.length;
    });
  }

  async listJobs(): Promise<ScheduledJob[]> {
    const rows = await this.storage.list<ScheduledJob>(this.collection, {
      orderBy: { field: 'createdAt', direction: 'asc' },
    });
    return rows.map((row) => row.data);
  }

  /** Read-modify-write in one transaction, so a concurrent claim is not lost. */
  private async patch(id: string, change: (job: ScheduledJob) => ScheduledJob): Promise<void> {
    await this.storage.runTransaction(async (tx: StorageTransaction) => {
      const current = await tx.get<ScheduledJob>(this.doc(id));
      if (!current) return;
      tx.set<ScheduledJob>(this.doc(id), change(current));
    });
  }
}

export function createStorageSchedulerStore(options?: StorageSchedulerStoreOptions): StorageSchedulerStore {
  return new StorageSchedulerStore(options);
}
