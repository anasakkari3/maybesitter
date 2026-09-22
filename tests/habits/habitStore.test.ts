/**
 * The habit store's own invariants (#520).
 *
 * Separate from the contract tests because these are the guards that have to
 * hold when a second caller arrives: the store re-validates rather than
 * trusting whatever a route parsed, and a habit id from another account does
 * not resolve at all. Both are checks a service-level test cannot see, which
 * is the shape of a guard that quietly stops being exercised.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { StorageHabitStore } from '../../lib/habits/habitStore.ts';
import { parseHabitPatchInput } from '../../src/contracts/v1/habitContracts.ts';
import { NOW, SCOPE, habitInput } from './habitSupport.ts';

const LATER = '2026-03-10T09:00:00.000Z';
const STRANGER = 'habitStranger';

function store() {
  return new StorageHabitStore(createMemoryStorage());
}

test('a created habit is active, stamped, and readable back in its own scope', async () => {
  const habits = store();
  const created = await habits.create(habitInput(), NOW);

  assert.equal(created.status, 'active');
  assert.equal(created.createdAt, NOW);
  assert.equal(created.updatedAt, NOW);
  assert.deepEqual(await habits.get(SCOPE, created.habitId), created);
  assert.deepEqual(await habits.list(SCOPE), [created]);
});

test('the store re-validates rather than trusting its caller', async () => {
  const habits = store();
  // A route that skipped its own parse, or a service that built the object by
  // hand: the confirmation is the one field that must never be optional, and
  // the check that matters is the one nearest the write.
  const { confirmation: _dropped, ...unconfirmed } = habitInput();
  await assert.rejects(
    () => habits.create(unconfirmed as never, NOW),
    /confirmation is required/,
  );
  await assert.rejects(
    () => habits.create(habitInput({ durationMinutes: 0 }), NOW),
    /durationMinutes must be between 1 and 480/,
  );
  assert.deepEqual(await habits.list(SCOPE), []);
});

test('a habit id from another account reads as absent, and patches nothing', async () => {
  const habits = store();
  const mine = await habits.create(habitInput(), NOW);

  assert.equal(await habits.get(STRANGER, mine.habitId), null);
  assert.equal(await habits.patch(STRANGER, mine.habitId, { title: 'theirs' }, LATER), null);
  assert.equal(await habits.remove(STRANGER, mine.habitId), false);
  assert.equal((await habits.get(SCOPE, mine.habitId))?.title, 'Gym');
});

test('pausing is a patch, and it keeps the habit and its history', async () => {
  const habits = store();
  const created = await habits.create(habitInput(), NOW);

  const paused = await habits.patch(SCOPE, created.habitId, parseHabitPatchInput({ status: 'paused' }), LATER);
  assert.equal(paused?.status, 'paused');
  assert.equal(paused?.createdAt, NOW);
  assert.equal(paused?.updatedAt, LATER);
  // Still there, still listed: a pause is not a delete.
  assert.equal((await habits.list(SCOPE)).length, 1);
  assert.equal((await habits.get(SCOPE, created.habitId))?.status, 'paused');

  const resumed = await habits.patch(SCOPE, created.habitId, { status: 'active' }, LATER);
  assert.equal(resumed?.status, 'active');
});

test('a document nothing wrote reads as absent rather than as a habit', async () => {
  const storage = createMemoryStorage();
  const habits = new StorageHabitStore(storage);
  const created = await habits.create(habitInput(), NOW);
  // Somebody edits the console, or a migration half-lands. Materialization
  // must not go on to generate occurrences from whatever is in the field.
  await storage.set(`users/${SCOPE}/habits/${created.habitId}`, {
    ...created,
    cadence: { kind: 'weekly_count', count: 400 },
  });
  assert.equal(await habits.get(SCOPE, created.habitId), null);
  assert.deepEqual(await habits.list(SCOPE), []);
});

test('remove and deleteScope take this account’s habits and nobody else’s', async () => {
  const habits = store();
  const mine = await habits.create(habitInput(), NOW);
  const alsoMine = await habits.create(habitInput({ title: 'Reading' }), LATER);
  const theirs = await habits.create(habitInput({ scopeId: STRANGER }), NOW);

  assert.equal(await habits.remove(SCOPE, mine.habitId), true);
  assert.equal(await habits.remove(SCOPE, mine.habitId), false);
  assert.deepEqual((await habits.list(SCOPE)).map((entry) => entry.habitId), [alsoMine.habitId]);

  assert.equal(await habits.deleteScope(SCOPE), 1);
  assert.deepEqual(await habits.list(SCOPE), []);
  assert.deepEqual((await habits.list(STRANGER)).map((entry) => entry.habitId), [theirs.habitId]);
});

test('the list order is stable across reads, including for a tie', async () => {
  const habits = store();
  const first = await habits.create(habitInput({ title: 'One' }), NOW);
  const second = await habits.create(habitInput({ title: 'Two' }), NOW);
  const expected = [first, second].sort((a, b) => (a.habitId < b.habitId ? -1 : 1))
    .map((entry) => entry.habitId);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.deepEqual((await habits.list(SCOPE)).map((entry) => entry.habitId), expected);
  }
});
