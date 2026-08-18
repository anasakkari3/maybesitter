/**
 * Lock tests for the held-out Priority evaluation split (Sprint 04, #19).
 *
 * The locked split is what an eventual annotation run is measured against, so
 * editing a locked pair after judgments exist would silently change what those
 * judgments refer to. These tests hold the lock to the same standard as
 * tests/evaluation/lockedTestPolicy.test.ts holds the dataset ledger: a checksum
 * that detects an edit, and a chain that detects the ledger row being rewritten
 * to match the edit.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { PRIORITY_SEED_PAIRS, lockedSplitPairs } from '../fixtures/prioritySeedSet.ts';
import {
  SEED_SET_LOCK_CONTRACT_VERSION,
  computeLockedSplitChecksum,
  parseSeedSetLock,
  readSeedSetLock,
  sealSeedSetLock,
  verifySeedSetLock,
} from '../../lib/priority/rubric/seedSetLock.ts';
import { hasIssue } from '../../lib/evaluation/registry/validationPrimitives.ts';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

test('the committed lock verifies against the committed seed set', () => {
  const result = verifySeedSetLock();

  assert.equal(result.valid, true, JSON.stringify(result.issues, null, 2));
});

test('the committed lock parses and declares the split it protects', () => {
  const parsed = parseSeedSetLock(readSeedSetLock());

  assert.equal(parsed.valid, true, JSON.stringify(parsed.issues, null, 2));
  assert.equal(parsed.lock?.contractVersion, SEED_SET_LOCK_CONTRACT_VERSION);

  const active = parsed.lock?.records.filter((record) => record.state === 'active') ?? [];
  assert.equal(active.length, 1, 'exactly one active lock row protects the current split');
  assert.deepEqual(
    active[0].pairIds,
    lockedSplitPairs().map((pair) => pair.pairId),
  );
  assert.equal(active[0].pairCount, lockedSplitPairs().length);
});

test('editing the text of a locked pair breaks the checksum', () => {
  const tampered = clone(PRIORITY_SEED_PAIRS as unknown as typeof PRIORITY_SEED_PAIRS[number][]);
  const target = tampered.find((pair) => pair.split === 'locked');
  assert.ok(target, 'the seed set must contain at least one locked pair');
  (target as { left: { commitment: { title: string } } }).left.commitment.title = 'edited after locking';

  const result = verifySeedSetLock({ pairs: tampered });

  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'PSL030'));
});

test('editing a calibration pair does not break the lock', () => {
  const tampered = clone(PRIORITY_SEED_PAIRS as unknown as typeof PRIORITY_SEED_PAIRS[number][]);
  const target = tampered.find((pair) => pair.split === 'calibration');
  assert.ok(target, 'the seed set must contain calibration pairs');
  (target as { left: { commitment: { title: string } } }).left.commitment.title = 'edited freely';

  assert.equal(verifySeedSetLock({ pairs: tampered }).valid, true);
});

test('removing a pair from the locked split is detected as a membership change', () => {
  const shrunk = clone(PRIORITY_SEED_PAIRS as unknown as typeof PRIORITY_SEED_PAIRS[number][]).filter(
    (pair) => pair.pairId !== lockedSplitPairs()[0].pairId,
  );

  const result = verifySeedSetLock({ pairs: shrunk });

  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'PSL031'), 'the membership change must be named, not only the checksum drift');
});

test('promoting an extra pair into the locked split is detected', () => {
  const grown = clone(PRIORITY_SEED_PAIRS as unknown as typeof PRIORITY_SEED_PAIRS[number][]);
  const promoted = grown.find((pair) => pair.split === 'calibration');
  (promoted as { split: string }).split = 'locked';

  const result = verifySeedSetLock({ pairs: grown });

  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'PSL031'));
});

test('rewriting the sealed row in place to match an edited split breaks the chain', () => {
  const tampered = clone(PRIORITY_SEED_PAIRS as unknown as typeof PRIORITY_SEED_PAIRS[number][]);
  const target = tampered.find((pair) => pair.split === 'locked');
  (target as { left: { commitment: { title: string } } }).left.commitment.title = 'edited after locking';

  // Make the lock file agree with the edit, exactly as someone hiding the edit would.
  const lock = clone(parseSeedSetLock(readSeedSetLock()).lock!);
  lock.records[0].checksum = computeLockedSplitChecksum(tampered.filter((pair) => pair.split === 'locked'));

  const result = verifySeedSetLock({ pairs: tampered, lock });

  assert.equal(result.valid, false, 'the row still carries the chain checksum it was sealed with');
  assert.ok(hasIssue(result, 'PSL040'));
});

test('appending a supersession row leaves earlier chain checksums untouched', () => {
  const first = parseSeedSetLock(readSeedSetLock()).lock!;
  const appended = sealSeedSetLock({
    contractVersion: SEED_SET_LOCK_CONTRACT_VERSION,
    records: [
      { ...clone(first.records[0]), state: 'superseded', supersededBy: 'priority-seed-set-locked-v2' },
      {
        ...clone(first.records[0]),
        splitId: 'priority-seed-set-locked-v2',
        state: 'active',
        supersededBy: null,
      },
    ],
  });

  assert.equal(appended.records.length, 2);
  assert.notDeepEqual(appended.records[0].chainChecksum, appended.records[1].chainChecksum);

  // Sealing the same history twice is stable — the chain is a function of the rows.
  const resealed = sealSeedSetLock({ contractVersion: SEED_SET_LOCK_CONTRACT_VERSION, records: appended.records });
  assert.deepEqual(resealed.records, appended.records);
});

test('the checksum is order-independent over the split but sensitive to its content', () => {
  const locked = lockedSplitPairs();
  const reversed = [...locked].reverse();

  assert.deepEqual(computeLockedSplitChecksum(locked), computeLockedSplitChecksum(reversed));

  const edited = clone(locked as unknown as typeof locked[number][]);
  (edited[0] as { rubricClause: string }).rubricClause = 'C9';
  assert.notDeepEqual(computeLockedSplitChecksum(locked), computeLockedSplitChecksum(edited));
});

test('a lock file with no active row is rejected rather than silently unprotecting the split', () => {
  const lock = clone(parseSeedSetLock(readSeedSetLock()).lock!);
  lock.records[0].state = 'superseded';
  lock.records[0].supersededBy = 'priority-seed-set-locked-v2';
  const resealed = sealSeedSetLock(lock);

  const result = verifySeedSetLock({ lock: resealed });

  assert.equal(result.valid, false);
  assert.ok(hasIssue(result, 'PSL020'));
});
