/**
 * The same deletion coverage against real Firestore (UC-1.0c #142).
 *
 * The memory adapter's `deleteTree` is ours; Firestore's is a recursive delete
 * we do not control. Proving the in-memory one complete says nothing about the
 * one that runs in production, so the suite runs here too. Ids are unique per
 * run because the emulator's collections are shared with every other
 * emulator test in the same `emulators:exec`.
 */
import test from 'node:test';
import { createFirestoreStorage } from '../../lib/storage/firestoreAdapter.ts';
import { userDoc } from '../../lib/storage/paths.ts';
import { assertDeleteTreeCoversEveryUserCollection } from './deletionCoverageSuite.ts';

test('firestore: deleteTree(users/U) covers every user collection and spares the sibling', async () => {
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const storage = createFirestoreStorage();
  const target = `delcov_${run}_u`;
  const sibling = `delcov_${run}_v`;
  try {
    await assertDeleteTreeCoversEveryUserCollection(storage, target, sibling);
  } finally {
    await storage.deleteTree(userDoc(target));
    await storage.deleteTree(userDoc(sibling));
  }
});
