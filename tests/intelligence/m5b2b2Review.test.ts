import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { INTELLIGENCE_OBSERVATIONS, userCol, userDoc } from '../../lib/storage/index.ts';
import { observationId, putReaddMarkerInTransaction } from '../../lib/intelligence/observationStore.ts';

// Claude's review of the M5b-2b-2 server build: the marker writer is a new
// writer, so it re-reads the account deletion fence in its own transaction
// (the rule M5b-2b-1 applied to every writer it added; #778 holds the rest).
const UID = 'readd-review-user';
const AT = '2030-03-29T08:00:00.000Z';
const OUTCOME = observationId('behavior', 'event-1', { kind: 'outcome', evidence: 'Dropped: Call mom', confidence: 0.8 });

async function seeded(user: Record<string, unknown> | null) {
  const storage = createMemoryStorage();
  if (user) await storage.set(userDoc(UID), user);
  await storage.set(`${userCol(UID, INTELLIGENCE_OBSERVATIONS)}/${OUTCOME}`, {
    id: OUTCOME, kind: 'outcome', evidence: 'Dropped: Call mom', confidence: 0.8,
    source: 'behavior', sourceRef: 'event-1', observedAt: '2030-03-20T08:00:00.000Z',
    review: 'confirmed', reviewedAt: '2030-03-20T08:00:00.000Z', linkedMemoryId: null,
  });
  return storage;
}

const markerPath = () => `${userCol(UID, INTELLIGENCE_OBSERVATIONS)}/${observationId('behavior', 'readd:c-2', { kind: 'outcome', evidence: 'Re-added', confidence: 0.6 })}`;

test('M5B2B2-CR-001 a live account gets its marker (control)', async () => {
  const storage = await seeded({ personalizationPurge: { state: 'active', epoch: 0 } });
  const marker = await putReaddMarkerInTransaction(UID, 'c-2', AT, OUTCOME, 0, storage);
  assert.ok(marker, 'control: the marker was not written for a live account');
  assert.ok(await storage.get(markerPath()));
});

for (const [name, user] of [
  ['after markDeleted', { personalizationPurge: { state: 'active', epoch: 0 }, trust: { deletedAt: AT } }],
  ['after the user document is gone', null],
] as const) {
  test(`M5B2B2-CR-001 the re-add marker transaction writes nothing ${name}`, async () => {
    const storage = await seeded(user as Record<string, unknown> | null);
    const marker = await putReaddMarkerInTransaction(UID, 'c-2', AT, OUTCOME, 0, storage);
    assert.equal(marker, null);
    assert.equal(await storage.get(markerPath()), null, 'a marker was written behind an account deletion');
  });
}

// M5B2B2-MERGE-001 (Codex inspection r2): for a pending question the account
// fence is read first and is authoritative, before the re-add guard reads the
// marker's bound outcome, event and commitments. A marker whose bound-outcome
// read would itself fail proves the order: account first answers the typed
// unavailable result; re-add first would surface a generic failure.
import { answerIntelligenceQuestion } from '../../lib/intelligence/answerQuestion.ts';
import { SuggestionUnavailableError } from '../../lib/intelligence/memoryBasis.ts';
import { suggestionPath } from '../../lib/intelligence/proposalEngine.ts';

const QUESTION = 'a'.repeat(64);
async function questionCitingMarker(user: Record<string, unknown> | null) {
  const storage = await seeded(user);
  const marker = observationId('behavior', 'readd:c-9', { kind: 'outcome', evidence: 'Re-added', confidence: 0.6 });
  await storage.set(`${userCol(UID, INTELLIGENCE_OBSERVATIONS)}/${marker}`, {
    id: marker, kind: 'outcome', evidence: 'Re-added', confidence: 0.6, source: 'behavior',
    sourceRef: 'readd:c-9', observedAt: AT, review: 'pending', reviewedAt: null, linkedMemoryId: null,
    matchedOutcomeId: 'not a valid id/..',
  });
  const question = {
    id: QUESTION, kind: 'question', title: 'Still want it?', reason: 'r', observationIds: [marker],
    confidence: 0.6, durationMinutes: null, status: 'pending', decidedAt: null, linkedEntityId: null, generatedAt: AT,
  };
  await storage.set(suggestionPath(UID, QUESTION), question);
  return { storage, question };
}

for (const [name, user] of [
  ['after markDeleted', { personalizationPurge: { state: 'active', epoch: 0 }, trust: { deletedAt: AT } }],
  ['after the user document is gone', null],
] as const) {
  test(`M5B2B2-MERGE-001 a re-add-backed question ${name} answers the typed account result first and writes nothing`, async (t) => {
    // The re-add guard reads only while the module is on.
    const saved = process.env.MAYBESITTER_FEATURE_MEMORY_LEARNING;
    process.env.MAYBESITTER_FEATURE_MEMORY_LEARNING = 'true';
    t.after(() => {
      if (saved === undefined) delete process.env.MAYBESITTER_FEATURE_MEMORY_LEARNING;
      else process.env.MAYBESITTER_FEATURE_MEMORY_LEARNING = saved;
    });
    const { storage, question } = await questionCitingMarker(user as Record<string, unknown> | null);
    await assert.rejects(
      answerIntelligenceQuestion(UID, QUESTION, 'yes, still', AT, storage, true),
      SuggestionUnavailableError,
    );
    assert.deepEqual(await storage.get(suggestionPath(UID, QUESTION)), question);
  });
}
