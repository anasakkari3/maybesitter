/**
 * The setup chat's per-account copy (UC-3.17, #469).
 *
 * Same shape as `routineCache`, and the same two hazards: a blob from another
 * version or another account must never half-restore, and storage that will
 * not co-operate degrades to "nothing remembered" rather than throwing.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { EMPTY_SETUP_ANSWERS } from '../../../features/onboarding/setupChat';
import {
  SETUP_CACHE_VERSION,
  clearSetupChatCache,
  loadSetupChatCache,
  saveSetupChatCache,
  setupChatStorageKey,
  type SetupChatCache,
} from '../setupChatCache';

const ACCOUNT = 'account-under-test';

const CACHE: SetupChatCache = {
  version: SETUP_CACHE_VERSION,
  answers: { ...EMPTY_SETUP_ANSWERS, life: 'I study nursing and work evenings', day: 'late starts' },
  index: 2,
  updatedAt: '2026-09-17T09:00:00.000Z',
};

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.restoreAllMocks();
});

describe('the cache round-trips', () => {
  it('saves and loads the answers and the question the user was on', async () => {
    await saveSetupChatCache(ACCOUNT, CACHE);
    expect(await loadSetupChatCache(ACCOUNT)).toEqual(CACHE);
  });

  it('reads as absent when there is nothing stored', async () => {
    expect(await loadSetupChatCache(ACCOUNT)).toBeNull();
  });

  it('is removed by clear', async () => {
    await saveSetupChatCache(ACCOUNT, CACHE);
    await clearSetupChatCache(ACCOUNT);
    expect(await loadSetupChatCache(ACCOUNT)).toBeNull();
  });
});

describe('a blob this version does not understand', () => {
  it('drops a version-1 draft from before the life narrative', async () => {
    await AsyncStorage.setItem(setupChatStorageKey(ACCOUNT), JSON.stringify({
      version: 1,
      answers: { work: 'nursing student', day: '', places: '', done: '', habits: '' },
      index: 1,
      updatedAt: '2026-09-17T09:00:00.000Z',
    }));
    expect(SETUP_CACHE_VERSION).toBe(2);
    expect(await loadSetupChatCache(ACCOUNT)).toBeNull();
  });

  async function stored(value: unknown): Promise<SetupChatCache | null> {
    await AsyncStorage.setItem(setupChatStorageKey(ACCOUNT), typeof value === 'string' ? value : JSON.stringify(value));
    return loadSetupChatCache(ACCOUNT);
  }

  it('reads as absent rather than as half a chat', async () => {
    expect(await stored('not json')).toBeNull();
    expect(await stored([1, 2])).toBeNull();
    expect(await stored({ version: SETUP_CACHE_VERSION })).toBeNull();
    expect(await stored({ ...CACHE, version: SETUP_CACHE_VERSION + 1 })).toBeNull();
  });

  it('reads as absent when the index points past the questions', async () => {
    // Restoring index 99 would render a question that does not exist.
    expect(await stored({ ...CACHE, index: 99 })).toBeNull();
    expect(await stored({ ...CACHE, index: -1 })).toBeNull();
    expect(await stored({ ...CACHE, index: '2' })).toBeNull();
  });

  it('drops a non-string answer instead of restoring it', async () => {
    const loaded = await stored({ ...CACHE, answers: { ...CACHE.answers, life: 42 } });
    expect(loaded?.answers.life).toBe('');
    expect(loaded?.answers.day).toBe('late starts');
  });
});

describe('storage that will not co-operate', () => {
  it('does not throw on a failed write', async () => {
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('disk full'));
    await expect(saveSetupChatCache(ACCOUNT, CACHE)).resolves.toBeUndefined();
  });

  it('reads as absent rather than throwing', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('unreadable'));
    expect(await loadSetupChatCache(ACCOUNT)).toBeNull();
  });

  it('does not throw when the cache cannot be removed', async () => {
    jest.spyOn(AsyncStorage, 'removeItem').mockRejectedValueOnce(new Error('locked'));
    await expect(clearSetupChatCache(ACCOUNT)).resolves.toBeUndefined();
  });
});

describe('the cache belongs to an account, not to the device', () => {
  it('names the account in the key', () => {
    expect(setupChatStorageKey('account-a')).toBe('onboarding.setupChat.v1.account-a');
  });

  it('does not show one account what another one answered', async () => {
    await saveSetupChatCache('account-a', CACHE);
    expect(await loadSetupChatCache('account-b')).toBeNull();
  });

  it('clears one account without touching another', async () => {
    await saveSetupChatCache('account-a', CACHE);
    await saveSetupChatCache('account-b', { ...CACHE, index: 0 });
    await clearSetupChatCache('account-a');
    expect(await loadSetupChatCache('account-a')).toBeNull();
    expect((await loadSetupChatCache('account-b'))?.index).toBe(0);
  });
});
