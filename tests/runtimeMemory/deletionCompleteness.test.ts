/**
 * Deletion completeness: a scope deletion must leave nothing holding that
 * user's content, including a document too damaged to read back.
 *
 * These started as an adversarial probe during the Sprint 02 security review
 * and found two real gaps, so they are kept as regressions.
 *
 * ── What changed with the storage move, and what did not ─────────
 *
 * They used to assert on `readdirSync`, because the failure mode was a *file*
 * the store could no longer see: a half-written record, or a `.tmp` left by a
 * crash between write and rename. Neither exists now — the adapter writes one
 * document atomically, so there is no rename window and no temp file to
 * orphan. Those two cases are therefore gone rather than ported, and saying so
 * here is the point: they were removed because the mechanism they guarded was
 * removed, not because they became inconvenient.
 *
 * What survives is every property that is still expressible, and it is now
 * checked against storage directly — `pathsForTests()` is the equivalent of
 * the old directory listing, and it is what catches a document the store's own
 * API can no longer see.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StorageRuntimeMemoryStore } from '../../lib/runtimeMemory/runtimeMemoryStore.ts';
import { createMemoryStorage, type MemoryStorageAdapter } from '../../lib/storage/memoryAdapter.ts';
import { MEMORY, userCol, userIdForKey } from '../../lib/storage/paths.ts';

const AT = '2026-08-18T00:00:00.000Z';

function setup(): { storage: MemoryStorageAdapter; store: StorageRuntimeMemoryStore } {
  const storage = createMemoryStorage();
  return { storage, store: new StorageRuntimeMemoryStore(storage) };
}

function record(scopeId: string, content: string) {
  return {
    scopeId, kind: 'fact' as const, content, language: 'en' as const,
    source: 'user_stated' as const, confidence: 0.9, observedAt: AT,
  };
}

/** Every document currently held for one scope, however damaged. */
function heldFor(storage: MemoryStorageAdapter, scopeId: string): string[] {
  const prefix = `${userCol(userIdForKey(scopeId), MEMORY)}/`;
  return storage.pathsForTests().filter((path) => path.startsWith(prefix));
}

test('SECURITY: a traversing or malformed id cannot read or delete anything', async () => {
  const { storage, store } = setup();
  await store.put(record('alice', 'SENSITIVE'), AT);

  for (const evil of ['../victim', '../../etc/passwd', 'mem_../../victim', '/etc/passwd', 'mem_a/../../victim']) {
    assert.equal(await store.get(evil), null, `get(${evil}) must not resolve`);
    assert.equal(await store.deleteById(evil), false, `deleteById(${evil}) must not delete`);
  }
  assert.equal(heldFor(storage, 'alice').length, 1, "alice's record must survive");
});

test('SECURITY: deleteScope removes a document even when it cannot be parsed', async () => {
  const { storage, store } = setup();
  const stored = await store.put(record('alice', 'x'), AT);
  // Corrupt it in place, as a half-applied write would. The store's own reads
  // now skip it — which is exactly why deletion must not rely on them.
  await storage.set(`${userCol(userIdForKey('alice'), MEMORY)}/${stored.id}`, {
    scopeId: 'alice',
    content: 'SECRET',
  });

  await store.deleteScope('alice');
  assert.deepEqual(heldFor(storage, 'alice'), [], 'no document holding alice content may survive deleteScope');
});

test('SECURITY: a document belonging to a different scope is never deleted', async () => {
  const { storage, store } = setup();
  await store.put(record('carol', 'c'), AT);

  assert.equal(await store.deleteScope('dave'), 0, "deleting dave must not touch carol's data");
  assert.equal(heldFor(storage, 'carol').length, 1, "carol's record must survive");
});

test('SECURITY: deleteById leaves nothing behind for the record it removed', async () => {
  const { storage, store } = setup();
  const stored = await store.put(record('erin', 'e'), AT);

  assert.equal(await store.deleteById(stored.id), true);
  assert.deepEqual(heldFor(storage, 'erin'), [], 'deleteById must leave no document holding the record');
  assert.equal(await store.get(stored.id), null);
});

test('SECURITY: one scope deletion cannot reach across the user boundary', async () => {
  // The property the per-user tree buys: scopes are separate paths, so a
  // deletion is bounded by construction rather than by a filename filter.
  const { storage, store } = setup();
  await store.put(record('alice', 'a'), AT);
  await store.put(record('bob', 'b'), AT);

  assert.equal(await store.deleteScope('alice'), 1);
  assert.deepEqual(heldFor(storage, 'alice'), []);
  assert.equal(heldFor(storage, 'bob').length, 1, "bob's record must survive alice's deletion");
});
