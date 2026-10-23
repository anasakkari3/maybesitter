import test from 'node:test';
import assert from 'node:assert/strict';
import type { Commitment } from '../../src/domain/stateMachine';
import { COMMITMENT_BASELINE_FIELD_CLASSIFICATION, commitmentBaselineFingerprint } from '../../lib/intelligence/autoAdds';
import {
  markerDecision,
  singleAgreementSentence,
  transitionReceipt,
  type M5aMarker,
} from '../../lib/intelligence/m5aGmailScan';
import { ownTextOf } from '../../lib/intelligence/ownText';
import { loadAutoAddSnapshot } from '../../lib/intelligence/autoAddSnapshot';
import { analyzeArbitratedGmailMessage } from '../../lib/intelligence/gmailArbitration';
import { listAutoAdds } from '../../lib/intelligence/autoAdds';
import { createMemoryStorage, BUSY_SOURCE_FENCES, CALENDAR_SOURCES, INTELLIGENCE_SOURCE_MARKERS, PLANNING_STATE_CHANGES,
  PROVIDER_CONNECTIONS, docIdForKey, userCol, userSubDoc,
  type ListOptions, type StorageAdapter, type StorageTransaction } from '../../lib/storage';
import type { GoogleRuntime } from '../../lib/integrations/google/googleRuntime';
import { coalescePauseIntervals, saveMonitoringSettings } from '../../lib/watchers/monitoringSettings';
import { sweepWindowFor } from '../../lib/intelligence/gmailMonitor';
import { callsToday, finalizeQuotaPermit, reserveQuotaPermit, settleQuotaPermitSlot, startQuotaPermitSlot } from '../../lib/llm/usageGuard';
import { cleanupCalendarWaits, distinctAccountUids, GMAIL_JOB_LIMITS } from '../../lib/intelligence/gmailJobs';
import { runCalendarMaintenanceStep } from '../../lib/intelligence/gmailCalendarJit';
import { GOOGLE_BUSY_SOURCE_ID, type GoogleBusyTarget } from '../../lib/integrations/google/googleCalendarBusy';
import { GOOGLE_FEATURE_SCOPES } from '../../lib/integrations/google/googleConfig';
import { connectionIdFor } from '../../lib/integrations/providers/production/storedConnectionStore';

const NOW = '2026-10-19T10:00:00.000Z';

test('ownTextOf recognises reply headers and fails closed on ambiguous quotes', () => {
  assert.deepEqual(ownTextOf('Sure, I will send it tomorrow.\n\nOn Sun, Maya wrote:\nOld text'), {
    own: 'Sure, I will send it tomorrow.', boundary: 'quote_header',
  });
  assert.deepEqual(ownTextOf('أكيد، ببعتها بكرا.\n\nفي الأحد كتب سامر:\nالنص القديم'), {
    own: 'أكيد، ببعتها بكرا.', boundary: 'quote_header',
  });
  assert.deepEqual(ownTextOf('כן, אשלח מחר.\n\nבתאריך יום א נכתב:\nטקסט ישן'), {
    own: 'כן, אשלח מחר.', boundary: 'quote_header',
  });
  assert.deepEqual(ownTextOf('Sure.\n> quoted without a recognised header'), {
    own: '', boundary: 'unknown',
  });
});

test('singleAgreementSentence rejects a second action and a second date anchor', () => {
  assert.equal(singleAgreementSentence('I will send it tomorrow at 10.'), true);
  assert.equal(singleAgreementSentence('I will send it tomorrow and also call you.'), false);
  assert.equal(singleAgreementSentence('I will send it tomorrow or Friday.'), false);
});

test('markerDecision implements takeover and rollback-reader guards', () => {
  const live: M5aMarker = { v: 2, state: 'claimed', owner: 'a', leaseUntil: '2026-10-19T11:00:00.000Z', providerAccountId: 'acct-a' };
  const expired: M5aMarker = { ...live, leaseUntil: '2026-10-19T09:00:00.000Z' };
  assert.equal(markerDecision(null, 'm5a', NOW), 'claim');
  assert.equal(markerDecision({ processedAt: NOW }, 'm5a', NOW), 'claim');
  assert.equal(markerDecision({ processedAt: NOW }, 'base', NOW, 'acct-a'), 'skip');
  assert.equal(markerDecision(live, 'm5a', NOW), 'block');
  assert.equal(markerDecision(live, 'base', NOW, 'acct-a'), 'block');
  assert.equal(markerDecision(expired, 'm5a', NOW), 'takeover');
  assert.equal(markerDecision(expired, 'base', NOW, 'acct-a'), 'takeover');
  assert.equal(markerDecision(expired, 'base', NOW, 'acct-b'), 'skip');
  assert.equal(markerDecision({ v: 2, state: 'released' }, 'base', NOW, 'acct-a'), 'process');
  assert.equal(markerDecision({ v: 2, state: 'waiting_for_calendar' }, 'cleanup', NOW), 'release');
  assert.equal(markerDecision({ v: 2, state: 'done' }, 'm5a', NOW), 'count');
});

test('transitionReceipt counts once and moves unavailable to read exactly once', () => {
  const marker: M5aMarker = { v: 2, state: 'unavailable' };
  const unavailable = transitionReceipt(marker, 'scan-a', 'unavailable');
  assert.deepEqual([unavailable.readDelta, unavailable.unavailableDelta], [0, 1]);
  const repeat = transitionReceipt(unavailable.marker, 'scan-a', 'unavailable');
  assert.deepEqual([repeat.readDelta, repeat.unavailableDelta], [0, 0]);
  const restored = transitionReceipt(repeat.marker, 'scan-a', 'read');
  assert.deepEqual([restored.readDelta, restored.unavailableDelta], [1, -1]);
  const readAgain = transitionReceipt(restored.marker, 'scan-a', 'read');
  assert.deepEqual([readAgain.readDelta, readAgain.unavailableDelta], [0, 0]);
});

function commitment(overrides: Partial<Commitment> = {}): Commitment {
  return {
    id: 'c1', kind: 'task', title: 'Send the form', description: null, person: null, status: 'active',
    priority: { level: 'normal', source: 'inferred', pressureAllowed: false, pressureLevel: 'none' },
    category: null, categorySource: 'inferred',
    timeSpec: { kind: 'due_by', dueAt: '2026-10-20T08:00:00.000Z', endAt: null, remindAt: null, allDay: false, timezone: 'Asia/Jerusalem' },
    currentAckState: 'not_seen', postponedUntil: null, createdAt: NOW, updatedAt: NOW,
    confirmedAt: NOW, completedAt: null, droppedAt: null,
    ...overrides,
  };
}

test('baseline fingerprint includes person edits and normalizes system acknowledgements', () => {
  const fingerprint = commitmentBaselineFingerprint(commitment());
  assert.equal(commitmentBaselineFingerprint(commitment({ currentAckState: 'seen' })), fingerprint);
  assert.equal(commitmentBaselineFingerprint(commitment({ currentAckState: 'ignored' })), fingerprint);
  assert.notEqual(commitmentBaselineFingerprint(commitment({ title: 'Send the signed form' })), fingerprint);
  assert.notEqual(commitmentBaselineFingerprint(commitment({
    locationTrigger: { kind: 'arrive', placeId: 'home', label: 'Home' },
  })), fingerprint);
  assert.notEqual(commitmentBaselineFingerprint(commitment({ currentAckState: 'aware' })), fingerprint);
});

test('baseline classification exhaustively names the commitment contract fields', () => {
  assert.deepEqual(Object.keys(COMMITMENT_BASELINE_FIELD_CLASSIFICATION).sort(), [
    'addedFrom', 'category', 'categorySource', 'completedAt', 'confirmedAt', 'createdAt',
    'currentAckState', 'description', 'droppedAt', 'id', 'kind', 'locationTrigger',
    'person', 'postponedUntil', 'priority', 'status', 'timeSpec', 'title', 'updatedAt',
  ]);
});

test('receipt transition prunes receipts that are not current manual or daily scans', () => {
  const marker: M5aMarker = { v: 2, state: 'done', receipts: { old: 'read', manual: 'read', daily: 'unavailable' } };
  const result = transitionReceipt(marker, 'manual', 'read', ['manual', 'daily']);
  assert.deepEqual(result.marker.receipts, { manual: 'read', daily: 'unavailable' });
});

test('auto-add snapshot lists every bounded collection once at its N+1 refusal limit', async () => {
  const calls = new Map<string, ListOptions[]>();
  const tx = {
    get: async () => null,
    list: async (_path: string, options?: ListOptions) => {
      const rows = calls.get(_path) ?? [];
      rows.push(options ?? {});
      calls.set(_path, rows);
      if (_path.endsWith('/calendarSources')) {
        return Array.from({ length: options?.limit ?? 0 }, (_, index) => ({
          id: `source-${index}`,
          data: { sourceId: `source-${index}`, kind: 'manual' },
        }));
      }
      return [];
    },
  } as unknown as StorageTransaction;
  const snapshot = await loadAutoAddSnapshot(tx, 'alice', {
    startsAt: '2026-10-20T08:00:00.000Z', endsAt: '2026-10-20T09:00:00.000Z',
  }, NOW);
  assert.equal(snapshot.boundedAndSettled, false);
  assert.equal(snapshot.schedule.complete, false);
  const expected = new Map([
    ['calendarSources', 61], ['busyBlocks', 1501], ['weeklyBlocks', 101],
    ['commitments', 1001], ['reminders', 1001], ['escalationStates', 1001],
  ]);
  for (const [collection, limit] of Array.from(expected)) {
    const match = Array.from(calls.entries()).find(([path]) => path.endsWith(`/${collection}`));
    assert.ok(match, `${collection} was not read`);
    assert.equal(match[1].length, 1, `${collection} was read more than once`);
    assert.equal(match[1][0]?.limit, limit);
  }
});

test('/added asks storage for the indexed page and batches the commitment join', async () => {
  let options: ListOptions | undefined;
  let getManyCalls = 0;
  const storage = {
    list: async (_path: string, supplied?: ListOptions) => {
      options = supplied;
      return [{ id: 'a'.repeat(64), data: {
        autoAddId: 'a'.repeat(64), providerAccountId: 'acct', commitmentId: 'c1', observationIds: [],
        evidence: 'I will send it tomorrow', baseline: 'different', at: NOW, removedAt: null,
      } }];
    },
    getMany: async () => { getManyCalls++; return [commitment()]; },
  } as unknown as StorageAdapter;
  const page = await listAutoAdds('alice', { limit: 5 }, storage);
  assert.equal(page.items.length, 1);
  assert.deepEqual(options?.where, [['removedAt', '==', null]]);
  assert.deepEqual(options?.orderBy, [{ field: 'at', direction: 'desc' }, { field: 'autoAddId', direction: 'desc' }]);
  assert.equal(options?.limit, 6);
  assert.equal(getManyCalls, 1);
});

test('legacy Gmail arbitration spends one semantic analysis and leaves one observation', async () => {
  const storage = createMemoryStorage();
  await storage.set('users/alice', { trust: null });
  let calls = 0;
  const runtime: GoogleRuntime = {
    storage, env: { MAYBESITTER_ENV: 'staging' } as GoogleRuntime['env'], secrets: null, fetchImpl: fetch,
    now: () => new Date(NOW),
    shareModel: async () => {
      calls++;
      return { text: JSON.stringify({ observations: [{ kind: 'request', evidence: 'Please send the form', confidence: 0.9 }] }),
        model: 'fake', latencyMs: 1, promptTokens: 1, outputTokens: 1 };
    },
  };
  const message = { id: 'mail-1', threadId: null, historyId: '1', receivedAt: NOW, from: null,
    subject: null, text: 'Please send the form' };
  assert.equal((await analyzeArbitratedGmailMessage('alice', 'acct', message, runtime)).kind, 'processed');
  assert.equal((await analyzeArbitratedGmailMessage('alice', 'acct', message, runtime)).kind, 'skipped');
  assert.equal(calls, 1);
  assert.equal((await storage.list('users/alice/intelligenceObservations')).length, 1);
});

test('B3 pause transitions coalesce intervals and preserve every paused instant under the 32-row cap', async () => {
  const intervals = Array.from({ length: 40 }, (_, index) => ({
    from: new Date(Date.parse('2026-10-01T00:00:00.000Z') + index * 10_000).toISOString(),
    to: new Date(Date.parse('2026-10-01T00:00:00.000Z') + index * 10_000 + 1_000).toISOString(),
  }));
  const compacted = coalescePauseIntervals(intervals);
  assert.equal(compacted.length, 32);
  for (const original of intervals) assert.ok(compacted.some(row => row.from <= original.from && row.to >= original.to));
  const storage = createMemoryStorage();
  await storage.set('users/alice/intelligenceMonitors/gmail', { enabled: true, generation: 'g', cursor: '1', pageToken: null,
    m5: { v: 1, providerAccountId: 'acct', enabledAt: NOW, timezone: 'UTC', at: NOW,
      pauseEpoch: 0, pausedSince: null, excluded: [] } });
  await saveMonitoringSettings('alice', true, NOW, { storage });
  await saveMonitoringSettings('alice', true, '2026-10-19T10:00:01.000Z', { storage });
  await saveMonitoringSettings('alice', false, '2026-10-19T10:00:02.000Z', { storage });
  const monitor = await storage.get<any>('users/alice/intelligenceMonitors/gmail');
  assert.equal(monitor.m5.pauseEpoch, 2);
  assert.deepEqual(monitor.m5.excluded, [{ from: NOW, to: '2026-10-19T10:00:02.000Z' }]);
});

test('B3 daily sweep windows use civil midnights across DST and timezone changes', () => {
  const spring = sweepWindowFor('2026-03-08T05:00:00.000Z', 'America/New_York', '2026-03-08');
  const fall = sweepWindowFor('2026-11-01T04:00:00.000Z', 'America/New_York', '2026-11-01');
  assert.equal(Date.parse(spring.until) - Date.parse(spring.from), 23 * 60 * 60_000);
  assert.equal(Date.parse(fall.until) - Date.parse(fall.from), 25 * 60 * 60_000);
  assert.notEqual(sweepWindowFor('2026-10-19T00:00:00.000Z', 'Asia/Jerusalem').dueAt,
    sweepWindowFor('2026-10-19T00:00:00.000Z', 'America/Los_Angeles').dueAt);
});

test('B3 quota permit reserves the whole unit and releases only its never-started slot', async () => {
  const storage = createMemoryStorage();
  const now = new Date(NOW);
  const reserved = await reserveQuotaPermit('alice', 'semantic_observation', { owner: 'unit-1', calls: 2, tokenBudget: 1_000 }, { storage, now });
  assert.equal(reserved.outcome, 'ok');
  const permit = reserved.permit!;
  assert.equal((await callsToday('alice', { storage, now })).user, 2);
  assert.equal(await startQuotaPermitSlot(permit, 0, { storage, now }), true);
  await settleQuotaPermitSlot(permit, 0, { promptTokens: 10, outputTokens: 5 }, { storage, now });
  await finalizeQuotaPermit(permit, { storage, now });
  assert.deepEqual(await callsToday('alice', { storage, now }), { user: 1, global: 1, tokens: 15, minuteCalls: 2 });
  await storage.set('users/bob/usage/2026-10-19', { calls: 0, date: '2026-10-19', updatedAt: NOW,
    inputTokens: 149_500, outputTokens: 0, reservedTokens: 0, minute: NOW.slice(0, 16), minuteCalls: 0 });
  assert.equal((await reserveQuotaPermit('bob', 'semantic_observation', { owner: 'unit-2', calls: 2, tokenBudget: 1_000 }, { storage, now })).outcome, 'user_token_cap');
});

test('B3 lane dispatch selects distinct accounts and pins the stage reserves', () => {
  assert.deepEqual(distinctAccountUids(['a', 'a', 'b', 'c', 'b', 'd'], 3), ['a', 'b', 'c']);
  assert.deepEqual(GMAIL_JOB_LIMITS.lanes, { live: 8, proposals: 2, continuation: 4, sweep: 3, calendar_maintenance: 1 });
  assert.deepEqual(GMAIL_JOB_LIMITS.reservesMs, { listing: 13_000, ordinary: 22_000, qualifyingReply: 34_000, calendarApply: 3_000 });
});

test('B3 wait cleanup releases no more than twenty unauthorised markers per tick', async () => {
  const storage = createMemoryStorage();
  await storage.set('system/m5aControls', { email: { epoch: 4, enabled: false }, calendar: { epoch: 2, enabled: true } });
  for (let index = 0; index < 25; index++) await storage.set(`${userCol(`u${index}`, INTELLIGENCE_SOURCE_MARKERS)}/${String(index).padStart(64, '0')}`, {
    v: 2, state: 'waiting_for_calendar', providerAccountId: 'acct', emailEpoch: 3,
    origin: { kind: 'scan', scanId: 'scan', scanKind: 'manual' }, requestedAt: NOW, nextEligibleAt: NOW,
  });
  assert.equal(await cleanupCalendarWaits(storage, new Date(NOW)), 20);
  assert.equal((await storage.listGroup<any>(INTELLIGENCE_SOURCE_MARKERS, { where: [['state', '==', 'waiting_for_calendar']] })).length, 5);
});

test('B3 calendar maintenance keeps a fenced target on mismatch, then certifies and clears it', async () => {
  const storage = createMemoryStorage();
  const uid = 'jit_user';
  const fencePath = userSubDoc(uid, BUSY_SOURCE_FENCES, docIdForKey(GOOGLE_BUSY_SOURCE_ID));
  const target: GoogleBusyTarget = { v: 1, targetId: 'target-1', providerAccountId: 'google-account', calendarEpoch: 1,
    choiceGeneration: null, calendarControlEpoch: 2, windowStart: NOW, windowEnd: '2026-10-20T10:00:00.000Z', fetchedAt: NOW,
    intervals: [{ start: '2026-10-19T11:00:00.000Z', end: '2026-10-19T12:00:00.000Z' }], digest: 'a'.repeat(64), nextEligibleAt: NOW };
  await storage.set(fencePath, { generation: 7, jitTarget: target });
  await storage.set('system/m5aControls', { email: { epoch: 3, enabled: false }, calendar: { epoch: 2, enabled: true } });
  await storage.set(`users/${uid}`, { trust: { calendarConsent: true }, calendarEpoch: 0 });
  await storage.set(userSubDoc(uid, PROVIDER_CONNECTIONS, connectionIdFor('google')), {
    identity: { provider: 'google', providerAccountId: 'google-account' }, state: 'connected', credentialRef: 'vault',
    capabilities: ['calendar_busy'], grantedScopes: [GOOGLE_FEATURE_SCOPES.calendar],
  });
  const runtime: GoogleRuntime = { storage, env: { MAYBESITTER_ENV: 'staging' } as GoogleRuntime['env'], secrets: null,
    fetchImpl: fetch, now: () => new Date(NOW) };
  assert.equal(await runCalendarMaintenanceStep(uid, runtime), false);
  assert.equal((await storage.get<any>(fencePath))?.jitTarget?.targetId, target.targetId);
  await storage.set(`users/${uid}`, { trust: { calendarConsent: true }, calendarEpoch: 1 });
  assert.equal(await runCalendarMaintenanceStep(uid, { ...runtime, now: () => new Date('2026-10-19T10:01:00.000Z') }), true);
  assert.equal((await storage.get<any>(fencePath))?.jitTarget, undefined);
  assert.equal((await storage.get<any>(userSubDoc(uid, CALENDAR_SOURCES, docIdForKey(GOOGLE_BUSY_SOURCE_ID))))?.m5Certificate?.providerAccountId, 'google-account');
  assert.equal((await storage.list(userCol(uid, PLANNING_STATE_CHANGES))).length, 1,
    'the applied JIT busy interval must announce the calendar change');
});
