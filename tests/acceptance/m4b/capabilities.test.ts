/**
 * M4b Gate B — the capability probe (PLAN-M4b R3.3, M4B-REV-007, M4B-R6-004;
 * WIRE-M4b "Capability probe") and the production pin (PLAN "Release").
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { begin, call, end, show } from './support.ts';

test.afterEach(() => end());

async function probe(uid: string) {
  const result = await call(uid, 'capabilities/m4b', 'GET');
  assert.equal(result.status, 200, show(result.body));
  return result.body;
}

test('REV-007: the probe answers the three capabilities', async () => {
  const uid = begin();
  const body = await probe(uid);
  assert.equal(body.success, true);
  assert.deepEqual({ a: body.externalClashHold, b: body.eveningImpact, c: body.smartPostpone }, { a: true, b: true, c: true });
});

test('REV-007: each capability answers false when off or killed, independently', async () => {
  const off = await probe(begin({ hold: false, impactKilled: true, postpone: false }));
  assert.deepEqual([off.externalClashHold, off.eveningImpact, off.smartPostpone], [false, false, false]);
  end();
  const mixed = await probe(begin({ holdKilled: true }));
  assert.deepEqual([mixed.externalClashHold, mixed.eveningImpact, mixed.smartPostpone], [false, true, true]);
});

test('M4B-R6-004: smart postpone resolves off without a slot key of at least 32 bytes', async () => {
  assert.equal((await probe(begin({ slotKey: null }))).smartPostpone, false);
  end();
  assert.equal((await probe(begin({ slotKey: 'short' }))).smartPostpone, false);
});

test('Release: outside local / test / staging every capability is false', async () => {
  const body = await probe(begin({ environment: 'production' }));
  assert.deepEqual([body.externalClashHold, body.eveningImpact, body.smartPostpone], [false, false, false]);
});

test('Release: the production flag config pins all three off, with explicit kill switches', () => {
  // The same script the deploy and tests/infra/firstDeploy.test.ts run.
  const script = fileURLToPath(new URL('../../../infra/cloudrun/flags.sh', import.meta.url));
  const production = execFileSync('bash', [script, 'production'], { encoding: 'utf8' });
  for (const name of ['EXTERNAL_CLASH_HOLD', 'EVENING_IMPACT', 'SMART_POSTPONE']) {
    assert.match(production, new RegExp(`MAYBESITTER_FEATURE_${name}=false`), `MAYBESITTER_FEATURE_${name} is not pinned off for production`);
    assert.match(production, new RegExp(`MAYBESITTER_KILL_SWITCH_${name}=false`), `no explicit kill switch for ${name}`);
  }
});

test('M4B-R6-004: the slot key is documented in .env.example', () => {
  const example = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');
  assert.match(example, /MAYBESITTER_POSTPONE_SLOT_HMAC_KEY/);
});
