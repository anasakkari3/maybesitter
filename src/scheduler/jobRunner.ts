import { createRequire } from 'module';
import { InvalidStateTransitionError, MissingEntityError, ValidationError } from '../domain/stateMachine';
import type { Command } from '../domain/stateMachine';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (filename: string) => DatabaseSyncLike;
};

export type JobStatus = 'pending' | 'claimed' | 'completed' | 'cancelled' | 'failed';
export type JobType = 'reminder_due' | 'ignored_check' | 'escalation_check';
export type JobResult = 'success' | 'no-op' | 'failed';

export interface ScheduledJob {
  id: string;
  jobType: JobType;
  targetType: 'reminder' | 'commitment';
  targetId: string;
  dedupeKey: string;
  runAt: string;
  status: JobStatus;
  result: JobResult | null;
  claimedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  attempts: number;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface NewScheduledJob {
  id: string;
  jobType: JobType;
  targetType: 'reminder' | 'commitment';
  targetId: string;
  runAt: string;
  payload?: Record<string, unknown>;
  dedupeKey?: string;
}

interface StatementSyncLike {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}

interface DatabaseSyncLike {
  exec(sql: string): void;
  prepare(sql: string): StatementSyncLike;
  close(): void;
}

export interface SchedulerStore {
  createJob(job: NewScheduledJob): ScheduledJob | null;
  claimDueJobs(now: string, limit?: number): ScheduledJob[];
  completeJob(id: string, now: string, result?: JobResult): void;
  failJob(id: string, now: string, error: string, retry?: boolean): void;
  recoverClaimedJobs(now: string, olderThanMs?: number): number;
  listJobs(): ScheduledJob[];
  close(): void;
}

type RawJobRow = {
  id: string;
  job_type: JobType;
  target_type: 'reminder' | 'commitment';
  target_id: string;
  dedupe_key: string;
  run_at: string;
  status: JobStatus;
  result: JobResult | null;
  claimed_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  attempts: number;
  payload_json: string;
  created_at: string;
  updated_at: string;
};

function toJob(row: RawJobRow): ScheduledJob {
  return {
    id: row.id,
    jobType: row.job_type,
    targetType: row.target_type,
    targetId: row.target_id,
    dedupeKey: row.dedupe_key,
    runAt: row.run_at,
    status: row.status,
    result: row.result,
    claimedAt: row.claimed_at,
    completedAt: row.completed_at,
    failedAt: row.failed_at,
    attempts: row.attempts,
    payload: JSON.parse(row.payload_json || '{}') as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function makeDedupeKey(job: Pick<NewScheduledJob, 'jobType' | 'targetType' | 'targetId' | 'runAt'>): string {
  return `${job.jobType}:${job.targetType}:${job.targetId}:${job.runAt}`;
}

export class SqliteSchedulerStore implements SchedulerStore {
  private db: DatabaseSyncLike;

  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scheduled_jobs (
        id TEXT PRIMARY KEY,
        job_type TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        dedupe_key TEXT NOT NULL UNIQUE,
        run_at TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT NULL,
        claimed_at TEXT NULL,
        completed_at TEXT NULL,
        failed_at TEXT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.ensureResultColumn();
  }

  private ensureResultColumn(): void {
    const columns = this.db.prepare('PRAGMA table_info(scheduled_jobs)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'result')) {
      this.db.exec('ALTER TABLE scheduled_jobs ADD COLUMN result TEXT NULL');
    }
  }

  createJob(job: NewScheduledJob): ScheduledJob | null {
    const now = new Date().toISOString();
    const dedupeKey = job.dedupeKey || makeDedupeKey(job);
    this.db.prepare(`
      INSERT OR IGNORE INTO scheduled_jobs (
        id, job_type, target_type, target_id, dedupe_key, run_at, status, result,
        claimed_at, completed_at, failed_at, attempts, payload_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL, 0, ?, ?, ?)
    `).run(
      job.id,
      job.jobType,
      job.targetType,
      job.targetId,
      dedupeKey,
      job.runAt,
      JSON.stringify(job.payload || {}),
      now,
      now
    );

    const row = this.db.prepare('SELECT * FROM scheduled_jobs WHERE dedupe_key = ?').get(dedupeKey) as RawJobRow | undefined;
    if (!row || row.id !== job.id) return null;
    return toJob(row);
  }

  claimDueJobs(now: string, limit = 25): ScheduledJob[] {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.db.prepare(`
        SELECT * FROM scheduled_jobs
        WHERE status = 'pending' AND run_at <= ?
        ORDER BY run_at ASC, created_at ASC
        LIMIT ?
      `).all(now, limit) as RawJobRow[];

      for (const row of rows) {
        this.db.prepare(`
          UPDATE scheduled_jobs
          SET status = 'claimed', claimed_at = ?, attempts = attempts + 1, updated_at = ?
          WHERE id = ? AND status = 'pending'
        `).run(now, now, row.id);
      }

      this.db.exec('COMMIT');
      return rows.map((row) => ({
        ...toJob(row),
        status: 'claimed',
        claimedAt: now,
        attempts: row.attempts + 1,
        updatedAt: now,
      }));
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  completeJob(id: string, now: string, result: JobResult = 'success'): void {
    this.db.prepare(`
      UPDATE scheduled_jobs
      SET status = 'completed', result = ?, completed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(result, now, now, id);
  }

  failJob(id: string, now: string, _error: string, retry = true): void {
    const row = this.db.prepare('SELECT * FROM scheduled_jobs WHERE id = ?').get(id) as RawJobRow | undefined;
    if (!row) return;
    if (retry && row.attempts < 3) {
      const retryAt = new Date(Date.parse(now) + 60 * 1000).toISOString();
      this.db.prepare(`
        UPDATE scheduled_jobs
        SET status = 'pending', result = NULL, run_at = ?, failed_at = ?, updated_at = ?
        WHERE id = ?
      `).run(retryAt, now, now, id);
      return;
    }
    this.db.prepare(`
      UPDATE scheduled_jobs
      SET status = 'failed', result = 'failed', failed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(now, now, id);
  }

  recoverClaimedJobs(now: string, olderThanMs = 2 * 60 * 1000): number {
    const cutoff = new Date(Date.parse(now) - olderThanMs).toISOString();
    const rows = this.db.prepare(`
      SELECT * FROM scheduled_jobs
      WHERE status = 'claimed' AND claimed_at <= ?
    `).all(cutoff) as RawJobRow[];

    for (const row of rows) {
      this.db.prepare(`
        UPDATE scheduled_jobs
        SET status = 'pending', claimed_at = NULL, updated_at = ?
        WHERE id = ?
      `).run(now, row.id);
    }

    return rows.length;
  }

  listJobs(): ScheduledJob[] {
    const rows = this.db.prepare('SELECT * FROM scheduled_jobs ORDER BY created_at ASC').all() as RawJobRow[];
    return rows.map(toJob);
  }

  close(): void {
    this.db.close();
  }
}

export interface JobRunResult {
  claimed: number;
  completed: number;
  noOp: number;
  failed: number;
  commands: Command[];
}

export type CommandHandlerResult = void | { result: 'applied' | 'noop' | 'rejected' };
export type CommandHandler = (command: Command) => CommandHandlerResult | Promise<CommandHandlerResult>;

function normalizeCommandHandlerResult(result: CommandHandlerResult): 'applied' | 'noop' | 'rejected' {
  return result?.result || 'applied';
}

function ignoredCheckJob(reminderId: string, runAt: string): NewScheduledJob {
  return {
    id: `job_ignored_${reminderId}_${Date.parse(runAt)}`,
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
  store.recoverClaimedJobs(nowIso);
  const jobs = store.claimDueJobs(nowIso, 25);
  const result: JobRunResult = { claimed: jobs.length, completed: 0, noOp: 0, failed: 0, commands: [] };

  for (const job of jobs) {
    try {
      let command: Command;
      if (job.jobType === 'reminder_due') {
        const reminderId = String(job.payload.reminderId || job.targetId);
        command = { type: 'ReminderTriggered', reminderId, now: nowIso };
        const commandResult = normalizeCommandHandlerResult(await handleCommand(command));
        result.commands.push(command);
        if (commandResult === 'rejected') {
          store.failJob(job.id, nowIso, 'Command rejected', false);
          result.failed += 1;
          continue;
        }
        if (commandResult === 'noop') {
          store.completeJob(job.id, nowIso, 'no-op');
          result.completed += 1;
          result.noOp += 1;
          continue;
        }
        if (job.payload.requiresAction !== false) {
          const ignoredAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
          store.createJob(ignoredCheckJob(reminderId, ignoredAt));
        }
      } else if (job.jobType === 'ignored_check') {
        command = { type: 'ReminderIgnored', reminderId: String(job.payload.reminderId || job.targetId), now: nowIso };
        const commandResult = normalizeCommandHandlerResult(await handleCommand(command));
        result.commands.push(command);
        if (commandResult === 'rejected') {
          store.failJob(job.id, nowIso, 'Command rejected', false);
          result.failed += 1;
          continue;
        }
        if (commandResult === 'noop') {
          store.completeJob(job.id, nowIso, 'no-op');
          result.completed += 1;
          result.noOp += 1;
          continue;
        }
      } else if (job.jobType === 'escalation_check') {
        command = { type: 'EscalationTriggered', commitmentId: String(job.payload.commitmentId || job.targetId), now: nowIso };
        const commandResult = normalizeCommandHandlerResult(await handleCommand(command));
        result.commands.push(command);
        if (commandResult === 'rejected') {
          store.failJob(job.id, nowIso, 'Command rejected', false);
          result.failed += 1;
          continue;
        }
        if (commandResult === 'noop') {
          store.completeJob(job.id, nowIso, 'no-op');
          result.completed += 1;
          result.noOp += 1;
          continue;
        }
      } else {
        throw new Error(`Unsupported job type: ${job.jobType}`);
      }

      store.completeJob(job.id, nowIso, 'success');
      result.completed += 1;
    } catch (error) {
      if (error instanceof InvalidStateTransitionError) {
        store.completeJob(job.id, nowIso, 'no-op');
        result.completed += 1;
        result.noOp += 1;
        continue;
      }
      if (error instanceof MissingEntityError || error instanceof ValidationError) {
        store.failJob(job.id, nowIso, error.message, false);
        result.failed += 1;
        continue;
      }
      store.failJob(job.id, nowIso, error instanceof Error ? error.message : 'Unknown job failure', true);
      result.failed += 1;
    }
  }

  return result;
}
