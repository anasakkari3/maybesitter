import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUSY_BLOCKS, BUSY_SOURCE_FENCES, CALENDAR_CHOICE, CALENDAR_SOURCES, DEVICE_STALE_STATE,
  INTELLIGENCE_SOURCE_MARKERS, PROVIDER_CONNECTIONS, REGISTERED_DEVICE_SOURCES,
  createMemoryStorage, docIdForKey, userCol, userSubDoc,
} from '../../lib/storage';
import type { GoogleRuntime } from '../../lib/integrations/google/googleRuntime';
import { GOOGLE_BUSY_SOURCE_ID, type GoogleBusyTarget } from '../../lib/integrations/google/googleCalendarBusy';
import { GOOGLE_FEATURE_SCOPES } from '../../lib/integrations/google/googleConfig';
import { connectionIdFor } from '../../lib/integrations/providers/production/storedConnectionStore';
import { calendarCoverageForEmail, runCalendarMaintenanceStep } from '../../lib/intelligence/gmailCalendarJit';
import { cleanupCalendarWaits, runReservedLanesForTests } from '../../lib/intelligence/gmailJobs';
import { gmailQueryOutsideIntervals, legacyMarkerIdFor, providerMarkerIdFor, type M5aMarker } from '../../lib/intelligence/m5aGmailScan';
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
  await storage.set(`users/${uid}`, { monitoringSettings: { paused: false, updatedAt: NOW } });
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
  const transport: Pick<GmailTransport, 'listHistory'> = {
    listHistory: async () => ({ historyId: '101', nextPageToken: null, messages: [message] }),
  };
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

test('G3 a 450-add/450-remove JIT target resumes over six chunks and certifies only at the end', async () => {
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
  await storage.set(`users/${uid}`, { trust: { calendarConsent: true }, calendarEpoch: 1 });
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
    if ((await storage.get<any>(fencePath))?.jitTarget) {
      assert.equal((await storage.get<any>(sourcePath))?.m5Certificate?.refreshedAt, NOW,
        'a partial target must not write its new certificate');
    }
    now = new Date(now.getTime() + 1_000);
    assert.ok(steps < 10, 'target did not make resumable progress');
  }
  assert.equal(steps, 6);
  const rows = await storage.list<any>(userCol(uid, BUSY_BLOCKS));
  assert.equal(rows.length, 450);
  assert.equal((await storage.get<any>(sourcePath))?.m5Certificate?.fenceGeneration, 7);
});

test('G4 registered stale devices wait for one hour account-wide, then force auto-add off until fresh', async () => {
  const storage = createMemoryStorage();
  const uid = 'stale_device';
  let now = new Date(NOW);
  const runtime: GoogleRuntime = { storage, env: {} as GoogleRuntime['env'], secrets: null, fetchImpl: fetch, now: () => new Date(now) };
  const sourceId = 'device:phone';
  await storage.set(`users/${uid}`, { trust: { calendarConsent: true } });
  await storage.set('system/m5aControls', { email: { epoch: 1, enabled: true }, calendar: { epoch: 1, enabled: true } });
  await storage.set(userSubDoc(uid, CALENDAR_CHOICE, 'state'), { v: 1, generation: 3, state: 'active' });
  await storage.set(userSubDoc(uid, REGISTERED_DEVICE_SOURCES, docIdForKey(sourceId)), { sourceId, state: 'active' });
  await storage.set(userSubDoc(uid, CALENDAR_SOURCES, docIdForKey(sourceId)), { sourceId, kind: 'device', status: 'active',
    platform: 'ios', choiceGeneration: 3, lastSyncedAt: new Date(now.getTime() - 7 * 60 * 60_000).toISOString(),
    windowStart: NOW, windowEnd: NOW });
  assert.equal(await calendarCoverageForEmail(uid, runtime), 'stale_device');
  assert.equal((await storage.list(userCol(uid, DEVICE_STALE_STATE))).length, 1);
  now = new Date(now.getTime() + 61 * 60_000);
  assert.equal(await calendarCoverageForEmail(uid, runtime), 'force_off');
  await storage.set(userSubDoc(uid, CALENDAR_SOURCES, docIdForKey(sourceId)), { sourceId, kind: 'device', status: 'active',
    platform: 'ios', choiceGeneration: 3, lastSyncedAt: now.toISOString(), windowStart: NOW, windowEnd: NOW });
  assert.equal(await calendarCoverageForEmail(uid, runtime), 'fresh');
  assert.equal((await storage.list(userCol(uid, DEVICE_STALE_STATE))).length, 0);
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

test('G6 paused intervals are removed from the Gmail listing query before messages.get', () => {
  const query = gmailQueryOutsideIntervals('2026-10-19T00:00:00.000Z', '2026-10-19T12:00:00.000Z', [
    { from: '2026-10-19T03:00:00.000Z', to: '2026-10-19T05:00:00.000Z' },
  ]);
  assert.equal(query, '(after:1792368000 before:1792378800) OR (after:1792386000 before:1792411200)');
});

test('G7 proposal rows and caller completion are one guarded all-or-nothing transaction', async () => {
  const storage = createMemoryStorage();
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

test('G8 24-hour clock with the real 45/2000 guard drains daily waits after UTC reset without duplicates', async () => {
  const storage = createMemoryStorage();
  const accounts = Array.from({ length: 50 }, (_, index) => `capacity-${index}`);
  const pending = new Map(accounts.map(uid => [uid, Array.from({ length: 50 }, (_, index) => `${uid}:m${index}`)]));
  const completed = new Set<string>();
  const failedOnce = new Set<string>();
  let proposalSteps = 0;
  let continuationSteps = 0;
  const start = Date.parse('2026-10-19T00:00:00.000Z');
  const runMinute = async (minuteIndex: number) => {
    const now = new Date(start + minuteIndex * 60_000);
    for (let lane = 0; lane < 8; lane++) {
      const uid = accounts[(minuteIndex * 8 + lane) % accounts.length]!;
      const messageId = pending.get(uid)![0];
      if (!messageId) continue;
      if ((minuteIndex + lane) % 97 === 0 && !failedOnce.has(messageId)) {
        failedOnce.add(messageId); // injected pre-dispatch failure: retry the same durable unit
        continue;
      }
      const reservation = await reserveQuotaPermit(uid, 'semantic_observation',
        { owner: messageId, calls: 1, tokenBudget: 10 }, { storage, now });
      if (reservation.outcome !== 'ok') continue;
      assert.equal(await startQuotaPermitSlot(reservation.permit!, 0, { storage, now }), true);
      await settleQuotaPermitSlot(reservation.permit!, 0, { promptTokens: 1, outputTokens: 1 }, { storage, now });
      await finalizeQuotaPermit(reservation.permit!, { storage, now });
      assert.equal(completed.has(messageId), false, `duplicate unit ${messageId}`);
      completed.add(messageId);
      pending.get(uid)!.shift();
    }
    proposalSteps += 2;
    continuationSteps += 4;
  };
  for (let minute = 0; minute < 24 * 60; minute++) await runMinute(minute);
  assert.equal(completed.size, M5A_GLOBAL_DAILY_CALL_CAP);
  assert.ok(Array.from(pending.values()).every(queue => queue.length > 0), 'daily-limit waits were not retained');
  for (let minute = 24 * 60; minute < 30 * 60 && completed.size < 2_500; minute++) await runMinute(minute);
  assert.equal(completed.size, 2_500);
  assert.ok(Array.from(pending.values()).every(queue => queue.length === 0));
  assert.ok(proposalSteps > 0 && continuationSteps > 0, 'proposal and continuation lanes were not charged');
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
