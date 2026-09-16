import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MemoryIntegrationConnectionStore,
  recordConnectionSync,
} from '../../lib/integrations/connections/connectionRegistry';

const NOW = '2026-09-16T12:00:00.000Z';

function googleInput(scopeId = 'scope-a') {
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
    provenance: { source: 'oauth' as const, connectedBy: 'user' as const, recordedAt: NOW },
  };
}

test('connection records keep only a credential reference and normalized provider state', async () => {
  const store = new MemoryIntegrationConnectionStore();
  const record = await store.upsert(googleInput(), NOW);

  assert.match(record.connectionId, /^int_[a-f0-9]{24}$/);
  assert.equal(record.reauthRequired, false);
  assert.deepEqual(record.capabilities, ['calendar_busy', 'mail_read']);
  assert.deepEqual(record.grantedScopes, ['calendar.readonly', 'gmail.readonly']);
  assert.deepEqual(record.credentialRef, { vault: 'kms', keyId: 'cred-1', version: '7' });
  assert.equal('accessToken' in record, false);
  assert.equal('refreshToken' in record, false);
});

test('upsert is idempotent by scope and provider identity', async () => {
  const store = new MemoryIntegrationConnectionStore();
  const first = await store.upsert(googleInput(), NOW);
  const second = await store.upsert({ ...googleInput(), state: 'needs_reauth' }, '2026-09-16T13:00:00.000Z');

  assert.equal(second.connectionId, first.connectionId);
  assert.equal(second.reauthRequired, true);
  assert.equal((await store.list({ scopeId: 'scope-a' })).length, 1);
});

test('sync checkpoints are opaque and update only connected records', async () => {
  const store = new MemoryIntegrationConnectionStore();
  const record = await store.upsert(googleInput(), NOW);
  const synced = await recordConnectionSync(
    store,
    record.connectionId,
    { cursor: 'provider-owned-cursor', checkpointAt: '2026-09-16T12:05:00.000Z' },
    '2026-09-16T12:05:00.000Z',
  );

  assert.equal(synced?.lastSyncedAt, '2026-09-16T12:05:00.000Z');
  assert.equal(synced?.sync?.cursor, 'provider-owned-cursor');

  await store.markState(record.connectionId, 'revoked', '2026-09-16T12:06:00.000Z');
  assert.equal(await recordConnectionSync(store, record.connectionId, { cursor: 'later', checkpointAt: NOW }, NOW), null);
});

test('provider and scope filters cannot leak another account connection', async () => {
  const store = new MemoryIntegrationConnectionStore();
  await store.upsert(googleInput('scope-a'), NOW);
  await store.upsert(googleInput('scope-b'), NOW);

  const visible = await store.list({ scopeId: 'scope-a', provider: 'google', capability: 'mail_read' });
  assert.equal(visible.length, 1);
  assert.equal(visible[0]?.scopeId, 'scope-a');
  assert.equal(await store.deleteScope('scope-a'), 1);
  assert.equal((await store.list({ scopeId: 'scope-b' })).length, 1);
});
