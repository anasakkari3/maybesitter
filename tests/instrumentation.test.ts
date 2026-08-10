import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { register } from '../src/instrumentation';

test('instrumentation skips pilot runtime validation in the Edge runtime bundle', async () => {
  const previousRuntime = process.env.NEXT_RUNTIME;
  const previousPilotMode = process.env.MAYBESITTER_PILOT_MODE;
  const previousSecret = process.env.MAYBESITTER_PILOT_TOKEN_SECRET;
  const previousAllowlist = process.env.MAYBESITTER_CLOSED_PILOT_IDS;
  const previousDataDir = process.env.MAYBESITTER_DATA_DIR;

  try {
    process.env.NEXT_RUNTIME = 'edge';
    process.env.MAYBESITTER_PILOT_MODE = 'true';
    delete process.env.MAYBESITTER_PILOT_TOKEN_SECRET;
    delete process.env.MAYBESITTER_CLOSED_PILOT_IDS;
    delete process.env.MAYBESITTER_DATA_DIR;

    await assert.doesNotReject(register());
  } finally {
    restoreEnv('NEXT_RUNTIME', previousRuntime);
    restoreEnv('MAYBESITTER_PILOT_MODE', previousPilotMode);
    restoreEnv('MAYBESITTER_PILOT_TOKEN_SECRET', previousSecret);
    restoreEnv('MAYBESITTER_CLOSED_PILOT_IDS', previousAllowlist);
    restoreEnv('MAYBESITTER_DATA_DIR', previousDataDir);
  }
});

test('instrumentation validates pilot runtime configuration in Node runtime', async () => {
  const previousRuntime = process.env.NEXT_RUNTIME;
  const previousPilotMode = process.env.MAYBESITTER_PILOT_MODE;
  const previousSecret = process.env.MAYBESITTER_PILOT_TOKEN_SECRET;
  const previousAllowlist = process.env.MAYBESITTER_CLOSED_PILOT_IDS;
  const previousDataDir = process.env.MAYBESITTER_DATA_DIR;

  try {
    process.env.NEXT_RUNTIME = 'nodejs';
    process.env.MAYBESITTER_PILOT_MODE = 'true';
    delete process.env.MAYBESITTER_PILOT_TOKEN_SECRET;
    delete process.env.MAYBESITTER_CLOSED_PILOT_IDS;
    delete process.env.MAYBESITTER_DATA_DIR;

    await assert.rejects(register(), /MAYBESITTER_PILOT_TOKEN_SECRET/);
  } finally {
    restoreEnv('NEXT_RUNTIME', previousRuntime);
    restoreEnv('MAYBESITTER_PILOT_MODE', previousPilotMode);
    restoreEnv('MAYBESITTER_PILOT_TOKEN_SECRET', previousSecret);
    restoreEnv('MAYBESITTER_CLOSED_PILOT_IDS', previousAllowlist);
    restoreEnv('MAYBESITTER_DATA_DIR', previousDataDir);
  }
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}