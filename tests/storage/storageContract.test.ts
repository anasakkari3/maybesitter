/**
 * The storage contract against the memory adapter, plus the two rules that are
 * about choosing a backend rather than about using one.
 *
 * The identical contract runs against Firestore in
 * `tests/storage/storageContract.emulator.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import {
  CLOUD_RUN_ENV_VAR,
  STORAGE_BACKEND_ENV_VAR,
  getStorage,
  resetStorageForTests,
  resolveStorageBackend,
  setStorageForTests,
} from '../../lib/storage/index.ts';
import { docIdForKey, requireUserId, userCol, userDoc } from '../../lib/storage/paths.ts';
import { storageContractSuite } from './storageContractSuite.ts';
import {
  MemoryIntegrationConnectionStore,
  recordConnectionSync,
} from '../../lib/integrations/connections/connectionRegistry.ts';
import {
  NATIVE_READINESS_PRIVACY_POLICY,
  type NativeReadinessResult,
} from '../../lib/integrations/readiness/nativeAdapterContracts.ts';

storageContractSuite('memory', async () => ({
  adapter: createMemoryStorage(),
  scope: `s${randomUUID().replace(/-/g, '')}`,
}));

/* ── Choosing a backend ──────────────────────────────────────────── */

function withEnv(values: Record<string, string | undefined>, run: () => void): void {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(values)) previous[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('the default backend is memory off Cloud Run and firestore on it', () => {
  withEnv({ [STORAGE_BACKEND_ENV_VAR]: undefined, [CLOUD_RUN_ENV_VAR]: undefined }, () => {
    assert.equal(resolveStorageBackend(), 'memory');
  });
  withEnv({ [STORAGE_BACKEND_ENV_VAR]: undefined, [CLOUD_RUN_ENV_VAR]: 'maybesitter-api' }, () => {
    assert.equal(resolveStorageBackend(), 'firestore');
  });
});

// In-memory storage on Cloud Run is not slow, it is lossy: it is gone on every
// instance restart and is not shared between instances. A deployment that
// configured it fails on first use rather than after the first user typed
// something.
test('K_SERVICE with a non-firestore backend throws on first storage use', () => {
  resetStorageForTests();
  try {
    withEnv({ [CLOUD_RUN_ENV_VAR]: 'x', [STORAGE_BACKEND_ENV_VAR]: 'memory' }, () => {
      assert.throws(() => getStorage(), /in-memory storage is lost on every instance restart/);
      assert.throws(() => resolveStorageBackend(), /K_SERVICE is set/);
    });
  } finally {
    resetStorageForTests();
  }
});

test('an unrecognised backend name is refused rather than guessed', () => {
  withEnv({ [STORAGE_BACKEND_ENV_VAR]: 'postgres', [CLOUD_RUN_ENV_VAR]: undefined }, () => {
    assert.throws(() => resolveStorageBackend(), /must be "firestore" or "memory"/);
  });
});

test('setStorageForTests overrides the environment, and reset restores it', () => {
  const adapter = createMemoryStorage();
  setStorageForTests(adapter);
  assert.equal(getStorage(), adapter);
  resetStorageForTests();
  assert.notEqual(getStorage(), adapter);
  resetStorageForTests();
});

/* ── Paths ───────────────────────────────────────────────────────── */

test('a user id accepts pilot ids and Firebase uids, and rejects what breaks a path', () => {
  // Mixed case matters: a Firebase uid is mixed-case, and the pilot pattern is
  // lowercase-only, so reusing it here would reject every real account.
  for (const id of ['p-100', 'pilot_1', 'aBcD3fGh1JkLmN0pQrSt', 'A'.repeat(128)]) {
    assert.equal(requireUserId(id), id);
  }
  for (const id of ['', '.', '..', 'a/b', 'a b', 'a.b', 'A'.repeat(129), null, undefined, 7]) {
    assert.throws(() => requireUserId(id as never), /userId must match/, `accepted ${String(id)}`);
  }
});

test('a user tree is built from one place', () => {
  assert.equal(userDoc('p-100'), 'users/p-100');
  assert.equal(userCol('p-100', 'commitments'), 'users/p-100/commitments');
  assert.throws(() => userCol('p-100', 'not a name'), /collection name/);
});

test('a free-text key becomes a sha256 document id, deterministically', () => {
  const key = 'idempotency key with / and spaces and أحرف';
  const id = docIdForKey(key);
  assert.match(id, /^[0-9a-f]{64}$/);
  assert.equal(docIdForKey(key), id);
  assert.notEqual(docIdForKey(`${key} `), id);
  assert.throws(() => docIdForKey(''), /non-empty string/);
});

/* ── Integration connections ───────────────────────────────────── */

const CONNECTION_NOW = '2026-09-16T12:00:00.000Z';

function googleConnectionInput(scopeId = 'scope-a') {
  return {
    scopeId,
    identity: {
      provider: 'google' as const,
      providerAccountId: 'acct-1',
      providerSpaceId: null,
      displayName: 'Work',
    },
    state: 'connected' as const,
    capabilities: ['calendar_busy', 'mail_read'] as const,
    grantedScopes: ['gmail.readonly', 'calendar.readonly'],
    credentialRef: { vault: 'kms', keyId: 'cred-1', version: '7' },
    featureFlag: 'connected_context_google',
    provenance: { source: 'oauth' as const, connectedBy: 'user' as const, recordedAt: CONNECTION_NOW },
  };
}

test('connection records keep references instead of provider credentials', async () => {
  const store = new MemoryIntegrationConnectionStore();
  const record = await store.upsert(googleConnectionInput(), CONNECTION_NOW);

  assert.match(record.connectionId, /^int_[a-f0-9]{24}$/);
  assert.deepEqual(record.capabilities, ['calendar_busy', 'mail_read']);
  assert.deepEqual(record.grantedScopes, ['calendar.readonly', 'gmail.readonly']);
  assert.deepEqual(record.credentialRef, { vault: 'kms', keyId: 'cred-1', version: '7' });
  assert.equal('accessToken' in record, false);
  assert.equal('refreshToken' in record, false);
});

test('connection identity is idempotent and scope filtering prevents account leakage', async () => {
  const store = new MemoryIntegrationConnectionStore();
  const first = await store.upsert(googleConnectionInput(), CONNECTION_NOW);
  const second = await store.upsert(
    { ...googleConnectionInput(), state: 'needs_reauth' },
    '2026-09-16T13:00:00.000Z',
  );
  await store.upsert(googleConnectionInput('scope-b'), CONNECTION_NOW);

  assert.equal(second.connectionId, first.connectionId);
  assert.equal(second.reauthRequired, true);
  const visible = await store.list({ scopeId: 'scope-a', provider: 'google', capability: 'mail_read' });
  assert.equal(visible.length, 1);
  assert.equal(visible[0]?.scopeId, 'scope-a');
});

test('sync checkpoints are opaque and update only connected records', async () => {
  const store = new MemoryIntegrationConnectionStore();
  const record = await store.upsert(googleConnectionInput(), CONNECTION_NOW);
  const synced = await recordConnectionSync(
    store,
    record.connectionId,
    { cursor: 'provider-owned-cursor', checkpointAt: '2026-09-16T12:05:00.000Z' },
    '2026-09-16T12:05:00.000Z',
  );

  assert.equal(synced?.sync?.cursor, 'provider-owned-cursor');
  await store.markState(record.connectionId, 'revoked', '2026-09-16T12:06:00.000Z');
  assert.equal(await recordConnectionSync(store, record.connectionId, { cursor: 'later', checkpointAt: CONNECTION_NOW }, CONNECTION_NOW), null);
});

test('native readiness adapters share one privacy boundary', () => {
  const result: NativeReadinessResult = {
    state: 'empty',
    authorization: 'authorized',
    snapshot: null,
    provenance: {
      source: 'healthkit',
      connectionId: null,
      collectedAt: CONNECTION_NOW,
      newestSampleAt: null,
      rawPayloadPersisted: false,
    },
    errorCode: null,
  };

  assert.equal(NATIVE_READINESS_PRIVACY_POLICY.rawPayloadLoggingAllowed, false);
  assert.equal(NATIVE_READINESS_PRIVACY_POLICY.rawPayloadPersistenceAllowed, false);
  assert.equal(result.provenance.rawPayloadPersisted, false);
  assert.equal('rawPayload' in result, false);
});
