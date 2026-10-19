/**
 * The fail-closed rules Codex's inspection of Task A asked for
 * (M5A-A-REV-001/004/006/008), each held by a test that turns red when its
 * guard is removed.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { deviceCalendar } from '../deviceCalendar';
import * as Crypto from 'expo-crypto';
import { ensureRegisteredSource, rejoinPhone, startSelection } from '../m5aCalendar';
import { deleteThisPhonesBusy } from '../useBusyCalendar';
import { BUSY_BLOCKS_KEY, clearCachedBusyBlocksOf } from '../../../lib/deviceSettings/calendarBusy';
import { applyIncludedCalendarIds } from '../../../lib/deviceSettings/calendarChoice';
import {
  ACCOUNT_A,
  NOW,
  initialState,
  prepare,
  showBusyHost,
  showCalendar,
  teardown,
  waitForRequest,
  type M5aHarness,
} from '../../../__acceptance__/m5a/harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

const UID = ACCOUNT_A.uid;
const ENROLLED = `calendar.choiceEnrolledAt.v1:${UID}`;
const INCLUDED = `calendar.includedCalendarIds.v1:${UID}`;
const PENDING = `calendar.pendingSelection.v1:${UID}`;
const REMOVED = `calendar.phoneRemoved.v1:${UID}`;

let harness: M5aHarness | undefined;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  jest.spyOn(deviceCalendar, 'getAccess').mockResolvedValue('granted');
  jest.spyOn(deviceCalendar, 'listEventCalendars').mockResolvedValue([]);
  jest.spyOn(deviceCalendar, 'listWritableCalendars').mockResolvedValue([]);
  jest.spyOn(deviceCalendar, 'fetchBusyBlocks').mockResolvedValue([]);
});

afterEach(async () => {
  await teardown(harness);
  harness = undefined;
  jest.useRealTimers();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await act(async () => { await jest.advanceTimersByTimeAsync(50); });
}

describe('an enrolled pass reads nothing it cannot vouch for', () => {
  it('REV-001: a failed choice probe stops the pass before any native read', async () => {
    harness = await prepare('en', initialState(), request => {
      if (request.path === '/api/mobile/calendar/choice' && request.method === 'GET') {
        return { status: 503, body: { success: false, error: 'unavailable', reason: 'unavailable' } };
      }
      return undefined;
    });
    await AsyncStorage.multiSet([[ENROLLED, '2030-03-20T08:00:00.000Z'], [INCLUDED, JSON.stringify(['work'])]]);
    await showBusyHost(harness);
    await waitForRequest(harness, 'GET', /\/calendar\/choice$/);
    await settle();
    expect(deviceCalendar.fetchBusyBlocks).not.toHaveBeenCalled();
  });

  it('REV-004: an unreadable secure store stops the pass before any native read', async () => {
    harness = await prepare();
    jest.spyOn(SecureStore, 'getItemAsync').mockRejectedValue(new Error('keychain locked'));
    await AsyncStorage.multiSet([[ENROLLED, '2030-03-20T08:00:00.000Z'], [INCLUDED, JSON.stringify(['work'])]]);
    await showBusyHost(harness);
    await settle();
    expect(deviceCalendar.fetchBusyBlocks).not.toHaveBeenCalled();
  });

  const CORRUPT: [string, [string, string][]][] = [
    ['an inclusion list with a non-id member', [[ENROLLED, '2030-03-20T08:00:00.000Z'], [INCLUDED, JSON.stringify(['work', 7])]]],
    ['a corrupt enrolment marker', [[ENROLLED, 'corrupt'], [INCLUDED, JSON.stringify(['work'])]]],
  ];
  it.each(CORRUPT)('REV-006: %s blocks the read', async (_label, entries) => {
    harness = await prepare();
    await AsyncStorage.multiSet(entries);
    await showBusyHost(harness);
    await settle();
    expect(deviceCalendar.fetchBusyBlocks).not.toHaveBeenCalled();
  });

  it('REV-006: a pending record whose operation contradicts its list sends nothing', async () => {
    harness = await prepare();
    await AsyncStorage.multiSet([
      [ENROLLED, '2030-03-20T08:00:00.000Z'],
      // A digest that matches its (empty) list, so only the operation check can refuse it.
      [PENDING, JSON.stringify({
        intentId: 'i-1', included: [], selectionDigest: createHash('sha256').update('[]').digest('hex'),
        operation: 'upload', epoch: null, opId: null,
      })],
    ]);
    await showBusyHost(harness);
    await settle();
    expect(harness.server.matching('POST', /\/calendar\/busy\/intent$/)).toHaveLength(0);
    expect(deviceCalendar.fetchBusyBlocks).not.toHaveBeenCalled();
  });
});

describe('rejoin', () => {
  it('REV-008: a retry after a lost response reuses the persisted tuple, and taps never overlap', async () => {
    let first = true;
    harness = await prepare('en', initialState({ sourceStatus: 'revoked' }), request => {
      if (request.path === '/api/mobile/calendar/busy/register' && first) {
        first = false;
        return { status: 503, body: { success: false, error: 'unavailable', reason: 'unavailable' } };
      }
      return undefined;
    });
    await AsyncStorage.multiSet([[ENROLLED, '2030-03-20T08:00:00.000Z'], [REMOVED, '2030-03-29T08:00:00.000Z']]);
    // Mounted so the signed-in account is known to the request layer.
    await showBusyHost(harness);
    await settle();
    const [a, b] = await act(async () => Promise.all([rejoinPhone(UID), rejoinPhone(UID)]));
    expect([a, b]).toEqual([false, false]);
    expect(await act(async () => rejoinPhone(UID))).toBe(true);
    const bodies = harness.server.matching('POST', /\/calendar\/busy\/register$/)
      .map(request => (request.body as { sourceInstallationId: string }).sourceInstallationId);
    expect(bodies).toHaveLength(2);
    expect(new Set(bodies).size).toBe(1);
    await waitFor(async () => expect(await AsyncStorage.getItem(REMOVED)).toBeNull());
  });
});

describe('selection order', () => {
  it('REV-002: the later tap wins even when the earlier digest is slow', async () => {
    harness = await prepare();
    await AsyncStorage.setItem(ENROLLED, '2030-03-20T08:00:00.000Z');
    await showBusyHost(harness);
    await settle();
    const real = Crypto.digestStringAsync;
    let releaseFirst: (() => void) | undefined;
    let calls = 0;
    jest.spyOn(Crypto, 'digestStringAsync').mockImplementation(async (...args: Parameters<typeof real>) => {
      calls += 1;
      if (calls === 1) await new Promise<void>((resolve) => { releaseFirst = resolve; });
      return real(...args);
    });
    const context = { uid: UID, accountCurrent: () => true, stillCurrent: () => true, consented: () => true };
    const first = startSelection(UID, ['work'], context);
    const second = startSelection(UID, ['home'], context);
    // The earlier tap's digest is slow; the later tap waits its turn and wins.
    await act(async () => {
      for (let i = 0; i < 200 && !releaseFirst; i += 1) await Promise.resolve();
      releaseFirst?.();
      await Promise.all([first, second]);
    });
    const pending = JSON.parse((await AsyncStorage.getItem(PENDING)) ?? 'null') as { included: string[] } | null;
    const included = JSON.parse((await AsyncStorage.getItem(INCLUDED)) ?? '[]') as string[];
    // Whatever stage the newer selection reached, nothing of the older one stands.
    expect(pending?.included ?? included).toEqual(['home']);
  });

  it('NEW-002: the generation is written before the list, so a failed list write still hides the old cache', async () => {
    harness = await prepare();
    const original = (AsyncStorage.setItem as jest.Mock).getMockImplementation() as (key: string, value: string) => Promise<void>;
    jest.spyOn(AsyncStorage, 'setItem').mockImplementation((key, value) => {
      if (key === INCLUDED) return Promise.reject(new Error('disk full'));
      return original(key, value);
    });
    await expect(applyIncludedCalendarIds(UID, ['work'])).rejects.toThrow('disk full');
    expect(await AsyncStorage.getItem(`calendar.inclusionGeneration.v1:${UID}`)).toBe('1');
  });
});

describe('toggles start from the newest state (M5A-R3-005)', () => {
  it('two quick toggles keep both: B on, then C on, from a list of A', async () => {
    harness = await prepare();
    await AsyncStorage.multiSet([[ENROLLED, '2030-03-20T08:00:00.000Z'], [INCLUDED, JSON.stringify(['a'])]]);
    await showBusyHost(harness);
    await settle();
    const context = { uid: UID, accountCurrent: () => true, stillCurrent: () => true, consented: () => true };
    const on = (id: string) => (current: readonly string[]) => [...current.filter((x) => x !== id), id];
    await act(async () => { await Promise.all([startSelection(UID, on('b'), context), startSelection(UID, on('c'), context)]); });
    const pending = JSON.parse((await AsyncStorage.getItem(PENDING)) ?? 'null') as { included: string[] } | null;
    const included = JSON.parse((await AsyncStorage.getItem(INCLUDED)) ?? '[]') as string[];
    expect([...(pending?.included ?? included)].sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('inspection r3 (M5A-R3-001/002/004)', () => {
  it('R3-001: a removal landing during registration stops it before it registers', async () => {
    harness = await prepare();
    await AsyncStorage.setItem(ENROLLED, '2030-03-20T08:00:00.000Z');
    await showBusyHost(harness);
    await settle();
    const realGet = SecureStore.getItemAsync;
    jest.spyOn(SecureStore, 'getItemAsync').mockImplementation(async (key, options) => {
      // The removal lands while the credential is being resolved.
      await AsyncStorage.setItem(REMOVED, '2030-03-29T09:00:00.000Z');
      return realGet(key, options);
    });
    const outcome = await act(async () => ensureRegisteredSource(UID));
    expect(outcome.kind).toBe('removed');
    expect(harness.server.matching('POST', /\/calendar\/busy\/register$/)).toHaveLength(0);
  });

  it('R3-002: disconnect on a phone that cannot prove its source is not reported as deleted', async () => {
    harness = await prepare();
    await AsyncStorage.multiSet([
      [ENROLLED, '2030-03-20T08:00:00.000Z'],
      [`calendar.sourceId.v1:${UID}`, JSON.stringify({ sourceId: 'device:old', sourceInstallationId: 'lost' })],
    ]);
    await expect(deleteThisPhonesBusy(UID)).rejects.toThrow();
  });

  it('R3-004: a late operation of one account never deletes another account\'s busy cache', async () => {
    harness = await prepare();
    await AsyncStorage.setItem(BUSY_BLOCKS_KEY, JSON.stringify({ owner: 'someone-else', inclusionGeneration: 0, blocks: [], coverage: null, syncedAt: null }));
    await clearCachedBusyBlocksOf(UID);
    expect(await AsyncStorage.getItem(BUSY_BLOCKS_KEY)).not.toBeNull();
    await clearCachedBusyBlocksOf('someone-else');
    expect(await AsyncStorage.getItem(BUSY_BLOCKS_KEY)).toBeNull();
  });
});

describe('inspection r4 (M5A-R4-001/002/003)', () => {
  const GENERATION = `calendar.inclusionGeneration.v1:${UID}`;
  const context = { uid: UID, accountCurrent: () => true, stillCurrent: () => true, consented: () => true };

  it('R4-001: a pending record that fails to save still leaves the old cache unmatched', async () => {
    harness = await prepare();
    await AsyncStorage.multiSet([[ENROLLED, '2030-03-20T08:00:00.000Z'], [INCLUDED, JSON.stringify(['a'])]]);
    await showBusyHost(harness);
    await settle();
    const before = await AsyncStorage.getItem(GENERATION);
    const original = (AsyncStorage.setItem as jest.Mock).getMockImplementation() as (key: string, value: string) => Promise<void>;
    jest.spyOn(AsyncStorage, 'setItem').mockImplementation((key, value) => {
      if (key === PENDING) return Promise.reject(new Error('disk full'));
      return original(key, value);
    });
    await act(async () => { await startSelection(UID, ['b'], context).catch(() => undefined); });
    expect(await AsyncStorage.getItem(PENDING)).toBeNull();
    expect(Number(await AsyncStorage.getItem(GENERATION))).toBe(Number(before ?? 0) + 1);
  });

  it('R4-002: a removal the server reports moves the generation, so the cache never matches again', async () => {
    harness = await prepare('en', initialState({ sourceStatus: 'revoked' }));
    await AsyncStorage.multiSet([[ENROLLED, '2030-03-20T08:00:00.000Z'], [INCLUDED, JSON.stringify(['work'])]]);
    await showBusyHost(harness);
    await waitForRequest(harness, 'GET', /\/calendar\/choice$/);
    await settle();
    expect(await AsyncStorage.getItem(REMOVED)).not.toBeNull();
    expect(await AsyncStorage.getItem(GENERATION)).toBe('1');
  });

  it('R4-002: disconnect moves the generation before anything else', async () => {
    harness = await prepare();
    await AsyncStorage.multiSet([[ENROLLED, '2030-03-20T08:00:00.000Z'], [INCLUDED, JSON.stringify(['work'])]]);
    await showCalendar(harness);
    await settle();
    await waitFor(() => expect(screen.queryByTestId('calendar-disconnect')).not.toBeNull());
    const before = Number((await AsyncStorage.getItem(GENERATION)) ?? 0);
    await fireEvent.press(screen.getByTestId('calendar-disconnect'));
    await waitFor(() => expect(screen.queryByTestId('calendar-disconnect-dialog')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('calendar-disconnect-confirm'));
    await settle();
    expect(Number(await AsyncStorage.getItem(GENERATION))).toBeGreaterThan(before);
  });

  it('R4-002: consent withdrawn moves the generation as well as deleting the cache', async () => {
    harness = await prepare('en', initialState({ trustConsent: false }));
    await AsyncStorage.multiSet([[ENROLLED, '2030-03-20T08:00:00.000Z'], [INCLUDED, JSON.stringify(['work'])]]);
    await showBusyHost(harness);
    await settle();
    await waitFor(async () => expect(await AsyncStorage.getItem(GENERATION)).toBe('1'));
  });

  it('R4-003: a calendar gone from the phone leaves the list on the next successful read', async () => {
    harness = await prepare();
    (deviceCalendar.listEventCalendars as jest.Mock<typeof deviceCalendar.listEventCalendars>).mockResolvedValue([
      { id: 'work', title: 'Work', color: null, sourceName: 'iCloud' },
    ]);
    await AsyncStorage.multiSet([[ENROLLED, '2030-03-20T08:00:00.000Z'], [INCLUDED, JSON.stringify(['work', 'gone'])]]);
    await showBusyHost(harness);
    await settle();
    await waitFor(async () => {
      const pending = JSON.parse((await AsyncStorage.getItem(PENDING)) ?? 'null') as { included: string[] } | null;
      const included = JSON.parse((await AsyncStorage.getItem(INCLUDED)) ?? '[]') as string[];
      expect(pending?.included ?? included).toEqual(['work']);
    });
  });

  const UNPROVEN: [string, 'granted' | 'denied', { id: string; title: string; color: null; sourceName: string }[]][] = [
    ['without calendar access', 'denied', [{ id: 'work', title: 'Work', color: null, sourceName: 'iCloud' }]],
    ['with nothing listed', 'granted', []],
  ];
  it.each(UNPROVEN)('R4-003: %s, nothing is pruned', async (_label, access, listed) => {
    harness = await prepare();
    (deviceCalendar.getAccess as jest.Mock<typeof deviceCalendar.getAccess>).mockResolvedValue(access);
    (deviceCalendar.listEventCalendars as jest.Mock<typeof deviceCalendar.listEventCalendars>).mockResolvedValue(listed);
    await AsyncStorage.multiSet([[ENROLLED, '2030-03-20T08:00:00.000Z'], [INCLUDED, JSON.stringify(['work', 'gone'])]]);
    await showBusyHost(harness);
    await settle();
    expect(await AsyncStorage.getItem(PENDING)).toBeNull();
    expect(JSON.parse((await AsyncStorage.getItem(INCLUDED)) ?? '[]')).toEqual(['work', 'gone']);
  });
});
