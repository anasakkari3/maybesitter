/**
 * Tests for the alpha feedback flag contracts, store, and review CLI.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VALID_FLAG_CATEGORIES,
  FLAG_NOTE_MAX_LENGTH,
  isValidFlagCategory,
  validateFlagInput,
  type AlphaFeedbackFlagCategory,
} from '../../src/contracts/v1/feedbackFlagContracts';
import { createInMemoryAlphaFeedbackStore } from '../../lib/alphaFeedback/alphaFeedbackStore';

test('feedback flag: valid categories are recognized', () => {
  for (const cat of VALID_FLAG_CATEGORIES) {
    assert.ok(isValidFlagCategory(cat), `expected ${cat} to be valid`);
  }
  assert.ok(!isValidFlagCategory('unknown'));
  assert.ok(!isValidFlagCategory(''));
});

test('feedback flag: validateFlagInput accepts valid input', () => {
  validateFlagInput({
    participantId: 'p001',
    sessionId: 's001',
    proposalId: 'pr001',
    category: 'recommendation_wrong',
  });
  // no throw = pass
});

test('feedback flag: validateFlagInput rejects invalid inputs', () => {
  assert.throws(() => validateFlagInput(null), /must be an object/);
  assert.throws(() => validateFlagInput({}), /participantId is required/);
  assert.throws(() => validateFlagInput({ participantId: 'p001', proposalId: 'pr001', category: 'bad' }), /category must be one of/);
  assert.throws(() => validateFlagInput({ participantId: 'p001', sessionId: 42, proposalId: 'pr001', category: 'invasive' }), /sessionId must be a string/);
});

test('feedback flag: in-memory store record/list/delete lifecycle', () => {
  const store = createInMemoryAlphaFeedbackStore();
  const flag = store.record({ participantId: 'p001', sessionId: 's001', proposalId: 'pr001', category: 'invasive', note: 'felt invasive' });
  assert.equal(flag.participantId, 'p001');
  assert.equal(flag.sessionId, 's001');
  assert.equal(flag.category, 'invasive');
  assert.equal(flag.note, 'felt invasive');
  assert.equal(flag.version, 'alpha-v1');
  assert.ok(flag.flagId.length > 0);

  assert.equal(store.count({ participantId: 'p001' }), 1);
  assert.equal(store.list({ sessionId: 's001' }).length, 1);
  assert.equal(store.list({ sessionId: 'other' }).length, 0);

  // Record a second flag in a different session.
  store.record({ participantId: 'p001', sessionId: 's002', proposalId: 'pr002', category: 'not_useful' });
  assert.equal(store.list({ participantId: 'p001' }).length, 2);

  // Delete by session.
  const deleted = store.deleteBySession('s001');
  assert.equal(deleted, 1);
  assert.equal(store.list({ participantId: 'p001' }).length, 1);

  // Delete by participant.
  const deleted2 = store.deleteByParticipant('p001');
  assert.equal(deleted2, 1);
  assert.equal(store.list().length, 0);
});

test('feedback flag: note is truncated to max length', () => {
  const store = createInMemoryAlphaFeedbackStore();
  const longNote = 'x'.repeat(FLAG_NOTE_MAX_LENGTH + 100);
  const flag = store.record({ participantId: 'p002', sessionId: 's003', proposalId: 'pr003', category: 'technical_problem', note: longNote });
  assert.equal(flag.note?.length, FLAG_NOTE_MAX_LENGTH);
});

test('feedback flag: list with since filter', () => {
  const store = createInMemoryAlphaFeedbackStore();
  store.record({ participantId: 'p003', sessionId: 's004', proposalId: 'pr004', category: 'recommendation_wrong' });
  const all = store.list();
  assert.equal(all.length, 1);
  const filtered = store.list({ since: '2099-01-01T00:00:00.000Z' });
  assert.equal(filtered.length, 0);
});
