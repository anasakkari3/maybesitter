/**
 * The Cloud Run guard itself (UC-1.0c, #142).
 *
 * `tests/storage/legacyStoreGuard.test.ts` checks that the guarded stores call
 * it. This file checks the function they call: that it fires only on Cloud
 * Run, that the message says which store and why, and that the env is read at
 * call time rather than captured at import — the whole point of guarding at
 * first use is that the decision is made when the disk is touched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLOUD_RUN_ENV_VAR,
  CloudRunUnsupportedStoreError,
  assertNotCloudRun,
  onCloudRun,
} from '../../lib/runtime/assertNotCloudRun.ts';

test('assertNotCloudRun: off Cloud Run it does nothing', () => {
  assert.equal(onCloudRun({}), false);
  assert.doesNotThrow(() => assertNotCloudRun('someStore', 'because', {}));
});

test('assertNotCloudRun: an empty K_SERVICE is not Cloud Run', () => {
  // Cloud Run sets a non-empty service name. An empty string is an operator
  // clearing the variable, and must not be read as "we are in the cloud".
  assert.equal(onCloudRun({ [CLOUD_RUN_ENV_VAR]: '' }), false);
  assert.doesNotThrow(() => assertNotCloudRun('someStore', 'because', { [CLOUD_RUN_ENV_VAR]: '' }));
});

/** `assert.throws` returns undefined, so the error is captured by hand. */
function captureThrow(body: () => unknown): unknown {
  try {
    body();
  } catch (error) {
    return error;
  }
  return undefined;
}

test('assertNotCloudRun: on Cloud Run it throws, naming the store and the reason', () => {
  const env = { [CLOUD_RUN_ENV_VAR]: 'maybesitter-api' };
  assert.equal(onCloudRun(env), true);

  const error = captureThrow(
    () => assertNotCloudRun('dataStore', 'the legacy web UI is not a launch surface', env),
  );
  assert.ok(error instanceof CloudRunUnsupportedStoreError, `expected the guard to throw, got ${String(error)}`);

  assert.equal(error.store, 'dataStore');
  // Whoever reads this in a Cloud Run log needs all three facts.
  assert.match(error.message, /dataStore/, 'the message must name the store');
  assert.match(error.message, /maybesitter-api/, 'the message must name the revision it fired on');
  assert.match(
    error.message,
    /the legacy web UI is not a launch surface/,
    'the message must carry the reason the caller supplied',
  );
});

// The guard is deliberately called at first use rather than at module init, so
// it must read the environment when it is called. A version that captured
// `process.env.K_SERVICE` into a module constant would pass every test above
// and still be wrong.
test('assertNotCloudRun: the environment is read at call time, not at import', () => {
  const previous = process.env[CLOUD_RUN_ENV_VAR];
  try {
    delete process.env[CLOUD_RUN_ENV_VAR];
    assert.doesNotThrow(() => assertNotCloudRun('someStore', 'because'));

    process.env[CLOUD_RUN_ENV_VAR] = 'maybesitter-api';
    assert.throws(() => assertNotCloudRun('someStore', 'because'), CloudRunUnsupportedStoreError);

    delete process.env[CLOUD_RUN_ENV_VAR];
    assert.doesNotThrow(
      () => assertNotCloudRun('someStore', 'because'),
      'the guard must stop firing once the variable is gone',
    );
  } finally {
    if (previous === undefined) delete process.env[CLOUD_RUN_ENV_VAR];
    else process.env[CLOUD_RUN_ENV_VAR] = previous;
  }
});
