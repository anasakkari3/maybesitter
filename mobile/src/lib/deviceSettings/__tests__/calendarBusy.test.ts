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
  BUSY_SYNCED_AT_KEY,
  clearCachedBusyBlocks,
  loadBusySyncedAt,
  loadCachedBusyBlocks,
  saveBusySyncedAt,
  saveCachedBusyBlocks,
} from '../calendarBusy';

const NOW = new Date();
const MINUTE = 60_000;

function at(minutes: number): string {
  return new Date(NOW.getTime() + minutes * MINUTE).toISOString();
}

beforeEach(async () => {
  await AsyncStorage.multiRemove([BUSY_BLOCKS_KEY, BUSY_SYNCED_AT_KEY]);
});

describe('a round trip through the file', () => {
  it('gives back what was put in', async () => {
    const blocks = [{ nativeId: 'a', startAt: at(60), endAt: at(120), allDay: false }];
    await saveCachedBusyBlocks(blocks);
    expect(await loadCachedBusyBlocks()).toEqual(blocks);
  });

  it('writes only the four fields, whatever it was handed', async () => {
    await saveCachedBusyBlocks([
      { nativeId: 'a', startAt: at(60), endAt: at(120), allDay: false, title: 'Oncology' } as never,
    ]);
    expect(await AsyncStorage.getItem(BUSY_BLOCKS_KEY)).not.toContain('Oncology');
  });

  it('reads back only the four fields, whatever is on disk', async () => {
    await AsyncStorage.setItem(BUSY_BLOCKS_KEY, JSON.stringify([
      { nativeId: 'a', startAt: at(60), endAt: at(120), allDay: false, title: 'Oncology', notes: 'referral' },
    ]));
    const [block] = await loadCachedBusyBlocks();
    expect(Object.keys(block!).sort()).toEqual(['allDay', 'endAt', 'nativeId', 'startAt']);
  });
});

describe('a cache that cannot be trusted', () => {
  it('is empty rather than an exception when it is not JSON', async () => {
    await AsyncStorage.setItem(BUSY_BLOCKS_KEY, 'not json at all');
    expect(await loadCachedBusyBlocks()).toEqual([]);
  });

  it('is empty when it is JSON but not a list', async () => {
    await AsyncStorage.setItem(BUSY_BLOCKS_KEY, JSON.stringify({ nativeId: 'a' }));
    expect(await loadCachedBusyBlocks()).toEqual([]);
  });

  it('drops the rows that make no sense and keeps the ones that do', async () => {
    await AsyncStorage.setItem(BUSY_BLOCKS_KEY, JSON.stringify([
      { nativeId: '', startAt: at(0), endAt: at(60), allDay: false },
      { nativeId: 'b', startAt: 'never', endAt: at(60), allDay: false },
      { nativeId: 'c', startAt: at(60), endAt: at(120), allDay: false },
      null,
    ]));
    expect((await loadCachedBusyBlocks()).map((block) => block.nativeId)).toEqual(['c']);
  });

  it('is empty when nothing has ever been written', async () => {
    expect(await loadCachedBusyBlocks()).toEqual([]);
  });
});

describe('disconnect', () => {
  it('takes the blocks and the sync time together', async () => {
    await saveCachedBusyBlocks([{ nativeId: 'a', startAt: at(60), endAt: at(120), allDay: false }]);
    await saveBusySyncedAt(NOW);
    await clearCachedBusyBlocks();
    expect(await loadCachedBusyBlocks()).toEqual([]);
    // The sync time has to go with them, or the next trigger would sit out the
    // fifteen-minute throttle on a cache that is no longer there.
    expect(await loadBusySyncedAt()).toBeNull();
  });
});

describe('when the last sync was', () => {
  it('comes back as the instant it was written at', async () => {
    await saveBusySyncedAt(NOW);
    expect(await loadBusySyncedAt()).toBe(NOW.getTime());
  });

  it('is null when it was never written', async () => {
    expect(await loadBusySyncedAt()).toBeNull();
  });

  it('is null rather than NaN when the stored value is nonsense', async () => {
    await AsyncStorage.setItem(BUSY_SYNCED_AT_KEY, 'soon');
    expect(await loadBusySyncedAt()).toBeNull();
  });
});
