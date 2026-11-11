/**
 * Background work respects a switched-off add-on (owner direction, 2026-11-10):
 * the watcher sweep passes over a watcher its caller says to skip, before it
 * evaluates, fires or writes anything.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { runWatcherSweep } from '../../lib/watchers/watcherEngine.ts';

const NOW = new Date('2026-11-10T21:00:00.000Z');

async function seedWatcher() {
  const storage = createMemoryStorage();
  // Deliberately incomplete: evaluating it fails, which is how the test sees
  // whether the sweep reached it.
  const stored = { definition: { watcherId: 'w1', scopeId: 'u1', source: { signalKind: 'fixture' } }, runtime: {} };
  await storage.set('users/u1/watchers/w1', stored);
  return { storage, before: JSON.stringify(stored) };
}

test('a skipped watcher is neither evaluated nor written', async () => {
  const { storage, before } = await seedWatcher();
  const seen: Array<{ scopeId: string; signalKind: string }> = [];
  const totals = await runWatcherSweep({
    storage, now: NOW, skip: async (watcher) => { seen.push({ ...watcher }); return true; },
  });
  assert.deepEqual(seen, [{ scopeId: 'u1', signalKind: 'fixture' }]);
  assert.equal(totals.scanned, 1);
  assert.equal(totals.evaluated, 0);
  assert.deepEqual(totals.failures, []);
  assert.equal(JSON.stringify(await storage.get('users/u1/watchers/w1')), before);
});

test('without a skip the sweep reaches the same watcher', async () => {
  const { storage } = await seedWatcher();
  const totals = await runWatcherSweep({ storage, now: NOW, skip: async () => false });
  assert.equal(totals.failures.length + totals.evaluated > 0, true);
});
