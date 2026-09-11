/**
 * The scheduler's job contract and its runner (UC-1.0c, #142).
 *
 * ── What replaced the SQLite store ──────────────────────────────
 *
 * `SqliteSchedulerStore` opened a database file on the local filesystem. On
 * Cloud Run that file is per-instance and thrown away with the revision, so
 * every scheduled reminder a user had queued would vanish on the next deploy —
 * and a second instance would happily claim and run the same job, because it
 * could not see the first instance's `BEGIN IMMEDIATE`. Reminders are the one
 * thing this product must not drop or double-send.
 *
 * Jobs now live in `jobs/{jobId}` on the storage adapter
 * (`lib/scheduler/storageSchedulerStore`). They are deliberately **top-level
 * and not under `users/{uid}`**: a job is operational scheduling state rather
 * than something the user owns, the runner reads across everyone at once, and
 * account deletion cancels a job rather than needing to find it inside a tree.
 * The `uid` travels on the document instead, so a job can still say who it is
 * for.
 *
 * ── Every store method is async ──────────────────────────────────
 *
 * The interface returns promises because a durable store is a network call.
 * That is the whole reason `claimDueJobs` can now be a real transaction
 * instead of a lock one process can see.
 */
import { InvalidStateTransitionError, MissingEntityError, ValidationError } from '../domain/stateMachine';
import type { Command } from '../domain/stateMachine';

export type JobStatus = 'pending' | 'claimed' | 'completed' | 'cancelled' | 'failed';
export type JobType = 'reminder_due' | 'ignored_check' | 'escalation_check';
export type JobResult = 'success' | 'no-op' | 'failed';

export interface ScheduledJob {
  id: string;
  /**
   * Who the job is for. Nullable only until UC-1.0e (#144) makes every request
   * carry an identity; the legacy no-participant path still creates jobs.
   */
  uid: string | null;
  jobType: JobType;
  targetType: 'reminder' | 'commitment';
  targetId: string;
  dedupeKey: string;
  runAt: string;
  status: JobStatus;
  result: JobResult | null;
  claimedAt: string | null;
  /** The instance that claimed it, so a stuck claim can be attributed. */
  claimedBy: string | null;
  completedAt: string | null;
  failedAt: string | null;
  lastError: string | null;
  attempts: number;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface NewScheduledJob {
  id: string;
  uid?: string | null;
  jobType: JobType;
  targetType: 'reminder' | 'commitment';
  targetId: string;
  runAt: string;
  payload?: Record<string, unknown>;
  dedupeKey?: string;
}

export interface SchedulerStore {
  /** Creates the job, or returns null when its dedupe key is already taken. */
  createJob(job: NewScheduledJob): Promise<ScheduledJob | null>;
  /** Atomically marks due pending jobs claimed. No job is ever claimed twice. */
  claimDueJobs(now: string, limit?: number): Promise<ScheduledJob[]>;
  completeJob(id: string, now: string, result?: JobResult): Promise<void>;
  failJob(id: string, now: string, error: string, retry?: boolean): Promise<void>;
  /** Returns claims older than the cutoff to pending. Returns how many. */
  recoverClaimedJobs(now: string, olderThanMs?: number): Promise<number>;
  listJobs(): Promise<ScheduledJob[]>;
}

export function makeDedupeKey(job: Pick<NewScheduledJob, 'jobType' | 'targetType' | 'targetId' | 'runAt'>): string {
  return `${job.jobType}:${job.targetType}:${job.targetId}:${job.runAt}`;
}

export interface JobRunResult {
  claimed: number;
  completed: number;
  noOp: number;
  failed: number;
  commands: Command[];
}

export type CommandHandlerResult = void | { result: 'applied' | 'noop' | 'rejected' };
/**
 * Applies one job's command. It receives the job as well as the command
 * because the command alone does not say *whose* state it applies to — a
 * `ReminderTriggered` names a reminder, not a user — and on the launch path
 * each user's state lives in its own `users/{uid}` tree (UC-1.0d, #143).
 * Handlers that only need the command may ignore the second argument.
 */
export type CommandHandler = (command: Command, job: ScheduledJob) => CommandHandlerResult | Promise<CommandHandlerResult>;

function normalizeCommandHandlerResult(result: CommandHandlerResult): 'applied' | 'noop' | 'rejected' {
  return result?.result || 'applied';
}

function ignoredCheckJob(reminderId: string, runAt: string, uid: string | null): NewScheduledJob {
  return {
    id: `job_ignored_${reminderId}_${Date.parse(runAt)}`,
    uid,
    jobType: 'ignored_check',
    targetType: 'reminder',
    targetId: reminderId,
    runAt,
    payload: { reminderId },
  };
}

export async function runDueJobs(
  store: SchedulerStore,
  handleCommand: CommandHandler,
  now: Date = new Date()
): Promise<JobRunResult> {
  const nowIso = now.toISOString();
  await store.recoverClaimedJobs(nowIso);
  const jobs = await store.claimDueJobs(nowIso, 25);
  const result: JobRunResult = { claimed: jobs.length, completed: 0, noOp: 0, failed: 0, commands: [] };

  for (const job of jobs) {
    try {
      let command: Command;
      if (job.jobType === 'reminder_due') {
        const reminderId = String(job.payload.reminderId || job.targetId);
        command = { type: 'ReminderTriggered', reminderId, now: nowIso };
        const commandResult = normalizeCommandHandlerResult(await handleCommand(command, job));
        result.commands.push(command);
        if (commandResult === 'rejected') {
          await store.failJob(job.id, nowIso, 'Command rejected', false);
          result.failed += 1;
          continue;
        }
        if (commandResult === 'noop') {
          await store.completeJob(job.id, nowIso, 'no-op');
          result.completed += 1;
          result.noOp += 1;
          continue;
        }
        if (job.payload.requiresAction !== false) {
          const ignoredAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
          await store.createJob(ignoredCheckJob(reminderId, ignoredAt, job.uid));
        }
      } else if (job.jobType === 'ignored_check') {
        command = { type: 'ReminderIgnored', reminderId: String(job.payload.reminderId || job.targetId), now: nowIso };
        const commandResult = normalizeCommandHandlerResult(await handleCommand(command, job));
        result.commands.push(command);
        if (commandResult === 'rejected') {
          await store.failJob(job.id, nowIso, 'Command rejected', false);
          result.failed += 1;
          continue;
        }
        if (commandResult === 'noop') {
          await store.completeJob(job.id, nowIso, 'no-op');
          result.completed += 1;
          result.noOp += 1;
          continue;
        }
      } else if (job.jobType === 'escalation_check') {
        command = { type: 'EscalationTriggered', commitmentId: String(job.payload.commitmentId || job.targetId), now: nowIso };
        const commandResult = normalizeCommandHandlerResult(await handleCommand(command, job));
        result.commands.push(command);
        if (commandResult === 'rejected') {
          await store.failJob(job.id, nowIso, 'Command rejected', false);
          result.failed += 1;
          continue;
        }
        if (commandResult === 'noop') {
          await store.completeJob(job.id, nowIso, 'no-op');
          result.completed += 1;
          result.noOp += 1;
          continue;
        }
      } else {
        throw new Error(`Unsupported job type: ${job.jobType}`);
      }

      await store.completeJob(job.id, nowIso, 'success');
      result.completed += 1;
    } catch (error) {
      if (error instanceof InvalidStateTransitionError) {
        await store.completeJob(job.id, nowIso, 'no-op');
        result.completed += 1;
        result.noOp += 1;
        continue;
      }
      if (error instanceof MissingEntityError || error instanceof ValidationError) {
        await store.failJob(job.id, nowIso, error.message, false);
        result.failed += 1;
        continue;
      }
      await store.failJob(job.id, nowIso, error instanceof Error ? error.message : 'Unknown job failure', true);
      result.failed += 1;
    }
  }

  return result;
}
