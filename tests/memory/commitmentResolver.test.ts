import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCommitment, scoreMatch } from '../../src/domain/memory/commitmentResolver.ts';
import type { MemoryCandidate, CommitmentMemory } from '../../src/domain/memory/memoryTypes.ts';

function makeCandidate(overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    candidateType: 'commitment',
    normalizedText: 'زيارة خالي',
    modality: 'certain',
    confidence: 0.90,
    evidenceSpan: { start: 0, end: 10, text: 'زيارة خالي' },
    ...overrides,
  };
}

function makeCommitment(overrides: Partial<CommitmentMemory> = {}): CommitmentMemory {
  return {
    id: 'cmem_1',
    userId: 'user_1',
    title: 'زيارة خالي',
    status: 'mentioned',
    timePrecision: 'day',
    participants: ['خالي'],
    confidence: 0.55,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    evidenceIds: ['obs_1'],
    requiresConfirmation: false,
    notificationEligible: false,
    ...overrides,
  };
}

test('resolver: identical text → high score, auto-link', () => {
  const candidate = makeCandidate({ normalizedText: 'زيارة خالي' });
  const commitment = makeCommitment({ title: 'زيارة خالي' });
  const decision = resolveCommitment(candidate, [commitment]);
  assert.equal(decision.action, 'link');
});

test('resolver: no open commitments → create new', () => {
  const candidate = makeCandidate();
  const decision = resolveCommitment(candidate, []);
  assert.equal(decision.action, 'create_new');
});

test('resolver: very different text → create new', () => {
  const candidate = makeCandidate({ normalizedText: 'اتصال بالدكتور' });
  const commitment = makeCommitment({ title: 'زيارة خالي' });
  const decision = resolveCommitment(candidate, [commitment]);
  assert.equal(decision.action, 'create_new');
});

test('resolver: score includes match reasons', () => {
  const candidate = makeCandidate();
  const commitment = makeCommitment();
  const score = scoreMatch(candidate, commitment);
  assert.ok(score.totalScore >= 0);
  assert.ok(Array.isArray(score.matchReasons));
});

test('resolver: participant overlap increases score', () => {
  const candidate = makeCandidate({ normalizedText: 'زيارة' });
  const withParticipant = makeCommitment({ title: 'زيارة', participants: ['خالي'] });
  const withoutParticipant = makeCommitment({ title: 'زيارة', participants: [], id: 'cmem_2' });

  const scoreWith = scoreMatch(candidate, withParticipant, ['خالي']);
  const scoreWithout = scoreMatch(candidate, withoutParticipant);
  assert.ok(scoreWith.totalScore > scoreWithout.totalScore);
});
