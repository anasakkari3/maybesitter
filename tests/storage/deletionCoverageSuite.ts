/**
 * Deletion coverage, shared by the memory and Firestore runs (UC-1.0c #142;
 * UC-1.5 #149 reuses it for in-app account deletion).
 *
 * Account deletion is `deleteTree('users/{uid}')`, and it is only as complete
 * as the set of places a user's data can live. This asserts three things,
 * because any one of them alone can pass while deletion is broken:
 *
 *   1. The seed is real: before deleting, every user-scoped collection holds
 *      the target's document. Without this, an adapter whose `set` quietly
 *      wrote nothing would "delete" everything perfectly.
 *   2. Deletion is complete: afterwards no collection holds a document under
 *      `users/{target}/`.
 *   3. Deletion is scoped: the sibling user's documents all survive. A
 *      `deleteTree` that wiped the whole database would satisfy (2) alone.
 *
 * The registry direction — that `USER_SCOPED_COLLECTIONS` names every
 * collection the code actually writes — lives in `deletionCoverage.test.ts`,
 * because seeding only the listed collections can never notice an unlisted one.
 */
import assert from 'node:assert/strict';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import { USER_SCOPED_COLLECTIONS, userDoc, userSubDoc } from '../../lib/storage/paths.ts';

function under(uid: string) {
  const prefix = `${userDoc(uid)}/`;
  return (row: { path: string }) => row.path.startsWith(prefix);
}

export async function assertDeleteTreeCoversEveryUserCollection(
  storage: StorageAdapter,
  target: string,
  sibling: string,
): Promise<void> {
  for (const uid of [target, sibling]) {
    await storage.set(userDoc(uid), { uid });
    for (const collection of USER_SCOPED_COLLECTIONS) {
      await storage.set(userSubDoc(uid, collection, 'seed'), { uid, collection });
    }
  }

  for (const collection of USER_SCOPED_COLLECTIONS) {
    const rows = await storage.listGroup(collection);
    assert.ok(rows.some(under(target)), `the seed never reached ${collection}, so this run would prove nothing`);
  }

  await storage.deleteTree(userDoc(target));

  for (const collection of USER_SCOPED_COLLECTIONS) {
    const rows = await storage.listGroup(collection);
    assert.deepEqual(
      rows.filter(under(target)).map((row) => row.path),
      [],
      `deleting the account left ${collection} documents behind`,
    );
    assert.ok(rows.some(under(sibling)), `deleting one account also removed another user's ${collection}`);
  }
}
