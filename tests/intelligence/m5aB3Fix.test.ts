import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUSY_BLOCKS, BUSY_SOURCE_FENCES, CALENDAR_CHOICE, CALENDAR_SOURCES, DEVICE_STALE_STATE,
  ICS_FEEDS, INTELLIGENCE_GMAIL_SCANS, INTELLIGENCE_SOURCE_MARKERS, PROVIDER_CONNECTIONS, REGISTERED_DEVICE_SOURCES,
  createMemoryStorage, docIdForKey, userCol, userSubDoc,
} from '../../lib/storage';
import type { GoogleRuntime } from '../../lib/integrations/google/googleRuntime';
import { GOOGLE_BUSY_SOURCE_ID, type GoogleBusyTarget } from '../../lib/integrations/google/googleCalendarBusy';
import { GOOGLE_FEATURE_SCOPES } from '../../lib/integrations/google/googleConfig';
import { connectionIdFor } from '../../lib/integrations/providers/production/storedConnectionStore';
import { calendarCoverageForEmail, runCalendarMaintenanceStep } from '../../lib/intelligence/gmailCalendarJit';
import {
  cleanupCalendarWaits, runAccountLeasedLanesForTests, runGmailJobTickForTests, runReservedLanesForTests,
} from '../../lib/intelligence/gmailJobs';
import {
  gmailQueryOutsideIntervals, legacyMarkerIdFor, providerMarkerIdFor, runM5aScanStep, type M5aMarker,
} from '../../lib/intelligence/m5aGmailScan';
import { runGmailMonitorTick } from '../../lib/intelligence/gmailMonitor';
import type { GmailTransport } from '../../lib/integrations/gmail/production/gmailTransport';
import { captureLlmProvider } from '../../lib/llm/captureProvider';
import { shareLlmProvider } from '../../lib/llm/shareProvider';
import {
  callsToday, finalizeQuotaPermit, reserveQuotaPermit,
  settleQuotaPermitSlot, startQuotaPermitSlot,
  M5A_GLOBAL_DAILY_CALL_CAP, M5A_USER_DAILY_CALL_CAP,
} from '../../lib/llm/usageGuard';
import type { LlmProvider } from '../../src/extraction/llm/llmProvider';
import { putObservations } from '../../lib/intelligence/observationStore';
import { proposeFromObservations } from '../../lib/intelligence/proposalEngine';
import { loadAutoAddSnapshot } from '../../lib/intelligence/autoAddSnapshot';
import { saveMonitoringSettings } from '../../lib/watchers/monitoringSettings';
import { createPilotTrustState } from '../../lib/pilot/closedPilotControls.ts';

const NOW = '2026-10-19T10:00:00.000Z';

test('G1 reserved lanes are concurrent and a step cannot start without its full reserve', async () => {
  let active = 0;
  let peak = 0;
  let started = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fallback = setTimeout(release, 100);
  const run = runReservedLanesForTests(
    Array.from({ length: 8 }, (_, index) => `u${index}`), 8, 1, Date.now() + 5_000,
    async () => {
      active++; started++; peak = Math.max(peak, active);
      if (started === 8) release();
      await gate;
      active--;
      return true;
    },
  );
  assert.equal(await run, 8);
  clearTimeout(fallback);
  assert.equal(peak, 8, 'the live allocation must be eight real simultaneous lanes');
  assert.equal(await runReservedLanesForTests(['late'], 1, 34_000, Date.now() + 33_999, async () => true), 0);
});

test('G1 overlapping fixed deadlines never admit a follow-up step after the first overruns', async () => {
  const started: string[] = [];
  const first = runReservedLanesForTests(['first', 'must-not-start'], 1, 10, Date.now() + 40, async uid => {
    started.push(uid);
    await new Promise(resolve => setTimeout(resolve, 50));
    return true;
  });
  const alreadyTooLate = runReservedLanesForTests(['other-instance'], 1, 10, Date.now() + 9, async uid => {
    started.push(uid);
    return true;
  });
  assert.deepEqual(await Promise.all([first, alreadyTooLate]), [1, 0]);
  assert.deepEqual(started, ['first']);
});

test('G8 simultaneous instances hold eight distinct live claims and four distinct continuation claims', async () => {
  const prove = async (count: number, route: 'live' | 'sweep', jobClass: 'live' | 'continuation') => {
    const storage = createMemoryStorage();
    const runtime: GoogleRuntime = { storage, env: {} as GoogleRuntime['env'], secrets: null,
      fetchImpl: fetch, now: () => new Date(NOW) };
    const accounts = Array.from({ length: count }, (_, index) => `${jobClass}-${index}`);
    const claimed = new Set<string>();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fallback = setTimeout(release, 100);
    const work = async (uid: string) => {
      assert.equal(claimed.has(uid), false, `duplicate simultaneous claim for ${uid}`);
      claimed.add(uid);
      if (claimed.size === count) release();
      await gate;
      return true;
    };
    await Promise.all([
      runAccountLeasedLanesForTests(accounts, count, route, jobClass, runtime, work),
      runAccountLeasedLanesForTests(accounts, count, route, jobClass, runtime, work),
    ]);
    clearTimeout(fallback);
    assert.equal(claimed.size, count);
  };
  await prove(8, 'live', 'live');
  await prove(4, 'sweep', 'continuation');
});

test('G2 an enrolled live monitor commits through the provider-scoped M5a unit and arms proposals atomically', async () => {
  const storage = createMemoryStorage();
  const uid = 'live_m5a';
  const runtime: GoogleRuntime = {
    storage,
    env: { MAYBESITTER_ENV: 'staging', MAYBESITTER_FEATURE_PROACTIVE_LOOP: 'true' } as GoogleRuntime['env'],
    secrets: null, fetchImpl: fetch, now: () => new Date(NOW),
    shareModel: async () => ({ text: JSON.stringify({ observations: [
      { kind: 'request', evidence: 'Please send the form', confidence: 0.9 },
    ] }), model: 'fake', latencyMs: 1, promptTokens: 1, outputTokens: 1 }),
  };
  await storage.set(`users/${uid}`, { monitoringSettings: { paused: false, updatedAt: NOW }, trust: createPilotTrustState(uid, NOW) });
  await storage.set('system/m5aControls', { email: { epoch: 9, enabled: true }, calendar: { epoch: 1, enabled: true } });
  await storage.set(userSubDoc(uid, PROVIDER_CONNECTIONS, connectionIdFor('google')), {
    identity: { provider: 'google', providerAccountId: 'acct' }, state: 'connected', credentialRef: 'vault',
    capabilities: ['mail_read'], grantedScopes: [GOOGLE_FEATURE_SCOPES.gmail],
  });
  await storage.set(`users/${uid}/intelligenceMonitors/gmail`, {
    enabled: true, generation: 'generation-1', cursor: '100', pageToken: null, nextPollAt: NOW,
    lease: null, leaseUntil: null, lastSuccessAt: null, error: null,
    proposalsVersion: 0, proposalsDoneVersion: 0, proposalsPending: false, proposalNextEligibleAt: NOW,
    m5: { v: 1, providerAccountId: 'acct', enabledAt: '2026-10-19T09:00:00.000Z', timezone: 'UTC', at: NOW,
      pauseEpoch: 0, pausedSince: null, excluded: [] },
  });
  const message = { id: 'mail-live', threadId: null, historyId: '101', receivedAt: '2026-10-19T09:59:00.000Z',
    from: null, subject: null, text: 'Please send the form', sentByAccount: false,
    isReply: false, bodyFormat: 'text/plain' as const };
  const transport: Pick<GmailTransport, 'listHistory' | 'listHistoryIds' | 'getMessageById'> = {
    listHistory: async () => ({ historyId: '101', nextPageToken: null, messages: [message] }),
    listHistoryIds: async () => ({ historyId: '101', nextPageToken: null, ids: [message.id] }),
    getMessageById: async () => message,
  };
  await runGmailMonitorTick(runtime, { uid, transport: () => transport, ensureReadable: async () => undefined });
  const result = await runGmailMonitorTick(runtime, { uid, transport: () => transport, ensureReadable: async () => undefined });
  assert.equal(result.failures, 0);
  assert.equal(result.messagesAnalyzed, 1, JSON.stringify({ result,
    live: await storage.get(`users/${uid}/intelligenceGmailScans/liveV2`),
    monitor: await storage.get(`users/${uid}/intelligenceMonitors/gmail`) }));
  const monitor = await storage.get<any>(`users/${uid}/intelligenceMonitors/gmail`);
  assert.equal(monitor.proposalsPending, true);
  assert.equal(monitor.proposalsVersion, 1);
  const provider = await storage.get<M5aMarker>(`${userCol(uid, INTELLIGENCE_SOURCE_MARKERS)}/${providerMarkerIdFor(uid, 'acct', message.id)}`);
  const legacy = await storage.get<M5aMarker>(`${userCol(uid, INTELLIGENCE_SOURCE_MARKERS)}/${legacyMarkerIdFor(message.id)}`);
  assert.equal(provider?.state, 'done');
  assert.equal(legacy?.state, 'done');
  assert.equal(provider?.providerAccountId, 'acct');
});

test('G3 a 450-add/450-remove JIT target resumes after lease takeover and certifies only at the end', async () => {
  const storage = createMemoryStorage();
  const uid = 'jit_chunks';
  let now = new Date(NOW);
  const runtime: GoogleRuntime = {
    storage, env: { MAYBESITTER_ENV: 'staging' } as GoogleRuntime['env'], secrets: null,
    fetchImpl: fetch, now: () => new Date(now),
  };
  const fencePath = userSubDoc(uid, BUSY_SOURCE_FENCES, docIdForKey(GOOGLE_BUSY_SOURCE_ID));
  const sourcePath = userSubDoc(uid, CALENDAR_SOURCES, docIdForKey(GOOGLE_BUSY_SOURCE_ID));
  const block = (prefix: string, index: number) => {
    const startAt = new Date(Date.parse(NOW) + (index + 1) * 60_000).toISOString();
    const endAt = new Date(Date.parse(startAt) + 30_000).toISOString();
    return { blockId: createHash('sha256').update(`${prefix}-${index}`).digest('hex'), sourceId: GOOGLE_BUSY_SOURCE_ID,
      sourceKind: 'google' as const, startAt, endAt, allDay: false };
  };
  const old = Array.from({ length: 450 }, (_, index) => block('old', index));
  const next = Array.from({ length: 450 }, (_, index) => block('new', index + 1_000));
  await storage.set(`users/${uid}`, { trust: { ...createPilotTrustState(uid, NOW), calendarConsent: true }, calendarEpoch: 1 });
  await storage.set('system/m5aControls', { email: { epoch: 4, enabled: false }, calendar: { epoch: 2, enabled: true } });
  await storage.set(userSubDoc(uid, PROVIDER_CONNECTIONS, connectionIdFor('google')), {
    identity: { provider: 'google', providerAccountId: 'account' }, state: 'connected', credentialRef: 'vault',
    capabilities: ['calendar_busy'], grantedScopes: [GOOGLE_FEATURE_SCOPES.calendar],
  });
  await storage.set(sourcePath, { sourceId: GOOGLE_BUSY_SOURCE_ID, kind: 'google', platform: null,
    lastSyncedAt: NOW, windowStart: NOW, windowEnd: new Date(Date.parse(NOW) + 86_400_000).toISOString(),
    coverageStatus: 'settled', m5Certificate: { v: 1, choiceGeneration: null, providerAccountId: 'account',
      fenceGeneration: 7, refreshedAt: NOW } });
  for (const item of old) await storage.set(userSubDoc(uid, BUSY_BLOCKS, docIdForKey(`${GOOGLE_BUSY_SOURCE_ID}\u001f${item.blockId}`)), item);
  const target: GoogleBusyTarget = { v: 1, targetId: 'target-many', providerAccountId: 'account', calendarEpoch: 1,
    choiceGeneration: null, calendarControlEpoch: 2, windowStart: NOW,
    windowEnd: new Date(Date.parse(NOW) + 3 * 86_400_000).toISOString(), fetchedAt: NOW,
    intervals: next.map(item => ({ start: item.startAt, end: item.endAt })), digest: 'b'.repeat(64), nextEligibleAt: NOW };
  await storage.set(fencePath, { generation: 7, jitTarget: target });
  let steps = 0;
  while ((await storage.get<any>(fencePath))?.jitTarget) {
    assert.equal(await runCalendarMaintenanceStep(uid, runtime), true);
    steps++;
    if (steps === 1) {
      const current = await storage.get<any>(fencePath);
      await storage.set(fencePath, { ...current,
        replace: { owner: 'takeover-racer', version: current.replace.version + 1,
          leaseUntil: new Date(now.getTime() + 120_000).toISOString() } });
    }
    if ((await storage.get<any>(fencePath))?.jitTarget) {
      assert.equal((await storage.get<any>(sourcePath))?.m5Certificate?.refreshedAt, NOW,
        'a partial target must not write its new certificate');
    }
    now = new Date(now.getTime() + 1_000);
    assert.ok(steps < 10, 'target did not make resumable progress');
  }
  assert.equal(steps, 7);
  const rows = await storage.list<any>(userCol(uid, BUSY_BLOCKS));
  assert.equal(rows.length, 450);
  assert.equal((await storage.get<any>(sourcePath))?.m5Certificate?.fenceGeneration, 7);
});

test('G4 registered stale devices wait for one hour account-wide, then force auto-add off until fresh', async () => {
  const storage = createMemoryStorage({ enforceFirestoreReadOrder: true });
  const uid = 'stale_device';
  let now = new Date(NOW);
  const runtime: GoogleRuntime = { storage, env: {} as GoogleRuntime['env'], secrets: null, fetchImpl: fetch, now: () => new Date(now) };
  const sourceIds = ['device:phone', 'device:tablet'];
  await storage.set(`users/${uid}`, { trust: { ...createPilotTrustState(uid, NOW), calendarConsent: true } });
  await storage.set('system/m5aControls', { email: { epoch: 1, enabled: true }, calendar: { epoch: 1, enabled: true } });
  await storage.set(userSubDoc(uid, CALENDAR_CHOICE, 'state'), { v: 1, generation: 3, state: 'active' });
  for (const sourceId of sourceIds) {
    await storage.set(userSubDoc(uid, REGISTERED_DEVICE_SOURCES, docIdForKey(sourceId)), { sourceId, state: 'active' });
    await storage.set(userSubDoc(uid, DEVICE_STALE_STATE, docIdForKey(sourceId)), {
      choiceGeneration: 3, sourceId, fenceGeneration: 0, failureStartedAt: null, version: 1,
    });
    await storage.set(userSubDoc(uid, CALENDAR_SOURCES, docIdForKey(sourceId)), { sourceId, kind: 'device', status: 'active',
      platform: 'ios', choiceGeneration: 3, lastSyncedAt: new Date(now.getTime() - 7 * 60 * 60_000).toISOString(),
      windowStart: NOW, windowEnd: NOW });
  }
  assert.equal(await calendarCoverageForEmail(uid, runtime), 'stale_device');
  assert.equal((await storage.list(userCol(uid, DEVICE_STALE_STATE))).length, 2);
  now = new Date(now.getTime() + 61 * 60_000);
  assert.equal(await calendarCoverageForEmail(uid, runtime), 'force_off');
  for (const sourceId of sourceIds) await storage.set(userSubDoc(uid, CALENDAR_SOURCES, docIdForKey(sourceId)), {
    sourceId, kind: 'device', status: 'active', platform: 'ios', choiceGeneration: 3,
    lastSyncedAt: now.toISOString(), windowStart: NOW, windowEnd: NOW,
  });
  assert.equal(await calendarCoverageForEmail(uid, runtime), 'fresh');
  assert.equal((await storage.list(userCol(uid, DEVICE_STALE_STATE))).length, 0);
});

test('G4 ICS freshness uses lastVerifiedAt, including the timestamp a conditional 304 advances', async () => {
  const storage = createMemoryStorage();
  const uid = 'ics_freshness';
  const sourceId = 'ics:feed-1';
  let now = new Date(NOW);
  const runtime: GoogleRuntime = { storage, env: {} as GoogleRuntime['env'], secrets: null,
    fetchImpl: fetch, now: () => new Date(now) };
  await storage.set(`users/${uid}`, { trust: { ...createPilotTrustState(uid, NOW), calendarConsent: true } });
  await storage.set('system/m5aControls', { email: { epoch: 1, enabled: true }, calendar: { epoch: 1, enabled: true } });
  await storage.set(userSubDoc(uid, CALENDAR_SOURCES, docIdForKey(sourceId)), {
    sourceId, kind: 'ics', platform: null, lastSyncedAt: NOW,
    windowStart: '2026-10-19T00:00:00.000Z', windowEnd: '2026-10-21T00:00:00.000Z', coverageStatus: 'settled',
  });
  await storage.set(userSubDoc(uid, ICS_FEEDS, 'feed-1'), {
    feedId: 'feed-1', status: 'ok', lastVerifiedAt: '2026-10-19T03:59:59.000Z',
    lastFetchedAt: '2026-10-19T03:59:59.000Z', createdAt: '2026-10-19T03:00:00.000Z',
  });
  const read = () => storage.runTransaction(tx => loadAutoAddSnapshot(tx, uid, {
    startsAt: '2026-10-20T10:00:00.000Z', endsAt: '2026-10-20T11:00:00.000Z',
  }, NOW));
  assert.equal((await read()).boundedAndSettled, false);
  assert.equal(await calendarCoverageForEmail(uid, runtime), 'stale_ics');
  now = new Date(now.getTime() + 61 * 60_000);
  assert.equal(await calendarCoverageForEmail(uid, runtime), 'force_off');
  const feed = await storage.get<any>(userSubDoc(uid, ICS_FEEDS, 'feed-1'));
  await storage.set(userSubDoc(uid, ICS_FEEDS, 'feed-1'), { ...feed, lastVerifiedAt: now.toISOString() });
  assert.equal(await calendarCoverageForEmail(uid, runtime), 'fresh');
  assert.equal((await storage.runTransaction(tx => loadAutoAddSnapshot(tx, uid, {
    startsAt: '2026-10-20T10:00:00.000Z', endsAt: '2026-10-20T11:00:00.000Z',
  }, now.toISOString()))).boundedAndSettled, true);
});

test('G5 cleanup preserves an authorised monitor wait and releases it after a pause-epoch takeover', async () => {
  const storage = createMemoryStorage();
  const uid = 'monitor_wait';
  const markerPath = `${userCol(uid, INTELLIGENCE_SOURCE_MARKERS)}/${'a'.repeat(64)}`;
  await storage.set('system/m5aControls', { email: { epoch: 5, enabled: true }, calendar: { epoch: 1, enabled: true } });
  await storage.set(`users/${uid}/intelligenceMonitors/gmail`, { enabled: true, generation: 'g1', nextPollAt: NOW,
    m5: { v: 1, providerAccountId: 'acct', enabledAt: NOW, timezone: 'UTC', at: NOW,
      pauseEpoch: 2, pausedSince: null, excluded: [] } });
  await storage.set<M5aMarker>(markerPath, { v: 2, state: 'waiting_for_calendar', providerAccountId: 'acct', emailEpoch: 5,
    origin: { kind: 'monitor', generation: 'g1', pauseEpoch: 2 }, requestedAt: NOW, nextEligibleAt: NOW });
  assert.equal(await cleanupCalendarWaits(storage, new Date(NOW)), 0);
  const monitor = await storage.get<any>(`users/${uid}/intelligenceMonitors/gmail`);
  await storage.set(`users/${uid}/intelligenceMonitors/gmail`, { ...monitor, m5: { ...monitor.m5, pauseEpoch: 3 } });
  assert.equal(await cleanupCalendarWaits(storage, new Date(NOW)), 1);
  assert.equal((await storage.get<M5aMarker>(markerPath))?.state, 'released');
});

test('G5 the matching live generation takes its wait straight back to a fenced claim', async () => {
  const storage = createMemoryStorage();
  const uid = 'monitor_wait_takeover';
  const messageId = 'waited-mail';
  const providerId = providerMarkerIdFor(uid, 'acct', messageId);
  const legacyId = legacyMarkerIdFor(messageId);
  const wait: M5aMarker = { v: 2, state: 'waiting_for_calendar', providerAccountId: 'acct', emailEpoch: 5,
    messageId, origin: { kind: 'monitor', generation: 'g1', pauseEpoch: 2 }, requestedAt: NOW, nextEligibleAt: NOW };
  await storage.set(`users/${uid}`, { monitoringSettings: { paused: false, updatedAt: NOW }, trust: { ...createPilotTrustState(uid, NOW), calendarConsent: false } });
  await storage.set('system/m5aControls', { email: { epoch: 5, enabled: true }, calendar: { epoch: 1, enabled: true } });
  await storage.set(userSubDoc(uid, PROVIDER_CONNECTIONS, connectionIdFor('google')), {
    identity: { provider: 'google', providerAccountId: 'acct' }, state: 'connected', credentialRef: 'vault',
    capabilities: ['mail_read'], grantedScopes: [GOOGLE_FEATURE_SCOPES.gmail],
  });
  await storage.set(`users/${uid}/intelligenceMonitors/gmail`, { enabled: true, generation: 'g1', cursor: '100',
    pageToken: null, nextPollAt: NOW, lease: null, leaseUntil: null, lastSuccessAt: null, error: null,
    waitingMessageId: messageId, m5: { v: 1, providerAccountId: 'acct', enabledAt: NOW, timezone: 'UTC', at: NOW,
      pauseEpoch: 2, pausedSince: null, excluded: [] } });
  await storage.set(`users/${uid}/${INTELLIGENCE_GMAIL_SCANS}/liveV2`, {
    scanId: 'live-scan', kind: 'live', status: 'running', origin: 'live', providerAccountId: 'acct', emailEpoch: 5,
    query: '', from: '2026-10-19T09:00:00.000Z', until: '2026-10-19T11:00:00.000Z', timezone: 'UTC',
    startedAt: NOW, finishedAt: null, failedAt: null, failure: null, pageToken: null,
    page: { ids: [messageId], nextPageToken: null, done: [] }, leaseOwner: null, leaseUntil: null, queued: null,
    nextEligibleAt: NOW, waiting: null, messagesRead: 0, messagesUnavailable: 0, messagesTrimmed: 0,
    observationsFound: 0, addedFromEmail: 0, monitorGeneration: 'g1', pauseEpoch: 2, excluded: [],
    liveHistoryId: '101', liveNextPageToken: null,
  });
  await storage.set(`${userCol(uid, INTELLIGENCE_SOURCE_MARKERS)}/${providerId}`, wait);
  await storage.set(`${userCol(uid, INTELLIGENCE_SOURCE_MARKERS)}/${legacyId}`, { ...wait, providerMarkerId: providerId });
  const runtime: GoogleRuntime = { storage,
    env: { MAYBESITTER_ENV: 'staging', MAYBESITTER_FEATURE_PROACTIVE_LOOP: 'true' } as GoogleRuntime['env'],
    secrets: null, fetchImpl: fetch, now: () => new Date(NOW),
    shareModel: async () => ({ text: '{"observations":[]}', model: 'fake', latencyMs: 1, promptTokens: 1, outputTokens: 1 }),
  };
  const message = { id: messageId, threadId: null, historyId: '101', receivedAt: NOW, from: null, subject: null,
    text: 'Nothing dated here', sentByAccount: false, isReply: false, bodyFormat: 'text/plain' as const };
  const result = await runGmailMonitorTick(runtime, { uid, ensureReadable: async () => undefined, transport: () => ({
    listHistory: async () => { throw new Error('checkpoint already exists'); },
    getMessageById: async () => message,
  }) });
  assert.equal(result.failures, 0);
  assert.equal((await storage.get<M5aMarker>(`${userCol(uid, INTELLIGENCE_SOURCE_MARKERS)}/${providerId}`))?.state, 'done');
});

test('G6 paused intervals end exactly while the sweep end keeps its one-second Gmail overlap', () => {
  const query = gmailQueryOutsideIntervals('2026-10-19T00:00:00.000Z', '2026-10-19T12:00:00.000Z', [
    { from: '2026-10-19T03:00:00.000Z', to: '2026-10-19T05:00:00.000Z' },
  ]);
  assert.equal(query, '(after:1792368000 before:1792378800) OR (after:1792386000 before:1792411201)');
});

test('G6 resume clears the live cursor, so paused mail is baselined without messages.get', async () => {
  const storage = createMemoryStorage();
  const uid = 'pause_resume_baseline';
  await storage.set(`users/${uid}`, { monitoringSettings: { paused: false, updatedAt: NOW }, trust: createPilotTrustState(uid, NOW) });
  await storage.set('system/m5aControls', { email: { epoch: 9, enabled: true }, calendar: { epoch: 1, enabled: true } });
  await storage.set(userSubDoc(uid, PROVIDER_CONNECTIONS, connectionIdFor('google')), {
    identity: { provider: 'google', providerAccountId: 'acct' }, state: 'connected', credentialRef: 'vault',
    capabilities: ['mail_read'], grantedScopes: [GOOGLE_FEATURE_SCOPES.gmail],
  });
  await storage.set(`users/${uid}/intelligenceMonitors/gmail`, {
    enabled: true, generation: 'g1', cursor: '100', pageToken: null, nextPollAt: NOW,
    lease: null, leaseUntil: null, lastSuccessAt: null, error: null,
    m5: { v: 1, providerAccountId: 'acct', enabledAt: '2026-10-19T08:00:00.000Z', timezone: 'UTC', at: NOW,
      pauseEpoch: 0, pausedSince: null, excluded: [] },
  });
  await saveMonitoringSettings(uid, true, '2026-10-19T09:00:00.000Z', { storage });
  await saveMonitoringSettings(uid, false, '2026-10-19T09:30:00.000Z', { storage });
  let gets = 0;
  let observedCursor: string | null | undefined;
  await runGmailMonitorTick({
    storage, env: { MAYBESITTER_ENV: 'staging', MAYBESITTER_FEATURE_PROACTIVE_LOOP: 'true' } as GoogleRuntime['env'],
    secrets: null, fetchImpl: fetch, now: () => new Date(NOW),
  }, { uid, ensureReadable: async () => undefined, transport: () => ({
    listHistory: async request => { observedCursor = request.startHistoryId; return {
      historyId: '200', nextPageToken: null, messages: [],
    }; },
    getMessageById: async () => { gets++; return null; },
  }) });
  assert.equal(observedCursor, null);
  assert.equal(gets, 0);
  assert.equal((await storage.get<any>(`users/${uid}/intelligenceMonitors/gmail`))?.cursor, '200');
});

test('G6 live pause races fence both the id checkpoint and the message result before any model call', async () => {
  const setup = async (uid: string) => {
    const storage = createMemoryStorage();
    await storage.set(`users/${uid}`, { monitoringSettings: { paused: false, updatedAt: NOW }, trust: createPilotTrustState(uid, NOW) });
    await storage.set('system/m5aControls', { email: { epoch: 9, enabled: true }, calendar: { epoch: 1, enabled: true } });
    await storage.set(userSubDoc(uid, PROVIDER_CONNECTIONS, connectionIdFor('google')), {
      identity: { provider: 'google', providerAccountId: 'acct' }, state: 'connected', credentialRef: 'vault',
      capabilities: ['mail_read'], grantedScopes: [GOOGLE_FEATURE_SCOPES.gmail],
    });
    await storage.set(`users/${uid}/intelligenceMonitors/gmail`, {
      enabled: true, generation: 'g1', cursor: '100', pageToken: null, nextPollAt: NOW,
      lease: null, leaseUntil: null, lastSuccessAt: null, error: null,
      m5: { v: 1, providerAccountId: 'acct', enabledAt: '2026-10-19T09:00:00.000Z', timezone: 'UTC', at: NOW,
        pauseEpoch: 0, pausedSince: null, excluded: [] },
    });
    return storage;
  };
  const pause = async (storage: ReturnType<typeof createMemoryStorage>, uid: string) => {
    const path = `users/${uid}/intelligenceMonitors/gmail`;
    const monitor = await storage.get<any>(path);
    await storage.set(path, { ...monitor, m5: { ...monitor.m5, pauseEpoch: monitor.m5.pauseEpoch + 1, pausedSince: NOW } });
    const user = await storage.get<any>(`users/${uid}`);
    await storage.set(`users/${uid}`, { ...user, monitoringSettings: { paused: true, updatedAt: NOW } });
  };

  const listingStorage = await setup('pause_listing');
  let listingGets = 0;
  const listingRuntime: GoogleRuntime = {
    storage: listingStorage, env: { MAYBESITTER_ENV: 'staging', MAYBESITTER_FEATURE_PROACTIVE_LOOP: 'true' } as GoogleRuntime['env'],
    secrets: null, fetchImpl: fetch, now: () => new Date(NOW),
    shareModel: async () => { throw new Error('model must not run'); },
  };
  await runGmailMonitorTick(listingRuntime, { uid: 'pause_listing', ensureReadable: async () => undefined,
    transport: () => ({
      listHistory: async () => { throw new Error('full history must not run'); },
      listHistoryIds: async () => {
        await pause(listingStorage, 'pause_listing');
        return { historyId: '101', nextPageToken: null, ids: ['mail'] };
      },
      getMessageById: async () => { listingGets++; return null; },
    }),
  });
  assert.equal(listingGets, 0);
  assert.equal(await listingStorage.get(`users/pause_listing/${INTELLIGENCE_GMAIL_SCANS}/liveV2`), null);

  const getStorage = await setup('pause_get');
  let modelCalls = 0;
  const getRuntime: GoogleRuntime = {
    storage: getStorage, env: { MAYBESITTER_ENV: 'staging', MAYBESITTER_FEATURE_PROACTIVE_LOOP: 'true' } as GoogleRuntime['env'],
    secrets: null, fetchImpl: fetch, now: () => new Date(NOW),
    shareModel: async () => { modelCalls++; return {
      text: '{"observations":[]}', model: 'fake', latencyMs: 1, promptTokens: 1, outputTokens: 1,
    }; },
  };
  const transport = {
    listHistory: async () => { throw new Error('full history must not run'); },
    listHistoryIds: async () => ({ historyId: '101', nextPageToken: null, ids: ['mail'] }),
    getMessageById: async () => {
      await pause(getStorage, 'pause_get');
      return { id: 'mail', threadId: null, historyId: '101', receivedAt: NOW, from: null, subject: null,
        text: 'Please send the report', sentByAccount: false, isReply: false, bodyFormat: 'text/plain' as const };
    },
  };
  await runGmailMonitorTick(getRuntime, { uid: 'pause_get', ensureReadable: async () => undefined, transport: () => transport });
  await runGmailMonitorTick(getRuntime, { uid: 'pause_get', ensureReadable: async () => undefined, transport: () => transport });
  assert.equal(modelCalls, 0);
  assert.equal((await getStorage.list('users/pause_get/intelligenceObservations')).length, 0);
});

test('G6 live and sweep pause races after analysis, extraction, and immediately before commit write nothing', async () => {
  for (const kind of ['live', 'daily'] as const) {
    for (const stage of ['analysis', 'extraction', 'commit'] as const) {
      const uid = `pause_${kind}_${stage}`;
      const storage = createMemoryStorage();
      const scanId = `${kind}-scan`;
      const scanPath = `users/${uid}/${INTELLIGENCE_GMAIL_SCANS}/${kind === 'daily' ? 'dailyV2' : 'liveV2'}`;
      const own = 'I will send the report tomorrow at 10.';
      const qualifying = stage === 'extraction';
      const message = { id: 'mail', threadId: null, historyId: '101', receivedAt: '2026-10-19T09:00:00.000Z',
        from: null, subject: null,
        text: qualifying ? `${own}\n\nOn Sun, Oct 18, Alex wrote:\nPlease send it.` : 'Please send the report',
        sentByAccount: qualifying, isReply: qualifying, bodyFormat: 'text/plain' as const };
      await storage.set(`users/${uid}`, { monitoringSettings: { paused: false, updatedAt: NOW }, trust: { ...createPilotTrustState(uid, NOW), calendarConsent: true } });
      await storage.set('system/m5aControls', { email: { epoch: 9, enabled: true }, calendar: { epoch: 1, enabled: true } });
      await storage.set(userSubDoc(uid, PROVIDER_CONNECTIONS, connectionIdFor('google')), {
        identity: { provider: 'google', providerAccountId: 'acct' }, state: 'connected', credentialRef: 'vault',
        capabilities: ['mail_read'], grantedScopes: [GOOGLE_FEATURE_SCOPES.gmail],
      });
      await storage.set(`users/${uid}/intelligenceMonitors/gmail`, {
        enabled: true, generation: 'g1', cursor: '100', pageToken: null, nextPollAt: NOW,
        lease: null, leaseUntil: null, lastSuccessAt: null, error: null,
        m5: { v: 1, providerAccountId: 'acct', enabledAt: '2026-10-19T08:00:00.000Z', timezone: 'UTC', at: NOW,
          pauseEpoch: 0, pausedSince: null, excluded: [] },
      });
      await storage.set(scanPath, {
        scanId, kind, status: 'running', origin: kind, providerAccountId: 'acct', emailEpoch: 9,
        query: '', from: '2026-10-19T08:00:00.000Z', until: '2026-10-19T11:00:00.000Z', timezone: 'UTC',
        startedAt: NOW, finishedAt: null, failedAt: null, failure: null, pageToken: null,
        page: { ids: [message.id], nextPageToken: null, done: [] }, leaseOwner: null, leaseUntil: null,
        queued: null, nextEligibleAt: NOW, waiting: null, messagesRead: 0, messagesUnavailable: 0,
        messagesTrimmed: 0, observationsFound: 0, addedFromEmail: 0,
        monitorGeneration: 'g1', pauseEpoch: 0, excluded: [],
        ...(kind === 'live' ? { liveHistoryId: '101', liveNextPageToken: null } : {}),
      });
      const pauseDirect = async () => {
        const monitorPath = `users/${uid}/intelligenceMonitors/gmail`;
        const monitor = await storage.get<any>(monitorPath);
        await storage.set(monitorPath, { ...monitor, m5: { ...monitor.m5, pauseEpoch: 1, pausedSince: NOW } });
        const user = await storage.get<any>(`users/${uid}`);
        await storage.set(`users/${uid}`, { ...user, monitoringSettings: { paused: true, updatedAt: NOW } });
      };
      const runtime: GoogleRuntime = {
        storage, env: { MAYBESITTER_ENV: 'staging' } as GoogleRuntime['env'], secrets: null,
        fetchImpl: fetch, now: () => new Date(NOW),
        shareModel: async () => {
          if (stage === 'analysis') await pauseDirect();
          if (stage === 'commit') storage.setBeforeCommitHookForTests(async () => {
            storage.setBeforeCommitHookForTests(null);
            await pauseDirect();
          });
          return { text: JSON.stringify({ observations: [{ kind: qualifying ? 'commitment' : 'request',
            evidence: qualifying ? own : message.text, confidence: 0.99 }] }),
            model: 'fake-share', latencyMs: 1, promptTokens: 1, outputTokens: 1 };
        },
        captureModel: async () => {
          await pauseDirect();
          return JSON.stringify({ type: 'task', title: own, description: null, person: null,
            dueAt: '2026-10-20T10:00:00.000Z', remindAt: null, allDay: false,
            missingFields: [], ambiguityFlags: [] });
        },
      };
      await runM5aScanStep(uid, kind, runtime, { getMessageById: async () => message } as unknown as GmailTransport,
        async () => undefined);
      storage.setBeforeCommitHookForTests(null);
      assert.equal((await storage.list(`users/${uid}/intelligenceObservations`)).length, 0, `${kind}/${stage}`);
      assert.equal((await storage.get<any>(scanPath))?.messagesRead, 0, `${kind}/${stage}`);
    }
  }
});

test('G6 a sweep paused during listing stores no message ids and performs no messages.get', async () => {
  const uid = 'pause_daily_listing';
  const storage = createMemoryStorage();
  const scanPath = `users/${uid}/${INTELLIGENCE_GMAIL_SCANS}/dailyV2`;
  await storage.set(`users/${uid}`, { monitoringSettings: { paused: false, updatedAt: NOW }, trust: createPilotTrustState(uid, NOW) });
  await storage.set('system/m5aControls', { email: { epoch: 9, enabled: true }, calendar: { epoch: 1, enabled: true } });
  await storage.set(userSubDoc(uid, PROVIDER_CONNECTIONS, connectionIdFor('google')), {
    identity: { provider: 'google', providerAccountId: 'acct' }, state: 'connected', credentialRef: 'vault',
    capabilities: ['mail_read'], grantedScopes: [GOOGLE_FEATURE_SCOPES.gmail],
  });
  await storage.set(`users/${uid}/intelligenceMonitors/gmail`, {
    enabled: true, generation: 'g1', cursor: '100', pageToken: null, nextPollAt: NOW,
    lease: null, leaseUntil: null, lastSuccessAt: null, error: null,
    m5: { v: 1, providerAccountId: 'acct', enabledAt: '2026-10-19T08:00:00.000Z', timezone: 'UTC', at: NOW,
      pauseEpoch: 0, pausedSince: null, excluded: [] },
  });
  await storage.set(scanPath, {
    scanId: 'daily-scan', kind: 'daily', status: 'running', origin: 'daily', providerAccountId: 'acct', emailEpoch: 9,
    query: 'after:1 before:9999999999', from: '2026-10-19T08:00:00.000Z', until: '2026-10-19T11:00:00.000Z',
    timezone: 'UTC', startedAt: NOW, finishedAt: null, failedAt: null, failure: null, pageToken: null, page: null,
    leaseOwner: null, leaseUntil: null, queued: null, nextEligibleAt: NOW, waiting: null,
    messagesRead: 0, messagesUnavailable: 0, messagesTrimmed: 0, observationsFound: 0, addedFromEmail: 0,
    monitorGeneration: 'g1', pauseEpoch: 0, excluded: [],
  });
  let gets = 0;
  await runM5aScanStep(uid, 'daily', {
    storage, env: { MAYBESITTER_ENV: 'staging' } as GoogleRuntime['env'], secrets: null,
    fetchImpl: fetch, now: () => new Date(NOW),
  }, {
    listRecentMessageIds: async () => {
      await saveMonitoringSettings(uid, true, NOW, { storage });
      return { ids: ['paused-mail'], nextPageToken: null };
    },
    getMessageById: async () => { gets++; return null; },
  } as unknown as GmailTransport, async () => undefined);
  assert.equal(gets, 0);
  assert.equal((await storage.get<any>(scanPath))?.page, null);
  assert.equal((await storage.get<any>(scanPath))?.leaseOwner, null);
});

test('H2 a killed enrolled monitor uses guarded legacy analysis and a mid-model pause commits no result', async () => {
  const run = async (pauseDuringModel: boolean) => {
    const uid = pauseDuringModel ? 'rollback-pause' : 'rollback-legacy';
    const storage = createMemoryStorage({ enforceFirestoreReadOrder: true });
    await storage.set(`users/${uid}`, { monitoringSettings: { paused: false, updatedAt: NOW }, trust: createPilotTrustState(uid, NOW) });
    await storage.set('system/m5aControls', { email: { epoch: 12, enabled: false }, calendar: { epoch: 1, enabled: true } });
    await storage.set(userSubDoc(uid, PROVIDER_CONNECTIONS, connectionIdFor('google')), {
      identity: { provider: 'google', providerAccountId: 'acct' }, state: 'connected', credentialRef: 'vault',
      capabilities: ['mail_read'], grantedScopes: [GOOGLE_FEATURE_SCOPES.gmail],
    });
    await storage.set(`users/${uid}/intelligenceMonitors/gmail`, {
      enabled: true, generation: 'g1', cursor: '100', pageToken: null, nextPollAt: NOW,
      lease: null, leaseUntil: null, lastSuccessAt: null, error: null,
      m5: { v: 1, providerAccountId: 'acct', enabledAt: '2026-10-19T09:00:00.000Z', timezone: 'UTC', at: NOW,
        pauseEpoch: 0, pausedSince: null, excluded: [] },
    });
    const message = { id: 'legacy-mail', threadId: null, historyId: '101', receivedAt: '2026-10-19T09:30:00.000Z',
      from: null, subject: null, text: 'Please send the form', sentByAccount: false,
      isReply: false, bodyFormat: 'text/plain' as const };
    let modelCalls = 0;
    const runtime: GoogleRuntime = {
      storage,
      env: { MAYBESITTER_ENV: 'staging', MAYBESITTER_FEATURE_PROACTIVE_LOOP: 'true',
        MAYBESITTER_FEATURE_EMAIL_SOURCES: 'true' } as GoogleRuntime['env'],
      secrets: null, fetchImpl: fetch, now: () => new Date(NOW),
      shareModel: async () => {
        modelCalls++;
        if (pauseDuringModel) await saveMonitoringSettings(uid, true, NOW, { storage });
        return { text: JSON.stringify({ observations: [
          { kind: 'request', evidence: message.text, confidence: 0.9 },
        ] }), model: 'fake', latencyMs: 1, promptTokens: 1, outputTokens: 1 };
      },
    };
    const result = await runGmailMonitorTick(runtime, { uid, ensureReadable: async () => undefined, transport: () => ({
      listHistory: async () => ({ historyId: '101', nextPageToken: null, messages: [message] }),
    }) });
    return { uid, storage, result, modelCalls };
  };

  const legacy = await run(false);
  assert.equal(legacy.result.failures, 0);
  assert.equal(legacy.modelCalls, 1);
  assert.equal((await legacy.storage.list(`users/${legacy.uid}/intelligenceObservations`)).length, 1);
  assert.equal((await legacy.storage.get<M5aMarker>(`${userCol(legacy.uid, INTELLIGENCE_SOURCE_MARKERS)}/${legacyMarkerIdFor('legacy-mail')}`))?.state, 'done');

  const paused = await run(true);
  assert.equal(paused.result.failures, 1);
  assert.equal(paused.modelCalls, 1);
  assert.equal((await paused.storage.list(`users/${paused.uid}/intelligenceObservations`)).length, 0);
  assert.equal((await paused.storage.get<any>(`users/${paused.uid}/intelligenceMonitors/gmail`))?.cursor, '100');
  assert.notEqual((await paused.storage.get<M5aMarker>(`${userCol(paused.uid, INTELLIGENCE_SOURCE_MARKERS)}/${legacyMarkerIdFor('legacy-mail')}`))?.state, 'done');
});

test('R3 a killed enrolled monitor skips excluded history without sticking its cursor', async () => {
  const uid = 'rollback-excluded';
  const storage = createMemoryStorage({ enforceFirestoreReadOrder: true });
  await storage.set(`users/${uid}`, { monitoringSettings: { paused: false, updatedAt: NOW }, trust: createPilotTrustState(uid, NOW) });
  await storage.set('system/m5aControls', { email: { epoch: 12, enabled: false }, calendar: { epoch: 1, enabled: true } });
  await storage.set(userSubDoc(uid, PROVIDER_CONNECTIONS, connectionIdFor('google')), {
    identity: { provider: 'google', providerAccountId: 'acct' }, state: 'connected', credentialRef: 'vault',
    capabilities: ['mail_read'], grantedScopes: [GOOGLE_FEATURE_SCOPES.gmail],
  });
  await storage.set(`users/${uid}/intelligenceMonitors/gmail`, {
    enabled: true, generation: 'g1', cursor: '100', pageToken: null, nextPollAt: NOW,
    lease: null, leaseUntil: null, lastSuccessAt: null, error: null,
    m5: { v: 1, providerAccountId: 'acct', enabledAt: '2026-10-19T09:00:00.000Z', timezone: 'UTC', at: NOW,
      pauseEpoch: 0, pausedSince: null,
      excluded: [{ from: '2026-10-19T09:10:00.000Z', to: '2026-10-19T09:30:00.000Z' }] },
  });
  const excluded = { id: 'excluded-mail', threadId: null, historyId: '101', receivedAt: '2026-10-19T09:15:00.000Z',
    from: null, subject: null, text: 'Do not inspect this message', sentByAccount: false,
    isReply: false, bodyFormat: 'text/plain' as const };
  const eligible = { ...excluded, id: 'eligible-mail', historyId: '102', receivedAt: '2026-10-19T09:45:00.000Z',
    text: 'Please send the form' };
  let modelCalls = 0;
  const runtime: GoogleRuntime = {
    storage,
    env: { MAYBESITTER_ENV: 'staging', MAYBESITTER_FEATURE_PROACTIVE_LOOP: 'true',
      MAYBESITTER_FEATURE_EMAIL_SOURCES: 'true' } as GoogleRuntime['env'],
    secrets: null, fetchImpl: fetch, now: () => new Date(NOW),
    shareModel: async () => {
      modelCalls++;
      return { text: JSON.stringify({ observations: [
        { kind: 'request', evidence: eligible.text, confidence: 0.9 },
      ] }), model: 'fake', latencyMs: 1, promptTokens: 1, outputTokens: 1 };
    },
  };

  const result = await runGmailMonitorTick(runtime, { uid, ensureReadable: async () => undefined, transport: () => ({
    listHistory: async () => ({ historyId: '102', nextPageToken: null, messages: [excluded, eligible] }),
  }) });

  assert.deepEqual(result, { enabled: true, accountsChecked: 1, messagesAnalyzed: 1, failures: 0 });
  assert.equal(modelCalls, 1);
  assert.equal((await storage.get<any>(`users/${uid}/intelligenceMonitors/gmail`))?.cursor, '102');
  assert.equal(await storage.get(`${userCol(uid, INTELLIGENCE_SOURCE_MARKERS)}/${legacyMarkerIdFor(excluded.id)}`), null);
  assert.equal((await storage.get<M5aMarker>(`${userCol(uid, INTELLIGENCE_SOURCE_MARKERS)}/${legacyMarkerIdFor(eligible.id)}`))?.state, 'done');
});

test('L1 a live quota wait moves the monitor poll and is not reclaimed before nextEligibleAt', async () => {
  const storage = createMemoryStorage();
  const uid = 'live-next-eligible';
  const resumesAt = '2026-10-20T00:00:00.000Z';
  await storage.set(`users/${uid}`, { monitoringSettings: { paused: false, updatedAt: NOW }, trust: createPilotTrustState(uid, NOW) });
  await storage.set('system/m5aControls', { email: { epoch: 4, enabled: true }, calendar: { epoch: 1, enabled: true } });
  await storage.set(userSubDoc(uid, PROVIDER_CONNECTIONS, connectionIdFor('google')), {
    identity: { provider: 'google', providerAccountId: 'acct' }, state: 'connected', credentialRef: 'vault',
    capabilities: ['mail_read'], grantedScopes: [GOOGLE_FEATURE_SCOPES.gmail],
  });
  await storage.set(`users/${uid}/intelligenceMonitors/gmail`, {
    enabled: true, generation: 'g1', cursor: '100', pageToken: null, nextPollAt: NOW,
    lease: null, leaseUntil: null, lastSuccessAt: null, error: null,
    liveWaiting: { reason: 'daily_ai_limit', resumesAt, generation: 'g1', providerAccountId: 'acct' },
    m5: { v: 1, providerAccountId: 'acct', enabledAt: NOW, timezone: 'UTC', at: NOW,
      pauseEpoch: 0, pausedSince: null, excluded: [] },
  });
  const scanPath = `users/${uid}/${INTELLIGENCE_GMAIL_SCANS}/liveV2`;
  await storage.set(scanPath, {
    scanId: 'live-scan', kind: 'live', status: 'running', origin: 'live', providerAccountId: 'acct', emailEpoch: 4,
    query: '', from: NOW, until: resumesAt, timezone: 'UTC', startedAt: NOW, finishedAt: null, failedAt: null,
    failure: null, pageToken: null, page: { ids: ['mail'], nextPageToken: null, done: [] },
    leaseOwner: null, leaseUntil: null, queued: null, nextEligibleAt: resumesAt,
    waiting: { reason: 'daily_ai_limit', resumesAt }, messagesRead: 0, messagesUnavailable: 0,
    messagesTrimmed: 0, observationsFound: 0, addedFromEmail: 0,
    monitorGeneration: 'g1', pauseEpoch: 0, excluded: [], liveHistoryId: '101', liveNextPageToken: null,
  });
  let gmailCalls = 0;
  await runGmailMonitorTick({ storage,
    env: { MAYBESITTER_ENV: 'staging', MAYBESITTER_FEATURE_PROACTIVE_LOOP: 'true' } as GoogleRuntime['env'],
    secrets: null, fetchImpl: fetch, now: () => new Date(NOW),
  }, { uid, ensureReadable: async () => undefined, transport: () => ({
    listHistory: async () => { gmailCalls++; throw new Error('must not list'); },
    getMessageById: async () => { gmailCalls++; throw new Error('must not fetch'); },
  }) });
  assert.equal(gmailCalls, 0);
  assert.deepEqual((await storage.get<any>(scanPath))?.waiting, { reason: 'daily_ai_limit', resumesAt });
  assert.equal((await storage.get<any>(`users/${uid}/intelligenceMonitors/gmail`))?.nextPollAt, resumesAt);
});

test('G7 proposal rows and caller completion are one guarded all-or-nothing transaction', async () => {
  const storage = createMemoryStorage();
  await storage.set('users/proposal-atomic', { trust: createPilotTrustState('proposal-atomic', NOW) });
  const [observation] = await putObservations('proposal-atomic', 'manual', 'note', NOW, [{
    kind: 'request', evidence: 'Please send the form', confidence: 0.9,
  }], storage);
  await assert.rejects(proposeFromObservations('proposal-atomic', NOW, {
    storage,
    generate: async () => ({ text: JSON.stringify({ suggestions: [{ kind: 'action', title: 'Send the form',
      reason: 'The form was requested', observationIds: [observation!.id], confidence: 0.9, durationMinutes: 10 }] }),
      model: 'fake', latencyMs: 1, promptTokens: 1, outputTokens: 1 }),
    transactionComplete: async () => { throw new Error('monitor fence changed'); },
  }), /monitor fence changed/);
  assert.equal((await storage.list(userCol('proposal-atomic', 'intelligenceSuggestions'))).length, 0,
    'a failed caller fence must leave no partial suggestion rows');
});

test('H1 proposal scheduler reads every authority guard before writing proposal completion', async () => {
  const storage = createMemoryStorage({ enforceFirestoreReadOrder: true });
  const uid = 'proposal-read-order';
  await storage.set(`users/${uid}`, { monitoringSettings: { paused: false, updatedAt: NOW }, trust: createPilotTrustState(uid, NOW) });
  const [observation] = await putObservations(uid, 'manual', 'note', NOW, [{
    kind: 'request', evidence: 'Please send the form', confidence: 0.9,
  }], storage);
  await storage.set('system/m5aControls', { email: { epoch: 7, enabled: true }, calendar: { epoch: 1, enabled: true } });
  await storage.set(userSubDoc(uid, PROVIDER_CONNECTIONS, connectionIdFor('google')), {
    identity: { provider: 'google', providerAccountId: 'acct' }, state: 'connected', credentialRef: 'vault',
    capabilities: ['mail_read'], grantedScopes: [GOOGLE_FEATURE_SCOPES.gmail],
  });
  await storage.set(`users/${uid}/intelligenceMonitors/gmail`, {
    enabled: true, generation: 'g1', cursor: '100', pageToken: null, nextPollAt: '2026-10-20T00:00:00.000Z',
    lease: null, leaseUntil: null, lastSuccessAt: null, error: null,
    proposalsVersion: 1, proposalsDoneVersion: 0, proposalsPending: true, proposalNextEligibleAt: NOW,
    m5: { v: 1, providerAccountId: 'acct', enabledAt: NOW, timezone: 'UTC', at: NOW,
      pauseEpoch: 0, pausedSince: null, excluded: [] },
  });
  const provider: LlmProvider = {
    name: 'gemini',
    generateJson: async () => { throw new Error('wrong provider verb'); },
    generateStructured: async () => ({ text: JSON.stringify({ suggestions: [{
      kind: 'action', title: 'Send the form', reason: 'The form was requested',
      observationIds: [observation!.id], confidence: 0.9, durationMinutes: 10,
    }] }), model: 'fake', latencyMs: 1, promptTokens: 1, outputTokens: 1 }),
  };
  const runtime: GoogleRuntime = { storage,
    env: { MAYBESITTER_ENV: 'staging' } as GoogleRuntime['env'], secrets: null, fetchImpl: fetch,
    now: () => new Date(NOW), shareProvider: provider,
  };
  await runGmailJobTickForTests('live', { runtime, ensureReadable: async () => undefined });
  const monitor = await storage.get<any>(`users/${uid}/intelligenceMonitors/gmail`);
  assert.equal(monitor.proposalsDoneVersion, 1);
  assert.equal(monitor.proposalsPending, false);
  assert.equal((await storage.get<any>(`users/${uid}/intelligenceRuns/latest`))?.status, 'complete');
});

test('G8 24-hour clock with the real 45/2000 guard drains daily waits after UTC reset without duplicates', async () => {
  const storage = createMemoryStorage();
  const accounts = Array.from({ length: 50 }, (_, index) => `capacity-${index}`);
  type CapacityUnit = { id: string; uid: string; kind: 'live' | 'continuation' | 'proposal'; calls: 1 | 2; arrival: number };
  const arrivals: CapacityUnit[] = accounts.flatMap((uid, accountIndex) => Array.from({ length: 50 }, (_, index) => {
    const kind = index % 10 === 0 ? 'proposal' as const : index % 4 === 0 ? 'continuation' as const : 'live' as const;
    return { id: `${uid}:m${index}`, uid, kind, calls: kind === 'proposal' ? 2 as const : 1 as const,
      arrival: (accountIndex * 29 + index * 31) % (24 * 60) };
  })).sort((a, b) => a.arrival - b.arrival || a.id.localeCompare(b.id));
  const pending = new Map(accounts.map(uid => [uid, {
    live: [] as CapacityUnit[], continuation: [] as CapacityUnit[], proposal: [] as CapacityUnit[],
  }]));
  const completed = new Set<string>();
  const failedOnce = new Set<string>();
  let proposalSteps = 0;
  let continuationSteps = 0;
  let arrivalCursor = 0;
  const start = Date.parse('2026-10-19T00:00:00.000Z');
  const runMinute = async (minuteIndex: number) => {
    const now = new Date(start + minuteIndex * 60_000);
    while (arrivalCursor < arrivals.length && arrivals[arrivalCursor]!.arrival <= minuteIndex) {
      const unit = arrivals[arrivalCursor++]!;
      pending.get(unit.uid)![unit.kind].push(unit);
    }
    for (const [kind, lanes] of [['live', 8], ['continuation', 4], ['proposal', 2]] as const) {
      for (let lane = 0; lane < lanes; lane++) {
        const offset = (minuteIndex * lanes + lane) % accounts.length;
        const uid = Array.from({ length: accounts.length }, (_, step) => accounts[(offset + step) % accounts.length]!)
          .find(candidate => pending.get(candidate)![kind].length > 0);
        if (!uid) continue;
        const unit = pending.get(uid)![kind][0]!;
        if ((minuteIndex + lane + unit.id.length) % 97 === 0 && !failedOnce.has(unit.id)) {
          failedOnce.add(unit.id); // injected pre-dispatch failure: retry the same durable unit
          continue;
        }
        const reservation = await reserveQuotaPermit(uid, 'semantic_observation',
          { owner: unit.id, calls: unit.calls, tokenBudget: unit.calls * 10 }, { storage, now });
        if (reservation.outcome !== 'ok') continue;
        for (let slot = 0; slot < unit.calls; slot++) {
          assert.equal(await startQuotaPermitSlot(reservation.permit!, slot, { storage, now }), true);
          await settleQuotaPermitSlot(reservation.permit!, slot, { promptTokens: 1, outputTokens: 1 }, { storage, now });
        }
        await finalizeQuotaPermit(reservation.permit!, { storage, now });
        assert.equal(completed.has(unit.id), false, `duplicate unit ${unit.id}`);
        completed.add(unit.id);
        pending.get(uid)![kind].shift();
        if (kind === 'proposal') proposalSteps++;
        if (kind === 'continuation') continuationSteps++;
      }
    }
  };
  for (let minute = 0; minute < 24 * 60; minute++) await runMinute(minute);
  assert.equal((await callsToday(accounts[0]!, { storage, now: new Date(start + 23 * 60 * 60_000) })).global,
    M5A_GLOBAL_DAILY_CALL_CAP);
  assert.ok(Array.from(pending.values()).some(queues => Object.values(queues).some(queue => queue.length > 0)),
    'daily-limit waits were not retained');
  for (let minute = 24 * 60; minute < 30 * 60 && completed.size < arrivals.length; minute++) await runMinute(minute);
  assert.equal(completed.size, 2_500);
  assert.ok(Array.from(pending.values()).every(queues => Object.values(queues).every(queue => queue.length === 0)));
  assert.ok(proposalSteps > 0 && continuationSteps > 0, 'proposal and continuation lanes were not charged');
});

test('M2 production live lanes drain a per-user 45-call wait after reset without duplicate effects', async () => {
  const storage = createMemoryStorage({ enforceFirestoreReadOrder: true });
  const uid = 'production-capacity';
  const ids = Array.from({ length: 47 }, (_, index) => `mail-${index}`);
  let now = new Date('2026-10-19T00:00:00.000Z');
  await storage.set(`users/${uid}`, { monitoringSettings: { paused: false, updatedAt: now.toISOString() }, trust: createPilotTrustState(uid, now.toISOString()) });
  await storage.set('system/m5aControls', { email: { epoch: 5, enabled: true }, calendar: { epoch: 1, enabled: true } });
  await storage.set(userSubDoc(uid, PROVIDER_CONNECTIONS, connectionIdFor('google')), {
    identity: { provider: 'google', providerAccountId: 'acct' }, state: 'connected', credentialRef: 'vault',
    capabilities: ['mail_read'], grantedScopes: [GOOGLE_FEATURE_SCOPES.gmail],
  });
  await storage.set(`users/${uid}/intelligenceMonitors/gmail`, {
    enabled: true, generation: 'g1', cursor: '100', pageToken: null, nextPollAt: now.toISOString(),
    lease: null, leaseUntil: null, lastSuccessAt: null, error: null,
    proposalsVersion: 0, proposalsDoneVersion: 0, proposalsPending: false, proposalNextEligibleAt: now.toISOString(),
    m5: { v: 1, providerAccountId: 'acct', enabledAt: '2026-10-18T23:00:00.000Z', timezone: 'UTC',
      at: now.toISOString(), pauseEpoch: 0, pausedSince: null, excluded: [] },
  });

  const successful = new Map<string, number>();
  const attempts = new Map<string, number>();
  const failedOnce = new Set<string>();
  let active = 0;
  let peak = 0;
  const shareProvider: LlmProvider = {
    name: 'gemini',
    generateJson: async () => { throw new Error('wrong provider verb'); },
    generateStructured: async request => {
      const text = JSON.stringify(request);
      const id = /unit:(mail-\d+)/.exec(text)?.[1];
      assert.ok(id, 'the fake provider must see the message id in its untrusted input');
      active++;
      peak = Math.max(peak, active);
      attempts.set(id, (attempts.get(id) ?? 0) + 1);
      try {
        await new Promise<void>(resolve => setImmediate(resolve));
        if (id === 'mail-7' && !failedOnce.has(id)) {
          failedOnce.add(id);
          throw new Error('injected_model_failure');
        }
        successful.set(id, (successful.get(id) ?? 0) + 1);
        return { text: '{"observations":[]}', model: 'fake-share', latencyMs: 1, promptTokens: 1, outputTokens: 1 };
      } finally { active--; }
    },
  };
  let captureCalls = 0;
  const captureProvider: LlmProvider = {
    name: 'gemini',
    generateJson: async () => { captureCalls++; throw new Error('ordinary mail must not extract a commitment'); },
    generateStructured: async () => { captureCalls++; throw new Error('ordinary mail must not extract a commitment'); },
  };
  const runtime: GoogleRuntime = { storage,
    env: { MAYBESITTER_ENV: 'staging', MAYBESITTER_FEATURE_PROACTIVE_LOOP: 'true',
      MAYBESITTER_FEATURE_EMAIL_SOURCES: 'true' } as GoogleRuntime['env'],
    secrets: null, fetchImpl: fetch, now: () => new Date(now), shareProvider, captureProvider,
  };
  let listed = false;
  const transport = (): GmailTransport => ({
    listHistory: async () => { throw new Error('the enrolled path must use id-only history'); },
    listHistoryIds: async () => {
      if (listed) return { historyId: '200', nextPageToken: null, ids: [] };
      listed = true;
      return { historyId: '200', nextPageToken: null, ids };
    },
    getMessageById: async (id: string) => ({
      id, threadId: null, historyId: '200', receivedAt: '2026-10-18T23:59:00.000Z',
      from: null, subject: null, text: `unit:${id}`, sentByAccount: false,
      isReply: false, bodyFormat: 'text/plain' as const,
    }),
    listRecentMessageIds: async () => { throw new Error('live work must not use mailbox search'); },
  } as unknown as GmailTransport);
  const tick = () => runGmailJobTickForTests('live', {
    runtime, transport: () => transport(), ensureReadable: async () => undefined,
  });

  let waiting: any = null;
  for (let minute = 0; minute < 180 && !waiting; minute++) {
    await Promise.all([tick(), tick()]);
    waiting = (await storage.get<any>(`users/${uid}/${INTELLIGENCE_GMAIL_SCANS}/liveV2`))?.waiting;
    now = new Date(now.getTime() + 60_000);
  }
  assert.deepEqual(waiting, { reason: 'daily_ai_limit', resumesAt: '2026-10-20T00:00:00.000Z' });
  assert.equal((await storage.get<any>(`users/${uid}/intelligenceMonitors/gmail`))?.nextPollAt, waiting.resumesAt);
  const attemptsAtWait = Array.from(attempts.values()).reduce((sum, count) => sum + count, 0);
  now = new Date('2026-10-19T23:59:00.000Z');
  await Promise.all([tick(), tick()]);
  assert.equal(Array.from(attempts.values()).reduce((sum, count) => sum + count, 0), attemptsAtWait,
    'a daily wait must not be retried before its reset');

  now = new Date(waiting.resumesAt);
  for (let minute = 0; minute < 20; minute++) {
    await Promise.all([tick(), tick()]);
    const scan = await storage.get<any>(`users/${uid}/${INTELLIGENCE_GMAIL_SCANS}/liveV2`);
    if (scan?.status === 'complete') break;
    now = new Date(now.getTime() + 60_000);
  }
  const scan = await storage.get<any>(`users/${uid}/${INTELLIGENCE_GMAIL_SCANS}/liveV2`);
  assert.equal(scan.status, 'complete');
  assert.equal(scan.messagesRead, ids.length);
  assert.equal(scan.waiting, null);
  assert.equal(successful.size, ids.length);
  assert.ok(Array.from(successful.values()).every(count => count === 1), 'each message must commit one successful analysis');
  assert.equal(attempts.get('mail-7'), 2, 'the injected failure must retry its durable unit once');
  assert.equal(peak, 1, 'overlapping job instances must not run two model steps for one account');
  assert.equal(captureCalls, 0);
  const markers = await storage.list<M5aMarker>(userCol(uid, INTELLIGENCE_SOURCE_MARKERS));
  assert.equal(markers.filter(row => row.data.state === 'done').length, ids.length * 2);
});

test('G9 fake providers behind both real adapters consume a whole permit and release an unused slot', async () => {
  const storage = createMemoryStorage();
  const now = new Date(NOW);
  const provider: LlmProvider = {
    name: 'gemini',
    generateJson: async () => ({ text: '{"type":"task","title":"Send it","description":null,"person":null,"dueAt":null,"remindAt":null,"allDay":false,"missingFields":[],"ambiguityFlags":[]}',
      model: 'fake', latencyMs: 1, promptTokens: 7, outputTokens: 3 }),
    generateStructured: async () => ({ text: '{"observations":[]}', model: 'fake', latencyMs: 1, promptTokens: 11, outputTokens: 5 }),
  };
  const reserved = await reserveQuotaPermit('adapter-user', 'semantic_observation',
    { owner: 'message-unit', calls: 2, tokenBudget: 1_000 }, { storage, now });
  assert.equal(reserved.outcome, 'ok');
  const permit = reserved.permit!;
  await shareLlmProvider('adapter-user', { provider, consent: async () => 'granted',
    quotaPermit: { permit, slot: 0, storage }, now: () => now })({ system: 'system', parts: [{ kind: 'text', text: 'mail' }], responseSchema: {} });
  await captureLlmProvider('adapter-user', { provider, consent: async () => 'granted',
    quotaPermit: { permit, slot: 1, storage }, now: () => now })('prompt');
  await finalizeQuotaPermit(permit, { storage, now });
  assert.deepEqual(await callsToday('adapter-user', { storage, now }), { user: 2, global: 2, tokens: 26, minuteCalls: 2 });

  const unused = await reserveQuotaPermit('unused-user', 'semantic_observation',
    { owner: 'ordinary-unit', calls: 2, tokenBudget: 1_000 }, { storage, now });
  await shareLlmProvider('unused-user', { provider, consent: async () => 'granted',
    quotaPermit: { permit: unused.permit!, slot: 0, storage }, now: () => now })({ system: 'system', parts: [{ kind: 'text', text: 'mail' }], responseSchema: {} });
  await finalizeQuotaPermit(unused.permit!, { storage, now });
  assert.equal((await callsToday('unused-user', { storage, now })).user, 1);

  await storage.set('users/capped/usage/2026-10-19', { calls: M5A_USER_DAILY_CALL_CAP - 1, m5aCalls: M5A_USER_DAILY_CALL_CAP - 1,
    date: '2026-10-19', updatedAt: NOW, inputTokens: 0, outputTokens: 0, reservedTokens: 0,
    minute: NOW.slice(0, 16), minuteCalls: 0 });
  assert.equal((await reserveQuotaPermit('capped', 'semantic_observation',
    { owner: 'two-pass', calls: 2, tokenBudget: 100 }, { storage, now })).outcome, 'user_cap');
  await storage.set('llmUsage/2026-10-19', { calls: M5A_GLOBAL_DAILY_CALL_CAP - 1, m5aCalls: M5A_GLOBAL_DAILY_CALL_CAP - 1,
    date: '2026-10-19', updatedAt: NOW });
  assert.equal((await reserveQuotaPermit('global-capped', 'semantic_observation',
    { owner: 'two-pass', calls: 2, tokenBudget: 100 }, { storage, now })).outcome, 'global_cap');
  assert.equal((await reserveQuotaPermit('boundary', 'semantic_observation',
    { owner: 'two-pass', calls: 2, tokenBudget: 100 }, { storage, now: new Date('2026-10-19T10:59:50.000Z') })).outcome, 'minute_boundary');
});

test('G9 a production-shaped qualifying unit reserves and settles both adapter slots end to end', async () => {
  const storage = createMemoryStorage();
  const uid = 'permit-unit';
  const own = 'I will send the report tomorrow at 10.';
  const message = {
    id: 'qualifying-mail', threadId: null, historyId: '101', receivedAt: '2026-10-19T09:00:00.000Z',
    from: null, subject: null, text: `${own}\n\nOn Sun, Oct 18, Alex wrote:\nCan you send it?`,
    sentByAccount: true, isReply: true, bodyFormat: 'text/plain' as const,
  };
  let shareCalls = 0;
  let captureCalls = 0;
  const shareProvider: LlmProvider = {
    name: 'gemini',
    generateJson: async () => { throw new Error('wrong provider verb'); },
    generateStructured: async () => {
      shareCalls++;
      return { text: JSON.stringify({ observations: [{ kind: 'commitment', evidence: own, confidence: 0.99 }] }),
        model: 'fake-share', latencyMs: 1, promptTokens: 13, outputTokens: 5 };
    },
  };
  const captureProvider: LlmProvider = {
    name: 'gemini',
    generateJson: async () => { throw new Error('wrong provider verb'); },
    generateStructured: async () => {
      captureCalls++;
      return { text: JSON.stringify({ type: 'task', title: own, description: null, person: null,
        dueAt: '2026-10-20T10:00:00.000Z', remindAt: null, allDay: false, missingFields: [], ambiguityFlags: [] }),
        model: 'fake-capture', latencyMs: 1, promptTokens: 17, outputTokens: 7 };
    },
  };
  const runtime: GoogleRuntime = {
    storage, env: { MAYBESITTER_ENV: 'staging' } as GoogleRuntime['env'], secrets: null, fetchImpl: fetch,
    now: () => new Date(NOW), shareProvider, captureProvider,
  };
  await storage.set(`users/${uid}`, { trust: { ...createPilotTrustState(uid, NOW), calendarConsent: true } });
  await storage.set('system/m5aControls', { email: { epoch: 3, enabled: true }, calendar: { epoch: 1, enabled: true } });
  await storage.set(userSubDoc(uid, PROVIDER_CONNECTIONS, connectionIdFor('google')), {
    identity: { provider: 'google', providerAccountId: 'acct' }, state: 'connected', credentialRef: 'vault',
    capabilities: ['mail_read'], grantedScopes: [GOOGLE_FEATURE_SCOPES.gmail],
  });
  await storage.set(`users/${uid}/${INTELLIGENCE_GMAIL_SCANS}/manualV2`, {
    scanId: 'scan', kind: 'manual', status: 'running', origin: 'manual', providerAccountId: 'acct', emailEpoch: 3,
    query: 'after:1 before:9999999999', from: '2026-10-19T00:00:00.000Z', until: '2026-10-20T00:00:00.000Z',
    timezone: 'UTC', startedAt: NOW, finishedAt: null, failedAt: null, failure: null,
    pageToken: null, page: null, leaseOwner: null, leaseUntil: null, queued: null, nextEligibleAt: NOW, waiting: null,
    messagesRead: 0, messagesUnavailable: 0, messagesTrimmed: 0, observationsFound: 0, addedFromEmail: 0,
  });
  const transport = {
    listRecentMessageIds: async () => ({ ids: [message.id], nextPageToken: null }),
    getMessageById: async () => message,
  } as unknown as GmailTransport;
  await runM5aScanStep(uid, 'manual', runtime, transport, async () => undefined);
  await runM5aScanStep(uid, 'manual', runtime, transport, async () => undefined);
  assert.equal(shareCalls, 1);
  assert.equal(captureCalls, 1);
  assert.deepEqual(await callsToday(uid, { storage, now: new Date(NOW) }), {
    user: 2, global: 2, tokens: 42, minuteCalls: 2,
  });
});

test('G9 a two-call quota boundary defers the whole unit and moves its schedule before either adapter runs', async () => {
  const storage = createMemoryStorage();
  const uid = 'permit-refused-unit';
  let providerCalls = 0;
  const provider: LlmProvider = {
    name: 'gemini',
    generateJson: async () => { providerCalls++; throw new Error('must not dispatch'); },
    generateStructured: async () => { providerCalls++; throw new Error('must not dispatch'); },
  };
  const runtime: GoogleRuntime = {
    storage, env: { MAYBESITTER_ENV: 'staging' } as GoogleRuntime['env'], secrets: null, fetchImpl: fetch,
    now: () => new Date(NOW), shareProvider: provider, captureProvider: provider,
  };
  await storage.set(`users/${uid}`, { trust: { ...createPilotTrustState(uid, NOW), calendarConsent: true } });
  await storage.set('system/m5aControls', { email: { epoch: 3, enabled: true }, calendar: { epoch: 1, enabled: true } });
  await storage.set(userSubDoc(uid, PROVIDER_CONNECTIONS, connectionIdFor('google')), {
    identity: { provider: 'google', providerAccountId: 'acct' }, state: 'connected', credentialRef: 'vault',
    capabilities: ['mail_read'], grantedScopes: [GOOGLE_FEATURE_SCOPES.gmail],
  });
  await storage.set(`users/${uid}/usage/2026-10-19`, {
    calls: M5A_USER_DAILY_CALL_CAP - 1, m5aCalls: M5A_USER_DAILY_CALL_CAP - 1,
    date: '2026-10-19', updatedAt: NOW, inputTokens: 0, outputTokens: 0, reservedTokens: 0,
    minute: NOW.slice(0, 16), minuteCalls: 0,
  });
  await storage.set(`users/${uid}/${INTELLIGENCE_GMAIL_SCANS}/manualV2`, {
    scanId: 'scan', kind: 'manual', status: 'running', origin: 'manual', providerAccountId: 'acct', emailEpoch: 3,
    query: 'after:1 before:9999999999', from: '2026-10-19T00:00:00.000Z', until: '2026-10-20T00:00:00.000Z',
    timezone: 'UTC', startedAt: NOW, finishedAt: null, failedAt: null, failure: null,
    pageToken: null, page: { ids: ['mail'], nextPageToken: null, done: [] }, leaseOwner: null, leaseUntil: null,
    queued: null, nextEligibleAt: NOW, waiting: null, messagesRead: 0, messagesUnavailable: 0,
    messagesTrimmed: 0, observationsFound: 0, addedFromEmail: 0,
  });
  const message = { id: 'mail', threadId: null, historyId: '101', receivedAt: '2026-10-19T09:00:00.000Z',
    from: null, subject: null, text: 'I will send the report tomorrow at 10.\n\nOn Sun, Oct 18, Alex wrote:\nPlease send it.',
    sentByAccount: true, isReply: true, bodyFormat: 'text/plain' as const };
  await runM5aScanStep(uid, 'manual', runtime, {
    getMessageById: async () => message,
  } as unknown as GmailTransport, async () => undefined);
  assert.equal(providerCalls, 0);
  const scan = await storage.get<any>(`users/${uid}/${INTELLIGENCE_GMAIL_SCANS}/manualV2`);
  assert.deepEqual(scan.waiting, { reason: 'daily_ai_limit', resumesAt: '2026-10-20T00:00:00.000Z' });
  assert.equal(scan.nextEligibleAt, scan.waiting.resumesAt);
  assert.deepEqual(scan.page.done, []);
});
