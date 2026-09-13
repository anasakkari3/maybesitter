/**
 * The offline copy (UC-2.R1 #171, UC-2.7a #167).
 *
 * Two things are load-bearing and easy to get subtly wrong: a cache written by
 * a different version must not half-restore, and the local-versus-server
 * decision must favour the device only while it holds something the server has
 * never seen.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  EMPTY_CACHE,
  ROUTINE_STORAGE_KEY,
  clearRoutineCache,
  loadRoutineCache,
  parseRoutineCache,
  saveRoutineCache,
  serverCopyWins,
  type RoutineCache,
} from '../routineStore';

const CACHE: RoutineCache = {
  ...EMPTY_CACHE,
  answers: { sleep: 'standard', focus: 'workday', fixed: 'none', reminder: 'soft', quiet: 'late' },
  updatedAt: '2026-09-13T09:00:00.000Z',
  timezone: 'Asia/Jerusalem',
};

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.restoreAllMocks();
});

describe('the cache round-trips', () => {
  it('saves and loads the answers, the zone and the pending bit', async () => {
    expect(await saveRoutineCache({ ...CACHE, pendingSync: true })).toBe(true);
    const loaded = await loadRoutineCache();
    expect(loaded?.answers.sleep).toBe('standard');
    expect(loaded?.timezone).toBe('Asia/Jerusalem');
    expect(loaded?.pendingSync).toBe(true);
  });

  it('reads as absent when there is nothing stored', async () => {
    expect(await loadRoutineCache()).toBeNull();
  });

  it('is removed by clear', async () => {
    await saveRoutineCache(CACHE);
    await clearRoutineCache();
    expect(await loadRoutineCache()).toBeNull();
  });
});

describe('a blob this version does not understand', () => {
  it('reads as absent rather than as half a profile', () => {
    // Half-restored answers would show the user chips they never picked.
    expect(parseRoutineCache(JSON.stringify({ ...CACHE, version: 2 }))).toBeNull();
    expect(parseRoutineCache('not json')).toBeNull();
    expect(parseRoutineCache(JSON.stringify([1, 2]))).toBeNull();
    expect(parseRoutineCache(JSON.stringify({ version: 1 }))).toBeNull();
    expect(parseRoutineCache(null)).toBeNull();
  });

  it('drops a non-string answer instead of restoring it', () => {
    const parsed = parseRoutineCache(JSON.stringify({
      ...CACHE, answers: { ...CACHE.answers, sleep: 42 },
    }));
    expect(parsed?.answers.sleep).toBeNull();
    expect(parsed?.answers.focus).toBe('workday');
  });
});

describe('storage that will not co-operate', () => {
  it('reports a failed write rather than throwing', async () => {
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('disk full'));
    expect(await saveRoutineCache(CACHE)).toBe(false);
  });

  it('reads as absent rather than throwing', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('unreadable'));
    expect(await loadRoutineCache()).toBeNull();
  });

  it('does not throw when the cache cannot be removed', async () => {
    jest.spyOn(AsyncStorage, 'removeItem').mockRejectedValueOnce(new Error('locked'));
    await expect(clearRoutineCache()).resolves.toBeUndefined();
  });
});

describe('which copy wins', () => {
  const local = { ...CACHE, updatedAt: '2026-09-13T09:00:00.000Z', pendingSync: false };

  it('the server, when its copy is newer', () => {
    expect(serverCopyWins(local, '2026-09-14T09:00:00.000Z')).toBe(true);
  });

  it('the server, on an exact tie', () => {
    // A tie is the same save seen from both sides, not a conflict.
    expect(serverCopyWins(local, '2026-09-13T09:00:00.000Z')).toBe(true);
  });

  it('the server, when the device has nothing', () => {
    expect(serverCopyWins(null, '2026-09-13T09:00:00.000Z')).toBe(true);
    expect(serverCopyWins({ ...local, updatedAt: '' }, '2026-09-13T09:00:00.000Z')).toBe(true);
  });

  it('the device, while it holds something the server has never seen', () => {
    // The whole point of the pending bit: an answer given on a plane is not
    // overwritten by the older copy the server still has.
    expect(serverCopyWins({ ...local, pendingSync: true }, '2026-09-14T09:00:00.000Z')).toBe(false);
  });

  it('the device, when the server has no copy at all', () => {
    expect(serverCopyWins(local, null)).toBe(false);
  });

  it('the device, when its copy is newer', () => {
    expect(serverCopyWins(local, '2026-09-12T09:00:00.000Z')).toBe(false);
  });
});

describe('the storage key', () => {
  it('is the one the issue names, so an installed app keeps its answers', async () => {
    await saveRoutineCache(CACHE);
    expect(await AsyncStorage.getItem(ROUTINE_STORAGE_KEY)).toContain('"sleep":"standard"');
    expect(ROUTINE_STORAGE_KEY).toBe('routine.profile.v1');
  });
});
