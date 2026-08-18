/**
 * File-backed runtime memory store (Sprint 02, issue #10).
 *
 * Covers what only the on-disk backend can prove: that Arabic and Hebrew
 * content survives a write/read cycle unchanged, that one corrupt file cannot
 * deny access to the rest of a user's memory, that deletion actually unlinks,
 * and that scopes stay isolated on disk.
 *
 * Uses the mkdtempSync + MAYBESITTER_DATA_DIR override + rmSync cleanup idiom
 * from tests/pilot/participantIsolation.test.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CreateMemoryInput } from '../../src/contracts/v1/memoryContracts.ts';
import { createFileRuntimeMemoryStore } from '../../lib/runtimeMemory/runtimeMemoryStore.ts';

const NOW = '2026-08-18T09:00:00.000Z';
const LATER = '2026-08-18T12:00:00.000Z';

const ARABIC = 'يفضّل التذكير صباحًا قبل الساعة ٩ — لا تتصل بعد المغرب';
const HEBREW = 'מעדיף תזכורות בבוקר לפני 9 — לא להתקשר אחרי השקיעה';
const MIXED = 'يفضل reminders בבוקר at 9am';
/** Bidi controls and presentation forms a re-encoding pass would introduce. */
const BIDI_MARKS = /[‎‏‪-‮⁦-⁩ﭐ-﷿ﹰ-﻿]/;

let directory = '';

function setup(): () => void {
  directory = mkdtempSync(join(tmpdir(), 'maybesitter-runtime-memory-'));
  const previous = process.env.MAYBESITTER_DATA_DIR;
  process.env.MAYBESITTER_DATA_DIR = directory;
  return () => {
    if (previous === undefined) delete process.env.MAYBESITTER_DATA_DIR;
    else process.env.MAYBESITTER_DATA_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  };
}

function recordDir(): string {
  return join(directory, 'runtime-memory');
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

test('file store writes one record file per memory under the data dir', () => {
  const cleanup = setup();
  try {
    const record = createFileRuntimeMemoryStore().put(input(), NOW);
    assert.deepEqual(readdirSync(recordDir()), [`${record.id}.memory.json`]);
  } finally {
    cleanup();
  }
});

test('Arabic and Hebrew content round-trips through the file store unchanged', () => {
  const cleanup = setup();
  try {
    const writer = createFileRuntimeMemoryStore();
    const written = [
      writer.put(input({ content: ARABIC, language: 'ar' }), NOW),
      writer.put(input({ content: HEBREW, language: 'he' }), NOW),
      writer.put(input({ content: MIXED, language: 'mixed' }), NOW),
    ];

    // A second store instance guarantees the value came back off disk rather
    // than out of a cache.
    const reader = createFileRuntimeMemoryStore();
    for (const record of written) {
      const loaded = reader.get(record.id);
      assert.ok(loaded, `record ${record.id} should load`);
      assert.equal(loaded.content, record.content);
      // Code-point equality catches reordering and normalization that plain
      // string equality on a visually identical value would still pass.
      assert.deepEqual(Array.from(loaded.content), Array.from(record.content));
      assert.equal(Buffer.from(loaded.content, 'utf8').equals(Buffer.from(record.content, 'utf8')), true);
      assert.doesNotMatch(loaded.content, BIDI_MARKS, 'no bidi control or presentation forms introduced');

      // The bytes on disk carry the logical text itself, not \uXXXX escapes.
      const raw = readFileSync(join(recordDir(), `${record.id}.memory.json`), 'utf8');
      assert.ok(raw.includes(record.content), 'record file stores the original text verbatim');
    }

    assert.deepEqual(
      reader.retrieve({ scopeId: 'scope-a', now: NOW }).map((r) => r.content).sort(),
      [ARABIC, HEBREW, MIXED].sort(),
    );
  } finally {
    cleanup();
  }
});

test('a corrupt record file is skipped, not fatal', () => {
  const cleanup = setup();
  try {
    const store = createFileRuntimeMemoryStore();
    const good = store.put(input({ content: ARABIC, language: 'ar' }), NOW);

    // Three ways a record file goes bad: unparseable, valid JSON of the wrong
    // shape, and a record from an unknown schema version.
    writeFileSync(join(recordDir(), 'mem_truncated.memory.json'), '{"version":"runtime-memory-v1","id":"mem_tr');
    writeFileSync(join(recordDir(), 'mem_wrong-shape.memory.json'), JSON.stringify({ hello: 'world' }));
    writeFileSync(
      join(recordDir(), 'mem_future-schema.memory.json'),
      JSON.stringify({ ...good, id: 'mem_future-schema', version: 'runtime-memory-v99' }),
    );

    const reader = createFileRuntimeMemoryStore();
    assert.deepEqual(reader.retrieve({ scopeId: 'scope-a', now: NOW }).map((r) => r.id), [good.id]);
    assert.deepEqual(reader.listAll('scope-a').map((r) => r.id), [good.id]);
    assert.equal(reader.get('mem_truncated'), null);
    assert.equal(reader.get('mem_future-schema'), null);
    assert.equal(reader.prune(LATER), 0);
    assert.equal(reader.export('scope-a', NOW).records.length, 1);
  } finally {
    cleanup();
  }
});

test('revocation and supersession survive a restart, deletion leaves no file', () => {
  const cleanup = setup();
  try {
    const store = createFileRuntimeMemoryStore();
    const revoked = store.put(input({ content: 'revoked' }), NOW);
    const original = store.put(input({ content: ARABIC, language: 'ar' }), NOW);
    const replacement = store.supersede(original.id, input({ content: HEBREW, language: 'he' }), LATER);
    const deleted = store.put(input({ content: 'deleted' }), NOW);
    assert.equal(store.revoke(revoked.id, LATER), true);
    assert.equal(store.deleteById(deleted.id), true);

    const reader = createFileRuntimeMemoryStore();
    assert.equal(reader.get(revoked.id)?.status, 'revoked');
    assert.equal(reader.get(revoked.id)?.revokedAt, LATER);
    assert.equal(reader.get(original.id)?.status, 'superseded');
    assert.equal(reader.get(original.id)?.supersededById, replacement.id);
    assert.equal(reader.get(replacement.id)?.supersedesId, original.id);

    // Deletion is not revocation: no record, and no file left behind.
    assert.equal(reader.get(deleted.id), null);
    assert.deepEqual(
      readdirSync(recordDir()).sort(),
      [revoked.id, original.id, replacement.id].map((id) => `${id}.memory.json`).sort(),
    );
    assert.deepEqual(reader.retrieve({ scopeId: 'scope-a', now: LATER }).map((r) => r.id), [replacement.id]);
  } finally {
    cleanup();
  }
});

test('deleteScope removes only the target scope, leaving a sibling scope intact', () => {
  const cleanup = setup();
  try {
    const store = createFileRuntimeMemoryStore();
    store.put(input({ scopeId: 'scope-a', content: ARABIC, language: 'ar' }), NOW);
    store.put(input({ scopeId: 'scope-a', content: 'second a record' }), NOW);
    const keptFirst = store.put(input({ scopeId: 'scope-b', content: HEBREW, language: 'he' }), NOW);
    const keptSecond = store.put(input({ scopeId: 'scope-b', content: 'second b record' }), NOW);

    assert.equal(store.deleteScope('scope-a'), 2);

    const reader = createFileRuntimeMemoryStore();
    assert.equal(reader.listAll('scope-a').length, 0);
    assert.equal(reader.retrieve({ scopeId: 'scope-a', now: NOW }).length, 0);
    assert.deepEqual(
      reader.listAll('scope-b').map((r) => r.id).sort(),
      [keptFirst.id, keptSecond.id].sort(),
    );
    assert.equal(reader.get(keptFirst.id)?.content, HEBREW);
    assert.deepEqual(
      readdirSync(recordDir()).sort(),
      [keptFirst.id, keptSecond.id].map((id) => `${id}.memory.json`).sort(),
    );
  } finally {
    cleanup();
  }
});

test('prune expires stale records on disk and leaves fresh ones alone', () => {
  const cleanup = setup();
  try {
    const store = createFileRuntimeMemoryStore({ defaultTtlMs: 60 * 60 * 1_000 });
    const stale = store.put(input({ content: 'stale' }), NOW);
    const fresh = store.put(input({ content: 'fresh', ttlMs: 24 * 60 * 60 * 1_000 }), NOW);

    assert.equal(store.prune(LATER), 1);

    const reader = createFileRuntimeMemoryStore();
    assert.equal(reader.get(stale.id)?.status, 'expired');
    assert.equal(reader.get(fresh.id)?.status, 'active');
    assert.deepEqual(reader.retrieve({ scopeId: 'scope-a', now: LATER }).map((r) => r.id), [fresh.id]);
    // Expiry is not deletion: the record is still inspectable.
    assert.equal(reader.listAll('scope-a').length, 2);
  } finally {
    cleanup();
  }
});

test('an explicit dataDir option overrides the environment default', () => {
  const cleanup = setup();
  try {
    const explicit = join(directory, 'elsewhere');
    const record = createFileRuntimeMemoryStore({ dataDir: explicit }).put(input(), NOW);
    assert.deepEqual(readdirSync(explicit), [`${record.id}.memory.json`]);
    assert.equal(createFileRuntimeMemoryStore().get(record.id), null, 'the default location stays empty');
  } finally {
    cleanup();
  }
});
