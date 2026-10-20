/**
 * M5b-1 Gate B — release: the probe, the switch's resolution and the
 * production pin (PLAN-M5b-1 "Release", Wire "GET /api/mobile/capabilities/m5b").
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { begin, end, loadModule, probe } from './support.ts';

test.afterEach(() => end());

test('Release: GET /api/mobile/capabilities/m5b answers { success: true, memoryLearning: true } when on, strict shape', async () => {
  const body = await probe(await begin());
  assert.equal(body.success, true);
  assert.equal(body.memoryLearning, true);
  assert.deepEqual(Object.keys(body).sort(), ['memoryLearning', 'success']);
});

test('Release: memoryLearning is false when the flag is off, unset or killed', async () => {
  assert.equal((await probe(await begin({ on: false }))).memoryLearning, false);
  end();
  assert.equal((await probe(await begin({ on: null }))).memoryLearning, false, 'default-off: an unset flag must resolve off');
  end();
  assert.equal((await probe(await begin({ on: true, killed: true }))).memoryLearning, false, 'the kill switch must win over the flag');
});

test('Release: memoryLearning is false outside local / test / staging, even with the flag on', async () => {
  assert.equal((await probe(await begin({ environment: 'production' }))).memoryLearning, false);
  end();
  assert.equal((await probe(await begin({ environment: 'test' }))).memoryLearning, true, 'test is an allowed environment, as M4b');
});

test('Release: the probe needs a signed-in caller (the M4b probe rules)', async () => {
  await begin();
  const { GET } = await loadModule('src/app/api/mobile/capabilities/m5b/route.ts') as { GET: (request: Request) => Promise<Response> };
  const anonymous = await GET(new Request('http://localhost:3000/api/mobile/capabilities/m5b'));
  assert.equal(anonymous.status, 401);
});

test('Release: lib/release/m5bCapabilities.ts resolves exactly like M4b (env allow-list → kill switch → flag)', async () => {
  const module = await loadModule('lib/release/m5bCapabilities.ts');
  const resolve = module.resolveMemoryLearning as (env?: Record<string, string | undefined>) => boolean;
  assert.equal(typeof resolve, 'function', 'resolveMemoryLearning is not exported');
  const on = { MAYBESITTER_FEATURE_MEMORY_LEARNING: 'true' };
  assert.equal(resolve({ ...on, MAYBESITTER_ENV: 'staging' }), true);
  assert.equal(resolve({ ...on, MAYBESITTER_ENV: 'local' }), true);
  assert.equal(resolve({ ...on }), true, 'MAYBESITTER_ENV unset reads as local, as M4b');
  assert.equal(resolve({ ...on, MAYBESITTER_ENV: 'production' }), false);
  assert.equal(resolve({ ...on, MAYBESITTER_ENV: 'staging', MAYBESITTER_KILL_SWITCH_MEMORY_LEARNING: 'true' }), false);
  assert.equal(resolve({ MAYBESITTER_ENV: 'staging' }), false);
});

test('Release / D19: flags.sh turns M5b on for staging and pins it off for production, both written out with explicit kill switches', () => {
  const script = fileURLToPath(new URL('../../../infra/cloudrun/flags.sh', import.meta.url));
  const production = execFileSync('bash', [script, 'production'], { encoding: 'utf8' });
  assert.match(production, /MAYBESITTER_FEATURE_MEMORY_LEARNING=false/, 'MAYBESITTER_FEATURE_MEMORY_LEARNING is not pinned off for production');
  assert.match(production, /MAYBESITTER_KILL_SWITCH_MEMORY_LEARNING=false/, 'no explicit kill switch for production');
  const staging = execFileSync('bash', [script, 'staging'], { encoding: 'utf8' });
  assert.match(staging, /MAYBESITTER_FEATURE_MEMORY_LEARNING=true/, 'M5b is not on for staging');
  assert.match(staging, /MAYBESITTER_KILL_SWITCH_MEMORY_LEARNING=false/);
  const source = readFileSync(script, 'utf8');
  assert.match(source, /m5b_features="true"/, 'staging m5b_features is not written out');
  assert.match(source, /m5b_features="false"/, 'production m5b_features is not written out');
});
