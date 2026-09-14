/**
 * The offline copy (UC-2.R1 #171, UC-2.7a #167).
 *
 * Two things are load-bearing and easy to get subtly wrong: a cache written by
 * a different version must not half-restore, and the local-versus-server
 * decision must favour the device only while it holds something the server has
 * never seen.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  EMPTY_CACHE,
  routineStorageKey,
  clearRoutineCache,
  loadRoutineCache,
  parseRoutineCache,
  saveRoutineCache,
  serverCopyWins,
  type RoutineCache,
} from '../routineCache';

const ACCOUNT = 'account-under-test';

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
    expect(await saveRoutineCache(ACCOUNT, { ...CACHE, pendingSync: true })).toBe(true);
    const loaded = await loadRoutineCache(ACCOUNT);
    expect(loaded?.answers.sleep).toBe('standard');
    expect(loaded?.timezone).toBe('Asia/Jerusalem');
    expect(loaded?.pendingSync).toBe(true);
  });

  it('reads as absent when there is nothing stored', async () => {
    expect(await loadRoutineCache(ACCOUNT)).toBeNull();
  });

  it('is removed by clear', async () => {
    await saveRoutineCache(ACCOUNT, CACHE);
    await clearRoutineCache(ACCOUNT);
    expect(await loadRoutineCache(ACCOUNT)).toBeNull();
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
    expect(await saveRoutineCache(ACCOUNT, CACHE)).toBe(false);
  });

  it('reads as absent rather than throwing', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('unreadable'));
    expect(await loadRoutineCache(ACCOUNT)).toBeNull();
  });

  it('does not throw when the cache cannot be removed', async () => {
    jest.spyOn(AsyncStorage, 'removeItem').mockRejectedValueOnce(new Error('locked'));
    await expect(clearRoutineCache(ACCOUNT)).resolves.toBeUndefined();
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
  it('names the account, so two of them cannot collide', async () => {
    await saveRoutineCache('account-a', CACHE);
    expect(await AsyncStorage.getItem(routineStorageKey('account-a')))
      .toContain('"sleep":"standard"');
    expect(routineStorageKey('account-a')).toBe('routine.profile.v1.account-a');
  });
});

/**
 * The account boundary (#148).
 *
 * The 2026-09-14 audit signed four real accounts into one installation and
 * every one of them opened the survey already filled in with somebody else's
 * answers — B saw A's, and A came back to B's. The key was one string for the
 * whole device, and the tests above never asked whose answers they were.
 */
describe('the cache belongs to an account, not to the device', () => {
  it('does not show one account what another one answered', async () => {
    await saveRoutineCache('account-a', CACHE);

    expect(await loadRoutineCache('account-b')).toBeNull();
  });

  it('gives each account back its own answers', async () => {
    await saveRoutineCache('account-a', CACHE);
    await saveRoutineCache('account-b', { ...CACHE, answers: { ...CACHE.answers, sleep: 'late' } });

    expect((await loadRoutineCache('account-a'))?.answers.sleep).toBe('standard');
    expect((await loadRoutineCache('account-b'))?.answers.sleep).toBe('late');
  });

  it('clears one account without touching another', async () => {
    await saveRoutineCache('account-a', CACHE);
    await saveRoutineCache('account-b', CACHE);

    await clearRoutineCache('account-a');

    expect(await loadRoutineCache('account-a')).toBeNull();
    expect(await loadRoutineCache('account-b')).not.toBeNull();
  });

  it('throws away the shared copy an older build left behind', async () => {
    // An installation that has been through the leak still holds it.
    await AsyncStorage.setItem('routine.profile.v1', JSON.stringify(CACHE));

    expect(await loadRoutineCache('account-a')).toBeNull();
    expect(await AsyncStorage.getItem('routine.profile.v1')).toBeNull();
  });
});
