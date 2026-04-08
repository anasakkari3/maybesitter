import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  applyCommand as applyDomainCommand,
  createEmptyDomainState,
  InvalidStateTransitionError,
  MissingEntityError,
} from '../../src/domain/stateMachine.ts';
import type { Command } from '../../src/domain/stateMachine.ts';
import { runDueJobs, SqliteSchedulerStore } from '../../src/scheduler/jobRunner.ts';
import { Scheduler } from '../../src/scheduler/scheduler.ts';
import {
  applyCommand as applyServiceCommand,
  configureCommandService,
} from '../../lib/services/commandService.ts';
import { clearPressureHistory } from '../../lib/services/pressureService.ts';

function tempDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'maybesitter-scheduler-'));
  return {
    path: join(dir, 'scheduler.sqlite'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('scheduler: job runs once', async () => {
  const db = tempDb();
  const commands: Command[] = [];
  const store = new SqliteSchedulerStore(db.path);
  try {
    store.createJob({
      id: 'job_1',
      jobType: 'reminder_due',
      targetType: 'reminder',
      targetId: 'rem_1',
      runAt: '2026-04-08T09:00:00.000Z',
      payload: { reminderId: 'rem_1' },
    });

    await runDueJobs(store, (command) => {
      commands.push(command);
    }, new Date('2026-04-08T09:00:00.000Z'));
    await runDueJobs(store, (command) => {
      commands.push(command);
    }, new Date('2026-04-08T09:01:00.000Z'));

    assert.deepEqual(commands.map((command) => command.type), ['ReminderTriggered']);
    assert.equal(store.listJobs().find((job) => job.id === 'job_1')?.status, 'completed');
  } finally {
    store.close();
    db.cleanup();
  }
});

test('scheduler: duplicate job is ignored', () => {
  const db = tempDb();
  const store = new SqliteSchedulerStore(db.path);
  try {
    const job = {
      id: 'job_1',
      jobType: 'reminder_due' as const,
      targetType: 'reminder' as const,
      targetId: 'rem_1',
      runAt: '2026-04-08T09:00:00.000Z',
      payload: { reminderId: 'rem_1' },
      dedupeKey: 'reminder_due:reminder:rem_1:2026-04-08T09:00:00.000Z',
    };
    assert.ok(store.createJob(job));
    assert.equal(store.createJob({ ...job, id: 'job_2' }), null);
    assert.equal(store.listJobs().length, 1);
  } finally {
    store.close();
    db.cleanup();
  }
});

test('scheduler: obsolete job completes as no-op', async () => {
  const db = tempDb();
  const store = new SqliteSchedulerStore(db.path);
  try {
    store.createJob({
      id: 'job_1',
      jobType: 'reminder_due',
      targetType: 'reminder',
      targetId: 'rem_1',
      runAt: '2026-04-08T09:00:00.000Z',
      payload: { reminderId: 'rem_1' },
    });

    const result = await runDueJobs(store, () => {
      throw new InvalidStateTransitionError('obsolete reminder');
    }, new Date('2026-04-08T09:00:00.000Z'));

    const job = store.listJobs().find((current) => current.id === 'job_1');
    assert.equal(result.noOp, 1);
    assert.equal(job?.status, 'completed');
    assert.equal(job?.result, 'no-op');
  } finally {
    store.close();
    db.cleanup();
  }
});

test('scheduler: noop command does not create ignored check', async () => {
  const db = tempDb();
  const store = new SqliteSchedulerStore(db.path);
  try {
    store.createJob({
      id: 'job_1',
      jobType: 'reminder_due',
      targetType: 'reminder',
      targetId: 'rem_1',
      runAt: '2026-04-08T09:00:00.000Z',
      payload: { reminderId: 'rem_1' },
    });

    const result = await runDueJobs(store, () => ({ result: 'noop' }), new Date('2026-04-08T09:00:00.000Z'));

    assert.equal(result.noOp, 1);
    assert.equal(store.listJobs().filter((job) => job.jobType === 'ignored_check').length, 0);
    assert.equal(store.listJobs().find((job) => job.id === 'job_1')?.result, 'no-op');
  } finally {
    store.close();
    db.cleanup();
  }
});

test('scheduler: missing entity fails instead of no-op', async () => {
  const db = tempDb();
  const store = new SqliteSchedulerStore(db.path);
  try {
    store.createJob({
      id: 'job_1',
      jobType: 'reminder_due',
      targetType: 'reminder',
      targetId: 'missing_reminder',
      runAt: '2026-04-08T09:00:00.000Z',
      payload: { reminderId: 'missing_reminder' },
    });

    const result = await runDueJobs(store, () => {
      throw new MissingEntityError('missing reminder');
    }, new Date('2026-04-08T09:00:00.000Z'));

    const job = store.listJobs().find((current) => current.id === 'job_1');
    assert.equal(result.failed, 1);
    assert.equal(job?.status, 'failed');
    assert.equal(job?.result, 'failed');
  } finally {
    store.close();
    db.cleanup();
  }
});

test('scheduler: crash replay does not duplicate effect', async () => {
  const db = tempDb();
  let state = createEmptyDomainState();
  state = applyDomainCommand(state, {
    type: 'CreateDraft',
    now: '2026-04-08T08:00:00.000Z',
    commitment: {
      id: 'cmt_1',
      kind: 'task',
      title: 'Send invoice',
      timeSpec: {
        kind: 'due_by',
        dueAt: '2026-04-08T18:00:00.000Z',
        remindAt: '2026-04-08T09:00:00.000Z',
        timezone: 'UTC',
      },
    },
    draftStatus: 'pending_confirmation',
  }).newState;
  state = applyDomainCommand(state, {
    type: 'ConfirmCommitment',
    commitmentId: 'cmt_1',
    now: '2026-04-08T08:00:00.000Z',
    reminders: [{ id: 'rem_1', scheduledFor: '2026-04-08T09:00:00.000Z' }],
  }).newState;

  const store = new SqliteSchedulerStore(db.path);
  try {
    configureCommandService({
      initialState: state,
      stateFile: `${db.path}.state.json`,
      schedulerStore: null,
    });
    store.createJob({
      id: 'job_1',
      jobType: 'reminder_due',
      targetType: 'reminder',
      targetId: 'rem_1',
      runAt: '2026-04-08T09:00:00.000Z',
      payload: { reminderId: 'rem_1' },
    });
    store.claimDueJobs('2026-04-08T09:00:00.000Z');

    const firstResult = applyServiceCommand({
      type: 'ReminderTriggered',
      reminderId: 'rem_1',
      now: '2026-04-08T09:00:00.000Z',
    });
    const replayResult = await runDueJobs(store, applyServiceCommand, new Date('2026-04-08T09:03:00.000Z'));

    assert.equal(firstResult.result, 'applied');
    assert.equal(replayResult.noOp, 1);
    assert.equal(store.listJobs().find((job) => job.id === 'job_1')?.result, 'no-op');
    assert.equal(store.listJobs().filter((job) => job.jobType === 'ignored_check').length, 0);
  } finally {
    store.close();
    db.cleanup();
  }
});

test('scheduler: overlapping tick executes once', async () => {
  const db = tempDb();
  const commands: Command[] = [];
  const store = new SqliteSchedulerStore(db.path);
  let release: () => void = () => undefined;
  const blocker = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    store.createJob({
      id: 'job_1',
      jobType: 'reminder_due',
      targetType: 'reminder',
      targetId: 'rem_1',
      runAt: '2026-04-08T09:00:00.000Z',
      payload: { reminderId: 'rem_1' },
    });
    const scheduler = new Scheduler(store, async (command) => {
      commands.push(command);
      await blocker;
    }, { logger: null });

    const first = scheduler.tick(new Date('2026-04-08T09:00:00.000Z'));
    const second = scheduler.tick(new Date('2026-04-08T09:00:00.000Z'));
    release();
    await Promise.all([first, second]);

    assert.deepEqual(commands.map((command) => command.type), ['ReminderTriggered']);
  } finally {
    store.close();
    db.cleanup();
  }
});

test('scheduler: tick evaluates agenda and pressure decision safely', async () => {
  const db = tempDb();
  let state = createEmptyDomainState();
  state = applyDomainCommand(state, {
    type: 'CreateDraft',
    now: '2026-04-08T07:00:00.000Z',
    commitment: {
      id: 'overdue',
      kind: 'task',
      title: 'Send invoice',
      timeSpec: {
        kind: 'due_by',
        dueAt: '2026-04-08T07:30:00.000Z',
        remindAt: null,
        timezone: 'UTC',
      },
    },
    draftStatus: 'pending_confirmation',
  }).newState;
  state = applyDomainCommand(state, {
    type: 'ConfirmCommitment',
    commitmentId: 'overdue',
    now: '2026-04-08T07:01:00.000Z',
    reminders: [],
  }).newState;

  const store = new SqliteSchedulerStore(db.path);
  const logs: string[] = [];
  const warnings: string[] = [];
  try {
    clearPressureHistory();
    configureCommandService({
      initialState: state,
      stateFile: `${db.path}.state.json`,
      schedulerStore: null,
    });

    const scheduler = new Scheduler(store, () => undefined, {
      logger: {
        log: (message) => logs.push(message),
        warn: (message) => warnings.push(message),
      },
    });

    await scheduler.tick(new Date('2026-04-08T08:00:00.000Z'));

    assert.equal(warnings.length, 0);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^\[scheduler\] agenda evaluated items=1 pressureCandidate=soft top=overdue:/);
    assert.match(logs[0], /Send invoice$/);
  } finally {
    store.close();
    db.cleanup();
  }
});

test('scheduler: restart recovery works', async () => {
  const db = tempDb();
  const commands: Command[] = [];
  const store1 = new SqliteSchedulerStore(db.path);
  try {
    store1.createJob({
      id: 'job_1',
      jobType: 'reminder_due',
      targetType: 'reminder',
      targetId: 'rem_1',
      runAt: '2026-04-08T09:00:00.000Z',
      payload: { reminderId: 'rem_1' },
    });
    store1.claimDueJobs('2026-04-08T09:00:00.000Z');
    store1.close();

    const store2 = new SqliteSchedulerStore(db.path);
    try {
      await runDueJobs(store2, (command) => {
        commands.push(command);
      }, new Date('2026-04-08T09:03:00.000Z'));
      assert.deepEqual(commands.map((command) => command.type), ['ReminderTriggered']);
      assert.equal(store2.listJobs().find((job) => job.id === 'job_1')?.status, 'completed');
    } finally {
      store2.close();
    }
  } finally {
    db.cleanup();
  }
});
