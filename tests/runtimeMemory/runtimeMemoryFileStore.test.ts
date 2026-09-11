/**
 * Runtime memory on durable storage — the durability half (UC-1.0c, #142).
 *
 * This file was `runtimeMemoryFileStore.test.ts` and covered what only the
 * on-disk backend could prove. The backend is gone, so the cases split three
 * ways and it is worth being explicit about which is which:
 *
 *  - **Kept, and now stronger.** Arabic and Hebrew content surviving a
 *    write/read cycle byte for byte, and revocation/supersession surviving a
 *    restart. A "restart" used to mean constructing a second store over the
 *    same directory; it now means a second store over the same backend, which
 *    is what two Cloud Run instances actually are. That is a better test of
 *    the same property.
 *
 *  - **Kept, relocated.** Scope isolation and prune are asserted here against
 *    storage rather than against a directory listing.
 *
 *  - **Removed, because the mechanism is gone.** "one file per record",
 *    "a corrupt file is skipped", the `.tmp` sweep, and the `dataDir` override
 *    were all about the filesystem. There is no file, no temp-then-rename
 *    window and no data directory; `tests/runtimeMemory/deletionCompleteness`
 *    keeps the damaged-document case in the form that still exists.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { CreateMemoryInput } from '../../src/contracts/v1/memoryContracts.ts';
import { StorageRuntimeMemoryStore } from '../../lib/runtimeMemory/runtimeMemoryStore.ts';
import { createMemoryStorage, type MemoryStorageAdapter } from '../../lib/storage/memoryAdapter.ts';

const NOW = '2026-08-18T09:00:00.000Z';
const LATER = '2026-08-18T12:00:00.000Z';

const ARABIC = 'يفضّل التذكير صباحًا قبل الساعة ٩ — لا تتصل بعد المغرب';
const HEBREW = 'מעדיף תזכורות בבוקר לפני 9 — לא להתקשר אחרי השקיעה';
const MIXED = 'يفضل reminders בבוקר at 9am';
/** Bidi controls and presentation forms a re-encoding pass would introduce. */
const BIDI_MARKS = /[‎‏‪-‮⁦-⁩ﭐ-﷿ﹰ-﻿]/;

function backend(): MemoryStorageAdapter {
  return createMemoryStorage();
}

function input(overrides: Partial<CreateMemoryInput> = {}): CreateMemoryInput {
  return {
    scopeId: 'scope-a',
    kind: 'preference',
    content: 'Prefers morning reminders',
    language: 'en',
    source: 'user_stated',
    confidence: 0.8,
    observedAt: NOW,
    ...overrides,
  };
}

test('Arabic and Hebrew content round-trips through storage unchanged', async () => {
  const shared = backend();
  const writer = new StorageRuntimeMemoryStore(shared);
  const written = [
    await writer.put(input({ content: ARABIC, language: 'ar' }), NOW),
    await writer.put(input({ content: HEBREW, language: 'he' }), NOW),
    await writer.put(input({ content: MIXED, language: 'mixed' }), NOW),
  ];

  // A second store over the same backend, so the value came back from storage
  // rather than out of anything the writer was holding.
  const reader = new StorageRuntimeMemoryStore(shared);
  for (const record of written) {
    const loaded = await reader.get(record.id);
    assert.ok(loaded, `record ${record.id} should load`);
    assert.equal(loaded.content, record.content);
    // Code-point equality catches reordering and normalization that plain
    // string equality on a visually identical value would still pass.
    assert.deepEqual(Array.from(loaded.content), Array.from(record.content));
    assert.equal(Buffer.from(loaded.content, 'utf8').equals(Buffer.from(record.content, 'utf8')), true);
    assert.doesNotMatch(loaded.content, BIDI_MARKS, 'no bidi control or presentation forms introduced');
  }

  assert.deepEqual(
    (await reader.retrieve({ scopeId: 'scope-a', now: NOW })).map((r) => r.content).sort(),
    [ARABIC, HEBREW, MIXED].sort(),
  );
});

test('revocation and supersession survive a restart; deletion leaves nothing', async () => {
  const shared = backend();
  const store = new StorageRuntimeMemoryStore(shared);
  const revoked = await store.put(input({ content: 'revoked' }), NOW);
  const original = await store.put(input({ content: ARABIC, language: 'ar' }), NOW);
  const replacement = await store.supersede(original.id, input({ content: HEBREW, language: 'he' }), LATER);
  const deleted = await store.put(input({ content: 'deleted' }), NOW);
  assert.equal(await store.revoke(revoked.id, LATER), true);
  assert.equal(await store.deleteById(deleted.id), true);

  const reader = new StorageRuntimeMemoryStore(shared);
  assert.equal((await reader.get(revoked.id))?.status, 'revoked');
  assert.equal((await reader.get(revoked.id))?.revokedAt, LATER);
  assert.equal((await reader.get(original.id))?.status, 'superseded');
  assert.equal((await reader.get(original.id))?.supersededById, replacement.id);
  assert.equal((await reader.get(replacement.id))?.supersedesId, original.id);

  // Deletion is not revocation: no record, and nothing left holding it.
  assert.equal(await reader.get(deleted.id), null);
  assert.deepEqual(
    (await reader.listAll('scope-a')).map((r) => r.id).sort(),
    [revoked.id, original.id, replacement.id].sort(),
  );
  assert.deepEqual((await reader.retrieve({ scopeId: 'scope-a', now: LATER })).map((r) => r.id), [replacement.id]);
});

test('deleteScope removes only the target scope, leaving a sibling scope intact', async () => {
  const shared = backend();
  const store = new StorageRuntimeMemoryStore(shared);
  await store.put(input({ scopeId: 'scope-a', content: ARABIC, language: 'ar' }), NOW);
  await store.put(input({ scopeId: 'scope-a', content: 'second a record' }), NOW);
  const keptFirst = await store.put(input({ scopeId: 'scope-b', content: HEBREW, language: 'he' }), NOW);
  const keptSecond = await store.put(input({ scopeId: 'scope-b', content: 'second b record' }), NOW);

  assert.equal(await store.deleteScope('scope-a'), 2);

  const reader = new StorageRuntimeMemoryStore(shared);
  assert.equal((await reader.listAll('scope-a')).length, 0);
  assert.equal((await reader.retrieve({ scopeId: 'scope-a', now: NOW })).length, 0);
  assert.deepEqual(
    (await reader.listAll('scope-b')).map((r) => r.id).sort(),
    [keptFirst.id, keptSecond.id].sort(),
  );
  assert.equal((await reader.get(keptFirst.id))?.content, HEBREW);
});

test('prune expires stale records and leaves fresh ones alone, across a restart', async () => {
  const shared = backend();
  const store = new StorageRuntimeMemoryStore(shared, { defaultTtlMs: 60 * 60 * 1_000 });
  const stale = await store.put(input({ content: 'stale' }), NOW);
  const fresh = await store.put(input({ content: 'fresh', ttlMs: 24 * 60 * 60 * 1_000 }), NOW);

  assert.equal(await store.prune(LATER), 1);

  const reader = new StorageRuntimeMemoryStore(shared);
  assert.equal((await reader.get(stale.id))?.status, 'expired');
  assert.equal((await reader.get(fresh.id))?.status, 'active');
  assert.deepEqual((await reader.retrieve({ scopeId: 'scope-a', now: LATER })).map((r) => r.id), [fresh.id]);
  // Expiry is not deletion: the record is still inspectable.
  assert.equal((await reader.listAll('scope-a')).length, 2);
});

test('two scopes never share a tree, so one user cannot read another', async () => {
  // What the per-user path buys, asserted directly rather than inferred from a
  // filename convention the way the file store had to.
  const shared = backend();
  const store = new StorageRuntimeMemoryStore(shared);
  const mine = await store.put(input({ scopeId: 'scope-a', content: 'mine' }), NOW);
  await store.put(input({ scopeId: 'scope-b', content: 'theirs' }), NOW);

  assert.deepEqual((await store.listAll('scope-a')).map((r) => r.id), [mine.id]);
  assert.equal((await store.retrieve({ scopeId: 'scope-b', now: NOW })).length, 1);
  assert.equal((await store.retrieve({ scopeId: 'scope-b', now: NOW }))[0].content, 'theirs');
});
