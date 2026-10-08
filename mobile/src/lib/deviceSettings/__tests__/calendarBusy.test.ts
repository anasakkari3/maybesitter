/**
 * The busy blocks kept on the phone (UC-3.2, #186 step 3).
 *
 * ── Why the read re-projects ─────────────────────────────────────
 *
 * `src/api/` persists nothing at all, deliberately: an unencrypted copy of
 * somebody's life on disk is not worth a warm start. This cache is the one
 * exception the product makes, and it is narrow — four fields per row, nothing
 * naming what any of the time is for — so the thing worth testing is that it
 * *stays* narrow across a round trip through a file.
 *
 * A value that has been off the heap and back is not the value that was
 * written. AsyncStorage is a file; another version of this app could have
 * written a wider row; on a rooted phone another process could write anything
 * at all. So the reader rebuilds each block from the four keys it wants rather
 * than trusting the keys it finds, and the case below writes a row carrying a
 * title to prove it.
 *
 * ── And why an unreadable cache is empty rather than a throw ─────
 *
 * The chips are a nicety. A cache somebody corrupted should cost the notes
 * until the next sync, not the screen.
 */
import { beforeEach, describe, expect, it } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  BUSY_BLOCKS_KEY,
  LEGACY_BUSY_KEYS,
  clearCachedBusyBlocks,
  loadBusySyncedAt,
  loadCachedBusyBlocks,
  loadDeviceBusy,
  saveBusySyncedAt,
  saveCachedBusyBlocks,
  uncoverCachedBusyBlocks,
} from '../calendarBusy';
import { seedDeviceBusyCache } from '../../../testing/deviceBusyCache';

const NOW = new Date();
const MINUTE = 60_000;
const A = 'account-a';
const B = 'account-b';

function at(minutes: number): string {
  return new Date(NOW.getTime() + minutes * MINUTE).toISOString();
}

const COVERAGE = { startAt: at(0), endAt: at(28 * 24 * 60) };

beforeEach(async () => {
  await AsyncStorage.multiRemove([BUSY_BLOCKS_KEY, ...LEGACY_BUSY_KEYS]);
});

describe('a round trip through the file', () => {
  it('gives back what was put in, with its coverage', async () => {
    const blocks = [{ nativeId: 'a', startAt: at(60), endAt: at(120), allDay: false }];
    await saveCachedBusyBlocks(A, blocks, COVERAGE);
    expect(await loadCachedBusyBlocks(A)).toEqual(blocks);
    expect((await loadDeviceBusy(A)).coverage).toEqual(COVERAGE);
  });

  it('writes only the four fields, whatever it was handed', async () => {
    await saveCachedBusyBlocks(A, [
      { nativeId: 'a', startAt: at(60), endAt: at(120), allDay: false, title: 'Oncology' } as never,
    ], COVERAGE);
    expect(await AsyncStorage.getItem(BUSY_BLOCKS_KEY)).not.toContain('Oncology');
  });

  it('reads back only the four fields, whatever is on disk', async () => {
    await seedDeviceBusyCache(A, [
      { nativeId: 'a', startAt: at(60), endAt: at(120), allDay: false, title: 'Oncology', notes: 'referral' },
    ]);
    const [block] = await loadCachedBusyBlocks(A);
    expect(Object.keys(block!).sort()).toEqual(['allDay', 'endAt', 'nativeId', 'startAt']);
  });
});

describe('one account\'s, never the installation\'s (M4A-R8-001)', () => {
  it('is empty under any other account', async () => {
    await saveCachedBusyBlocks(A, [{ nativeId: 'a', startAt: at(60), endAt: at(120), allDay: false }], COVERAGE);
    await saveBusySyncedAt(A, NOW);
    expect(await loadDeviceBusy(B)).toEqual({ blocks: [], coverage: null, syncedAt: null });
    // And still A's for A.
    expect(await loadCachedBusyBlocks(A)).toHaveLength(1);
  });

  it('deletes the old unowned keys on first read', async () => {
    await AsyncStorage.setItem(LEGACY_BUSY_KEYS[0], JSON.stringify([{ nativeId: 'a', startAt: at(60), endAt: at(120), allDay: false }]));
    await AsyncStorage.setItem(LEGACY_BUSY_KEYS[1], String(NOW.getTime()));
    expect(await loadCachedBusyBlocks(A)).toEqual([]);
    expect(await AsyncStorage.getItem(LEGACY_BUSY_KEYS[0])).toBeNull();
    expect(await AsyncStorage.getItem(LEGACY_BUSY_KEYS[1])).toBeNull();
  });

  it('a refused read keeps the blocks and covers nothing', async () => {
    await saveCachedBusyBlocks(A, [{ nativeId: 'a', startAt: at(60), endAt: at(120), allDay: false }], COVERAGE);
    await uncoverCachedBusyBlocks(A);
    const cache = await loadDeviceBusy(A);
    expect(cache.blocks).toHaveLength(1);
    expect(cache.coverage).toBeNull();
  });
});

describe('a cache that cannot be trusted', () => {
  it('is empty rather than an exception when it is not JSON', async () => {
    await AsyncStorage.setItem(BUSY_BLOCKS_KEY, 'not json at all');
    expect(await loadCachedBusyBlocks(A)).toEqual([]);
  });

  it('is empty when it names no owner, a bare list included', async () => {
    await AsyncStorage.setItem(BUSY_BLOCKS_KEY, JSON.stringify([{ nativeId: 'a', startAt: at(60), endAt: at(120), allDay: false }]));
    expect(await loadCachedBusyBlocks(A)).toEqual([]);
    await AsyncStorage.setItem(BUSY_BLOCKS_KEY, JSON.stringify({ blocks: [{ nativeId: 'a', startAt: at(60), endAt: at(120), allDay: false }] }));
    expect(await loadCachedBusyBlocks(A)).toEqual([]);
  });

  it('drops the rows that make no sense and keeps the ones that do', async () => {
    await seedDeviceBusyCache(A, [
      { nativeId: '', startAt: at(0), endAt: at(60), allDay: false },
      { nativeId: 'b', startAt: 'never', endAt: at(60), allDay: false },
      { nativeId: 'c', startAt: at(60), endAt: at(120), allDay: false },
      null,
    ]);
    expect((await loadCachedBusyBlocks(A)).map((block) => block.nativeId)).toEqual(['c']);
  });

  it('a coverage that ends before it starts covers nothing', async () => {
    await seedDeviceBusyCache(A, [], { coverage: { startAt: at(60), endAt: at(0) } });
    expect((await loadDeviceBusy(A)).coverage).toBeNull();
  });

  it('is empty when nothing has ever been written', async () => {
    expect(await loadCachedBusyBlocks(A)).toEqual([]);
  });
});

describe('disconnect', () => {
  it('takes the blocks and the sync time together', async () => {
    await saveCachedBusyBlocks(A, [{ nativeId: 'a', startAt: at(60), endAt: at(120), allDay: false }], COVERAGE);
    await saveBusySyncedAt(A, NOW);
    await clearCachedBusyBlocks();
    expect(await loadCachedBusyBlocks(A)).toEqual([]);
    // The sync time has to go with them, or the next trigger would sit out the
    // fifteen-minute throttle on a cache that is no longer there.
    expect(await loadBusySyncedAt(A)).toBeNull();
  });
});

describe('when the last sync was', () => {
  it('comes back as the instant it was written at', async () => {
    await saveBusySyncedAt(A, NOW);
    expect(await loadBusySyncedAt(A)).toBe(NOW.getTime());
  });

  it('is null when it was never written', async () => {
    expect(await loadBusySyncedAt(A)).toBeNull();
  });

  it('is null rather than NaN when the stored value is nonsense', async () => {
    await seedDeviceBusyCache(A, [], { syncedAt: 'soon' as never });
    expect(await loadBusySyncedAt(A)).toBeNull();
  });
});
