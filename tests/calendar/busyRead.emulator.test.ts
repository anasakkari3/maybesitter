/**
 * The M4a busy-read query plan against real Firestore.
 *
 * The memory acceptance gate proves response semantics. This test makes the
 * three indexed range-query shapes execute in Firestore and pins the scan
 * count: two bounded manual queries plus one overlap query for each active ICS
 * feed (and no query per calendar-source document).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
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

test('firestore M4a: busy GET uses two manual queries and one indexed overlap query per ICS feed', { skip: emulatorSkip }, async () => {
  resetFirestoreForTests();
  const storage = createFirestoreStorage();
  const auth = installFakeAuth();
  const uid = uidFor(`BusyRead${Date.now().toString(36)}`);
  const saved = {
    feature: process.env.MAYBESITTER_FEATURE_FREE_SLOTS,
    killed: process.env.MAYBESITTER_KILL_SWITCH_FREE_SLOTS,
    environment: process.env.MAYBESITTER_ENV,
  };
  process.env.MAYBESITTER_FEATURE_FREE_SLOTS = 'true';
  process.env.MAYBESITTER_KILL_SWITCH_FREE_SLOTS = 'false';
  process.env.MAYBESITTER_ENV = 'test';

  let busyQueries = 0;
  const counted: StorageAdapter = {
    get: storage.get.bind(storage),
    list: async <T>(path: string, options?: ListOptions) => {
      if (path === userCol(uid, BUSY_BLOCKS)) busyQueries += 1;
      return storage.list<T>(path, options);
    },
    listGroup: storage.listGroup.bind(storage),
    set: storage.set.bind(storage),
    delete: storage.delete.bind(storage),
    runTransaction: storage.runTransaction.bind(storage),
    deleteTree: storage.deleteTree.bind(storage),
  };
  setStorageForTests(counted);

  const from = '2026-10-07T00:00:00.000Z';
  const to = '2026-10-14T00:00:00.000Z';
  try {
    await storage.set(userDoc(uid), { timezone: 'UTC', locale: 'en' });
    for (const feedId of ['one', 'two']) {
      const sourceId = `ics:${feedId}`;
      await storage.set(userSubDoc(uid, ICS_FEEDS, feedId), {
        feedId, status: 'ok', lastFetchedAt: new Date().toISOString(),
      });
      await storage.set(userSubDoc(uid, CALENDAR_SOURCES, sourceId), {
        sourceId, sourceKind: 'ics', windowStart: from, windowEnd: to,
      });
      await storage.set(`${userCol(uid, BUSY_BLOCKS)}/${feedId}`, {
        blockId: feedId, sourceId, sourceKind: 'ics',
        startAt: '2026-10-08T09:00:00.000Z', endAt: '2026-10-08T10:00:00.000Z', allDay: false,
      });
    }
    await storage.set(`${userCol(uid, BUSY_BLOCKS)}/manual`, {
      blockId: 'manual', sourceId: 'manual:test', sourceKind: 'manual',
      startAt: '2026-10-09T09:00:00.000Z', endAt: '2026-10-09T10:00:00.000Z', allDay: false,
    });

    const response = await busyGet(new Request(
      `http://localhost:3000/api/mobile/calendar/busy?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      { headers: { authorization: `Bearer ${tokenFor(uid)}` } },
    ));
    const body = await response.json() as { success: boolean; blocks: unknown[] };
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.success, true);
    assert.equal(body.blocks.length, 3);
    assert.equal(busyQueries, 4, 'two manual queries plus one query for each of two ICS feeds');
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
});
