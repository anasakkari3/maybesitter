import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyCommitmentStatus,
  decideConfirmationLevel,
  evaluateNotificationEligibility,
} from '../../src/domain/memory/memoryPolicy.ts';
import type { MemoryCandidate, CommitmentMemory } from '../../src/domain/memory/memoryTypes.ts';

function makeCandidate(overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    candidateType: 'commitment',
    normalizedText: 'test commitment',
    modality: 'certain',
    confidence: 0.90,
    evidenceSpan: { start: 0, end: 15, text: 'test commitment' },
    ...overrides,
  };
}

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
    notificationEligible: false,
    ...overrides,
  };
}

test('policy: "possible" modality → mentioned', () => {
  const result = classifyCommitmentStatus(makeCandidate({ modality: 'possible' }));
  assert.equal(result, 'mentioned');
});

test('policy: "conditional" modality → mentioned', () => {
  const result = classifyCommitmentStatus(makeCandidate({ modality: 'conditional' }));
  assert.equal(result, 'mentioned');
});

test('policy: "intended" modality → proposed', () => {
  const result = classifyCommitmentStatus(makeCandidate({ modality: 'intended' }));
  assert.equal(result, 'proposed');
});

test('policy: "certain" modality with time → scheduled', () => {
  const result = classifyCommitmentStatus(makeCandidate({
    modality: 'certain',
    temporal: { rawText: 'Thursday', resolvedAt: '2026-08-06T00:00:00.000Z', precision: 'day' },
  }));
  assert.equal(result, 'scheduled');
});

test('policy: "certain" modality without time → confirmed', () => {
  const result = classifyCommitmentStatus(makeCandidate({ modality: 'certain' }));
  assert.equal(result, 'confirmed');
});

test('policy: "negated" modality → null', () => {
  const result = classifyCommitmentStatus(makeCandidate({ modality: 'negated' }));
  assert.equal(result, null);
});

test('policy: "reported" modality → mentioned', () => {
  const result = classifyCommitmentStatus(makeCandidate({ modality: 'reported' }));
  assert.equal(result, 'mentioned');
});

test('policy: non-commitment candidate → null', () => {
  const result = classifyCommitmentStatus(makeCandidate({ candidateType: 'fact' }));
  assert.equal(result, null);
});

test('policy: high confidence certain → auto_accept', () => {
  const level = decideConfirmationLevel(makeCandidate({ modality: 'certain', confidence: 0.95 }));
  assert.equal(level, 'auto_accept');
});

test('policy: intended → soft_confirmation', () => {
  const level = decideConfirmationLevel(makeCandidate({ modality: 'intended', confidence: 0.80 }));
  assert.equal(level, 'soft_confirmation');
});

test('policy: possible → hard_confirmation', () => {
  const level = decideConfirmationLevel(makeCandidate({ modality: 'possible', confidence: 0.55 }));
  assert.equal(level, 'hard_confirmation');
});

test('notification: confirmed + time + high confidence → eligible', () => {
  const decision = evaluateNotificationEligibility(makeCommitment());
  assert.ok(decision.eligible);
  assert.deepEqual(decision.reasonCodes, ['ELIGIBLE']);
});

test('notification: mentioned status → not eligible', () => {
  const decision = evaluateNotificationEligibility(makeCommitment({ status: 'mentioned' }));
  assert.ok(!decision.eligible);
  assert.ok(decision.reasonCodes.includes('STATUS_NOT_CONFIRMED'));
});

test('notification: no time → not eligible', () => {
  const decision = evaluateNotificationEligibility(makeCommitment({ dueAt: undefined }));
  assert.ok(!decision.eligible);
  assert.ok(decision.reasonCodes.includes('MISSING_TIME'));
});

test('notification: low confidence → not eligible', () => {
  const decision = evaluateNotificationEligibility(makeCommitment({ confidence: 0.60 }));
  assert.ok(!decision.eligible);
  assert.ok(decision.reasonCodes.includes('LOW_CONFIDENCE'));
});

test('notification: requires confirmation → not eligible', () => {
  const decision = evaluateNotificationEligibility(makeCommitment({ requiresConfirmation: true }));
  assert.ok(!decision.eligible);
  assert.ok(decision.reasonCodes.includes('USER_CONFIRMATION_REQUIRED'));
});

test('notification: proposed status → not eligible', () => {
  const decision = evaluateNotificationEligibility(makeCommitment({ status: 'proposed' }));
  assert.ok(!decision.eligible);
});

test('notification: scheduled + time + high confidence → eligible', () => {
  const decision = evaluateNotificationEligibility(makeCommitment({ status: 'scheduled' }));
  assert.ok(decision.eligible);
});
