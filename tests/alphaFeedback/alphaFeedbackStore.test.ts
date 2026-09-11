/**
 * Tests for the alpha feedback flag contracts and store (UC-1.0c, #142).
 *
 * The store is async and storage-backed now, and the factory that used to be
 * exported as `createFileAlphaFeedbackStore` while actually returning the
 * internal store is gone — so the restart case below can finally mean
 * something: two handles over one backend, which is what two instances are.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VALID_FLAG_CATEGORIES,
  FLAG_NOTE_MAX_LENGTH,
  isValidFlagCategory,
  validateFlagInput,
} from '../../src/contracts/v1/feedbackFlagContracts';
import {
  StorageAlphaFeedbackStore,
  createInMemoryAlphaFeedbackStore,
} from '../../lib/alphaFeedback/alphaFeedbackStore.ts';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';

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

test('feedback flag: record/list/delete lifecycle', async () => {
  const store = createInMemoryAlphaFeedbackStore();
  const flag = await store.record({ participantId: 'p001', sessionId: 's001', proposalId: 'pr001', category: 'invasive', note: 'felt invasive' });
  assert.equal(flag.participantId, 'p001');
  assert.equal(flag.sessionId, 's001');
  assert.equal(flag.category, 'invasive');
  assert.equal(flag.note, 'felt invasive');
  assert.equal(flag.version, 'alpha-v1');
  assert.ok(flag.flagId.length > 0);

  assert.equal(await store.count({ participantId: 'p001' }), 1);
  assert.equal((await store.list({ sessionId: 's001' })).length, 1);
  assert.equal((await store.list({ sessionId: 'other' })).length, 0);

  // Record a second flag in a different session.
  await store.record({ participantId: 'p001', sessionId: 's002', proposalId: 'pr002', category: 'not_useful' });
  assert.equal((await store.list({ participantId: 'p001' })).length, 2);

  // Delete by session.
  assert.equal(await store.deleteBySession('s001'), 1);
  assert.equal((await store.list({ participantId: 'p001' })).length, 1);

  // Delete by participant.
  assert.equal(await store.deleteByParticipant('p001'), 1);
  assert.equal((await store.list()).length, 0);
});

test('feedback flag: note is truncated to max length', async () => {
  const store = createInMemoryAlphaFeedbackStore();
  const longNote = 'x'.repeat(FLAG_NOTE_MAX_LENGTH + 100);
  const flag = await store.record({ participantId: 'p002', sessionId: 's003', proposalId: 'pr003', category: 'technical_problem', note: longNote });
  assert.equal(flag.note?.length, FLAG_NOTE_MAX_LENGTH);
});

test('feedback flag: list with since filter', async () => {
  const store = createInMemoryAlphaFeedbackStore();
  await store.record({ participantId: 'p003', sessionId: 's004', proposalId: 'pr004', category: 'recommendation_wrong' });
  assert.equal((await store.list()).length, 1);
  assert.equal((await store.list({ since: '2099-01-01T00:00:00.000Z' })).length, 0);
});

test('feedback flag: a flag written through one handle is read through a fresh one', async () => {
  // The simulated restart, and what two Cloud Run instances actually are.
  const shared = createMemoryStorage();
  const writer = new StorageAlphaFeedbackStore({ storage: shared });
  const reader = new StorageAlphaFeedbackStore({ storage: shared });

  const flag = await writer.record({ participantId: 'p004', sessionId: 's005', proposalId: 'pr005', category: 'invasive' });

  const seen = await reader.list({ participantId: 'p004' });
  assert.equal(seen.length, 1, 'the flag did not survive the handle: nothing durable was written');
  assert.equal(seen[0].flagId, flag.flagId);
});

test('feedback flag: one participant flags never appear under another', async () => {
  const store = createInMemoryAlphaFeedbackStore();
  await store.record({ participantId: 'p_a', sessionId: 's_a', proposalId: 'pr_a', category: 'invasive' });
  await store.record({ participantId: 'p_b', sessionId: 's_b', proposalId: 'pr_b', category: 'invasive' });

  assert.equal((await store.list({ participantId: 'p_a' })).length, 1);
  assert.equal(await store.deleteByParticipant('p_a'), 1);
  assert.equal((await store.list({ participantId: 'p_b' })).length, 1, 'deleting one participant removed another');
});
