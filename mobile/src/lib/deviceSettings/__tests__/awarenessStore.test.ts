import { beforeEach, describe, expect, it } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  AWARENESS_MAX_AGE_MS,
  awarenessStorageKey,
  clearAwareness,
  EMPTY_AWARENESS,
  isAware,
  loadAwareness,
  markAware,
  parseAwarenessCache,
  pruneAwareness,
  withAwareness,
} from '../awarenessStore';

/**
 * "I know about this", across a relaunch (UC-3.11, #196).
 *
 * The Flutter engine kept this in memory, so a force-quit undid the one
 * gesture whose meaning is "stop". Every case here is about the properties
 * that make the persisted version worth having.
 */

const ALICE = 'account-a';
const BOB = 'account-b';
const START = '2026-09-15T12:00:00.000Z';
const NOW = new Date('2026-09-15T11:00:00.000Z');

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('a round trip', () => {
  it('survives a reload, which is the whole feature', async () => {
    await markAware(ALICE, 'c1', START, NOW);
    // A second `loadAwareness` stands in for the relaunch: nothing is carried
    // in module state, so this is the same read a cold start makes.
    expect(isAware(await loadAwareness(ALICE), 'c1', START)).toBe(true);
  });

  it('keeps one account out of another account s answer', async () => {
    await markAware(ALICE, 'c1', START, NOW);
    expect(isAware(await loadAwareness(BOB), 'c1', START)).toBe(false);
    expect(await AsyncStorage.getItem(awarenessStorageKey(BOB))).toBeNull();
  });

  it('is gone after a sign-out', async () => {
    await markAware(ALICE, 'c1', START, NOW);
    await clearAwareness(ALICE);
    expect(isAware(await loadAwareness(ALICE), 'c1', START)).toBe(false);
  });
});

describe('a rescheduled commitment starts a fresh cycle', () => {
  it('stops being aware when the start moves', async () => {
    const cache = withAwareness(EMPTY_AWARENESS, 'c1', START, NOW.toISOString());
    expect(isAware(cache, 'c1', START)).toBe(true);

    const movedToTomorrow = '2026-09-16T12:00:00.000Z';
    // The thing they acknowledged is not the thing that is going to happen.
    expect(isAware(cache, 'c1', movedToTomorrow)).toBe(false);
  });

  it('treats an item that lost its time as a different item too', () => {
    const cache = withAwareness(EMPTY_AWARENESS, 'c1', START, NOW.toISOString());
    expect(isAware(cache, 'c1', null)).toBe(false);
    // And the converse: acknowledged with no time, then given one.
    const undated = withAwareness(EMPTY_AWARENESS, 'c2', null, NOW.toISOString());
    expect(isAware(undated, 'c2', null)).toBe(true);
    expect(isAware(undated, 'c2', START)).toBe(false);
  });
});

describe('pruning', () => {
  it('forgets entries older than a fortnight and keeps the rest', () => {
    const now = Date.parse(NOW.toISOString());
    const cache = {
      version: 1,
      entries: {
        stale: { at: new Date(now - AWARENESS_MAX_AGE_MS - 1).toISOString(), startFingerprint: START },
        fresh: { at: new Date(now - AWARENESS_MAX_AGE_MS + 1).toISOString(), startFingerprint: START },
        broken: { at: 'not an instant', startFingerprint: START },
      },
    };
    expect(Object.keys(pruneAwareness(cache, now).entries)).toEqual(['fresh']);
  });

  it('happens on the write, because nothing else would trigger it', async () => {
    const old = new Date(NOW.getTime() - AWARENESS_MAX_AGE_MS - 60_000);
    await markAware(ALICE, 'ancient', START, old);
    await markAware(ALICE, 'recent', START, NOW);
    expect(Object.keys((await loadAwareness(ALICE)).entries)).toEqual(['recent']);
  });
});

describe('a blob this version does not understand', () => {
  it.each([
    ['nothing stored', null],
    ['not JSON', '{'],
    ['an array', '[]'],
    ['a future version', '{"version":99,"entries":{"c1":{"at":"x","startFingerprint":"y"}}}'],
    ['entries that are not entries', '{"version":1,"entries":[1,2]}'],
  ])('reads %s as empty rather than as half a record', (_name, raw) => {
    expect(parseAwarenessCache(raw as string | null)).toEqual(EMPTY_AWARENESS);
  });

  it('skips a malformed row and keeps the readable ones', () => {
    const raw = JSON.stringify({
      version: 1,
      entries: { good: { at: START, startFingerprint: START }, bad: { at: 7 } },
    });
    expect(Object.keys(parseAwarenessCache(raw).entries)).toEqual(['good']);
  });
});
