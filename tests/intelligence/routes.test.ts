import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryStorage, resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { installFakeAuth, tokenFor, uidFor } from '../support/fakeAuth.ts';
import { GET as inboxGet, POST as statementPost } from '../../src/app/api/mobile/intelligence/route.ts';
import { POST as observationPost } from '../../src/app/api/mobile/intelligence/observations/[id]/route.ts';
import { createStorageRuntimeMemoryStore } from '../../lib/runtimeMemory/runtimeMemoryStore.ts';
import { GET as monitorGet, POST as monitorPost } from '../../src/app/api/mobile/intelligence/sources/gmail/monitor/route.ts';

const ALICE = uidFor('IntelligenceAlice');
const BOB = uidFor('IntelligenceBob');
const BASE = 'http://127.0.0.1:4321';

function request(uid: string, path: string, body?: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${tokenFor(uid)}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test('staging route keeps each observation under the authenticated account and requires review', async () => {
  const before = {
    env: process.env.MAYBESITTER_ENV,
    feature: process.env.MAYBESITTER_FEATURE_PROACTIVE_LOOP,
    provider: process.env.MAYBESITTER_LLM_PROVIDER,
  };
  const auth = installFakeAuth();
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  try {
    process.env.MAYBESITTER_ENV = 'staging';
    process.env.MAYBESITTER_FEATURE_PROACTIVE_LOOP = 'true';
    process.env.MAYBESITTER_LLM_PROVIDER = 'none';
    const created = await statementPost(request(ALICE, '/api/mobile/intelligence', { text: 'I want to learn React' }));
    assert.equal(created.status, 201);
    const observation = ((await created.json()) as any).observations[0];
    assert.equal(observation.kind, 'goal');
    assert.equal(observation.review, 'pending');
    assert.equal(((await (await inboxGet(request(BOB, '/api/mobile/intelligence'))).json()) as any).observations.length, 0);
    const stranger = await observationPost(request(BOB, `/api/mobile/intelligence/observations/${observation.id}`, { review: 'confirmed' }), { params: Promise.resolve({ id: observation.id }) });
    assert.equal(stranger.status, 404);
    const confirmed = await observationPost(request(ALICE, `/api/mobile/intelligence/observations/${observation.id}`, { review: 'confirmed' }), { params: Promise.resolve({ id: observation.id }) });
    const confirmedObservation = ((await confirmed.json()) as any).observation;
    assert.equal(confirmedObservation.review, 'confirmed');
    assert.ok(confirmedObservation.linkedMemoryId, 'confirming a goal must make it available to My things');
    const memory = createStorageRuntimeMemoryStore(undefined, storage);
    assert.equal((await memory.retrieve({ scopeId: ALICE, kind: 'goal', now: new Date().toISOString() })).length, 1);
    assert.equal((await memory.retrieve({ scopeId: BOB, kind: 'goal', now: new Date().toISOString() })).length, 0);
    assert.equal((await observationPost(request(ALICE, `/api/mobile/intelligence/observations/${observation.id}`, { review: 'confirmed' }), { params: Promise.resolve({ id: observation.id }) })).status, 200);
    assert.equal((await memory.retrieve({ scopeId: ALICE, kind: 'goal', now: new Date().toISOString() })).length, 1);
    await storage.set(`users/${ALICE}/intelligenceMonitors/gmail`, {
      enabled: true, generation: 'alice-only', cursor: '100', pageToken: null,
      nextPollAt: '2026-10-01T00:00:00.000Z', leaseUntil: null, lastSuccessAt: null, error: null,
    });
    assert.equal(((await (await monitorGet(request(ALICE, '/api/mobile/intelligence/sources/gmail/monitor'))).json()) as any).enabled, true);
    assert.equal(((await (await monitorGet(request(BOB, '/api/mobile/intelligence/sources/gmail/monitor'))).json()) as any).enabled, false);
    assert.equal(((await (await monitorPost(request(ALICE, '/api/mobile/intelligence/sources/gmail/monitor', { enabled: false }))).json()) as any).enabled, false);
    // Released to production on 2026-10-01 (owner decision); the kill switch
    // still takes the whole route out, and an unknown environment stays off.
    process.env.MAYBESITTER_ENV = 'production';
    assert.equal((await inboxGet(request(ALICE, '/api/mobile/intelligence'))).status, 200);
    process.env.MAYBESITTER_KILL_SWITCH_PROACTIVE_LOOP = 'true';
    assert.equal((await inboxGet(request(ALICE, '/api/mobile/intelligence'))).status, 404);
    delete process.env.MAYBESITTER_KILL_SWITCH_PROACTIVE_LOOP;
    process.env.MAYBESITTER_ENV = 'development';
    assert.equal((await inboxGet(request(ALICE, '/api/mobile/intelligence'))).status, 404);
  } finally {
    for (const [key, value] of Object.entries({
      MAYBESITTER_ENV: before.env,
      MAYBESITTER_FEATURE_PROACTIVE_LOOP: before.feature,
      MAYBESITTER_LLM_PROVIDER: before.provider,
    })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    resetStorageForTests();
    auth.restore();
  }
});
