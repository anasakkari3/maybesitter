/**
 * Two runners, ten due jobs, no reminder sent twice (UC-1.0c, #142).
 *
 * This is the defect the SQLite store could not defend against once the app
 * ran on more than one instance. `BEGIN IMMEDIATE` locks one database *file*;
 * a second Cloud Run instance has its own file and its own lock, so both
 * runners would read the same due jobs, both would claim all of them, and the
 * user would get every reminder twice. Double-sending is the failure people
 * actually notice and the reason they turn reminders off.
 *
 * `claimDueJobs` puts the query and the claims in one transaction, so the
 * query's result set is part of what the transaction read: whichever runner
 * commits first invalidates the other, which retries and finds the jobs
 * already taken. The assertion is therefore not "each runner got roughly
 * half" — it is that the union is exactly ten and the intersection is empty.
 *
 * The same property is checked against real Firestore in
 * `tests/scheduler/firestoreScheduler.emulator.test.ts`; the memory adapter
 * models the contention, the emulator proves the model.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StorageSchedulerStore } from '../../lib/scheduler/storageSchedulerStore.ts';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import type { ScheduledJob } from '../../src/scheduler/jobRunner.ts';

const DUE = '2026-04-08T09:00:00.000Z';
const JOB_COUNT = 10;

function setup(): () => void {
  setStorageForTests(createMemoryStorage());
  return () => resetStorageForTests();
}

async function seedDueJobs(store: StorageSchedulerStore, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await store.createJob({
      id: `job_${String(index).padStart(2, '0')}`,
      jobType: 'reminder_due',
      targetType: 'reminder',
      targetId: `rem_${index}`,
      runAt: DUE,
      payload: { reminderId: `rem_${index}` },
    });
  }
}

test('two concurrent claimDueJobs over 10 due jobs claim 10 in total, with no duplicates', async () => {
  const cleanup = setup();
  try {
    // Two distinct runners over one database, which is what two instances are.
    const runnerA = new StorageSchedulerStore({ instanceId: 'instance-a' });
    const runnerB = new StorageSchedulerStore({ instanceId: 'instance-b' });
    await seedDueJobs(runnerA, JOB_COUNT);

    const [claimedA, claimedB] = await Promise.all([
      runnerA.claimDueJobs(DUE, 25),
      runnerB.claimDueJobs(DUE, 25),
    ]);

    const idsA = claimedA.map((job) => job.id);
    const idsB = claimedB.map((job) => job.id);

    // The load-bearing assertion: no job was handed to both runners.
    const overlap = idsA.filter((id) => idsB.includes(id));
    assert.deepEqual(overlap, [], 'a job was claimed by both runners; the user would be reminded twice');

    const all = [...idsA, ...idsB].sort();
    assert.equal(all.length, JOB_COUNT, 'the two runners claimed more or fewer than the ten due jobs');
    assert.equal(new Set(all).size, JOB_COUNT, 'the same job id appears twice across the two claims');

    // And the store agrees: every job is claimed, by exactly one instance.
    const stored = await runnerA.listJobs();
    assert.equal(stored.length, JOB_COUNT);
    assert.equal(stored.every((job: ScheduledJob) => job.status === 'claimed'), true);
    assert.equal(
      stored.every((job: ScheduledJob) => job.claimedBy === 'instance-a' || job.claimedBy === 'instance-b'),
      true,
      'a claimed job does not record which runner took it',
    );
    // Claiming increments the attempt count exactly once per claim.
    assert.equal(stored.every((job: ScheduledJob) => job.attempts === 1), true);
  } finally {
    cleanup();
  }
});

test('a second claim after the first finds nothing left to claim', async () => {
  const cleanup = setup();
  try {
    const store = new StorageSchedulerStore({ instanceId: 'instance-a' });
    await seedDueJobs(store, 3);

    assert.equal((await store.claimDueJobs(DUE, 25)).length, 3);
    assert.deepEqual(await store.claimDueJobs(DUE, 25), [], 'an already-claimed job was claimed again');
  } finally {
    cleanup();
  }
});

test('a job that is not due yet is not claimed', async () => {
  const cleanup = setup();
  try {
    const store = new StorageSchedulerStore();
    await store.createJob({
      id: 'job_future',
      jobType: 'reminder_due',
      targetType: 'reminder',
      targetId: 'rem_future',
      runAt: '2026-04-08T10:00:00.000Z',
      payload: { reminderId: 'rem_future' },
    });

    assert.deepEqual(await store.claimDueJobs(DUE, 25), [], 'a job scheduled for later was claimed early');
  } finally {
    cleanup();
  }
});

test('concurrent creates for one dedupe key produce exactly one job', async () => {
  // The other race the UNIQUE index used to cover. Two instances reacting to
  // the same confirmation would otherwise schedule the same reminder twice.
  const cleanup = setup();
  try {
    const runnerA = new StorageSchedulerStore({ instanceId: 'instance-a' });
    const runnerB = new StorageSchedulerStore({ instanceId: 'instance-b' });
    const job = {
      jobType: 'reminder_due' as const,
      targetType: 'reminder' as const,
      targetId: 'rem_1',
      runAt: DUE,
      dedupeKey: 'reminder_due:reminder:rem_1:2026-04-08T09:00:00.000Z',
      payload: { reminderId: 'rem_1' },
    };

    const results = await Promise.all([
      runnerA.createJob({ ...job, id: 'job_a' }),
      runnerB.createJob({ ...job, id: 'job_b' }),
    ]);

    assert.equal(results.filter((created) => created !== null).length, 1, 'both creates were accepted');
    assert.equal((await runnerA.listJobs()).length, 1);
  } finally {
    cleanup();
  }
});
