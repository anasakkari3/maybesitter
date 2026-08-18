/**
 * Fine-tuning export guard (Sprint 02, issue #10, criterion 3).
 *
 * assertNoPersonalMemory() is the single choke point any future fine-tuning
 * exporter must pass through. These tests pin that it throws, that it fails
 * closed on records whose policy is missing or unrecognised, and that the
 * user's own data export (MemoryExport) stays a separate path that keeps
 * personal records.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { CreateMemoryInput, RuntimeMemoryRecord } from '../../src/contracts/v1/memoryContracts.ts';
import { createInMemoryRuntimeMemoryStore } from '../../lib/runtimeMemory/runtimeMemoryStore.ts';
import { assertNoPersonalMemory, isFineTuningExportable } from '../../lib/runtimeMemory/exportPolicy.ts';

const NOW = '2026-08-18T09:00:00.000Z';
const SECRET = 'Lives at 12 Herzl Street with two children';

function input(overrides: Partial<CreateMemoryInput> = {}): CreateMemoryInput {
  return {
    scopeId: 'scope-a',
    kind: 'fact',
    content: 'Works from home on Sundays',
    language: 'en',
    source: 'user_stated',
    confidence: 0.8,
    observedAt: NOW,
    ...overrides,
  };
}

test('criterion 3: assertNoPersonalMemory throws on a personal record', () => {
  const store = createInMemoryRuntimeMemoryStore();
  // No exportPolicy given, so the record is personal by default.
  const record = store.put(input({ content: SECRET }), NOW);
  assert.equal(record.exportPolicy, 'personal_never_export');

  assert.throws(
    () => assertNoPersonalMemory([record]),
    /personal_never_export/,
  );
});

test('assertNoPersonalMemory passes shareable records and empty batches', () => {
  const store = createInMemoryRuntimeMemoryStore();
  const shareable = store.put(input({ exportPolicy: 'shareable_aggregate' }), NOW);

  assertNoPersonalMemory([]);
  assertNoPersonalMemory([shareable]);
  assert.equal(isFineTuningExportable(shareable), true);
});

test('assertNoPersonalMemory fails closed on missing or unknown policies', () => {
  const store = createInMemoryRuntimeMemoryStore();
  const shareable = store.put(input({ exportPolicy: 'shareable_aggregate' }), NOW);

  // A record that lost its policy in transit must not be treated as shareable.
  const stripped = { ...shareable, exportPolicy: undefined } as unknown as RuntimeMemoryRecord;
  const unknownPolicy = { ...shareable, exportPolicy: 'ok_to_export' } as unknown as RuntimeMemoryRecord;

  assert.throws(() => assertNoPersonalMemory([stripped]), /export policy/);
  assert.throws(() => assertNoPersonalMemory([unknownPolicy]), /export policy/);
  assert.throws(() => assertNoPersonalMemory([null as unknown as RuntimeMemoryRecord]), /export policy/);
  assert.equal(isFineTuningExportable(stripped), false);
  assert.equal(isFineTuningExportable(unknownPolicy), false);
});

test('a single personal record blocks an otherwise shareable batch', () => {
  const store = createInMemoryRuntimeMemoryStore();
  const batch = [
    store.put(input({ exportPolicy: 'shareable_aggregate' }), NOW),
    store.put(input({ content: SECRET }), NOW),
    store.put(input({ exportPolicy: 'shareable_aggregate' }), NOW),
  ];

  assert.throws(() => assertNoPersonalMemory(batch), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, new RegExp(batch[1].id));
    // The guard names ids, never content: an exporter's crash log must not
    // become the leak the guard exists to prevent.
    assert.doesNotMatch(error.message, /Herzl/);
    return true;
  });
});

test('revoked and superseded records are still blocked by the guard', () => {
  const store = createInMemoryRuntimeMemoryStore();
  const revoked = store.put(input({ content: SECRET }), NOW);
  store.revoke(revoked.id, NOW);
  const superseded = store.put(input({ content: SECRET }), NOW);
  store.supersede(superseded.id, input({ content: 'updated' }), NOW);

  // Status is irrelevant to the guard; only exportPolicy decides.
  assert.throws(() => assertNoPersonalMemory(store.listAll('scope-a')), /personal_never_export/);
});

test('the user data export keeps personal records the fine-tuning guard rejects', () => {
  const store = createInMemoryRuntimeMemoryStore();
  store.put(input({ content: SECRET }), NOW);

  const exported = store.export('scope-a', NOW);
  assert.equal(exported.records.length, 1, 'a user data export must include the user\'s own personal memory');
  assert.throws(() => assertNoPersonalMemory(exported.records), /personal_never_export/);
});
