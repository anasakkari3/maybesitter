/**
 * #167's two writes against real Firestore (UC-2.7a).
 *
 * The in-memory adapter proves the semantics; it does not prove they survive
 * the adapter that runs in production. Three things differ enough to be worth
 * a real emulator:
 *
 *  - the supersession chain is written as two documents in two round trips,
 *    not one map mutation, so "delete the chain" has to find records the
 *    in-memory adapter would have handed back from the same object graph;
 *  - `store.get` resolves a record by a **collection-group** query on `id`,
 *    which is an index in Firestore and a linear scan in memory;
 *  - the routine profile is a nested merge into `users/{uid}`, and a merge
 *    that replaced the map rather than merging into it would take the trust
 *    record with it — invisible in a test that only reads the profile back.
 *
 * Ids are unique per run: the emulator's collections are shared with every
 * other emulator test in the same `emulators:exec`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreStorage } from '../../lib/storage/firestoreAdapter.ts';
import { userDoc } from '../../lib/storage/paths.ts';
import { createStorageRuntimeMemoryStore } from '../../lib/runtimeMemory/runtimeMemoryStore.ts';
import {
  readRoutineProfile,
  saveRoutineProfile,
} from '../../lib/services/mobile/routineProfileService.ts';
import { deleteMemory } from '../../lib/services/mobile/memoryService.ts';
import type { RoutineProfileInput } from '../../src/contracts/v1/routineContracts.ts';

const FIRST = '2026-09-13T09:00:00.000Z';
const SECOND = '2026-09-14T09:00:00.000Z';

function uniqueUid(label: string): string {
  return `rm_${label}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function input(overrides: Partial<RoutineProfileInput> = {}): RoutineProfileInput {
  return {
    timezone: 'Asia/Jerusalem',
    sleepWindow: { start: '23:30', end: '07:30' },
    focusWindows: [{ start: '09:00', end: '17:00', label: 'work_study' }],
    fixedCommitmentWindows: [],
    preferredReminderIntensity: 'followUp',
    quietHours: { start: '22:30', end: '07:30' },
    surveySkipped: false,
    ...overrides,
  };
}

test('firestore: the routine survey round-trips and supersedes only what changed', async () => {
  const storage = createFirestoreStorage();
  const uid = uniqueUid('profile');
  const options = { storage, memory: createStorageRuntimeMemoryStore(undefined, storage) };
  try {
    // Something else already on the user document, which the profile merge
    // must not take with it.
    await storage.set(userDoc(uid), { schemaVersion: 1, trust: { marker: 'keep-me' } });

    await saveRoutineProfile(uid, input(), FIRST, options);
    const stored = await readRoutineProfile(uid, options);
    assert.equal(stored?.quietHours?.start, '22:30');
    assert.equal(stored?.updatedAt, FIRST);

    const user = await storage.get<{ trust?: { marker?: string } }>(userDoc(uid));
    assert.equal(user?.trust?.marker, 'keep-me', 'saving the profile overwrote the rest of the user document');

    const result = await saveRoutineProfile(uid, input({ sleepWindow: { start: '00:30', end: '08:30' } }), SECOND, options);
    assert.deepEqual(result.facts, { created: 0, superseded: 1, revoked: 0, unchanged: 3 });

    const active = (await options.memory.listAll(uid))
      .filter((record) => record.status === 'active')
      .map((record) => record.content)
      .sort();
    assert.deepEqual(active, [
      'focus_window:09:00-17:00',
      'quiet_hours:22:30-07:30',
      'reminder_intensity:followUp',
      'sleep_window:00:30-08:30',
    ]);
  } finally {
    await storage.deleteTree(userDoc(uid));
  }
});

test('firestore: deleting one fact removes every document in its chain', async () => {
  const storage = createFirestoreStorage();
  const uid = uniqueUid('chain');
  const memory = createStorageRuntimeMemoryStore(undefined, storage);
  const options = { storage, memory };
  try {
    await saveRoutineProfile(uid, input(), FIRST, options);
    await saveRoutineProfile(uid, input({ sleepWindow: { start: '00:30', end: '08:30' } }), SECOND, options);

    const chainHead = (await memory.listAll(uid)).find((r) => r.content === 'sleep_window:00:30-08:30')!;
    const superseded = (await memory.listAll(uid)).find((r) => r.content === 'sleep_window:23:30-07:30')!;
    assert.equal(superseded.status, 'superseded', 'this run proves nothing without a chain');

    const removed = await deleteMemory(uid, chainHead.id, SECOND, options);
    assert.equal(removed, 2, 'the superseded half of the chain survived');

    // Read back from Firestore, not from the store's return value.
    for (const id of [chainHead.id, superseded.id]) {
      assert.equal(await memory.get(id), null, `${id} is still in Firestore`);
    }
    const left = (await memory.listAll(uid)).map((r) => r.content).sort();
    assert.deepEqual(left, ['focus_window:09:00-17:00', 'quiet_hours:22:30-07:30', 'reminder_intensity:followUp']);
  } finally {
    await storage.deleteTree(userDoc(uid));
  }
});

test('firestore: one account cannot resolve another account’s record by id', async () => {
  const storage = createFirestoreStorage();
  const owner = uniqueUid('owner');
  const stranger = uniqueUid('stranger');
  const memory = createStorageRuntimeMemoryStore(undefined, storage);
  const options = { storage, memory };
  try {
    await saveRoutineProfile(owner, input(), FIRST, options);
    const theirs = (await memory.listAll(owner))[0]!;

    // The group query *will* find it — that is exactly why the service checks
    // the scope, and why this has to be proven against real Firestore.
    assert.ok(await memory.get(theirs.id), 'the group query cannot see the record, so this proves nothing');
    await assert.rejects(
      () => deleteMemory(stranger, theirs.id, SECOND, options),
      /memory not found/,
      'a stranger deleted a record through the collection-group lookup',
    );
    assert.ok(await memory.get(theirs.id), 'the record was deleted anyway');
  } finally {
    await storage.deleteTree(userDoc(owner));
    await storage.deleteTree(userDoc(stranger));
  }
});
