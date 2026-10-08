/**
 * The M4a busy-read query plan against real Firestore.
 *
 * Fixtures go through the production busy-block writer. The assertions pin the
 * bounded query shapes and source-document reads because the emulator does not
 * enforce production composite indexes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { replaceBusyBlocks, type BusyBlock } from '../../lib/calendar/busyBlocks.ts';
import {
  createFirestoreStorage,
  resetFirestoreForTests,
  resetStorageForTests,
  setStorageForTests,
  type ListOptions,
  type StorageAdapter,
} from '../../lib/storage/index.ts';
import { BUSY_BLOCKS, CALENDAR_SOURCES, ICS_FEEDS, userCol, userDoc, userSubDoc } from '../../lib/storage/paths.ts';
import { installFakeAuth, tokenFor, uidFor } from '../support/fakeAuth.ts';
import { GET as busyGet } from '../../src/app/api/mobile/calendar/busy/route.ts';

const emulatorSkip = process.env.FIRESTORE_EMULATOR_HOST
  ? false
  : 'FIRESTORE_EMULATOR_HOST is not set; run npm run test:emulator';
const FROM = '2026-10-07T00:00:00.000Z';
const TO = '2026-10-14T00:00:00.000Z';

interface ReadCounts {
  busyQueries: ListOptions[];
  calendarSourceGets: number;
  calendarSourceLists: number;
}

function block(sourceId: string, blockId: string, startAt: string, endAt: string, sourceKind: BusyBlock['sourceKind']): BusyBlock {
  return { blockId, sourceId, sourceKind, startAt, endAt, allDay: false };
}

async function withFirestoreCase(
  label: string,
  run: (context: { uid: string; storage: StorageAdapter; counts: ReadCounts; get: (from?: string, to?: string) => Promise<any> }) => Promise<void>,
): Promise<void> {
  resetFirestoreForTests();
  const storage = createFirestoreStorage();
  const auth = installFakeAuth();
  const uid = uidFor(`${label}${Date.now().toString(36)}`);
  const saved = {
    feature: process.env.MAYBESITTER_FEATURE_FREE_SLOTS,
    killed: process.env.MAYBESITTER_KILL_SWITCH_FREE_SLOTS,
    environment: process.env.MAYBESITTER_ENV,
  };
  process.env.MAYBESITTER_FEATURE_FREE_SLOTS = 'true';
  process.env.MAYBESITTER_KILL_SWITCH_FREE_SLOTS = 'false';
  process.env.MAYBESITTER_ENV = 'test';
  const counts: ReadCounts = { busyQueries: [], calendarSourceGets: 0, calendarSourceLists: 0 };
  const counted: StorageAdapter = {
    get: async <T>(path: string) => {
      if (path.startsWith(`${userCol(uid, CALENDAR_SOURCES)}/`)) counts.calendarSourceGets += 1;
      return storage.get<T>(path);
    },
    list: async <T>(path: string, options?: ListOptions) => {
      if (path === userCol(uid, BUSY_BLOCKS)) counts.busyQueries.push(options ?? {});
      if (path === userCol(uid, CALENDAR_SOURCES)) counts.calendarSourceLists += 1;
      return storage.list<T>(path, options);
    },
    listGroup: storage.listGroup.bind(storage),
    set: storage.set.bind(storage),
    delete: storage.delete.bind(storage),
    runTransaction: storage.runTransaction.bind(storage),
    deleteTree: storage.deleteTree.bind(storage),
  };
  const get = async (from = FROM, to = TO) => {
    const response = await busyGet(new Request(
      `http://localhost:3000/api/mobile/calendar/busy?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      { headers: { authorization: `Bearer ${tokenFor(uid)}` } },
    ));
    return { status: response.status, body: await response.json() as any };
  };
  try {
    await storage.set(userDoc(uid), { timezone: 'UTC', locale: 'en' });
    setStorageForTests(counted);
    await run({ uid, storage, counts, get });
  } finally {
    resetStorageForTests();
    auth.restore();
    await storage.deleteTree(userDoc(uid));
    resetFirestoreForTests();
    if (saved.feature === undefined) delete process.env.MAYBESITTER_FEATURE_FREE_SLOTS;
    else process.env.MAYBESITTER_FEATURE_FREE_SLOTS = saved.feature;
    if (saved.killed === undefined) delete process.env.MAYBESITTER_KILL_SWITCH_FREE_SLOTS;
    else process.env.MAYBESITTER_KILL_SWITCH_FREE_SLOTS = saved.killed;
    if (saved.environment === undefined) delete process.env.MAYBESITTER_ENV;
    else process.env.MAYBESITTER_ENV = saved.environment;
  }
}

test('firestore M4a: query shapes and calendar-source reads stay source-bounded', { skip: emulatorSkip }, async () => {
  await withFirestoreCase('BusyReadShapes', async ({ uid, storage, counts, get }) => {
    for (const feedId of ['one', 'two']) {
      const sourceId = `ics:${feedId}`;
      await storage.set(userSubDoc(uid, ICS_FEEDS, feedId), { feedId, status: 'ok', lastFetchedAt: new Date().toISOString() });
      await replaceBusyBlocks(uid, sourceId, { startsAt: FROM, endsAt: TO }, [
        block(sourceId, feedId, '2026-10-08T09:00:00.000Z', '2026-10-08T10:00:00.000Z', 'ics'),
      ], { storage, platform: null });
    }
    await replaceBusyBlocks(uid, 'manual:test', { startsAt: FROM, endsAt: TO }, [
      block('manual:test', 'manual', '2026-10-09T09:00:00.000Z', '2026-10-09T10:00:00.000Z', 'manual'),
    ], { storage, platform: null });
    for (let index = 0; index < 60; index += 1) {
      await replaceBusyBlocks(uid, `manual:empty-${index}`, { startsAt: FROM, endsAt: TO }, [], { storage, platform: null });
    }

    const result = await get();
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.blocks.length, 3);
    assert.equal(counts.busyQueries.length, 4, 'two manual queries plus one overlap query per ICS feed');
    assert.equal(counts.calendarSourceGets, 2, 'one source document per ICS feed, independent of 60 manual sources');
    assert.equal(counts.calendarSourceLists, 0, 'the GET never scans calendarSources');
    assert.deepEqual(counts.busyQueries.slice(0, 2).map((query) => query.limit), [2001, 2001]);
    assert.ok(counts.busyQueries.slice(2).every((query) => query.where?.some(([field, op]) => field === 'sourceId' && op === '==')));
  });
});

test('firestore M4a: more than 2000 matching rows reports the first omitted start', { skip: emulatorSkip }, async () => {
  await withFirestoreCase('BusyReadDense', async ({ uid, storage, counts, get }) => {
    const sourceId = 'manual:dense';
    // After `from + 40h`, so the carry-in query (which saturates to
    // `cutoff = from`, WIRE) does not see them and the in-window limit decides.
    const rows = Array.from({ length: 2001 }, (_, index) => {
      const start = Date.parse('2026-10-09T12:00:00.000Z') + index * 10_000;
      return block(sourceId, `dense-${index}`, new Date(start).toISOString(), new Date(start + 5_000).toISOString(), 'manual');
    });
    await replaceBusyBlocks(uid, sourceId, { startsAt: FROM, endsAt: TO }, rows, { storage, platform: null });
    const result = await get();
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.complete, false);
    assert.equal(result.body.cutoff, rows[2000]!.startAt);
    assert.equal(result.body.blocks.length, 2000);
    assert.equal(counts.busyQueries.length, 2);
  });
});

test('firestore M4a: expired carry-in rows do not hide a live row', { skip: emulatorSkip }, async () => {
  await withFirestoreCase('BusyReadCarry', async ({ uid, storage, counts, get }) => {
    const sourceId = 'manual:carry';
    const from = '2026-10-08T00:00:00.000Z';
    const expired = Array.from({ length: 2001 }, (_, index) => {
      const start = Date.parse(from) - 25 * 3_600_000 + index * 30_000;
      return block(sourceId, `old-${index}`, new Date(start).toISOString(), new Date(start + 20_000).toISOString(), 'manual');
    });
    const live = block(sourceId, 'live', '2026-10-08T01:00:00.000Z', '2026-10-08T02:00:00.000Z', 'manual');
    await replaceBusyBlocks(uid, sourceId, { startsAt: FROM, endsAt: TO }, [...expired, live], { storage, platform: null });
    const result = await get(from, '2026-10-08T23:59:00.000Z');
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.ok(result.body.blocks.some((row: BusyBlock) => row.blockId === 'live'));
    assert.ok(!result.body.blocks.some((row: BusyBlock) => row.blockId.startsWith('old-')));
    assert.equal(counts.busyQueries.length, 2);
  });
});

test('firestore M4a: saturation before from marks the whole requested window unknown', { skip: emulatorSkip }, async () => {
  await withFirestoreCase('BusyReadBefore', async ({ uid, storage, counts, get }) => {
    const sourceId = 'manual:before';
    const fromMs = Date.parse(FROM);
    const before = Array.from({ length: 2001 }, (_, index) => {
      const start = fromMs - 13 * 3_600_000 + index * 10_000;
      return block(sourceId, `before-${index}`, new Date(start).toISOString(), new Date(start + 5_000).toISOString(), 'manual');
    });
    const live = block(sourceId, 'live', '2026-10-08T10:00:00.000Z', '2026-10-08T11:00:00.000Z', 'manual');
    await replaceBusyBlocks(uid, sourceId, { startsAt: new Date(fromMs - 14 * 3_600_000).toISOString(), endsAt: TO }, [...before, live], { storage, platform: null });
    const result = await get();
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.complete, false);
    assert.equal(result.body.cutoff, FROM);
    assert.equal(counts.busyQueries.length, 2);
  });
});

test('firestore M4a: an orphan ICS source is excluded without an overlap query', { skip: emulatorSkip }, async () => {
  await withFirestoreCase('BusyReadOrphan', async ({ uid, storage, counts, get }) => {
    const sourceId = 'ics:orphan';
    await replaceBusyBlocks(uid, sourceId, { startsAt: FROM, endsAt: TO }, [
      block(sourceId, 'orphan', '2026-10-08T09:00:00.000Z', '2026-10-08T10:00:00.000Z', 'ics'),
    ], { storage, platform: null });
    const result = await get();
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.ok(!result.body.blocks.some((row: BusyBlock) => row.sourceId === sourceId));
    assert.equal(counts.busyQueries.length, 2);
    assert.equal(counts.calendarSourceGets, 0);
    assert.equal(counts.calendarSourceLists, 0);
  });
});
