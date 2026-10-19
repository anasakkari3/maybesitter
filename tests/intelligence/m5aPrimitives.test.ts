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
import { createMemoryStorage, type ListOptions, type StorageAdapter, type StorageTransaction } from '../../lib/storage';
import type { GoogleRuntime } from '../../lib/integrations/google/googleRuntime';

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
