/**
 * Retrieval ordering must compare timestamps as instants.
 *
 * isIsoTimestamp accepts UTC offsets, and offset-bearing timestamps sort
 * differently as text than they do in time. A textual sort therefore ranks an
 * older record above a newer one, and `limit` returns the wrong record — the
 * failure is silent, because the result is a plausible record either way.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryRuntimeMemoryStore } from '../../lib/runtimeMemory/runtimeMemoryStore.ts';

const NOW = '2026-08-18T00:00:00.000Z';

test('retrieve orders by instant, not by timestamp text', () => {
  const store = createInMemoryRuntimeMemoryStore();
  const base = {
    scopeId: 's', kind: 'fact', language: 'en', source: 'user_stated', confidence: 0.9,
  } as const;

  // 21:00Z, but its text sorts ABOVE the 22:00Z record below.
  const older = store.put({ ...base, content: 'older', observedAt: '2026-08-17T23:00:00.000+02:00' }, NOW);
  const newer = store.put({ ...base, content: 'newer', observedAt: '2026-08-17T22:00:00.000Z' }, NOW);

  const all = store.retrieve({ scopeId: 's', now: NOW });
  assert.deepEqual(all.map((r) => r.content), ['newer', 'older'], 'newest instant must come first');

  const limited = store.retrieve({ scopeId: 's', now: NOW, limit: 1 });
  assert.equal(limited[0]?.id, newer.id, 'limit must keep the newest record, not the one that sorts first as text');
  assert.notEqual(limited[0]?.id, older.id);
});
