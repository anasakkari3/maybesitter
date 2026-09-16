/**
 * #202's growth half against real Firestore (UC-3.16).
 *
 * The in-memory adapter proves the semantics. These prove the parts that differ
 * in production: the event read is a Firestore range query on `at`; a kept
 * suggestion is resolved later by a collection-group query on `id`; and
 * "deleted" has to mean a document read back from Firestore is gone, not that a
 * map entry was removed.
 *
 * Ids are unique per run: the emulator's collections are shared with every
 * other emulator test in the same `emulators:exec`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreStorage } from '../../lib/storage/firestoreAdapter.ts';
import { EVENTS, MEMORY, MEMORY_DISMISSALS, userCol, userDoc, userSubDoc } from '../../lib/storage/paths.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import { createStorageRuntimeMemoryStore } from '../../lib/runtimeMemory/runtimeMemoryStore.ts';
import { createStoragePersonalizationConsentStore } from '../../lib/personalizationControls/consentStore.ts';
import { createStorageFeedbackEventStore } from '../../lib/feedback/feedbackEventStore.ts';
import {
  decideMemorySuggestion,
  keptFocusWindow,
  listMemorySuggestions,
} from '../../lib/memoryGrowth/suggestionService.ts';
import { deleteAllMemory, deleteMemory } from '../../lib/services/mobile/memoryService.ts';

const NOW = '2026-09-16T18:00:00.000Z';

function uniqueUid(label: string): string {
  return `mg_${label}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Jerusalem is UTC+3 in September: 06:15Z is 09:15 local. */
async function seedHabit(storage: StorageAdapter, uid: string): Promise<void> {
  await storage.set(userDoc(uid), { uid, timezone: 'Asia/Jerusalem' });
  const utc: Array<[string, string]> = [
    ['2026-09-15', '06:15'], ['2026-09-14', '06:40'], ['2026-09-13', '07:00'], ['2026-09-11', '07:30'],
    ['2026-09-10', '08:00'], ['2026-09-08', '08:20'], ['2026-09-07', '08:45'],
    ['2026-09-12', '16:05'], ['2026-09-09', '17:05'], ['2026-09-06', '18:05'],
  ];
  for (let index = 0; index < utc.length; index += 1) {
    const [day, time] = utc[index]!;
    const id = `ev_${index}`;
    await storage.set(userSubDoc(uid, EVENTS, id), {
      id, type: 'commitment_completed', at: `${day}T${time}:00.000Z`, aggregateId: `c_${index}`, payload: {},
    });
  }
  // Outside the 28 days, and after now: neither may count.
  await storage.set(userSubDoc(uid, EVENTS, 'ev_old'), {
    id: 'ev_old', type: 'commitment_completed', at: '2026-08-01T15:00:00.000Z', aggregateId: 'c_old', payload: {},
  });
  await storage.set(userSubDoc(uid, EVENTS, 'ev_future'), {
    id: 'ev_future', type: 'commitment_completed', at: '2026-09-17T15:00:00.000Z', aggregateId: 'c_future', payload: {},
  });
  await createStoragePersonalizationConsentStore(storage).write(uid, 'enabled', '2026-09-01T00:00:00.000Z');
}

function options(storage: StorageAdapter) {
  return { storage, memory: createStorageRuntimeMemoryStore(undefined, storage) };
}

test('firestore: a suggestion is read from the event log, kept, used by the planner and deleted for real', async () => {
  const storage = createFirestoreStorage();
  const uid = uniqueUid('keep');
  try {
    await seedHabit(storage, uid);
    const [suggestion] = await listMemorySuggestions(uid, NOW, options(storage));
    assert.ok(suggestion);
    assert.equal(suggestion.fingerprint, 'R1_focus_window:09:00-12:00');
    assert.deepEqual(suggestion.evidence, { matchingCount: 7, totalCount: 10, lookbackDays: 28 });
    assert.equal((await storage.list(userCol(uid, MEMORY))).length, 0, 'a read wrote a memory');

    const kept = await decideMemorySuggestion(uid, 'R1_focus_window', {
      decision: 'keep', fingerprint: suggestion.fingerprint, language: 'he',
    }, NOW, options(storage));
    assert.equal(kept.decision, 'keep');
    const id = kept.decision === 'keep' ? kept.memory.id : '';

    // Resolved by the collection-group query production uses.
    const stored = await createStorageRuntimeMemoryStore(undefined, storage).get(id);
    assert.equal(stored?.source, 'deterministic_rule');
    assert.equal(stored?.language, 'he');
    assert.equal(stored?.evidenceIds.length, 7);
    assert.deepEqual(await keptFocusWindow(uid, NOW, options(storage)), { start: '09:00', end: '12:00' });
    assert.deepEqual(await listMemorySuggestions(uid, NOW, options(storage)), []);

    await deleteMemory(uid, id, NOW, options(storage));
    assert.equal(await storage.get(userSubDoc(uid, MEMORY, id)), null);
    assert.equal(await createStorageRuntimeMemoryStore(undefined, storage).get(id), null);
    assert.equal((await createStorageRuntimeMemoryStore(undefined, storage).export(uid, NOW)).records.length, 0);
    assert.equal(await keptFocusWindow(uid, NOW, options(storage)), null);
    // Deleting it counts as turning it down.
    assert.deepEqual(await listMemorySuggestions(uid, NOW, options(storage)), []);
    assert.equal(
      (await storage.get<{ fingerprint: string }>(userSubDoc(uid, MEMORY_DISMISSALS, 'R1_focus_window')))?.fingerprint,
      'R1_focus_window:09:00-12:00',
    );
  } finally {
    await storage.deleteTree(userDoc(uid));
  }
});

test('firestore: "delete everything" leaves no memory and no dismissal documents', async () => {
  const storage = createFirestoreStorage();
  const uid = uniqueUid('all');
  try {
    await seedHabit(storage, uid);
    await decideMemorySuggestion(uid, 'R1_focus_window', {
      decision: 'dismiss', fingerprint: 'R1_focus_window:09:00-12:00',
    }, NOW, options(storage));
    assert.equal((await storage.list(userCol(uid, MEMORY_DISMISSALS))).length, 1);

    await deleteAllMemory(uid, NOW, { ...options(storage), feedback: createStorageFeedbackEventStore(storage) });

    assert.equal((await storage.list(userCol(uid, MEMORY_DISMISSALS))).length, 0);
    assert.equal((await storage.list(userCol(uid, MEMORY))).length, 0);
    // The completions are the user's own history and are not touched.
    assert.equal((await storage.list(userCol(uid, EVENTS))).length, 12);
  } finally {
    await storage.deleteTree(userDoc(uid));
  }
});
