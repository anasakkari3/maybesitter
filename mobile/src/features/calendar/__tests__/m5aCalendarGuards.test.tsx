/**
 * The fail-closed rules Codex's inspection of Task A asked for
 * (M5A-A-REV-001/004/006/008), each held by a test that turns red when its
 * guard is removed.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { deviceCalendar } from '../deviceCalendar';
import * as Crypto from 'expo-crypto';
import { ensureRegisteredSource, rejoinPhone, startSelection } from '../m5aCalendar';
import { BusyCalendarHost, deleteThisPhonesBusy, useBusyBlocks } from '../useBusyCalendar';
import { ensureSourceCredential } from '../../../lib/deviceSettings/sourceCredential';
import { accountBoundCalendar } from '../accountBoundCalendar';
import { apiSyncPorts } from '../useDeviceCalendarSync';
import * as calendarEndpoints from '../../../api/endpoints/calendar';
import { AccountChangedError } from '../../../api/errors';
import { BUSY_BLOCKS_KEY, clearCachedBusyBlocksOf } from '../../../lib/deviceSettings/calendarBusy';
import { applyIncludedCalendarIds } from '../../../lib/deviceSettings/calendarChoice';
import {
  ACCOUNT_A,
  NOW,
  initialState,
  prepare,
  showBusyHost,
  showCalendar,
  Providers,
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
  // Every id the tests include is on the phone, so the R4-003 prune leaves them be.
  jest.spyOn(deviceCalendar, 'listEventCalendars').mockResolvedValue(
    ['work', 'home', 'a', 'b', 'c'].map((id) => ({ id, title: id, color: null, sourceName: 'iCloud' })),
  );
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
    expect(Number(await AsyncStorage.getItem(GENERATION))).toBeGreaterThan(0);
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
  ];
  it('R5-002: a granted, successful empty listing clears the list (the last calendar was deleted)', async () => {
    harness = await prepare();
    (deviceCalendar.listEventCalendars as jest.Mock<typeof deviceCalendar.listEventCalendars>).mockResolvedValue([]);
    await AsyncStorage.multiSet([[ENROLLED, '2030-03-20T08:00:00.000Z'], [INCLUDED, JSON.stringify(['work', 'gone'])]]);
    await showBusyHost(harness);
    await settle();
    await waitFor(async () => {
      const pending = JSON.parse((await AsyncStorage.getItem(PENDING)) ?? 'null') as { included: string[] } | null;
      const included = JSON.parse((await AsyncStorage.getItem(INCLUDED)) ?? '[]') as string[];
      expect(pending?.included ?? included).toEqual([]);
    });
  });
  it('R4-003: a failed listing prunes nothing', async () => {
    harness = await prepare();
    (deviceCalendar.listEventCalendars as jest.Mock<typeof deviceCalendar.listEventCalendars>).mockRejectedValue(new Error('provider gone'));
    await AsyncStorage.multiSet([[ENROLLED, '2030-03-20T08:00:00.000Z'], [INCLUDED, JSON.stringify(['work', 'gone'])]]);
    await showBusyHost(harness);
    await settle();
    expect(await AsyncStorage.getItem(PENDING)).toBeNull();
    expect(JSON.parse((await AsyncStorage.getItem(INCLUDED)) ?? '[]')).toEqual(['work', 'gone']);
  });
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

  it('R5-001: the cache moves straight after the barrier, before the credential cleanup finishes', async () => {
    harness = await prepare('en', initialState({ sourceStatus: 'revoked' }));
    await AsyncStorage.multiSet([[ENROLLED, '2030-03-20T08:00:00.000Z'], [INCLUDED, JSON.stringify(['work'])]]);
    // The credential delete never finishes: only an invalidation before it passes.
    jest.spyOn(SecureStore, 'deleteItemAsync').mockReturnValue(new Promise(() => {}));
    await showBusyHost(harness);
    await waitForRequest(harness, 'GET', /\/calendar\/choice$/);
    await settle();
    expect(await AsyncStorage.getItem(REMOVED)).not.toBeNull();
    expect(await AsyncStorage.getItem(GENERATION)).toBe('1');
  });

  it('R5-001: a removal killed before its invalidation is finished on the next start', async () => {
    harness = await prepare();
    await AsyncStorage.multiSet([
      [ENROLLED, '2030-03-20T08:00:00.000Z'],
      [REMOVED, '2030-03-29T08:00:00.000Z'],
      [BUSY_BLOCKS_KEY, JSON.stringify({ owner: UID, inclusionGeneration: 0, blocks: [], coverage: null, syncedAt: null })],
    ]);
    await showBusyHost(harness);
    await settle();
    await waitFor(async () => expect(await AsyncStorage.getItem(BUSY_BLOCKS_KEY)).toBeNull());
    expect(await AsyncStorage.getItem(GENERATION)).toBe('1');
  });
});

describe('inspection r6 and the simulator pass (M5A-R6-001/002/003, SIM-M5A-02)', () => {
  const GENERATION = `calendar.inclusionGeneration.v1:${UID}`;
  const BLOCK = { nativeId: 'n-1', startAt: '2030-03-30T07:00:00.000Z', endAt: '2030-03-30T08:00:00.000Z', allDay: false };

  it('R6-001: a pass whose selection changed during its read writes nothing under the new generation', async () => {
    harness = await prepare();
    await AsyncStorage.multiSet([[ENROLLED, '2030-03-20T08:00:00.000Z'], [INCLUDED, JSON.stringify(['work'])]]);
    (deviceCalendar.fetchBusyBlocks as jest.Mock<typeof deviceCalendar.fetchBusyBlocks>).mockImplementation(async () => {
      // A new selection lands while the native read runs.
      const now = Number((await AsyncStorage.getItem(GENERATION)) ?? 0);
      await AsyncStorage.setItem(GENERATION, String(now + 1));
      return [BLOCK];
    });
    await showBusyHost(harness);
    await settle();
    expect(deviceCalendar.fetchBusyBlocks).toHaveBeenCalled();
    expect(await AsyncStorage.getItem(BUSY_BLOCKS_KEY) ?? '').not.toContain('n-1');
  });

  it('R6-002: an update or delete that finishes after the account changed stops the pass', async () => {
    let current = true;
    jest.spyOn(deviceCalendar, 'deleteEvent').mockImplementation(async () => { current = false; });
    jest.spyOn(deviceCalendar, 'updateEvent').mockImplementation(async () => { current = false; });
    const bound = accountBoundCalendar(() => current);
    await expect(bound.calendar.deleteEvent('e-1')).rejects.toBeInstanceOf(AccountChangedError);
    current = true;
    await expect(bound.calendar.updateEvent('e-1', {} as never)).rejects.toBeInstanceOf(AccountChangedError);
  });

  it('R6-003: a rejoin never sends the removed tuple, even when its delete failed and it survived', async () => {
    harness = await prepare();
    await AsyncStorage.multiSet([[ENROLLED, '2030-03-20T08:00:00.000Z'], [REMOVED, '2030-03-29T08:00:00.000Z']]);
    await showBusyHost(harness);
    await settle();
    const removed = await act(async () => ensureSourceCredential(UID));
    await AsyncStorage.setItem(`calendar.removedInstallation.v1:${UID}`, removed!.sourceInstallationId);
    expect(await act(async () => rejoinPhone(UID))).toBe(true);
    const sent = harness.server.matching('POST', /\/calendar\/busy\/register$/)
      .map((request) => (request.body as { sourceInstallationId: string }).sourceInstallationId);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent).not.toContain(removed!.sourceInstallationId);
  });

  it('SIM-M5A-02: the busy blocks a selection reads reach the screens without a restart', async () => {
    harness = await prepare();
    await AsyncStorage.multiSet([[ENROLLED, '2030-03-20T08:00:00.000Z'], [INCLUDED, JSON.stringify([])]]);
    (deviceCalendar.fetchBusyBlocks as jest.Mock<typeof deviceCalendar.fetchBusyBlocks>).mockResolvedValue([BLOCK]);
    function Probe() {
      return <Text testID="busy-count">{String(useBusyBlocks().length)}</Text>;
    }
    await render(<Providers harness={harness!}><BusyCalendarHost /><Probe /></Providers>);
    await settle();
    expect(screen.getByTestId('busy-count')).toHaveTextContent('0');
    const context = { uid: UID, accountCurrent: () => true, stillCurrent: () => true, consented: () => true };
    await act(async () => { await startSelection(UID, ['work'], context); });
    await settle();
    await waitFor(() => expect(screen.getByTestId('busy-count')).toHaveTextContent('1'));
  });

  it('SIM-M5A-03: iOS local sources get our words, a real account keeps its name', async () => {
    harness = await prepare('en');
    await AsyncStorage.multiSet([[ENROLLED, '2030-03-20T08:00:00.000Z'], [INCLUDED, JSON.stringify([])]]);
    (deviceCalendar.listEventCalendars as jest.Mock<typeof deviceCalendar.listEventCalendars>).mockResolvedValue([
      { id: 'd', title: 'Calendar', color: null, sourceName: 'Default' },
      { id: 's', title: 'Clinic', color: null, sourceName: 'Subscribed Calendars' },
      { id: 'i', title: 'Home', color: null, sourceName: 'iCloud' },
      { id: 'c', title: 'Odd', color: null, sourceName: 'constructor' },
    ]);
    await showCalendar(harness);
    await settle();
    await waitFor(() => expect(screen.queryByTestId('calendar-account-Default')).not.toBeNull());
    expect(screen.getByTestId('calendar-account-Default')).toHaveTextContent(/On this phone/);
    expect(screen.getByTestId('calendar-account-Default')).not.toHaveTextContent(/Default/);
    expect(screen.getByTestId('calendar-account-Subscribed Calendars')).toHaveTextContent(/Subscribed calendars/);
    expect(screen.getByTestId('calendar-account-iCloud')).toHaveTextContent(/iCloud/);
    expect(screen.getByTestId('calendar-account-constructor')).toHaveTextContent(/constructor/);
  });

  it('R7-001: a link the server stored is the commit point; a switch right after never rolls its event back', async () => {
    let current = true;
    jest.spyOn(deviceCalendar, 'createEvent').mockResolvedValue('e-new');
    const deleted = jest.spyOn(deviceCalendar, 'deleteEvent').mockResolvedValue(undefined);
    jest.spyOn(calendarEndpoints, 'putDeviceCalendarLink').mockImplementation(async () => {
      current = false; // the account changes while the link is being stored
      return undefined as never;
    });
    const ports = apiSyncPorts(UID, () => current);
    const eventId = await ports.calendar.createEvent('cal', {} as never);
    await expect(ports.putLink('c-1', { writerId: 'w', calendarId: 'cal', eventId, contentHash: 'h', state: 'linked' }))
      .rejects.toBeInstanceOf(AccountChangedError);
    await ports.rollbackUnlinked();
    expect(deleted).not.toHaveBeenCalledWith('e-new');
  });

  it('R7-002: a removal interrupted before recording its tuple still never sends that tuple on rejoin', async () => {
    harness = await prepare();
    await AsyncStorage.multiSet([[ENROLLED, '2030-03-20T08:00:00.000Z'], [REMOVED, '2030-03-29T08:00:00.000Z']]);
    await showBusyHost(harness);
    await settle();
    // The revoked tuple survived and nothing recorded which one it was.
    const old = await act(async () => ensureSourceCredential(UID));
    expect(await act(async () => rejoinPhone(UID))).toBe(true);
    const sent = harness.server.matching('POST', /\/calendar\/busy\/register$/)
      .map((request) => (request.body as { sourceInstallationId: string }).sourceInstallationId);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent).not.toContain(old!.sourceInstallationId);
  });

  it('R8-002: an event whose rollback delete failed stays recorded and is removed on the account\'s next pass', async () => {
    let current = true;
    jest.spyOn(deviceCalendar, 'createEvent').mockResolvedValue('e-left');
    const remove = jest.spyOn(deviceCalendar, 'deleteEvent').mockRejectedValueOnce(new Error('busy')).mockResolvedValue(undefined);
    const first = accountBoundCalendar(() => current, UID);
    await first.calendar.createEvent('cal', {} as never);
    current = false;
    await first.rollbackUnlinked();
    expect(JSON.parse((await AsyncStorage.getItem(`calendar.unlinkedCreated.v1:${UID}`)) ?? '[]')).toEqual(['e-left']);
    current = true;
    const next = accountBoundCalendar(() => current, UID);
    await next.recoverUnlinked(new Set());
    expect(remove).toHaveBeenLastCalledWith('e-left');
    expect(JSON.parse((await AsyncStorage.getItem(`calendar.unlinkedCreated.v1:${UID}`)) ?? '[]')).toEqual([]);
  });

  it('R8-002: recovery never deletes an event a stored link names', async () => {
    await AsyncStorage.setItem(`calendar.unlinkedCreated.v1:${UID}`, JSON.stringify(['e-linked']));
    const remove = jest.spyOn(deviceCalendar, 'deleteEvent').mockResolvedValue(undefined);
    await accountBoundCalendar(() => true, UID).recoverUnlinked(new Set(['e-linked']));
    expect(remove).not.toHaveBeenCalled();
  });

  it('R8-003: a rejoin whose marker cannot be stored sends nothing', async () => {
    harness = await prepare();
    await AsyncStorage.multiSet([[ENROLLED, '2030-03-20T08:00:00.000Z'], [REMOVED, '2030-03-29T08:00:00.000Z']]);
    await showBusyHost(harness);
    await settle();
    const original = (AsyncStorage.setItem as jest.Mock).getMockImplementation() as (key: string, value: string) => Promise<void>;
    jest.spyOn(AsyncStorage, 'setItem').mockImplementation((key, value) => {
      if (key === `calendar.rejoinInstallation.v1:${UID}`) return Promise.reject(new Error('disk full'));
      return original(key, value);
    });
    expect(await act(async () => rejoinPhone(UID))).toBe(false);
    expect(harness.server.matching('POST', /\/calendar\/busy\/register$/)).toHaveLength(0);
  });
});

