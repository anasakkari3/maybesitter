/**
 * Restart durability for the two migrated stores that had no such test yet
 * (UC-1.0c #142).
 *
 * The acceptance criterion: for each migrated store, a test writes through
 * adapter handle A and reads through a fresh handle B on the same backend.
 * Most migrated stores prove this beside their own tests; the clarification
 * and study-response stores did not. A fresh store instance over the same
 * adapter is exactly what a restarted process is — nothing held in memory
 * survives, only what reached storage.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { StorageClarificationStore } from '../../lib/services/clarificationStore.ts';
import { createStorageShadowStudyResponseStore } from '../../lib/release/studyStore.ts';
import { extract } from '../../src/extraction/ruleBasedExtractor.ts';
import { SHADOW_STUDY_QUESTIONS } from '../../src/contracts/v1/shadowPipelineContracts.ts';

const NOW = new Date('2027-01-10T09:00:00.000Z');
const ONE_MINUTE_LATER = new Date(NOW.getTime() + 60_000);

test('clarifications: a question asked before a restart is answerable after it, exactly once', async () => {
  const storage = createMemoryStorage();
  const text = 'remind me to call the doctor';

  const before = new StorageClarificationStore(storage);
  const created = await before.create({
    scopeId: 'scope-restart',
    originalInput: text,
    // A real extraction, not a cast: the store keeps it as given, and a
    // made-up shape would prove round-tripping of something production never writes.
    partialExtraction: extract(text, { now: NOW }),
    now: NOW,
    ttlMs: 10 * 60 * 1000,
  });

  const after = new StorageClarificationStore(storage);
  assert.deepEqual(await after.getAndClear('scope-restart', created.id, ONE_MINUTE_LATER), created);

  // Clearing is durable too: another process cannot answer the same question again.
  const third = new StorageClarificationStore(storage);
  assert.equal(await third.getAndClear('scope-restart', created.id, ONE_MINUTE_LATER), null);
});

test('study responses: an answer recorded before a restart is listed and counted after it', async () => {
  const storage = createMemoryStorage();
  const question = SHADOW_STUDY_QUESTIONS[0]!;

  const before = createStorageShadowStudyResponseStore(storage);
  const recorded = await before.record({
    status: 'rated',
    participantId: 'participant-restart',
    runId: 'run-0001',
    question,
    rating: 4,
    respondedAt: NOW.toISOString(),
  });
  assert.equal(recorded.status, 'recorded');

  const after = createStorageShadowStudyResponseStore(storage);
  const listed = await after.list('participant-restart');
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.question, question);
  assert.equal(listed[0]!.rating, 4);
  assert.equal(await after.countFor('participant-restart'), 1);
});
