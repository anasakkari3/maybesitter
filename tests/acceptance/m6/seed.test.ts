/**
 * M6a-1 Gate B — M6A-R4-008: the committed dense seed fails closed unless the
 * target is loopback with both emulators set and an explicit --email.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
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

test('M6A-R5-004 a loopback API without the server-side emulator attestation gets exactly one request (the health check) and the seed refuses', async () => {
  const seen: string[] = [];
  const server = createServer((request, response) => {
    seen.push(`${request.method} ${request.url}`);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const child = await new Promise<{ status: number | null; out: string }>((resolve) => {
      const proc = spawn(process.execPath, [SCRIPT.pathname, '--email', 'dense@maybesitter.test'], {
        env: { PATH: process.env.PATH ?? '', ...EMULATORS, SEED_API_BASE_URL: `http://127.0.0.1:${port}` } as unknown as NodeJS.ProcessEnv,
      });
      let out = '';
      proc.stdout.on('data', (chunk) => { out += chunk; });
      proc.stderr.on('data', (chunk) => { out += chunk; });
      proc.on('close', (status) => resolve({ status, out }));
    });
    assert.notEqual(child.status, 0, child.out);
    assert.match(child.out, /attestation/i);
    assert.deepEqual(seen, ['GET /api/health/ready']);
  } finally {
    server.close();
  }
});

test('M6A-R5-004 the health route sends X-MaybeSitter-Emulators only when this process has both emulator hosts and is not production', async () => {
  const { GET } = await import('../../../src/app/api/health/ready/route.ts') as { GET: (r: Request) => Promise<Response> };
  const keys = ['FIREBASE_AUTH_EMULATOR_HOST', 'FIRESTORE_EMULATOR_HOST', 'MAYBESITTER_ENV'] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9199';
    process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8180';
    process.env.MAYBESITTER_ENV = 'staging';
    assert.equal((await GET(new Request('http://localhost/api/health/ready'))).headers.get('X-MaybeSitter-Emulators'), 'auth,firestore');
    process.env.MAYBESITTER_ENV = 'production';
    assert.equal((await GET(new Request('http://localhost/api/health/ready'))).headers.get('X-MaybeSitter-Emulators'), null);
    process.env.MAYBESITTER_ENV = 'staging';
    delete process.env.FIRESTORE_EMULATOR_HOST;
    assert.equal((await GET(new Request('http://localhost/api/health/ready'))).headers.get('X-MaybeSitter-Emulators'), null);
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
