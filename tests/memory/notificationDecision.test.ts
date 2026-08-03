import test from 'node:test';
import assert from 'node:assert/strict';
import { decideNotificationAction } from '../../src/services/notificationDecisionService.ts';
import type { CommitmentMemory } from '../../src/domain/memory/memoryTypes.ts';

function makeCommitment(overrides: Partial<CommitmentMemory> = {}): CommitmentMemory {
  return {
    id: 'cmem_1',
    userId: 'user_1',
    title: 'Test',
    status: 'confirmed',
    dueAt: '2026-08-10T10:00:00.000Z',
    timePrecision: 'exact_time',
    participants: [],
    confidence: 0.90,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    evidenceIds: ['obs_1'],
    requiresConfirmation: false,
    notificationEligible: true,
    ...overrides,
  };
}

test('notification: new eligible commitment → schedule', () => {
  const action = decideNotificationAction(makeCommitment(), null);
  assert.equal(action.type, 'schedule');
  assert.equal(action.scheduledAt, '2026-08-10T10:00:00.000Z');
});

test('notification: new ineligible commitment → none', () => {
  const action = decideNotificationAction(makeCommitment({ status: 'mentioned' }), null);
  assert.equal(action.type, 'none');
});

test('notification: was eligible, now cancelled → cancel', () => {
  const prev = makeCommitment();
  const current = makeCommitment({ status: 'cancelled' });
  const action = decideNotificationAction(current, prev);
  assert.equal(action.type, 'cancel');
});

test('notification: was ineligible, now confirmed with time → schedule', () => {
  const prev = makeCommitment({ status: 'mentioned' });
  const current = makeCommitment({ status: 'confirmed' });
  const action = decideNotificationAction(current, prev);
  assert.equal(action.type, 'schedule');
});

test('notification: date changed while eligible → reschedule', () => {
  const prev = makeCommitment({ dueAt: '2026-08-10T10:00:00.000Z' });
  const current = makeCommitment({ dueAt: '2026-08-11T15:00:00.000Z' });
  const action = decideNotificationAction(current, prev);
  assert.equal(action.type, 'reschedule');
  assert.equal(action.scheduledAt, '2026-08-11T15:00:00.000Z');
});

test('notification: low confidence → not eligible even with confirmed status', () => {
  const action = decideNotificationAction(makeCommitment({ confidence: 0.60 }), null);
  assert.equal(action.type, 'none');
  assert.ok(action.decision.reasonCodes.includes('LOW_CONFIDENCE'));
});

test('notification: requires confirmation → not eligible', () => {
  const action = decideNotificationAction(makeCommitment({ requiresConfirmation: true }), null);
  assert.equal(action.type, 'none');
  assert.ok(action.decision.reasonCodes.includes('USER_CONFIRMATION_REQUIRED'));
});
