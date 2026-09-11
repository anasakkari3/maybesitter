/**
 * The scheduler, on the storage adapter (UC-1.0c, #142).
 *
 * These are the same behaviours the SQLite-backed store was checked for —
 * run-once, dedupe, no-op vs failure, crash replay, overlapping ticks and
 * restart recovery — re-pointed at `StorageSchedulerStore`. Keeping the cases
 * identical is the point: the storage move must not change what the scheduler
 * does, only where it keeps it.
 *
 * The temp SQLite file is gone. A "restart" is now a second store object over
 * the same adapter, which is what two Cloud Run instances actually are.
 *
 * One timing change is deliberate. `recoverClaimedJobs` defaults to a
 * five-minute cutoff (the issue's figure) where the SQLite store used two, so
 * the cases that rely on a stale claim being recovered now tick at 09:06
 * rather than 09:03. At 09:03 nothing would be recovered and those assertions
 * would pass for the wrong reason.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCommand as applyDomainCommand,
  createEmptyDomainState,
  InvalidStateTransitionError,
  MissingEntityError,
} from '../../src/domain/stateMachine.ts';
import type { Command } from '../../src/domain/stateMachine.ts';
import { runDueJobs } from '../../src/scheduler/jobRunner.ts';
import { StorageSchedulerStore } from '../../lib/scheduler/storageSchedulerStore.ts';
import { Scheduler } from '../../src/scheduler/scheduler.ts';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import {
  applyCommand as applyServiceCommand,
  configureCommandService,
} from '../../lib/services/commandService.ts';
import { clearPressureHistory } from '../../lib/services/pressureService.ts';

const DUE = '2026-04-08T09:00:00.000Z';
/** Past the five-minute claim-recovery cutoff, so a stale claim is recovered. */
const AFTER_RECOVERY = '2026-04-08T09:06:00.000Z';

function setup(): { store: StorageSchedulerStore; cleanup: () => void } {
  setStorageForTests(createMemoryStorage());
  return { store: new StorageSchedulerStore(), cleanup: () => resetStorageForTests() };
}

function reminderJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job_1',
    jobType: 'reminder_due' as const,
    targetType: 'reminder' as const,
    targetId: 'rem_1',
    runAt: DUE,
    payload: { reminderId: 'rem_1' },
    ...overrides,
  };
}

async function jobById(store: StorageSchedulerStore, id: string) {
  return (await store.listJobs()).find((job) => job.id === id);
}

test('scheduler: job runs once', async () => {
  const { store, cleanup } = setup();
  const commands: Command[] = [];
  try {
    await store.createJob(reminderJob());

    await runDueJobs(store, (command) => {
      commands.push(command);
    }, new Date(DUE));
    // A second tick must not run it again: it is completed, not pending.
    await runDueJobs(store, (command) => {
      commands.push(command);
    }, new Date('2026-04-08T09:01:00.000Z'));

    assert.deepEqual(commands.map((command) => command.type), ['ReminderTriggered']);
    assert.equal((await jobById(store, 'job_1'))?.status, 'completed');
  } finally {
    cleanup();
  }
});

test('scheduler: duplicate job is ignored', async () => {
  const { store, cleanup } = setup();
  try {
    const job = reminderJob({ dedupeKey: 'reminder_due:reminder:rem_1:2026-04-08T09:00:00.000Z' });
    assert.ok(await store.createJob(job));
    // Same dedupe key, different id: the key is taken, so nothing is created.
    assert.equal(await store.createJob({ ...job, id: 'job_2' }), null);
    assert.equal((await store.listJobs()).length, 1);
  } finally {
    cleanup();
  }
});

test('scheduler: obsolete job completes as no-op', async () => {
  const { store, cleanup } = setup();
  try {
    await store.createJob(reminderJob());
    const result = await runDueJobs(store, () => {
      throw new InvalidStateTransitionError('obsolete reminder');
    }, new Date(DUE));

    const job = await jobById(store, 'job_1');
    assert.equal(result.noOp, 1);
    assert.equal(job?.status, 'completed');
    assert.equal(job?.result, 'no-op');
  } finally {
    cleanup();
  }
});

test('scheduler: noop command does not create ignored check', async () => {
  const { store, cleanup } = setup();
  try {
    await store.createJob(reminderJob());
    const result = await runDueJobs(store, () => ({ result: 'noop' }), new Date(DUE));

    assert.equal(result.noOp, 1);
    assert.equal((await store.listJobs()).filter((job) => job.jobType === 'ignored_check').length, 0);
    assert.equal((await jobById(store, 'job_1'))?.result, 'no-op');
  } finally {
    cleanup();
  }
});

test('scheduler: missing entity fails instead of no-op', async () => {
  const { store, cleanup } = setup();
  try {
    await store.createJob(reminderJob({ targetId: 'missing_reminder', payload: { reminderId: 'missing_reminder' } }));
    const result = await runDueJobs(store, () => {
      throw new MissingEntityError('missing reminder');
    }, new Date(DUE));

    const job = await jobById(store, 'job_1');
    assert.equal(result.failed, 1);
    assert.equal(job?.status, 'failed');
    assert.equal(job?.result, 'failed');
    // The reason is kept on the document, so a failed job can be diagnosed.
    assert.match(job?.lastError ?? '', /missing reminder/);
  } finally {
    cleanup();
  }
});

test('scheduler: crash replay does not duplicate effect', async () => {
  const { store, cleanup } = setup();
  let state = createEmptyDomainState();
  state = applyDomainCommand(state, {
    type: 'CreateDraft',
    now: '2026-04-08T08:00:00.000Z',
    commitment: {
      id: 'cmt_1',
      kind: 'task',
      title: 'Send invoice',
      timeSpec: { kind: 'due_by', dueAt: '2026-04-08T18:00:00.000Z', remindAt: DUE, timezone: 'UTC' },
    },
    draftStatus: 'pending_confirmation',
  }).newState;
  state = applyDomainCommand(state, {
    type: 'ConfirmCommitment',
    commitmentId: 'cmt_1',
    now: '2026-04-08T08:00:00.000Z',
    reminders: [{ id: 'rem_1', scheduledFor: DUE }],
  }).newState;

  try {
    configureCommandService({ initialState: state, schedulerStore: null });
    await store.createJob(reminderJob());
    // Claimed, then the runner "crashes" before completing it.
    await store.claimDueJobs(DUE);

    const firstResult = applyServiceCommand({ type: 'ReminderTriggered', reminderId: 'rem_1', now: DUE });
    const replayResult = await runDueJobs(store, applyServiceCommand, new Date(AFTER_RECOVERY));

    assert.equal(firstResult.result, 'applied');
    // Recovered and re-run, but the effect already happened, so it is a no-op
    // rather than a second reminder.
    assert.equal(replayResult.noOp, 1);
    assert.equal((await jobById(store, 'job_1'))?.result, 'no-op');
    assert.equal((await store.listJobs()).filter((job) => job.jobType === 'ignored_check').length, 0);
  } finally {
    cleanup();
  }
});

test('scheduler: overlapping tick executes once', async () => {
  const { store, cleanup } = setup();
  const commands: Command[] = [];
  let release: () => void = () => undefined;
  const blocker = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await store.createJob(reminderJob());
    const scheduler = new Scheduler(store, async (command) => {
      commands.push(command);
      await blocker;
    }, { logger: null });

    const first = scheduler.tick(new Date(DUE));
    const second = scheduler.tick(new Date(DUE));
    release();
    await Promise.all([first, second]);

    assert.deepEqual(commands.map((command) => command.type), ['ReminderTriggered']);
  } finally {
    cleanup();
  }
});

test('scheduler: tick evaluates agenda and pressure decision safely', async () => {
  const { store, cleanup } = setup();
  let state = createEmptyDomainState();
  state = applyDomainCommand(state, {
    type: 'CreateDraft',
    now: '2026-04-08T07:00:00.000Z',
    commitment: {
      id: 'overdue',
      kind: 'task',
      title: 'Send invoice',
      timeSpec: { kind: 'due_by', dueAt: '2026-04-08T07:30:00.000Z', remindAt: null, timezone: 'UTC' },
    },
    draftStatus: 'pending_confirmation',
  }).newState;
  state = applyDomainCommand(state, {
    type: 'ConfirmCommitment',
    commitmentId: 'overdue',
    now: '2026-04-08T07:01:00.000Z',
    reminders: [],
  }).newState;

  const logs: string[] = [];
  const warnings: string[] = [];
  try {
    clearPressureHistory();
    configureCommandService({ initialState: state, schedulerStore: null });

    const scheduler = new Scheduler(store, () => undefined, {
      logger: { log: (message) => logs.push(message), warn: (message) => warnings.push(message) },
    });

    await scheduler.tick(new Date('2026-04-08T08:00:00.000Z'));

    assert.equal(warnings.length, 0);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^\[scheduler\] agenda evaluated items=1 pressureCandidate=soft top=overdue:/);
    assert.match(logs[0], /Send invoice$/);
  } finally {
    cleanup();
  }
});

// The restart that used to mean "reopen the SQLite file". A second store over
// the same adapter is what a second Cloud Run instance actually is, and the
// claim the dead instance left has to be recoverable by it.
test('scheduler: restart recovery works', async () => {
  const { store, cleanup } = setup();
  const commands: Command[] = [];
  try {
    await store.createJob(reminderJob());
    await store.claimDueJobs(DUE);

    // A different instance id: this is not the runner that took the claim.
    const restarted = new StorageSchedulerStore();
    await runDueJobs(restarted, (command) => {
      commands.push(command);
    }, new Date(AFTER_RECOVERY));

    assert.deepEqual(commands.map((command) => command.type), ['ReminderTriggered']);
    assert.equal((await jobById(restarted, 'job_1'))?.status, 'completed');
  } finally {
    cleanup();
  }
});

test('scheduler: a claim younger than the cutoff is left alone', async () => {
  // The other half of recovery: a job a live runner is still working on must
  // not be handed to a second runner just because it has not finished yet.
  const { store, cleanup } = setup();
  try {
    await store.createJob(reminderJob());
    await store.claimDueJobs(DUE);

    const recovered = await store.recoverClaimedJobs('2026-04-08T09:03:00.000Z');
    assert.equal(recovered, 0, 'a three-minute-old claim is inside the five-minute cutoff');
    assert.equal((await jobById(store, 'job_1'))?.status, 'claimed');
  } finally {
    cleanup();
  }
});
