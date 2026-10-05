import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryStorage } from '../../lib/storage/index.ts';
import { runGmailMonitorTick, readGmailMonitor, type GmailMonitor } from '../../lib/intelligence/gmailMonitor.ts';
import { scanGmailIntelligence } from '../../lib/intelligence/googleGmailIntelligence.ts';
import type { GmailTransport } from '../../lib/integrations/gmail/production/gmailTransport.ts';
import type { GoogleRuntime } from '../../lib/integrations/google/googleRuntime.ts';

const FIRST = '2026-09-30T10:00:00.000Z';

test('manual intelligence scan reads every page in the seven-day window and resumes a failed page', async () => {
  const storage = createMemoryStorage();
  const now = '2026-10-06T12:00:00.000Z';
  const messages = Array.from({ length: 13 }, (_, index) => ({
    id: `mail-${index}`, threadId: null, historyId: '101',
    receivedAt: index === 12 ? '2026-09-28T12:00:00.000Z' : '2026-10-05T12:00:00.000Z',
    from: null, subject: null, text: `Please finish application ${index}`,
  }));
  let failOnce = true;
  let modelCalls = 0;
  const runtime: GoogleRuntime = {
    storage, env: { MAYBESITTER_ENV: 'staging' } as GoogleRuntime['env'],
    secrets: null, fetchImpl: fetch, now: () => new Date(now),
    shareModel: async input => {
      modelCalls++;
      if (failOnce && input.parts.some(part => part.kind === 'text' && part.text.includes('application 3'))) {
        failOnce = false;
        throw new Error('temporary model failure');
      }
      const content = input.parts[0]?.kind === 'text' ? input.parts[0].text : '';
      const evidence = /Please finish application \d+/.exec(content)?.[0] ?? '';
      return { text: JSON.stringify({ observations: [{ kind: 'request', evidence, confidence: 0.9 }] }),
        model: 'fake', latencyMs: 1, promptTokens: 1, outputTokens: 1 };
    },
  };
  const queries: string[] = [];
  const options = {
    ensureReadable: async () => undefined,
    transport: { listRecentMessagePage: async (request: { query: string; maxResults: number; pageToken?: string | null }) => {
      queries.push(request.query);
      assert.equal(request.maxResults, 3);
      const start = Number(request.pageToken ?? 0);
      return { messages: messages.slice(start, start + 3),
        nextPageToken: start + 3 < messages.length ? String(start + 3) : null };
    } },
  };
  const first = await scanGmailIntelligence('alice', runtime, options);
  assert.equal(first.scan.status, 'running');
  assert.equal(first.scan.messagesVisited, 3);
  await assert.rejects(scanGmailIntelligence('alice', runtime, options), /source_analysis_failed/);
  let result = await scanGmailIntelligence('alice', runtime, options);
  while (result.scan.status !== 'complete') result = await scanGmailIntelligence('alice', runtime, options);
  assert.equal(result.scan.messagesVisited, 13, 'the scan must not stop after ten messages');
  assert.equal((await storage.list('users/alice/intelligenceObservations')).length, 12);
  assert.equal((await storage.list('users/bob/intelligenceObservations')).length, 0);
  assert.equal(new Set(queries).size, 1, 'the entire paginated run must keep its original seven-day window');
  assert.match(queries[0]!, /^after:\d+ before:\d+$/);
  const callsBeforeRescan = modelCalls;
  await scanGmailIntelligence('alice', runtime, options);
  assert.equal(modelCalls, callsBeforeRescan, 'receipts avoid analyzing the same message twice');
});

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
