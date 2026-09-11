/**
 * The scheduler against real Firestore (UC-1.0c, #142).
 *
 * ── Why the restart check has to run here ────────────────────────
 *
 * The acceptance criterion is that a store written through handle A is read
 * back through a fresh handle B — a simulated restart. Against the memory
 * adapter that check is very nearly vacuous: both handles resolve to the same
 * in-process `Map`, so it passes whether or not anything was durably written.
 * It only means something against a backend that survives the handle, which is
 * this one. The memory suite still runs the same behaviours
 * (`tests/scheduler/scheduler.test.ts`); this file is what makes "it persists"
 * an assertion rather than an assumption.
 *
 * ── And why the contention check is repeated here ────────────────
 *
 * `tests/scheduler/schedulerContention.test.ts` proves the memory adapter
 * models two runners correctly. That is a statement about the model. Firestore
 * is where the transaction actually has to hold, so the ten-jobs-two-runners
 * case is run again against the real thing.
 *
 * Each test uses its own collection: `emulators:exec` keeps one database for
 * the whole run, and `claimDueJobs` claims every due job in its collection, so
 * sharing `jobs` would mean each test claiming the others' jobs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFirestoreStorage } from '../../lib/storage/firestoreAdapter.ts';
import { StorageSchedulerStore } from '../../lib/scheduler/storageSchedulerStore.ts';
import type { ScheduledJob } from '../../src/scheduler/jobRunner.ts';
import { runDueJobs } from '../../src/scheduler/jobRunner.ts';
import type { Command } from '../../src/domain/stateMachine.ts';

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    'FIRESTORE_EMULATOR_HOST is unset. Run this file through `npm run test:emulator`, never against a real project.',
  );
}

const DUE = '2026-04-08T09:00:00.000Z';
/** Past the five-minute claim-recovery cutoff. */
const AFTER_RECOVERY = '2026-04-08T09:06:00.000Z';

/** A collection nothing else in this emulator run writes to. */
function scopedCollection(): string {
  return `jobs_${randomUUID().replace(/-/g, '')}`;
}

function reminderJob(id: string, targetId: string) {
  return {
    id,
    uid: 'p-emulator-1',
    jobType: 'reminder_due' as const,
    targetType: 'reminder' as const,
    targetId,
    runAt: DUE,
    payload: { reminderId: targetId },
  };
}

test('firestore scheduler: a job written through handle A is read back through a fresh handle B', async () => {
  const collection = scopedCollection();
  // Two independent adapters and two independent stores — nothing in-process
  // is shared between them, so a read-back can only come off the server.
  const writer = new StorageSchedulerStore({ storage: createFirestoreStorage(), collection, instanceId: 'A' });
  const reader = new StorageSchedulerStore({ storage: createFirestoreStorage(), collection, instanceId: 'B' });

  const created = await writer.createJob(reminderJob('job_restart', 'rem_restart'));
  assert.ok(created, 'the job was not created');

  const seen = (await reader.listJobs()).find((job) => job.id === 'job_restart');
  assert.ok(seen, 'the job did not survive the handle: nothing durable was written');
  assert.equal(seen.status, 'pending');
  assert.equal(seen.uid, 'p-emulator-1', 'the job forgot who it was for');
  assert.equal(seen.dedupeKey, created.dedupeKey);
  assert.deepEqual(seen.payload, { reminderId: 'rem_restart' });
});

test('firestore scheduler: a claim left by a dead runner is recovered by a fresh one', async () => {
  const collection = scopedCollection();
  const dead = new StorageSchedulerStore({ storage: createFirestoreStorage(), collection, instanceId: 'dead' });
  await dead.createJob(reminderJob('job_stuck', 'rem_stuck'));
  await dead.claimDueJobs(DUE, 25);

  const restarted = new StorageSchedulerStore({ storage: createFirestoreStorage(), collection, instanceId: 'restarted' });
  const commands: Command[] = [];
  await runDueJobs(restarted, (command) => {
    commands.push(command);
  }, new Date(AFTER_RECOVERY));

  assert.deepEqual(commands.map((command) => command.type), ['ReminderTriggered']);
  const job = (await restarted.listJobs()).find((current) => current.id === 'job_stuck');
  assert.equal(job?.status, 'completed');
});

test('firestore scheduler: two concurrent claims over 10 due jobs claim 10, with no duplicates', async () => {
  const collection = scopedCollection();
  const runnerA = new StorageSchedulerStore({ storage: createFirestoreStorage(), collection, instanceId: 'instance-a' });
  const runnerB = new StorageSchedulerStore({ storage: createFirestoreStorage(), collection, instanceId: 'instance-b' });

  for (let index = 0; index < 10; index += 1) {
    await runnerA.createJob(reminderJob(`job_${String(index).padStart(2, '0')}`, `rem_${index}`));
  }

  const [claimedA, claimedB] = await Promise.all([
    runnerA.claimDueJobs(DUE, 25),
    runnerB.claimDueJobs(DUE, 25),
  ]);

  const idsA = claimedA.map((job) => job.id);
  const idsB = claimedB.map((job) => job.id);
  assert.deepEqual(
    idsA.filter((id) => idsB.includes(id)),
    [],
    'Firestore handed one job to both runners; the user would be reminded twice',
  );

  const all = [...idsA, ...idsB];
  assert.equal(all.length, 10);
  assert.equal(new Set(all).size, 10);

  const stored = await runnerA.listJobs();
  assert.equal(stored.length, 10);
  assert.equal(stored.every((job: ScheduledJob) => job.status === 'claimed'), true);
  assert.equal(stored.every((job: ScheduledJob) => job.attempts === 1), true);
});

test('firestore scheduler: one dedupe key survives two concurrent creates', async () => {
  const collection = scopedCollection();
  const runnerA = new StorageSchedulerStore({ storage: createFirestoreStorage(), collection, instanceId: 'instance-a' });
  const runnerB = new StorageSchedulerStore({ storage: createFirestoreStorage(), collection, instanceId: 'instance-b' });
  const shared = {
    uid: 'p-emulator-1',
    jobType: 'reminder_due' as const,
    targetType: 'reminder' as const,
    targetId: 'rem_dupe',
    runAt: DUE,
    dedupeKey: `reminder_due:reminder:rem_dupe:${DUE}`,
    payload: { reminderId: 'rem_dupe' },
  };

  const results = await Promise.all([
    runnerA.createJob({ ...shared, id: 'job_dupe_a' }),
    runnerB.createJob({ ...shared, id: 'job_dupe_b' }),
  ]);

  assert.equal(results.filter((created) => created !== null).length, 1, 'both creates were accepted');
  assert.equal((await runnerA.listJobs()).length, 1);
});
