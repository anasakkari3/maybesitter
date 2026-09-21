/**
 * The seed store's own invariants (#519).
 *
 * Separate from `tests/mobile/intentSeeds.test.ts` because the route tests
 * cannot see these. `seedService` refuses a `promoted` status before the store
 * is ever asked, and it short-circuits a second promotion before
 * `claimPromotion` is called — so deleting either guard inside the store
 * leaves every route test green. That is precisely the shape of a test that
 * cannot fail for its own defect, and these two guards are not decoration:
 * they are what holds when two requests arrive together and both get past the
 * service's read.
 *
 * So this file talks to the store directly, and each test names the race or
 * the bypass it stands for.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { StorageIntentSeedStore } from '../../lib/intentSeeds/intentSeedStore.ts';
import type { CreateSeedInput } from '../../src/contracts/v1/intentContracts.ts';

const NOW = '2026-09-20T09:00:00.000Z';
const LATER = '2026-09-20T10:00:00.000Z';
const MINE = 'seedStoreOwner';
const THEIRS = 'seedStoreStranger';

function storeWithAdapter() {
  return new StorageIntentSeedStore(createMemoryStorage());
}

function input(overrides: Partial<CreateSeedInput> = {}): CreateSeedInput {
  return {
    scopeId: MINE,
    kind: 'consideration',
    summary: "Maybe I'll apply to NVIDIA this semester.",
    source: 'capture',
    sourceRef: 'proposal-1',
    provenance: { proposalId: 'proposal-1', extractor: 'rule-based', confirmedByUserAt: NOW },
    idempotencyKey: 'key-1',
    ...overrides,
  };
}

test('create is keyed by the idempotency key, so two taps write one seed', async () => {
  const store = storeWithAdapter();
  const first = await store.create(input(), NOW);
  const second = await store.create(input(), LATER);

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(second.seed.seedId, first.seed.seedId);
  // And the second call did not rewrite the first seed's timestamps.
  assert.equal(second.seed.createdAt, NOW);
  assert.equal((await store.list(MINE)).length, 1);
});

test('a created seed is open, unpromoted, and carries no date the user did not set', async () => {
  const { seed } = await storeWithAdapter().create(input(), NOW);

  assert.equal(seed.status, 'open');
  assert.equal(seed.promotedTo, null);
  assert.equal(seed.revisitAt, null);
  assert.equal(seed.createdAt, NOW);
  assert.equal(seed.updatedAt, NOW);
});

test('patch refuses every status that is not the user’s to choose', async () => {
  const store = storeWithAdapter();
  const { seed } = await store.create(input(), NOW);

  for (const status of ['promoted', 'expired'] as const) {
    // Straight at the store, past the service's own validation. This is the
    // guard that has to hold if a second caller is ever added.
    assert.equal(await store.patch(MINE, seed.seedId, { status }, LATER), null, status);
  }
  const unchanged = await store.get(MINE, seed.seedId);
  assert.equal(unchanged?.status, 'open');
  assert.equal(unchanged?.promotedTo, null);
});

test('patch accepts the four the user can choose', async () => {
  const store = storeWithAdapter();
  const { seed } = await store.create(input(), NOW);

  for (const status of ['snoozed', 'waiting', 'open', 'dismissed'] as const) {
    const updated = await store.patch(MINE, seed.seedId, { status }, LATER);
    assert.equal(updated?.status, status);
  }
});

test('a promotion is claimed exactly once, whoever asks second', async () => {
  const store = storeWithAdapter();
  const { seed } = await store.create(input(), NOW);

  const first = await store.claimPromotion(MINE, seed.seedId, { kind: 'commitment', id: 'c1' }, LATER);
  // The racing second request: it got past the service's read because the
  // first had not committed yet, and this is the only thing standing between
  // it and a second commitment for one thought.
  const second = await store.claimPromotion(MINE, seed.seedId, { kind: 'commitment', id: 'c2' }, LATER);

  assert.equal(first?.promotedTo?.id, 'c1');
  assert.equal(second, null, 'a second claim was allowed');
  assert.equal((await store.get(MINE, seed.seedId))?.promotedTo?.id, 'c1');
});

test('a dismissed seed cannot be claimed, and a promoted one cannot be patched', async () => {
  const store = storeWithAdapter();
  const { seed } = await store.create(input(), NOW);
  await store.patch(MINE, seed.seedId, { status: 'dismissed' }, LATER);
  assert.equal(await store.claimPromotion(MINE, seed.seedId, { kind: 'goal', id: 'g1' }, LATER), null);

  // A patch that names no status at all: the only thing refusing it is the
  // `promoted` guard, which is what makes this a test of that guard rather
  // than of the status allowlist beside it.
  const other = await store.create(input({ idempotencyKey: 'key-2' }), NOW);
  await store.claimPromotion(MINE, other.seed.seedId, { kind: 'goal', id: 'g2' }, LATER);
  assert.equal(await store.patch(MINE, other.seed.seedId, { summary: 'rewritten' }, LATER), null);
  assert.equal((await store.get(MINE, other.seed.seedId))?.summary, input().summary);
});

test('a seed in another scope is not readable, patchable, claimable or removable', async () => {
  const store = storeWithAdapter();
  const { seed } = await store.create(input(), NOW);

  assert.equal(await store.get(THEIRS, seed.seedId), null);
  assert.equal(await store.patch(THEIRS, seed.seedId, { status: 'dismissed' }, LATER), null);
  assert.equal(await store.claimPromotion(THEIRS, seed.seedId, { kind: 'goal', id: 'g' }, LATER), null);
  assert.equal(await store.remove(THEIRS, seed.seedId), false);
  assert.deepEqual(await store.list(THEIRS), []);
  assert.equal((await store.get(MINE, seed.seedId))?.status, 'open');
});

test('the list is newest first, and ties break the same way on every read', async () => {
  const store = storeWithAdapter();
  // Three distinct instants, created out of order, so "newest first" is a
  // claim about the timestamps rather than about whatever order the adapter
  // happens to return documents in. Two of the three share an instant, which
  // is the tie the id has to break the same way on every read.
  const middle = '2026-09-20T09:30:00.000Z';
  await store.create(input({ idempotencyKey: 'a' }), middle);
  await store.create(input({ idempotencyKey: 'b' }), LATER);
  await store.create(input({ idempotencyKey: 'c' }), NOW);
  await store.create(input({ idempotencyKey: 'd' }), NOW);

  const once = await store.list(MINE);
  const twice = await store.list(MINE);
  assert.deepEqual(
    once.map((seed) => seed.createdAt),
    [LATER, middle, NOW, NOW],
    'the list is not newest first',
  );
  assert.deepEqual(
    once.map((seed) => seed.seedId),
    twice.map((seed) => seed.seedId),
    'two reads of one save disagreed about the order',
  );
});

test('deleteScope empties one scope and leaves the other alone', async () => {
  const store = storeWithAdapter();
  await store.create(input(), NOW);
  await store.create(input({ scopeId: THEIRS, idempotencyKey: 'theirs' }), NOW);

  assert.equal(await store.deleteScope(MINE), 1);
  assert.deepEqual(await store.list(MINE), []);
  assert.equal((await store.list(THEIRS)).length, 1);
});

test('the export names the scope and the instant, and carries terminal rows', async () => {
  const store = storeWithAdapter();
  const { seed } = await store.create(input(), NOW);
  await store.patch(MINE, seed.seedId, { status: 'dismissed' }, LATER);

  const exported = await store.export(MINE, LATER);
  assert.equal(exported.scopeId, MINE);
  assert.equal(exported.exportedAt, LATER);
  assert.equal(exported.seeds.length, 1);
  assert.equal(exported.seeds[0]!.status, 'dismissed');
});
