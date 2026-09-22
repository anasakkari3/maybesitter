/**
 * The internal job routes (UC-1.0d, #143).
 *
 * These run every user's due work on a service reachable from the internet, so
 * the refusals come first — and each one also asserts that no job ran, because
 * a 401 that still processed the queue would pass a status-only check.
 *
 * The positive case goes through the route's real wiring (default tick, default
 * scheduler store, default handler) over memory storage: a reminder due in a
 * participant's durable state is completed exactly once.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import { AUDIENCE_ENV_VAR, SCHEDULER_SA_ENV_VAR, type OidcPayload } from '../../lib/auth/schedulerOidc.ts';
import {
  TICK_BATCH,
  handleContinuousReplanRequest,
  handleJobsRunRequest,
  handleMaintenanceRequest,
  runJobsTick,
  runMaintenance,
  type ContinuousReplanTickTotals,
  type TickTotals,
} from '../../lib/jobs/internalJobs.ts';
import { createStorageSchedulerStore } from '../../lib/scheduler/storageSchedulerStore.ts';
import { persistParticipantState, readParticipantState } from '../../lib/services/mobile/participantState.ts';
import { applyCommand as applyDomainCommand, createEmptyDomainState } from '../../src/domain/stateMachine.ts';

const SA = 'maybesitter-scheduler@example-project.iam.gserviceaccount.com';
const AUDIENCE = 'https://api.example.invalid';
const ENV: NodeJS.ProcessEnv = { NODE_ENV: 'test', [SCHEDULER_SA_ENV_VAR]: SA, [AUDIENCE_ENV_VAR]: AUDIENCE };
const DUE = '2026-04-08T09:00:00.000Z';
const UID = 'user_sched_1';

const SCHEDULER: OidcPayload = { email: SA, email_verified: true, aud: AUDIENCE, iss: 'https://accounts.google.com' };

function bearer(token: string | null) {
  return { headers: { get: (name: string) => (name.toLowerCase() === 'authorization' ? token : null) } };
}

/** A tick that records whether it ran, so refusals can prove they ran nothing. */
function spyTick() {
  const calls: number[] = [];
  const empty: TickTotals = { claimed: 0, completed: 0, noOp: 0, failed: 0, rounds: 1, stoppedBy: 'drained' };
  return { calls, tick: async () => { calls.push(1); return empty; } };
}

function withStorage<T>(storage: StorageAdapter, fn: () => Promise<T>): Promise<T> {
  setStorageForTests(storage);
  return fn().finally(() => resetStorageForTests());
}

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    return await fn();
  } finally {
    console.warn = warn;
  }
}

/* ── Refusals ────────────────────────────────────────────────────── */

const REFUSED: Array<[string, string | null, OidcPayload | 'throws']> = [
  ['no token', null, SCHEDULER],
  ['a Firebase user ID token', 'Bearer user-token', { email: 'someone@example.com', email_verified: true, aud: 'example-project', iss: 'https://securetoken.google.com/example-project' }],
  ['a different service account', 'Bearer t', { ...SCHEDULER, email: 'other@other-project.iam.gserviceaccount.com' }],
  ['a token for the wrong audience', 'Bearer t', { ...SCHEDULER, aud: 'https://staging.example.invalid' }],
  ['a token Google does not verify', 'Bearer t', 'throws'],
];

for (const [label, header, payload] of REFUSED) {
  test(`run: ${label} is refused with 401 and runs no job`, async () => {
    const spy = spyTick();
    const response = await quiet(() => handleJobsRunRequest(bearer(header), {
      env: ENV,
      verify: async () => {
        if (payload === 'throws') throw new Error('bad signature');
        return payload;
      },
      tick: spy.tick,
    }));
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'unauthorized' });
    assert.equal(spy.calls.length, 0, 'a refused request still ran the queue');
  });
}

test('run: missing configuration is 503 and runs no job', async () => {
  const spy = spyTick();
  const response = await quiet(() => handleJobsRunRequest(bearer('Bearer t'), {
    env: { NODE_ENV: 'test' },
    verify: async () => SCHEDULER,
    tick: spy.tick,
  }));
  assert.equal(response.status, 503);
  assert.equal(spy.calls.length, 0);
});

test('maintenance: the same guard, and a refusal sweeps nothing', async () => {
  let swept = false;
  const response = await quiet(() => handleMaintenanceRequest(bearer(null), {
    env: ENV,
    verify: async () => SCHEDULER,
    maintenance: async () => {
      swept = true;
      return { ok: true, steps: [] };
    },
  }));
  assert.equal(response.status, 401);
  assert.equal(swept, false);
});

test('continuous replan: auth guard refuses unauthenticated request and runs no sweep', async () => {
  let ran = false;
  const emptyTotals: ContinuousReplanTickTotals = {
    examined: 0,
    replanRequired: 0,
    autoApplied: 0,
    proposed: 0,
    stale: 0,
    noEffect: 0,
    failed: 0,
  };
  const response = await quiet(() => handleContinuousReplanRequest(bearer(null), {
    env: ENV,
    verify: async () => SCHEDULER,
    continuousReplan: async () => {
      ran = true;
      return emptyTotals;
    },
  }));
  assert.equal(response.status, 401);
  assert.equal(ran, false);

  const appliedTotals: ContinuousReplanTickTotals = {
    examined: 1,
    replanRequired: 1,
    autoApplied: 1,
    proposed: 0,
    stale: 0,
    noEffect: 0,
    failed: 0,
  };
  const okResponse = await handleContinuousReplanRequest(bearer('Bearer scheduler-token'), {
    env: ENV,
    verify: async () => SCHEDULER,
    continuousReplan: async () => {
      ran = true;
      return appliedTotals;
    },
  });
  assert.equal(okResponse.status, 200);
  assert.equal(ran, true);
  assert.deepEqual(await okResponse.json(), appliedTotals);
});

/* ── The real wiring ─────────────────────────────────────────────── */

function stateWithDueReminder() {
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
  return applyDomainCommand(state, {
    type: 'ConfirmCommitment',
    commitmentId: 'cmt_1',
    now: '2026-04-08T08:00:00.000Z',
    reminders: [{ id: 'rem_1', scheduledFor: DUE }],
  }).newState;
}

test('run: a due reminder in a participant\'s durable state is completed exactly once', async () => {
  await withStorage(createMemoryStorage(), async () => {
    await persistParticipantState(UID, stateWithDueReminder());
    const before = JSON.stringify(await readParticipantState(UID));
    const store = createStorageSchedulerStore();
    await store.createJob({
      id: 'job_reminder_1',
      uid: UID,
      jobType: 'reminder_due',
      targetType: 'reminder',
      targetId: 'rem_1',
      runAt: DUE,
      payload: { reminderId: 'rem_1' },
    });

    // No injected tick, store or handler: this is the route as deployed.
    const first = await handleJobsRunRequest(bearer('Bearer scheduler-token'), { env: ENV, verify: async () => SCHEDULER });
    assert.equal(first.status, 200);
    const totals = (await first.json()) as TickTotals;
    assert.equal(totals.claimed, 1);
    assert.equal(totals.completed, 1);
    assert.equal(totals.failed, 0);

    const job = (await store.listJobs()).find((candidate) => candidate.id === 'job_reminder_1');
    assert.equal(job?.status, 'completed');
    assert.equal(job?.result, 'success');
    assert.equal(job?.attempts, 1);
    // Applied to the owner's own durable state — not to a per-process one.
    assert.notEqual(JSON.stringify(await readParticipantState(UID)), before, 'the reminder did not change the participant\'s state');

    // A second tick (Scheduler retries, or the next minute) must not run it again.
    const second = await handleJobsRunRequest(bearer('Bearer scheduler-token'), { env: ENV, verify: async () => SCHEDULER });
    assert.equal(((await second.json()) as TickTotals).completed, 0);
    const again = (await store.listJobs()).find((candidate) => candidate.id === 'job_reminder_1');
    assert.equal(again?.attempts, 1, 'the job ran twice');
  });
});

test('run: a job with no owner is failed, not retried', async () => {
  await withStorage(createMemoryStorage(), async () => {
    const store = createStorageSchedulerStore();
    await store.createJob({ id: 'job_orphan', uid: null, jobType: 'reminder_due', targetType: 'reminder', targetId: 'rem_x', runAt: DUE, payload: { reminderId: 'rem_x' } });
    const totals = await runJobsTick({ store });
    assert.equal(totals.failed, 1);
    const job = (await store.listJobs()).find((candidate) => candidate.id === 'job_orphan');
    assert.equal(job?.status, 'failed');
    assert.match(job?.lastError ?? '', /no owner/);
  });
});

/* ── The tick loop ───────────────────────────────────────────────── */

async function seedOrphans(count: number) {
  const store = createStorageSchedulerStore();
  for (let i = 0; i < count; i += 1) {
    await store.createJob({ id: `job_${i}`, uid: null, jobType: 'reminder_due', targetType: 'reminder', targetId: `rem_${i}`, runAt: DUE, payload: { reminderId: `rem_${i}` } });
  }
  return store;
}

test('tick: a backlog larger than one batch is drained in several rounds', async () => {
  await withStorage(createMemoryStorage(), async () => {
    const store = await seedOrphans(TICK_BATCH + 5);
    const totals = await runJobsTick({ store });
    assert.equal(totals.claimed, TICK_BATCH + 5);
    assert.equal(totals.rounds, 2);
    assert.equal(totals.stoppedBy, 'drained');
  });
});

test('tick: it stops claiming when the time budget is spent, leaving the rest for the next tick', async () => {
  await withStorage(createMemoryStorage(), async () => {
    const store = await seedOrphans(TICK_BATCH * 3);
    let now = Date.parse('2026-09-11T10:00:00.000Z');
    const totals = await runJobsTick({ store, budgetMs: 45_000, clock: () => (now += 30_000) });
    assert.equal(totals.stoppedBy, 'budget');
    assert.ok(totals.claimed < TICK_BATCH * 3, 'it claimed everything despite the budget');
  });
});

/* ── Maintenance ─────────────────────────────────────────────────── */

test('maintenance: every sweep runs, and it reports each one', async () => {
  const result = await runMaintenance({ storage: createMemoryStorage(), now: new Date(DUE) });
  assert.equal(result.ok, true);
  assert.deepEqual(result.steps.map((step) => step.name), [
    'runtime_memory_expired',
    'alpha_feedback_pruned',
    'alpha_traces_pruned',
    'clarifications_pruned',
    // UC-1.5 (#149): a deletion whose instance went away is finished here.
    'deletions_resumed',
  ]);
});

test('maintenance: one unreachable store does not stop the other sweeps, and the call fails', async () => {
  const memory = createMemoryStorage();
  const brokenTraces = new Proxy(memory, {
    get(target, property, receiver) {
      if (property === 'listGroup') {
        return (collectionId: string, options?: unknown) => {
          if (collectionId === 'alphaTraces') return Promise.reject(new Error('firestore is unreachable'));
          return (target.listGroup as (c: string, o?: unknown) => unknown).call(target, collectionId, options);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as StorageAdapter;

  const errorLog = console.error;
  console.error = () => undefined;
  try {
    const result = await runMaintenance({ storage: brokenTraces, now: new Date(DUE) });
    assert.equal(result.ok, false);
    const byName = Object.fromEntries(result.steps.map((step) => [step.name, step.ok]));
    assert.deepEqual(byName, {
      runtime_memory_expired: true,
      alpha_feedback_pruned: true,
      alpha_traces_pruned: false,
      clarifications_pruned: true,
      deletions_resumed: true,
    });
  } finally {
    console.error = errorLog;
  }
});
