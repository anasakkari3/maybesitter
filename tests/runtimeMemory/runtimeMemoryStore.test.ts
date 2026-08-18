/**
 * Runtime memory store semantics (Sprint 02, issue #10).
 *
 * The issue's three acceptance criteria each get their own mechanism, so each
 * gets its own test rather than one test standing in for all three:
 *
 *  - "conflicting memories remain inspectable" -> supersede() links both
 *    records and listAll() still returns the chain.
 *  - "deletion removes memory from retrieval" -> revoke() (hidden, auditable)
 *    is asserted to behave differently from deleteById()/deleteScope()
 *    (removed outright).
 *  - "personal memory excluded from fine-tuning exports" -> see
 *    exportPolicy.test.ts, which pins the guard itself.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MEMORY_TTL_MS,
  MEMORY_RECORD_SCHEMA_VERSION,
  type CreateMemoryInput,
} from '../../src/contracts/v1/memoryContracts.ts';
import { createInMemoryRuntimeMemoryStore } from '../../lib/runtimeMemory/runtimeMemoryStore.ts';

const NOW = '2026-08-18T09:00:00.000Z';
const LATER = '2026-08-18T11:00:00.000Z';
const OBSERVED = '2026-08-17T08:00:00.000Z';

function input(overrides: Partial<CreateMemoryInput> = {}): CreateMemoryInput {
  return {
    scopeId: 'scope-a',
    kind: 'preference',
    content: 'Prefers morning reminders',
    language: 'en',
    source: 'user_stated',
    confidence: 0.9,
    observedAt: OBSERVED,
    evidenceIds: ['obs-1'],
    ...overrides,
  };
}

function isoAfter(base: string, ms: number): string {
  return new Date(Date.parse(base) + ms).toISOString();
}

test('put assigns server-owned fields and defaults exportPolicy to personal_never_export', () => {
  const store = createInMemoryRuntimeMemoryStore();
  const record = store.put(input(), NOW);

  assert.equal(record.version, MEMORY_RECORD_SCHEMA_VERSION);
  assert.ok(record.id.length > 0);
  assert.equal(record.status, 'active');
  assert.equal(record.createdAt, NOW);
  assert.equal(record.updatedAt, NOW);
  assert.equal(record.observedAt, OBSERVED);
  assert.equal(record.staleAfter, isoAfter(NOW, DEFAULT_MEMORY_TTL_MS));
  // The privacy-safe default: a caller that says nothing gets the strict policy.
  assert.equal(record.exportPolicy, 'personal_never_export');
  assert.equal(record.supersedesId, undefined);
  assert.equal(record.supersededById, undefined);
  assert.equal(record.revokedAt, undefined);
  assert.deepEqual(record.evidenceIds, ['obs-1']);
});

test('put ignores caller-supplied server-assigned fields', () => {
  const store = createInMemoryRuntimeMemoryStore();
  // A caller trying to forge provenance: pre-picked id, faked timestamps, a
  // staleAfter far in the future, and forged supersession/revocation links.
  const hostile = {
    ...input(),
    id: 'attacker-chosen-id',
    version: 'forged-version',
    status: 'revoked',
    createdAt: '1999-01-01T00:00:00.000Z',
    updatedAt: '1999-01-01T00:00:00.000Z',
    staleAfter: '2999-01-01T00:00:00.000Z',
    supersedesId: 'ghost-old',
    supersededById: 'ghost-new',
    revokedAt: '1999-01-01T00:00:00.000Z',
  } as unknown as CreateMemoryInput;

  const record = store.put(hostile, NOW);

  assert.notEqual(record.id, 'attacker-chosen-id');
  assert.equal(store.get('attacker-chosen-id'), null);
  assert.equal(record.version, MEMORY_RECORD_SCHEMA_VERSION);
  assert.equal(record.status, 'active');
  assert.equal(record.createdAt, NOW);
  assert.equal(record.updatedAt, NOW);
  assert.equal(record.staleAfter, isoAfter(NOW, DEFAULT_MEMORY_TTL_MS));
  assert.equal(record.supersedesId, undefined);
  assert.equal(record.supersededById, undefined);
  assert.equal(record.revokedAt, undefined);
});

test('put rejects malformed input rather than storing it', () => {
  const store = createInMemoryRuntimeMemoryStore();
  assert.throws(() => store.put(input({ scopeId: '  ' }), NOW), /scopeId/);
  assert.throws(() => store.put(input({ content: '' }), NOW), /content/);
  assert.throws(() => store.put(input({ confidence: 1.5 }), NOW), /confidence/);
  assert.throws(() => store.put(input({ confidence: Number.NaN }), NOW), /confidence/);
  assert.throws(() => store.put(input({ kind: 'observation' as never }), NOW), /kind/);
  assert.throws(() => store.put(input({ language: 'fr' as never }), NOW), /language/);
  assert.throws(() => store.put(input({ source: 'guessed' as never }), NOW), /source/);
  assert.throws(() => store.put(input({ observedAt: 'yesterday' }), NOW), /observedAt/);
  assert.throws(() => store.put(input({ ttlMs: 0 }), NOW), /ttlMs/);
  assert.throws(() => store.put(input(), 'not-a-timestamp'), /now/);
  assert.equal(store.listAll('scope-a').length, 0);
});

test('stored records are frozen so a consumer cannot mutate store state', () => {
  const store = createInMemoryRuntimeMemoryStore();
  const record = store.put(input(), NOW);
  assert.throws(() => {
    (record as { content: string }).content = 'tampered';
  }, TypeError);
  assert.equal(store.get(record.id)?.content, 'Prefers morning reminders');
});

test('retrieve returns active in-window records newest-observedAt first', () => {
  const store = createInMemoryRuntimeMemoryStore();
  const older = store.put(input({ content: 'older', observedAt: '2026-08-10T08:00:00.000Z' }), NOW);
  const newer = store.put(input({ content: 'newer', observedAt: '2026-08-17T08:00:00.000Z' }), NOW);

  const found = store.retrieve({ scopeId: 'scope-a', now: NOW });
  assert.deepEqual(found.map((r) => r.id), [newer.id, older.id]);
});

test('retrieve honors kind, minConfidence, language, and limit filters', () => {
  const store = createInMemoryRuntimeMemoryStore();
  store.put(input({ kind: 'fact', confidence: 0.95, language: 'ar', observedAt: '2026-08-17T09:00:00.000Z' }), NOW);
  store.put(input({ kind: 'preference', confidence: 0.4, language: 'en', observedAt: '2026-08-17T08:00:00.000Z' }), NOW);
  store.put(input({ kind: 'hypothesis', confidence: 0.7, language: 'he', observedAt: '2026-08-17T07:00:00.000Z' }), NOW);

  assert.equal(store.retrieve({ scopeId: 'scope-a', now: NOW, kind: 'fact' }).length, 1);
  assert.equal(store.retrieve({ scopeId: 'scope-a', now: NOW, minConfidence: 0.5 }).length, 2);
  assert.equal(store.retrieve({ scopeId: 'scope-a', now: NOW, language: 'he' }).length, 1);
  assert.equal(store.retrieve({ scopeId: 'scope-a', now: NOW, limit: 2 }).length, 2);
});

test('retrieve never crosses scope boundaries', () => {
  const store = createInMemoryRuntimeMemoryStore();
  store.put(input({ scopeId: 'scope-a', content: 'a-only' }), NOW);
  store.put(input({ scopeId: 'scope-b', content: 'b-only' }), NOW);

  assert.deepEqual(store.retrieve({ scopeId: 'scope-a', now: NOW }).map((r) => r.content), ['a-only']);
  assert.deepEqual(store.retrieve({ scopeId: 'scope-b', now: NOW }).map((r) => r.content), ['b-only']);
});

test('criterion 1: supersede keeps the prior record inspectable and linked', () => {
  const store = createInMemoryRuntimeMemoryStore();
  const original = store.put(input({ content: 'Prefers morning reminders' }), NOW);
  const replacement = store.supersede(original.id, input({ content: 'Prefers evening reminders' }), LATER);

  // Both directions of the link exist, so the conflict is traceable either way.
  assert.equal(replacement.supersedesId, original.id);
  const priorAfter = store.get(original.id);
  assert.ok(priorAfter, 'superseding must never destroy the prior record');
  assert.equal(priorAfter.status, 'superseded');
  assert.equal(priorAfter.supersededById, replacement.id);
  assert.equal(priorAfter.updatedAt, LATER);
  assert.equal(priorAfter.content, 'Prefers morning reminders');

  // retrieve() shows only the winner; listAll() shows the whole chain.
  assert.deepEqual(store.retrieve({ scopeId: 'scope-a', now: LATER }).map((r) => r.id), [replacement.id]);
  assert.deepEqual(
    store.listAll('scope-a').map((r) => r.id).sort(),
    [original.id, replacement.id].sort(),
  );
});

test('supersede refuses forks, cross-scope links, and reviving revoked records', () => {
  const store = createInMemoryRuntimeMemoryStore();
  const original = store.put(input(), NOW);
  store.supersede(original.id, input({ content: 'second' }), LATER);

  // Already has a successor: a second supersede would orphan the first link.
  assert.throws(() => store.supersede(original.id, input({ content: 'third' }), LATER), /already superseded/);
  assert.throws(() => store.supersede('mem_missing', input(), LATER), /not found/);

  const other = store.put(input({ content: 'cross' }), NOW);
  assert.throws(
    () => store.supersede(other.id, input({ scopeId: 'scope-b' }), LATER),
    /scope/,
    'a replacement must not link across scopes',
  );

  const revoked = store.put(input({ content: 'revoked' }), NOW);
  assert.equal(store.revoke(revoked.id, LATER), true);
  assert.throws(
    () => store.supersede(revoked.id, input(), LATER),
    /revoked/,
    'superseding a revoked record would silently undo the revocation',
  );
});

test('criterion 2a: revoke hides from retrieval but keeps the record auditable', () => {
  const store = createInMemoryRuntimeMemoryStore();
  const record = store.put(input(), NOW);

  assert.equal(store.revoke(record.id, LATER), true);
  assert.equal(store.revoke('mem_missing', LATER), false);

  assert.equal(store.retrieve({ scopeId: 'scope-a', now: LATER }).length, 0);
  const audited = store.get(record.id);
  assert.ok(audited, 'revoke must keep the record for audit');
  assert.equal(audited.status, 'revoked');
  assert.equal(audited.revokedAt, LATER);
  assert.deepEqual(store.listAll('scope-a').map((r) => r.id), [record.id]);
});

test('criterion 2b: deleteById removes outright — retrieve and get both miss', () => {
  const store = createInMemoryRuntimeMemoryStore();
  const record = store.put(input(), NOW);

  assert.equal(store.deleteById(record.id), true);
  assert.equal(store.deleteById(record.id), false);

  assert.equal(store.retrieve({ scopeId: 'scope-a', now: NOW }).length, 0);
  assert.equal(store.get(record.id), null, 'deletion is not revocation: nothing remains');
  assert.equal(store.listAll('scope-a').length, 0);
  assert.equal(store.export('scope-a', NOW).records.length, 0);
});

test('deleteScope removes only the target scope', () => {
  const store = createInMemoryRuntimeMemoryStore();
  store.put(input({ scopeId: 'scope-a', content: 'a-1' }), NOW);
  store.put(input({ scopeId: 'scope-a', content: 'a-2' }), NOW);
  const kept = store.put(input({ scopeId: 'scope-b', content: 'b-1' }), NOW);

  assert.equal(store.deleteScope('scope-a'), 2);
  assert.equal(store.listAll('scope-a').length, 0);
  assert.deepEqual(store.listAll('scope-b').map((r) => r.id), [kept.id]);
  assert.equal(store.deleteScope('scope-a'), 0);
});

test('ids that could escape the record namespace are treated as not found', () => {
  const store = createInMemoryRuntimeMemoryStore();
  store.put(input(), NOW);
  for (const unsafe of ['../../etc/passwd', 'a/b', 'a\\b', '..', '', 'a.memory']) {
    assert.equal(store.get(unsafe), null, `get(${JSON.stringify(unsafe)}) must not resolve`);
    assert.equal(store.deleteById(unsafe), false, `deleteById(${JSON.stringify(unsafe)}) must not resolve`);
    assert.equal(store.revoke(unsafe, LATER), false);
  }
  assert.equal(store.listAll('scope-a').length, 1);
});

test('prune expires stale records and removes them from retrieval', () => {
  const store = createInMemoryRuntimeMemoryStore();
  const shortLived = store.put(input({ content: 'stale soon', ttlMs: 1_000 }), NOW);
  const longLived = store.put(input({ content: 'still fresh' }), NOW);
  const afterExpiry = isoAfter(NOW, 2_000);

  // retrieve() already excludes it on staleness alone, before prune runs.
  assert.deepEqual(store.retrieve({ scopeId: 'scope-a', now: afterExpiry }).map((r) => r.id), [longLived.id]);

  assert.equal(store.prune(afterExpiry), 1);
  assert.equal(store.get(shortLived.id)?.status, 'expired');
  assert.equal(store.get(shortLived.id)?.updatedAt, afterExpiry);
  assert.equal(store.get(longLived.id)?.status, 'active');
  assert.equal(store.prune(afterExpiry), 0, 'prune is idempotent');
});

test('prune leaves revoked and superseded statuses intact for audit', () => {
  const store = createInMemoryRuntimeMemoryStore();
  const revoked = store.put(input({ content: 'revoked', ttlMs: 1_000 }), NOW);
  const original = store.put(input({ content: 'original', ttlMs: 1_000 }), NOW);
  store.supersede(original.id, input({ content: 'replacement', ttlMs: 1_000 }), NOW);
  assert.equal(store.revoke(revoked.id, NOW), true);

  const afterExpiry = isoAfter(NOW, 2_000);
  assert.equal(store.prune(afterExpiry), 1, 'only the active replacement expires');
  assert.equal(store.get(revoked.id)?.status, 'revoked');
  assert.equal(store.get(original.id)?.status, 'superseded');
});

test('export returns every status in the scope, including personal records', () => {
  const store = createInMemoryRuntimeMemoryStore();
  const active = store.put(input({ content: 'active' }), NOW);
  const revoked = store.put(input({ content: 'revoked' }), NOW);
  store.revoke(revoked.id, NOW);
  store.put(input({ scopeId: 'scope-b', content: 'other scope' }), NOW);

  const exported = store.export('scope-a', LATER);
  assert.equal(exported.version, MEMORY_RECORD_SCHEMA_VERSION);
  assert.equal(exported.scopeId, 'scope-a');
  assert.equal(exported.exportedAt, LATER);
  assert.deepEqual(exported.records.map((r) => r.id).sort(), [active.id, revoked.id].sort());
  assert.ok(exported.records.every((r) => r.exportPolicy === 'personal_never_export'));
});
