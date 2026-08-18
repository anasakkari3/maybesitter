/**
 * Deletion completeness: a scope deletion must leave no file holding that
 * user's content, including files a crash left unreadable or unrenamed.
 *
 * These started as an adversarial probe during the Sprint 02 security review
 * and found two real gaps, so they are kept as regressions. Each asserts on the
 * filesystem rather than on the store's own API, because the failure mode is
 * precisely a file the store can no longer see.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileRuntimeMemoryStore } from '../../lib/runtimeMemory/runtimeMemoryStore.ts';

test('SECURITY: path traversal cannot read or delete outside the store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sec-'));
  const victim = join(dir, 'victim.txt');
  writeFileSync(victim, 'SENSITIVE');
  const store = createFileRuntimeMemoryStore({ dataDir: join(dir, 'store') });

  for (const evil of ['../victim', '../../etc/passwd', 'mem_../../victim', '/etc/passwd', 'mem_a/../../victim']) {
    assert.equal(store.get(evil), null, `get(${evil}) must not resolve`);
    assert.equal(store.deleteById(evil), false, `deleteById(${evil}) must not delete`);
  }
  assert.equal(existsSync(victim), true, 'victim file must survive');
  rmSync(dir, { recursive: true, force: true });
});

test('SECURITY: deleteScope removes files even when their JSON is unreadable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sec2-'));
  const dataDir = join(dir, 'store');
  const store = createFileRuntimeMemoryStore({ dataDir });
  const rec = store.put({
    scopeId: 'alice', kind: 'fact', content: 'x', language: 'en',
    source: 'user_stated', confidence: 0.9, observedAt: '2026-08-18T00:00:00.000Z',
  }, '2026-08-18T00:00:00.000Z');
  // Corrupt it in place, as a mid-crash write would.
  writeFileSync(join(dataDir, `${rec.id}.memory.json`), '{"scopeId":"alice","content":"SECRET",');
  const removed = store.deleteScope('alice');
  const leftovers = readdirSync(dataDir);
  assert.deepEqual(leftovers, [], 'no file holding alice content may survive deleteScope');
  rmSync(dir, { recursive: true, force: true });
});

test('SECURITY: an orphaned temp file from a crashed write is also deleted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sec3-'));
  const dataDir = join(dir, 'store');
  const store = createFileRuntimeMemoryStore({ dataDir });
  store.put({
    scopeId: 'bob', kind: 'fact', content: 'y', language: 'en',
    source: 'user_stated', confidence: 0.5, observedAt: '2026-08-18T00:00:00.000Z',
  }, '2026-08-18T00:00:00.000Z');
  // Simulate a crash between writeFileSync and renameSync.
  writeFileSync(join(dataDir, 'mem_orphan.memory.json.999.tmp'),
    JSON.stringify({ scopeId: 'bob', content: 'LEAKED SECRET' }));
  const removed = store.deleteScope('bob');
  const leftovers = readdirSync(dataDir);
  assert.deepEqual(leftovers, [], 'a crashed temp write must not survive deletion');
  rmSync(dir, { recursive: true, force: true });
});

test('SECURITY: a file naming a different scope is never deleted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sec4-'));
  const dataDir = join(dir, 'store');
  const store = createFileRuntimeMemoryStore({ dataDir });
  const carol = store.put({
    scopeId: 'carol', kind: 'fact', content: 'c', language: 'en',
    source: 'user_stated', confidence: 0.5, observedAt: '2026-08-18T00:00:00.000Z',
  }, '2026-08-18T00:00:00.000Z');
  writeFileSync(join(dataDir, `${carol.id}.memory.json`), '{"scopeId":"carol","content":"CORRUPT',
  );
  assert.equal(store.deleteScope('dave'), 0, "deleting dave must not touch carol's data");
  assert.equal(readdirSync(dataDir).length, 1, "carol's file must survive");
  rmSync(dir, { recursive: true, force: true });
});
