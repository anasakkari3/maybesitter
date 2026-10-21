/**
 * M6a-1 Gate B — M6A-R4-008: the committed dense seed fails closed unless the
 * target is loopback with both emulators set and an explicit --email.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { test } from 'node:test';

const SCRIPT = new URL('../../../scripts/seed-dense-account.mjs', import.meta.url);

function run(env: Record<string, string>, args: string[]) {
  return spawnSync(process.execPath, [SCRIPT.pathname, ...args], {
    env: { PATH: process.env.PATH ?? '', ...env } as unknown as NodeJS.ProcessEnv,
    encoding: 'utf8',
    timeout: 20_000,
  });
}

const EMULATORS = { FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9', FIRESTORE_EMULATOR_HOST: '127.0.0.1:9' };

test('M6A-R4-008 the seed script exists', () => {
  assert.ok(existsSync(SCRIPT), 'scripts/seed-dense-account.mjs not committed');
});

test('M6A-R4-008 a non-loopback API host exits non-zero before any request', () => {
  const result = run({ ...EMULATORS, SEED_API_BASE_URL: 'https://maybesitter-api.example.com' }, ['--email', 'dense@maybesitter.test']);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /loopback/i);
});

test('M6A-R4-008 missing emulator hosts or a missing --email exit non-zero', () => {
  const noEmulators = run({ SEED_API_BASE_URL: 'http://127.0.0.1:9' }, ['--email', 'dense@maybesitter.test']);
  assert.notEqual(noEmulators.status, 0);
  assert.match(noEmulators.stdout + noEmulators.stderr, /EMULATOR_HOST/);
  const noEmail = run({ ...EMULATORS, SEED_API_BASE_URL: 'http://127.0.0.1:9' }, []);
  assert.notEqual(noEmail.status, 0);
  assert.match(noEmail.stdout + noEmail.stderr, /--email/);
});
