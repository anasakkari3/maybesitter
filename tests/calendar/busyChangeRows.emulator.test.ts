/**
 * Busy-block change rows against real Firestore (#611).
 *
 * The memory adapter models Firestore's transactions, but the producer leans
 * on three things only the real one can confirm: reads issued concurrently
 * inside one transaction (the account and every block of a commit), a commit
 * of up to 400 writes, and a sync that spans several commits. Each is run here
 * against the emulator.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreStorage } from '../../lib/storage/firestoreAdapter.ts';
import { BUSY_BLOCKS, PLANNING_STATE_CHANGES, userCol, userDoc } from '../../lib/storage/paths.ts';
import {
  busyBlockId,
  deleteBusySource,
  replaceBusyBlocks,
  type BusyBlock,
} from '../../lib/calendar/busyBlocks.ts';
import { resolveChangedEntityFacts } from '../../lib/services/dailyPlan/changedEntityFacts.ts';
import type { PlanningStateChange } from '../../src/contracts/v1/watcherContracts.ts';

const SOURCE = 'device:5d0c2b1a-9e8f-4a7b-8c6d-1e2f3a4b5c6d';
const START = Date.parse('2026-09-15T00:00:00.000Z');
const WINDOW = { startsAt: new Date(START).toISOString(), endsAt: new Date(START + 28 * 86_400_000).toISOString() };

function blocksFrom(count: number, shiftMinutes = 0): BusyBlock[] {
  return Array.from({ length: count }, (_, index) => {
    const start = START + index * 60 * 60_000 + shiftMinutes * 60_000;
    const startAt = new Date(start).toISOString();
    return {
      blockId: busyBlockId(SOURCE, `evt-${index}`, startAt),
      sourceId: SOURCE,
      sourceKind: 'device' as const,
      startAt,
      endAt: new Date(start + 30 * 60_000).toISOString(),
      allDay: false,
    };
  });
}

test('firestore: a multi-commit sync writes each block with its row, an identical re-sync writes none, and a move is two rows per meeting', async () => {
  const storage = createFirestoreStorage();
  const uid = `busy_rows_${Date.now().toString(36)}`;
  const rows = async () => (await storage.list<PlanningStateChange>(userCol(uid, PLANNING_STATE_CHANGES))).map((row) => row.data);
  const drain = async () => {
    const found = await storage.list<PlanningStateChange>(userCol(uid, PLANNING_STATE_CHANGES));
    for (const row of found) await storage.delete(`${userCol(uid, PLANNING_STATE_CHANGES)}/${row.id}`);
    return found.map((row) => row.data);
  };
  try {
    await storage.set(userDoc(uid), { timezone: 'UTC', locale: 'en' });

    // 450 blocks: three commits of the producer's chunk size.
    const first = blocksFrom(450);
    await replaceBusyBlocks(uid, SOURCE, WINDOW, first, { storage });
    const announced = await drain();
    assert.equal(announced.length, 450);
    assert.deepEqual(new Set(announced.map((row) => row.entityId)), new Set(first.map((block) => block.blockId)));
    assert.ok(announced.every((row) => row.source === 'calendar' && row.scopeId === uid));

    await replaceBusyBlocks(uid, SOURCE, WINDOW, first, { storage });
    assert.deepEqual(await rows(), [], 'an identical re-sync writes no row');

    // Every meeting moves a quarter of an hour: 300 new ids, 300 freed.
    const moved = blocksFrom(300, 15);
    await replaceBusyBlocks(uid, SOURCE, WINDOW, moved, { storage });
    const changes = await drain();
    assert.equal(changes.length, 450 + 300, '300 moves are 600 rows, and 150 dropped meetings are 150 more');
    const facts = await resolveChangedEntityFacts(uid, changes, { storage });
    const freed = changes.filter((row) => facts.get(row.changeId)?.interval === null).length;
    assert.equal(freed, 450, 'every old id resolves as deleted');
    const removals = changes.filter((row) => facts.get(row.changeId)?.interval === null);
    assert.ok(removals.every((row) => row.beforeInterval && facts.get(row.changeId)?.previousInterval?.startsAt === row.beforeInterval.startsAt),
      'each removal carries where it was, through Firestore, and the resolver reads it back');
    assert.equal((await storage.list(userCol(uid, BUSY_BLOCKS))).length, 300);

    assert.deepEqual(await deleteBusySource(uid, SOURCE, { storage }), { deleted: 300 });
    assert.equal((await drain()).length, 300);
  } finally {
    await storage.deleteTree(userDoc(uid));
  }
});

test('firestore: an account marked deleted gets blocks cleaned up and no row', async () => {
  const storage = createFirestoreStorage();
  const uid = `busy_rows_gone_${Date.now().toString(36)}`;
  try {
    await storage.set(userDoc(uid), { trust: { deletedAt: new Date(START).toISOString() } });
    await replaceBusyBlocks(uid, SOURCE, WINDOW, blocksFrom(3), { storage });
    await deleteBusySource(uid, SOURCE, { storage });
    assert.deepEqual(await storage.list(userCol(uid, PLANNING_STATE_CHANGES)), []);
    assert.deepEqual(await storage.list(userCol(uid, BUSY_BLOCKS)), []);
  } finally {
    await storage.deleteTree(userDoc(uid));
  }
});
