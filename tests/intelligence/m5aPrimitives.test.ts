import test from 'node:test';
import assert from 'node:assert/strict';
import type { Commitment } from '../../src/domain/stateMachine';
import { commitmentBaselineFingerprint } from '../../lib/intelligence/autoAdds';
import {
  markerDecision,
  singleAgreementSentence,
  transitionReceipt,
  type M5aMarker,
} from '../../lib/intelligence/m5aGmailScan';
import { ownTextOf } from '../../lib/intelligence/ownText';

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
