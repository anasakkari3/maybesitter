import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { screen, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { deviceCalendar } from '../../features/calendar/deviceCalendar';
import { BUSY_BLOCKS_KEY } from '../../lib/deviceSettings/calendarBusy';
import {
  ACCOUNT_A,
  NOW,
  changeSwitch,
  initialState,
  prepare,
  press,
  showCalendar,
  teardown,
  waitForRequest,
  type M5aHarness,
} from './harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

const UID = ACCOUNT_A.uid;
const INCLUDED = `calendar.includedCalendarIds.v1:${UID}`;
const ENROLLED = `calendar.choiceEnrolledAt.v1:${UID}`;
const PENDING = `calendar.pendingSelection.v1:${UID}`;
const REMOVED = `calendar.phoneRemoved.v1:${UID}`;

let harness: M5aHarness | undefined;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  jest.spyOn(deviceCalendar, 'getAccess').mockResolvedValue('granted');
  jest.spyOn(deviceCalendar, 'requestAccess').mockResolvedValue('granted');
  jest.spyOn(deviceCalendar, 'listWritableCalendars').mockResolvedValue([]);
  jest.spyOn(deviceCalendar, 'listEventCalendars').mockResolvedValue([
    { id: 'work', title: 'Work', color: null, sourceName: 'work@example.com' },
  ]);
  jest.spyOn(deviceCalendar, 'fetchBusyBlocks').mockResolvedValue([]);
});

afterEach(async () => {
  await teardown(harness);
  harness = undefined;
  jest.useRealTimers();
});

async function enrolledCalendar(state = initialState()) {
  harness = await prepare('en', state);
  await AsyncStorage.setItem(ENROLLED, '2030-03-20T08:00:00.000Z');
  await showCalendar(harness);
  await waitFor(() => expect(screen.queryByTestId('calendar-include-work')).not.toBeNull());
}

describe('M5a two-phase calendar selection', () => {
  it('M5A-R51-001 persists the sole pending record before intent and sends nothing when persistence fails', async () => {
    harness = await prepare();
    await AsyncStorage.setItem(ENROLLED, '2030-03-20T08:00:00.000Z');
    const original = AsyncStorage.setItem.bind(AsyncStorage);
    jest.spyOn(AsyncStorage, 'setItem').mockImplementation((key, value) => {
      if (key === PENDING) return Promise.reject(new Error('disk full'));
      return original(key, value);
    });
    await showCalendar(harness);
    await waitFor(() => expect(screen.queryByTestId('calendar-include-work')).not.toBeNull());
    await changeSwitch('calendar-include-work', true);

    expect(harness.server.matching('POST', /\/calendar\/busy\/intent$/)).toHaveLength(0);
    expect(harness.server.matching('POST', /\/calendar\/busy$/)).toHaveLength(0);
    expect(screen.queryByTestId('calendar-save-failed')).not.toBeNull();
    expect(screen.getByTestId('calendar-include-work').props.accessibilityState).toMatchObject({ checked: false });
  });

  it('M5A-R52-001/002 stores an intent, registers once, then reads and continues with opId plus epoch', async () => {
    const timeline: string[] = [];
    const originalSet = AsyncStorage.setItem.bind(AsyncStorage);
    jest.spyOn(AsyncStorage, 'setItem').mockImplementation(async (key, value) => {
      if (key === PENDING) timeline.push('pending');
      return originalSet(key, value);
    });
    (deviceCalendar.fetchBusyBlocks as jest.Mock).mockImplementation(async () => {
      timeline.push('read');
      return [];
    });
    await enrolledCalendar();
    await changeSwitch('calendar-include-work', true);

    const register = await waitForRequest(harness!, 'POST', /\/calendar\/busy\/register$/);
    const intent = await waitForRequest(harness!, 'POST', /\/calendar\/busy\/intent$/);
    const upload = await waitForRequest(harness!, 'POST', /\/calendar\/busy$/);
    const pending = JSON.parse((await AsyncStorage.getItem(PENDING)) ?? '{}') as Record<string, unknown>;

    expect(register.body).toEqual({
      sourceInstallationId: expect.any(String), sourceSecret: expect.any(String), registrationId: expect.any(String),
    });
    expect(intent.body).toEqual({
      sourceId: 'device:m5a-phone', intentId: expect.any(String), operation: 'upload',
      selectionDigest: expect.any(String), choiceVersion: 1,
    });
    expect(intent.headers['x-maybesitter-source-secret']).toEqual(expect.any(String));
    expect(upload.body).toMatchObject({ opId: 'op-1', epoch: 7, selectionEpoch: expect.any(Number), choiceVersion: 1 });
    expect(upload.headers['x-maybesitter-source-secret']).toEqual(expect.any(String));
    expect(timeline.indexOf('pending')).toBeLessThan(timeline.indexOf('read'));
    expect(pending).toEqual({});
  });

  it('M5A-R53-005 deselecting the last calendar uses operation clear and no native read', async () => {
    harness = await prepare();
    await AsyncStorage.multiSet([
      [ENROLLED, '2030-03-20T08:00:00.000Z'],
      [INCLUDED, JSON.stringify(['work'])],
    ]);
    await showCalendar(harness);
    await waitFor(() => expect(screen.queryByTestId('calendar-include-work')).not.toBeNull());
    (deviceCalendar.fetchBusyBlocks as jest.Mock).mockClear();
    await changeSwitch('calendar-include-work', false);

    const intent = await waitForRequest(harness, 'POST', /\/calendar\/busy\/intent$/);
    const clear = await waitForRequest(harness, 'DELETE', /\/calendar\/busy$/);
    expect(intent.body).toMatchObject({ operation: 'clear', choiceVersion: 1 });
    expect(clear.query.get('opId')).toBe('op-1');
    expect(clear.query.get('epoch')).toBe('7');
    expect(deviceCalendar.fetchBusyBlocks).not.toHaveBeenCalled();
  });

  it('M5A-R53-001 selection_stale discards the old op and mints a fresh intentId', async () => {
    let intents = 0;
    harness = await prepare('en', initialState(), request => {
      if (request.path === '/api/mobile/calendar/busy/intent') {
        intents += 1;
        if (intents === 1) return { status: 409, body: { success: false, error: 'selection_stale', currentEpoch: 9 } };
      }
      return undefined;
    });
    await AsyncStorage.setItem(ENROLLED, '2030-03-20T08:00:00.000Z');
    await showCalendar(harness);
    await waitFor(() => expect(screen.queryByTestId('calendar-include-work')).not.toBeNull());
    await changeSwitch('calendar-include-work', true);
    await waitFor(() => expect(harness!.server.matching('POST', /\/calendar\/busy\/intent$/)).toHaveLength(2));

    const [first, second] = harness.server.matching('POST', /\/calendar\/busy\/intent$/);
    expect((first!.body as { intentId: string }).intentId).not.toBe((second!.body as { intentId: string }).intentId);
    expect((second!.body as { operation: string }).operation).toBe('upload');
  });

  it('M5A-R54-001 ignores a stale intentId response after a rapid newer selection', async () => {
    const releases: ((reply: { status: number; body: unknown }) => void)[] = [];
    harness = await prepare('en', initialState(), request => {
      if (request.path === '/api/mobile/calendar/busy/intent') {
        return new Promise(resolve => { releases.push(resolve); });
      }
      return undefined;
    });
    await AsyncStorage.setItem(ENROLLED, '2030-03-20T08:00:00.000Z');
    await showCalendar(harness);
    await waitFor(() => expect(screen.queryByTestId('calendar-include-work')).not.toBeNull());
    await changeSwitch('calendar-include-work', true);
    await changeSwitch('calendar-include-work', false);
    await waitFor(() => expect(releases.length).toBe(2));
    const requests = harness.server.matching('POST', /\/calendar\/busy\/intent$/);
    const oldId = (requests[0]!.body as { intentId: string }).intentId;
    const newId = (requests[1]!.body as { intentId: string }).intentId;
    releases[1]!({ status: 200, body: { success: true, opId: 'new-op', epoch: 11, intentId: newId } });
    releases[0]!({ status: 200, body: { success: true, opId: 'old-op', epoch: 10, intentId: oldId } });
    await waitFor(() => expect(AsyncStorage.getItem(INCLUDED)).resolves.toBe(JSON.stringify([])));

    expect(harness.server.requests.some(request => JSON.stringify(request.body).includes('old-op'))).toBe(false);
  });

  it('M5A-011 confirms storage before showing a switch or starting sync, and clears the old cache first', async () => {
    const order: string[] = [];
    jest.spyOn(AsyncStorage, 'multiRemove').mockImplementation(async keys => {
      if (keys.includes(BUSY_BLOCKS_KEY)) order.push('cache-cleared');
    });
    (deviceCalendar.fetchBusyBlocks as jest.Mock).mockImplementation(async () => {
      order.push('read');
      return [];
    });
    await enrolledCalendar();
    await changeSwitch('calendar-include-work', true);
    await waitFor(() => expect(deviceCalendar.fetchBusyBlocks).toHaveBeenCalled());

    expect(screen.getByTestId('calendar-include-work').props.accessibilityState).toMatchObject({ checked: true });
    expect(order.indexOf('cache-cleared')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('cache-cleared')).toBeLessThan(order.indexOf('read'));
  });

  it('M5A-R51-001 unreadable inclusion storage blocks reads and shows calendar-save-failed', async () => {
    const original = AsyncStorage.getItem.bind(AsyncStorage);
    jest.spyOn(AsyncStorage, 'getItem').mockImplementation(key => {
      if (key === INCLUDED) return Promise.reject(new Error('unreadable'));
      return original(key);
    });
    await enrolledCalendar();

    expect(deviceCalendar.fetchBusyBlocks).not.toHaveBeenCalled();
    expect(screen.queryByTestId('calendar-save-failed')).not.toBeNull();
  });
});

describe('M5a source credentials and revocation', () => {
  it('M5A-R55-001 / M5A-R56-001 persists one secure tuple and single-flights registration', async () => {
    const secureWrites = jest.spyOn(SecureStore, 'setItemAsync');
    await enrolledCalendar();
    await Promise.all([
      changeSwitch('calendar-include-work', true),
      changeSwitch('calendar-include-work', true),
    ]);
    await waitForRequest(harness!, 'POST', /\/calendar\/busy\/register$/);

    const tuples = secureWrites.mock.calls.map(call => JSON.parse(String(call[1])) as Record<string, unknown>)
      .filter(value => value.sourceInstallationId && value.sourceSecret && value.registrationId);
    expect(tuples).toHaveLength(1);
    expect(harness!.server.matching('POST', /\/calendar\/busy\/register$/)).toHaveLength(1);
  });

  it('M5A-R55-001 secure storage failure refuses registration, intent, and native read', async () => {
    jest.spyOn(SecureStore, 'setItemAsync').mockRejectedValue(new Error('keychain unavailable'));
    await enrolledCalendar();
    (deviceCalendar.fetchBusyBlocks as jest.Mock).mockClear();
    await changeSwitch('calendar-include-work', true);

    expect(harness!.server.matching('POST', /\/calendar\/busy\/register$/)).toHaveLength(0);
    expect(harness!.server.matching('POST', /\/calendar\/busy\/intent$/)).toHaveLength(0);
    expect(deviceCalendar.fetchBusyBlocks).not.toHaveBeenCalled();
  });

  it('M5A-R57-003 too_many_phones is rendered and never starts a native read', async () => {
    harness = await prepare('en', initialState(), request => {
      if (request.path === '/api/mobile/calendar/busy/register') {
        return { status: 409, body: { success: false, error: 'too_many_phones' } };
      }
      return undefined;
    });
    await AsyncStorage.setItem(ENROLLED, '2030-03-20T08:00:00.000Z');
    await showCalendar(harness);
    await waitFor(() => expect(screen.queryByTestId('calendar-include-work')).not.toBeNull());
    (deviceCalendar.fetchBusyBlocks as jest.Mock).mockClear();
    await changeSwitch('calendar-include-work', true);
    await waitFor(() => expect(screen.queryByTestId('calendar-too-many-phones')).not.toBeNull());

    expect(deviceCalendar.fetchBusyBlocks).not.toHaveBeenCalled();
  });

  it.each(['source_revoked', 'probe_revoked'] as const)(
    'M5A-R59-001 %s writes the phoneRemoved barrier before clearing credentials and blocks restart reads',
    async kind => {
      const secureDelete = jest.spyOn(SecureStore, 'deleteItemAsync');
      harness = await prepare('en', initialState({ sourceStatus: kind === 'probe_revoked' ? 'revoked' : 'active' }), request => {
        if (kind === 'source_revoked' && request.path === '/api/mobile/calendar/busy/register') {
          return { status: 409, body: { success: false, error: 'source_revoked' } };
        }
        return undefined;
      });
      await AsyncStorage.setItem(ENROLLED, '2030-03-20T08:00:00.000Z');
      await showCalendar(harness);
      if (kind === 'source_revoked') {
        await waitFor(() => expect(screen.queryByTestId('calendar-include-work')).not.toBeNull());
        await changeSwitch('calendar-include-work', true);
      }
      await waitFor(() => expect(screen.queryByTestId('calendar-this-phone-removed')).not.toBeNull());

      expect(await AsyncStorage.getItem(REMOVED)).not.toBeNull();
      expect(secureDelete).toHaveBeenCalled();
      expect(deviceCalendar.fetchBusyBlocks).not.toHaveBeenCalled();
      expect(harness.server.matching('POST', /\/calendar\/busy\/register$/).length).toBe(kind === 'source_revoked' ? 1 : 0);
    },
  );

  it('M5A-R60-001 rejoin clears the barrier, mints a new tuple, and registers before reading', async () => {
    harness = await prepare('en', initialState({ sourceStatus: 'revoked' }));
    await AsyncStorage.multiSet([
      [ENROLLED, '2030-03-20T08:00:00.000Z'],
      [REMOVED, '2030-03-29T08:00:00.000Z'],
      [INCLUDED, JSON.stringify(['work'])],
    ]);
    await showCalendar(harness);
    await waitFor(() => expect(screen.queryByTestId('calendar-this-phone-rejoin')).not.toBeNull());
    await press('calendar-this-phone-rejoin');
    await waitForRequest(harness, 'POST', /\/calendar\/busy\/register$/);

    expect(await AsyncStorage.getItem(REMOVED)).toBeNull();
    expect(SecureStore.setItemAsync).toHaveBeenCalled();
    expect(deviceCalendar.fetchBusyBlocks).toHaveBeenCalled();
  });
});

