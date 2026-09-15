import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GET } from '../../src/app/api/health/ready/route';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage';
import type { StorageAdapter } from '../../lib/storage/storageAdapter';

// Cloud Run's startup probe points at this route. If it reports ready while
// storage is unreachable, the deploy sends traffic to a service that answers
// requests by losing data — so the failing case matters more than the happy one.

/**
 * `PROBE_TIMEOUT_MS` in src/app/api/health/ready/route.ts.
 *
 * Restated here rather than imported, because the route does not export it and
 * a test must not reshape production code to be observable. Restating it is the
 * point as much as the cost: Cloud Run's startup probe depends on this number,
 * so a change to it should have to change a test that says so out loud.
 */
const PROBE_BUDGET_MS = 2_000;

/**
 * Let every already-resolved continuation run, without advancing any clock.
 *
 * `GET` reaches its 503 through several awaits after the budget's timer
 * rejects. One `await` would only drain the first of them, so a check made
 * after it would be reading "the microtasks have not run yet" and calling it
 * "the probe is still waiting".
 */
async function drainMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
}

test('ready when storage answers', async () => {
  setStorageForTests(createMemoryStorage());
  try {
    const response = await GET();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ready: true });
  } finally {
    resetStorageForTests();
  }
});

test('503 with a coarse reason when storage is unreachable', async () => {
  const broken = {
    get: async () => {
      throw new Error('connection refused to firestore.googleapis.com:443 (project maybesitter-app)');
    },
  } as unknown as StorageAdapter;
  setStorageForTests(broken);
  try {
    const response = await GET();
    assert.equal(response.status, 503);
    // A probe response is public, so assert the whole body rather than a few
    // fields: this proves nothing else is in it — no host, no project id, no
    // error text — which a substring check could never establish.
    assert.deepEqual(await response.json(), { ready: false, reason: 'storage_unavailable' });
  } finally {
    resetStorageForTests();
  }
});

test('503 rather than hanging when storage never answers', async (t) => {
  const hanging = {
    get: () => new Promise(() => {}),
  } as unknown as StorageAdapter;
  setStorageForTests(hanging);
  // The probe runs every few seconds, so it has to give up quickly — and how
  // quickly is a property of `PROBE_TIMEOUT_MS`, not of this machine. Driving a
  // mock clock says exactly that: still waiting one millisecond before the
  // budget, answered 503 one millisecond after it.
  //
  // This replaces `Date.now() - started < 5_000` (#380). That assertion was a
  // statement about the host: it passed on an idle laptop, could fail on a busy
  // one, and would have passed a route whose budget had been quietly raised to
  // four seconds.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let answered = false;
    const probe = GET().then((response) => {
      answered = true;
      return response;
    });

    t.mock.timers.tick(PROBE_BUDGET_MS - 1);
    await drainMicrotasks();
    assert.equal(answered, false, 'the probe gave up before its own budget expired');

    t.mock.timers.tick(1);
    await drainMicrotasks();
    assert.equal(answered, true, `the probe was still waiting ${PROBE_BUDGET_MS} ms in, so it can hang`);

    const response = await probe;
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ready: false, reason: 'storage_unavailable' });
  } finally {
    t.mock.timers.reset();
    resetStorageForTests();
  }
});
