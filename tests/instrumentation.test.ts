/**
 * The boot check, after the pilot configuration it used to validate was
 * deleted (UC-1.0e, #144).
 *
 * It used to demand an HMAC token secret, a 25–40 participant allowlist and
 * an absolute durable data directory. None of those exist now. What is left
 * is what a Cloud Run revision can still get wrong in a way that loses data
 * or loses identity, and each of those fails the boot rather than the first
 * request.
 */
import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { register } from '../src/instrumentation';

const KEYS = [
  'NEXT_RUNTIME',
  'K_SERVICE',
  'GOOGLE_CLOUD_PROJECT',
  'MAYBESITTER_STORAGE_BACKEND',
  'MAYBESITTER_DEV_AUTH',
] as const;

/** Runs `body` with exactly the given environment, then restores every key. */
async function withEnv(
  env: Partial<Record<(typeof KEYS)[number], string>>,
  body: () => Promise<void>,
): Promise<void> {
  const previous = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(env)) {
      // Assigning `undefined` would set the literal string "undefined".
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await body();
  } finally {
    for (const key of KEYS) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const VALID_PRODUCTION = {
  NEXT_RUNTIME: 'nodejs',
  K_SERVICE: 'maybesitter-api',
  GOOGLE_CLOUD_PROJECT: 'maybesitter-app',
  MAYBESITTER_STORAGE_BACKEND: 'firestore',
} as const;

test('instrumentation skips the runtime check in the Edge runtime bundle', async () => {
  // Deliberately a configuration the Node path would reject, so this asserts
  // the skip rather than accidentally passing a valid configuration.
  await withEnv({ ...VALID_PRODUCTION, NEXT_RUNTIME: 'edge', MAYBESITTER_STORAGE_BACKEND: 'memory' }, async () => {
    await assert.doesNotReject(register());
  });
});

test('a local process is not held to the Cloud Run requirements', async () => {
  // No K_SERVICE: no project bound, memory storage, and that is correct here.
  await withEnv({ NEXT_RUNTIME: 'nodejs' }, async () => {
    await assert.doesNotReject(register());
  });
});

test('a correctly configured Cloud Run revision boots', async () => {
  await withEnv(VALID_PRODUCTION, async () => {
    await assert.doesNotReject(register());
  });
});

test('Cloud Run without a project binding fails the boot', async () => {
  await withEnv({ ...VALID_PRODUCTION, GOOGLE_CLOUD_PROJECT: undefined }, async () => {
    await assert.rejects(register(), /GOOGLE_CLOUD_PROJECT/);
  });
});

test('Cloud Run with in-memory storage fails the boot rather than losing data', async () => {
  for (const backend of ['memory', '', 'firestore-ish']) {
    await withEnv({ ...VALID_PRODUCTION, MAYBESITTER_STORAGE_BACKEND: backend }, async () => {
      await assert.rejects(register(), /MAYBESITTER_STORAGE_BACKEND/);
    });
  }
});

test('a development authentication variable fails the boot on Cloud Run', async () => {
  // No code reads this variable — UC-1.0e shipped no development bypass. The
  // boot refuses the name so that reintroducing one cannot reach production
  // quietly.
  for (const value of ['true', 'false', '1', '']) {
    await withEnv({ ...VALID_PRODUCTION, MAYBESITTER_DEV_AUTH: value }, async () => {
      await assert.rejects(register(), /MAYBESITTER_DEV_AUTH/);
    });
  }
});

test('the same development variable is simply ignored off Cloud Run', async () => {
  await withEnv({ NEXT_RUNTIME: 'nodejs', MAYBESITTER_DEV_AUTH: 'true' }, async () => {
    await assert.doesNotReject(register());
  });
});
