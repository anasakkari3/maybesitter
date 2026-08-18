/**
 * Runs the Sprint 02 fixture corpus against the real projection and the real
 * memory store.
 *
 * The corpus (#11), the projection (#9), and the store (#10) were built in
 * parallel against the shared contracts, so each was verified only against its
 * own view of them. Fixtures that are never executed are documentation, not
 * tests: they can drift from the implementation indefinitely and stay green.
 * This file is the join — it is what makes the corpus load-bearing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FIXTURE_CLOCK_ISO,
  LIFE_STATE_MEMORY_FIXTURES,
  type ExpectedField,
  type LifeStateMemoryFixture,
  type MemoryFixtureRecord,
} from './lifeStateMemoryFixtures.ts';
import { projectLifeState } from '../../lib/lifeState/lifeStateProjection.ts';
import { createInMemoryRuntimeMemoryStore } from '../../lib/runtimeMemory/runtimeMemoryStore.ts';
import { assertNoPersonalMemory } from '../../lib/runtimeMemory/exportPolicy.ts';
import type { Field } from '../../src/contracts/v1/lifeStateContracts.ts';
import type { RuntimeMemoryRecord } from '../../src/contracts/v1/memoryContracts.ts';

/**
 * Compares an actual Field against a fixture's expectation.
 *
 * Known fields are compared only on the keys the fixture pins, so a fixture
 * stays honest about what it does and does not claim (`unpinned` records why).
 * Provenance is always compared in full — it is the part of the contract most
 * likely to drift silently between modules.
 */
function assertFieldMatches<T extends object>(
  label: string,
  actual: Field<T>,
  expected: ExpectedField<T>,
): void {
  assert.equal(actual.known, expected.known, `${label}: known mismatch`);

  if (!expected.known) {
    if (actual.known) return;
    assert.equal(actual.reason, expected.reason, `${label}: unknown reason mismatch`);
    assert.equal(
      'value' in actual,
      false,
      `${label}: an unknown field must not carry a value`,
    );
  } else {
    if (!actual.known) return;
    for (const key of Object.keys(expected.value) as (keyof T)[]) {
      assert.deepEqual(
        actual.value[key],
        expected.value[key],
        `${label}: value.${String(key)} mismatch`,
      );
    }
  }

  assert.deepEqual(
    actual.provenance,
    expected.provenance,
    `${label}: provenance mismatch`,
  );
}

/** Writes a fixture's memory records in order, returning handle -> stored record. */
function writeMemoryRecords(
  fixture: LifeStateMemoryFixture,
  store: ReturnType<typeof createInMemoryRuntimeMemoryStore>,
): Map<string, RuntimeMemoryRecord> {
  const byHandle = new Map<string, RuntimeMemoryRecord>();

  for (const record of fixture.memory.records as readonly MemoryFixtureRecord[]) {
    const written = record.supersedesHandle
      ? store.supersede(
          requireHandle(byHandle, record.supersedesHandle).id,
          record.input,
          record.putAt,
        )
      : store.put(record.input, record.putAt);
    byHandle.set(record.handle, written);
  }

  return byHandle;
}

function requireHandle(
  byHandle: Map<string, RuntimeMemoryRecord>,
  handle: string,
): RuntimeMemoryRecord {
  const record = byHandle.get(handle);
  if (!record) throw new Error(`fixture references an unwritten handle: ${handle}`);
  return record;
}

/** Maps stored ids back to fixture handles so failures name the handle, not a uuid. */
function handlesOf(
  byHandle: Map<string, RuntimeMemoryRecord>,
  records: readonly RuntimeMemoryRecord[],
): string[] {
  const idToHandle = new Map<string, string>();
  byHandle.forEach((record, handle) => idToHandle.set(record.id, handle));
  return records.map((record) => idToHandle.get(record.id) ?? `<unknown:${record.id}>`);
}

for (const fixture of LIFE_STATE_MEMORY_FIXTURES) {
  test(`fixture ${fixture.id}: the real projection produces the expected LifeState`, () => {
    const actual = projectLifeState(fixture.lifeState.input);
    const expected = fixture.lifeState.expected;

    assertFieldMatches('commitments', actual.commitments, expected.commitments);
    assertFieldMatches('availability', actual.availability, expected.availability);
    assertFieldMatches('recentOutcomes', actual.recentOutcomes, expected.recentOutcomes);

    // load is pinned only on openCount/overdueCount/band; urgency score and the
    // due-soon horizon are implementation-owned.
    assert.equal(actual.load.known, expected.load.known, 'load: known mismatch');
    if (actual.load.known && expected.load.known) {
      assert.equal(actual.load.value.openCount, expected.load.value.openCount, 'load.openCount');
      assert.equal(actual.load.value.overdueCount, expected.load.value.overdueCount, 'load.overdueCount');
      assert.equal(actual.load.value.band, expected.load.value.band, 'load.band');
    }
    assert.deepEqual(actual.load.provenance, expected.load.provenance, 'load: provenance mismatch');

    assert.equal(actual.computedAt, fixture.lifeState.input.now, 'computedAt must come from input.now');
    assert.equal(actual.scopeId, fixture.lifeState.input.scopeId);
  });

  test(`fixture ${fixture.id}: LifeState carries no commitment content`, () => {
    const serialized = JSON.stringify(projectLifeState(fixture.lifeState.input));

    for (const secret of fixture.expectedAbsentFromProjection) {
      assert.equal(
        serialized.includes(secret),
        false,
        `LifeState leaked fixture content that must never appear in a projection: ${secret}`,
      );
    }
  });

  test(`fixture ${fixture.id}: the real memory store matches the expected record states`, () => {
    const store = createInMemoryRuntimeMemoryStore();
    const byHandle = writeMemoryRecords(fixture, store);

    for (const record of fixture.memory.records) {
      const stored = requireHandle(byHandle, record.handle);
      const current = store.get(stored.id);
      assert.ok(current, `${record.handle}: record should exist before prune`);
      assert.equal(current.status, record.expected.statusBeforePrune, `${record.handle}: statusBeforePrune`);
      assert.equal(current.exportPolicy, record.expected.exportPolicy, `${record.handle}: exportPolicy`);
      assert.equal(current.staleAfter, record.expected.staleAfter, `${record.handle}: staleAfter`);
    }

    const retrieved = store.retrieve({ scopeId: fixture.scopeId, now: FIXTURE_CLOCK_ISO });
    assert.deepEqual(
      handlesOf(byHandle, retrieved),
      [...fixture.memory.expectedRetrieveHandles],
      'retrieve returned the wrong records or the wrong order',
    );

    const listed = store.listAll(fixture.scopeId);
    assert.deepEqual(
      handlesOf(byHandle, listed).sort(),
      [...fixture.memory.expectedListAllHandles].sort(),
      'listAll returned the wrong record set',
    );
  });

  test(`fixture ${fixture.id}: prune and the fine-tuning guard behave as pinned`, () => {
    const store = createInMemoryRuntimeMemoryStore();
    const byHandle = writeMemoryRecords(fixture, store);

    assert.equal(
      store.prune(FIXTURE_CLOCK_ISO),
      fixture.memory.expectedPrunedCount,
      'prune expired a different number of records than the fixture pins',
    );

    for (const record of fixture.memory.records) {
      const stored = requireHandle(byHandle, record.handle);
      const current = store.get(stored.id);
      assert.ok(current, `${record.handle}: record should survive prune as a status change`);
      assert.equal(current.status, record.expected.statusAfterPrune, `${record.handle}: statusAfterPrune`);
    }

    const inScope = store.listAll(fixture.scopeId);
    if (fixture.memory.expectedAssertNoPersonalMemoryThrows) {
      assert.throws(
        () => assertNoPersonalMemory(inScope),
        `${fixture.id}: personal memory must never pass the fine-tuning guard`,
      );
    } else {
      assert.doesNotThrow(() => assertNoPersonalMemory(inScope));
    }
  });

  test(`fixture ${fixture.id}: multilingual content survives the store byte-identically`, () => {
    const store = createInMemoryRuntimeMemoryStore();
    const byHandle = writeMemoryRecords(fixture, store);

    for (const record of fixture.memory.records) {
      const stored = requireHandle(byHandle, record.handle);
      const roundTripped = store.get(stored.id);
      assert.ok(roundTripped);
      assert.equal(
        roundTripped.content,
        record.input.content,
        `${record.handle}: ${fixture.language} content was altered in storage`,
      );
      assert.equal(roundTripped.language, record.input.language, `${record.handle}: language changed`);
    }
  });
}

test('the corpus actually exercised the real modules', () => {
  // Guards against a refactor that leaves this file iterating an empty corpus
  // and reporting success.
  assert.ok(
    LIFE_STATE_MEMORY_FIXTURES.length >= 16,
    'the fixture corpus is unexpectedly small; integration coverage may have been lost',
  );
});
