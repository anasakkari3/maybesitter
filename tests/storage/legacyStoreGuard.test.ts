/**
 * The local-disk stores refuse to run on Cloud Run (UC-1.0c, #142).
 *
 * UC-1.0c moved every launch-path store onto the storage adapter and left five
 * modules on the local filesystem on purpose — the three legacy web stores,
 * the offline annotation corpus, and the pilot backup helpers. Each is correct
 * where it runs and silently wrong on Cloud Run, where the filesystem is
 * per-instance and disappears with the revision: a write would appear to
 * succeed and be gone on the next request.
 *
 * "Silently wrong" is the part these tests exist for. The acceptance criterion
 * is that **first use throws** with `K_SERVICE` set, so the failure is a 500 on
 * one endpoint naming the store, not data quietly evaporating.
 *
 * ── Why first use, asserted as such ──────────────────────────────
 *
 * The last test is the load-bearing one: importing these modules with
 * `K_SERVICE` set must NOT throw. Next collects route modules at build time and
 * again on boot, so a module-init guard would fail the build or take the whole
 * revision down — every other endpoint included — instead of failing the one
 * request that reached the offline store. A guard moved to module scope would
 * pass every "it throws" test above and still be the wrong design, so the
 * import is checked directly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CLOUD_RUN_ENV_VAR, CloudRunUnsupportedStoreError } from '../../lib/runtime/assertNotCloudRun.ts';

import { getAppSnapshot, updateAppData } from '../../src/server/dataStore.ts';
import { FileCommitmentMemoryStore } from '../../src/domain/memory/commitmentMemoryStore.ts';
import { FileObservationStore } from '../../src/domain/memory/observationStore.ts';
import { createFileDecisionStore } from '../../lib/priority/annotation/decisionStore.ts';
import { backupPilotData, restorePilotData } from '../../lib/operations/pilotDataBackup.ts';

/** Runs a synchronous `body` as though the process were a Cloud Run revision. */
function onCloudRun<T>(body: () => T): T {
  const previous = process.env[CLOUD_RUN_ENV_VAR];
  process.env[CLOUD_RUN_ENV_VAR] = 'maybesitter-api';
  try {
    return body();
  } finally {
    if (previous === undefined) delete process.env[CLOUD_RUN_ENV_VAR];
    else process.env[CLOUD_RUN_ENV_VAR] = previous;
  }
}

/**
 * The async form, and it has to be separate.
 *
 * `try { return body() } finally { restore }` around an *async* body restores
 * the variable the moment the body first suspends, not when it settles — so
 * everything after the first `await` would run with `K_SERVICE` already
 * cleared and quietly not be under test at all. Awaiting inside the `try` is
 * what keeps the whole body on Cloud Run.
 */
async function onCloudRunAsync<T>(body: () => Promise<T>): Promise<T> {
  const previous = process.env[CLOUD_RUN_ENV_VAR];
  process.env[CLOUD_RUN_ENV_VAR] = 'maybesitter-api';
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env[CLOUD_RUN_ENV_VAR];
    else process.env[CLOUD_RUN_ENV_VAR] = previous;
  }
}

/**
 * `assert.throws` returns undefined, so the error is captured by hand — the
 * refusal has to be inspected, not merely counted: a guard that fired for some
 * other reason would satisfy "it threw" and tell an operator nothing.
 */
function captureThrow(body: () => unknown): unknown {
  try {
    body();
  } catch (error) {
    return error;
  }
  return undefined;
}

function assertRefused(store: string, firstUse: () => unknown): void {
  const error = captureThrow(firstUse);
  assert.ok(
    error instanceof CloudRunUnsupportedStoreError,
    `first use of ${store} on Cloud Run must throw CloudRunUnsupportedStoreError, got ${String(error)}`,
  );
  assert.equal(error.store, store, `the refusal must name ${store} so a log line identifies it`);
}

test('legacy web store: reading and writing the single-user data file are both refused', async () => {
  // Both exported entry points are guarded, not just the writer: a read that
  // returns an empty snapshot on Cloud Run would look to the UI like a user
  // with no data rather than a store that is not available.
  await onCloudRunAsync(async () => {
    await assert.rejects(getAppSnapshot(), CloudRunUnsupportedStoreError);
    await assert.rejects(updateAppData(async (data) => data), CloudRunUnsupportedStoreError);
  });
});

test('legacy commitment-memory store: constructing it is refused', () => {
  onCloudRun(() => assertRefused(
    'src/domain/memory/commitmentMemoryStore',
    () => new FileCommitmentMemoryStore(),
  ));
});

test('legacy observation store: constructing it is refused', () => {
  onCloudRun(() => assertRefused(
    'src/domain/memory/observationStore',
    () => new FileObservationStore(),
  ));
});

test('offline annotation store: building the file-backed store is refused', () => {
  onCloudRun(() => assertRefused(
    'lib/priority/annotation/decisionStore',
    () => createFileDecisionStore(),
  ));
});

test('pilot backup helpers: both backup and restore are refused', () => {
  onCloudRun(() => {
    // Refused before any argument validation, so a misconfigured Cloud Run job
    // is told the real reason rather than "MAYBESITTER_DATA_DIR is empty".
    assertRefused('lib/operations/pilotDataBackup', () => backupPilotData({ sourceDir: '', backupRoot: '' }));
    assertRefused('lib/operations/pilotDataBackup', () => restorePilotData({ backupPath: '', targetDir: '' }));
  });
});

test('off Cloud Run the guards are inert, so local development is unaffected', () => {
  const previous = process.env[CLOUD_RUN_ENV_VAR];
  try {
    delete process.env[CLOUD_RUN_ENV_VAR];
    // Constructing is allowed; these touch no disk until a method is called.
    assert.doesNotThrow(() => new FileCommitmentMemoryStore());
    assert.doesNotThrow(() => new FileObservationStore());
    assert.doesNotThrow(() => createFileDecisionStore());
  } finally {
    if (previous === undefined) delete process.env[CLOUD_RUN_ENV_VAR];
    else process.env[CLOUD_RUN_ENV_VAR] = previous;
  }
});

// The whole point of guarding at first use. If someone moves a guard to module
// scope, every test above still passes and the deployment stops booting.
test('importing a guarded module on Cloud Run does not throw: the guard is at first use', async () => {
  await onCloudRunAsync(async () => {
    for (const specifier of [
      '../../src/server/dataStore.ts',
      '../../src/domain/memory/commitmentMemoryStore.ts',
      '../../src/domain/memory/observationStore.ts',
      '../../lib/priority/annotation/decisionStore.ts',
      '../../lib/operations/pilotDataBackup.ts',
    ]) {
      // A cache-busting query so this is a real module evaluation rather than
      // a hit on the instance the static imports above already loaded.
      await assert.doesNotReject(
        import(`${specifier}?cloudrun=${Math.random()}`),
        `${specifier} threw while being imported; the guard belongs at first use, not module init`,
      );
    }
  });
});
