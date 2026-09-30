import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryStorage } from '../../lib/storage/index.ts';
import { runGmailMonitorTick, readGmailMonitor, type GmailMonitor } from '../../lib/intelligence/gmailMonitor.ts';
import type { GmailTransport } from '../../lib/integrations/gmail/production/gmailTransport.ts';
import type { GoogleRuntime } from '../../lib/integrations/google/googleRuntime.ts';

const FIRST = '2026-09-30T10:00:00.000Z';

test('opted-in Gmail monitor processes source evidence once and advances only after success', async () => {
  const storage = createMemoryStorage();
  let time = FIRST;
  const runtime: GoogleRuntime = {
    storage, env: { MAYBESITTER_ENV: 'staging', MAYBESITTER_FEATURE_PROACTIVE_LOOP: 'true' } as GoogleRuntime['env'],
    secrets: null, fetchImpl: fetch, now: () => new Date(time),
    shareModel: async () => ({ text: JSON.stringify({ observations: [
      { kind: 'request', evidence: 'Please finish your application', confidence: 0.9 },
    ] }), model: 'fake', latencyMs: 1, promptTokens: 1, outputTokens: 1 }),
  };
  const monitor: GmailMonitor = {
    enabled: true, generation: 'enabled', cursor: '100', pageToken: null,
    nextPollAt: FIRST, leaseUntil: null, lastSuccessAt: null, error: null,
  };
  await storage.set('users/alice/intelligenceMonitors/gmail', monitor);
  let reads = 0;
  const transport = { listHistory: async () => {
    reads++;
    return { historyId: '101', nextPageToken: null, messages: [{
      id: 'mail1', threadId: null, historyId: '101', receivedAt: FIRST,
      from: null, subject: 'Please finish your application', text: 'Please finish your application',
    }] };
  } } satisfies Pick<GmailTransport, 'listHistory'>;
  const options = { transport: () => transport, ensureReadable: async () => undefined };
  assert.deepEqual(await runGmailMonitorTick(runtime, options), {
    enabled: true, accountsChecked: 1, messagesAnalyzed: 1, failures: 0,
  });
  assert.equal((await readGmailMonitor('alice', storage))?.cursor, '101');
  assert.equal((await storage.list('users/alice/intelligenceObservations')).length, 1);
  time = '2026-09-30T10:05:00.000Z';
  assert.equal((await runGmailMonitorTick(runtime, options)).messagesAnalyzed, 0);
  assert.equal((await storage.list('users/alice/intelligenceObservations')).length, 1);
  assert.equal(reads, 2);
  assert.equal((await storage.list('users/bob/intelligenceObservations')).length, 0);
});

test('a model outage keeps the Gmail cursor for retry', async () => {
  const storage = createMemoryStorage();
  await storage.set('users/alice/intelligenceMonitors/gmail', {
    enabled: true, generation: 'enabled', cursor: '100', pageToken: null,
    nextPollAt: FIRST, leaseUntil: null, lastSuccessAt: null, error: null,
  } satisfies GmailMonitor);
  const runtime: GoogleRuntime = {
    storage, env: { MAYBESITTER_ENV: 'staging', MAYBESITTER_FEATURE_PROACTIVE_LOOP: 'true' } as GoogleRuntime['env'],
    secrets: null, fetchImpl: fetch, now: () => new Date(FIRST),
    shareModel: async () => { throw new Error('model unavailable'); },
  };
  const transport = { listHistory: async () => ({ historyId: '101', nextPageToken: null, messages: [{
    id: 'mail1', threadId: null, historyId: '101', receivedAt: FIRST,
    from: null, subject: 'Please finish your application', text: 'Please finish your application',
  }] }) } satisfies Pick<GmailTransport, 'listHistory'>;
  const result = await runGmailMonitorTick(runtime, { transport: () => transport, ensureReadable: async () => undefined });
  assert.equal(result.failures, 1);
  assert.equal((await readGmailMonitor('alice', storage))?.cursor, '100');
  assert.equal((await readGmailMonitor('alice', storage))?.error, 'analysis_unavailable');
  assert.equal((await storage.list('users/alice/intelligenceSourceMarkers')).length, 0);
});

test('turning monitoring off during model analysis prevents a new observation', async () => {
  const storage = createMemoryStorage();
  await storage.set('users/alice/intelligenceMonitors/gmail', {
    enabled: true, generation: 'enabled', cursor: '100', pageToken: null,
    nextPollAt: FIRST, leaseUntil: null, lastSuccessAt: null, error: null,
  } satisfies GmailMonitor);
  const runtime: GoogleRuntime = {
    storage, env: { MAYBESITTER_ENV: 'staging', MAYBESITTER_FEATURE_PROACTIVE_LOOP: 'true' } as GoogleRuntime['env'],
    secrets: null, fetchImpl: fetch, now: () => new Date(FIRST),
    shareModel: async () => {
      await storage.runTransaction(async tx => {
        await tx.get('users/alice/intelligenceMonitors/gmail');
        tx.merge('users/alice/intelligenceMonitors/gmail', { enabled: false, generation: 'revoked' });
      });
      return { text: JSON.stringify({ observations: [
        { kind: 'request', evidence: 'Please finish your application', confidence: 0.9 },
      ] }), model: 'fake', latencyMs: 1, promptTokens: 1, outputTokens: 1 };
    },
  };
  const transport = { listHistory: async () => ({ historyId: '101', nextPageToken: null, messages: [{
    id: 'mail1', threadId: null, historyId: '101', receivedAt: FIRST,
    from: null, subject: 'Please finish your application', text: 'Please finish your application',
  }] }) } satisfies Pick<GmailTransport, 'listHistory'>;
  const result = await runGmailMonitorTick(runtime, { transport: () => transport, ensureReadable: async () => undefined });
  assert.equal(result.failures, 1);
  assert.equal((await storage.list('users/alice/intelligenceObservations')).length, 0);
  assert.equal((await storage.list('users/alice/intelligenceSourceMarkers')).length, 0);
  assert.equal((await readGmailMonitor('alice', storage))?.enabled, false);
});

test('global monitoring pause stops the Gmail reader', async () => {
  const storage = createMemoryStorage();
  await storage.set('users/alice', { monitoringSettings: { paused: true, updatedAt: FIRST } });
  await storage.set('users/alice/intelligenceMonitors/gmail', {
    enabled: true, generation: 'enabled', cursor: '100', pageToken: null,
    nextPollAt: FIRST, leaseUntil: null, lastSuccessAt: null, error: null,
  } satisfies GmailMonitor);
  const runtime: GoogleRuntime = {
    storage, env: { MAYBESITTER_ENV: 'staging', MAYBESITTER_FEATURE_PROACTIVE_LOOP: 'true' } as GoogleRuntime['env'],
    secrets: null, fetchImpl: fetch, now: () => new Date(FIRST),
  };
  const result = await runGmailMonitorTick(runtime, {
    transport: () => { throw new Error('reader should not open'); },
    ensureReadable: async () => { throw new Error('grant should not be checked'); },
  });
  assert.equal(result.failures, 0);
  assert.equal(result.messagesAnalyzed, 0);
  assert.equal((await readGmailMonitor('alice', storage))?.cursor, '100');
});
