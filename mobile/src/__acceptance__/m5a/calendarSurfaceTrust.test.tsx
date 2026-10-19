import React from 'react';
import { Text } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, render, screen, waitFor, within } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { deviceCalendar } from '../../features/calendar/deviceCalendar';
import { BusyCalendarHost, useBusyBlocks } from '../../features/calendar/useBusyCalendar';
import { BUSY_BLOCKS_KEY } from '../../lib/deviceSettings/calendarBusy';
import {
  ACCOUNT_A,
  ACCOUNT_B,
  NOW,
  Providers,
  captureAppState,
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

const ENROLLED = `calendar.choiceEnrolledAt.v1:${ACCOUNT_A.uid}`;
const INCLUDED = `calendar.includedCalendarIds.v1:${ACCOUNT_A.uid}`;

let harness: M5aHarness | undefined;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  jest.spyOn(deviceCalendar, 'getAccess').mockResolvedValue('granted');
  jest.spyOn(deviceCalendar, 'requestAccess').mockResolvedValue('granted');
  jest.spyOn(deviceCalendar, 'listWritableCalendars').mockResolvedValue([
    { id: 'write-a', title: 'Writable', color: null, isPrimary: true, sourceName: 'iCloud' },
  ]);
  jest.spyOn(deviceCalendar, 'listEventCalendars').mockResolvedValue([
    { id: 'work', title: 'Work', color: null, sourceName: 'work@example.com' },
    { id: 'home', title: 'Home', color: null, sourceName: 'iCloud' },
  ]);
  jest.spyOn(deviceCalendar, 'fetchBusyBlocks').mockResolvedValue([]);
});

afterEach(async () => {
  await teardown(harness);
  harness = undefined;
  delete process.env.EXPO_PUBLIC_FEATURE_CALENDAR_WRITE;
  jest.useRealTimers();
});

async function showEnrolled(state = initialState()) {
  harness = await prepare('en', state);
  await AsyncStorage.setItem(ENROLLED, '2030-03-20T08:00:00.000Z');
  await showCalendar(harness);
  await waitFor(() => expect(screen.queryByTestId('calendar-perm-section')).not.toBeNull());
}

describe('R1.2 four distinct calendar sections', () => {
  it('R1.2 renders permission, use, phone-calendar and Google sections with independent controls', async () => {
    await showEnrolled();

    for (const id of ['calendar-perm-section', 'calendar-use-section', 'calendar-list-section', 'calendar-google-section']) {
      expect(screen.queryByTestId(id)).not.toBeNull();
    }
    expect(screen.getByTestId('calendar-use-toggle').props.accessibilityRole).toBe('switch');
    expect(screen.getByTestId('calendar-include-work').props.accessibilityRole).toBe('switch');
    expect(screen.queryByTestId('calendar-account-work@example.com')).not.toBeNull();
    expect(screen.queryByTestId('calendar-google-open')).not.toBeNull();
    expect(within(screen.getByTestId('calendar-google-section')).queryByText(/person@example\.com/)).not.toBeNull();
  });

  it('R1.2 calendar-perm-allow invokes the OS prompt from the permission section', async () => {
    jest.mocked(deviceCalendar.getAccess).mockResolvedValue('undetermined');
    await showEnrolled();
    await press('calendar-perm-allow');

    expect(deviceCalendar.requestAccess).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('calendar-use-toggle').props.accessibilityState).toMatchObject({ disabled: false });
  });

  it('R1.2 calendar-use-toggle never invokes the OS prompt when permission is missing', async () => {
    jest.mocked(deviceCalendar.getAccess).mockResolvedValue('undetermined');
    await showEnrolled();
    await changeSwitch('calendar-use-toggle', true);

    expect(deviceCalendar.requestAccess).not.toHaveBeenCalled();
    expect(screen.queryByTestId('calendar-perm-allow')).not.toBeNull();
  });

  it('M5A-R2-003 starts with no included calendars and exposes the one-screen empty notice', async () => {
    await showEnrolled();

    expect(screen.queryByTestId('calendar-none-chosen')).not.toBeNull();
    expect(screen.getByTestId('calendar-include-work').props.accessibilityState).toMatchObject({ checked: false });
    expect(screen.getByTestId('calendar-include-home').props.accessibilityState).toMatchObject({ checked: false });
    expect(deviceCalendar.fetchBusyBlocks).not.toHaveBeenCalled();
  });

  it('R1.2 denied permission offers only open settings in its own section', async () => {
    jest.mocked(deviceCalendar.getAccess).mockResolvedValue('denied');
    await showEnrolled();

    expect(within(screen.getByTestId('calendar-perm-section')).queryByTestId('calendar-perm-open-settings')).not.toBeNull();
    expect(screen.queryByTestId('calendar-perm-allow')).toBeNull();
    expect(screen.getByTestId('calendar-use-toggle').props.accessibilityState).toMatchObject({ disabled: false });
  });

  it('R1.2 lists every phone-source status with nullable fields and revokes one explicitly', async () => {
    await showEnrolled(initialState({
      sources: [
        { sourceId: 'device:old', status: 'registered', platform: null, lastUploadAt: null, blockCount: 0 },
        { sourceId: 'device:uploading', status: 'uploading', platform: 'ios', lastUploadAt: null, blockCount: 0 },
        { sourceId: 'device:active', status: 'active', platform: 'ios', lastUploadAt: '2030-03-28T07:00:00.000Z', blockCount: 2 },
        { sourceId: 'device:clearing', status: 'clearing', platform: null, lastUploadAt: '2030-03-28T07:30:00.000Z', blockCount: 1 },
        { sourceId: 'device:retiring', status: 'retiring', platform: 'android', lastUploadAt: '2030-03-28T08:00:00.000Z', blockCount: 4 },
      ],
    }));

    expect(screen.queryByTestId('calendar-other-phones')).not.toBeNull();
    for (const id of ['device:old', 'device:uploading', 'device:active', 'device:clearing', 'device:retiring']) {
      expect(screen.queryByTestId(`calendar-other-phone-${id}`)).not.toBeNull();
    }
    await press('calendar-other-phone-remove-device:old');
    const request = await waitForRequest(harness!, 'DELETE', /\/calendar\/busy$/);
    expect(request.query.get('sourceId')).toBe('device:old');
    expect(request.query.get('revoke')).toBe('1');
  });

  it('M5A-R7-004 a failed clear stays pending, shows calendar-clear-failed, and retries next pass', async () => {
    let deletes = 0;
    const fireAppState = captureAppState();
    harness = await prepare('en', initialState(), request => {
      if (request.path === '/api/mobile/calendar/busy' && request.method === 'DELETE') {
        deletes += 1;
        if (deletes === 1) return { status: 503, body: { success: false, error: 'unavailable', reason: 'unavailable' } };
      }
      return undefined;
    });
    await AsyncStorage.multiSet([
      [ENROLLED, '2030-03-20T08:00:00.000Z'],
      [INCLUDED, JSON.stringify(['work'])],
    ]);
    await showCalendar(harness);
    await waitFor(() => expect(screen.queryByTestId('calendar-include-work')).not.toBeNull());
    await changeSwitch('calendar-include-work', false);
    await waitFor(() => expect(screen.queryByTestId('calendar-clear-failed')).not.toBeNull());

    await act(async () => { fireAppState('active'); });
    await waitFor(() => expect(deletes).toBe(2));
    expect(screen.queryByTestId('calendar-clear-failed')).toBeNull();
  });
});

describe('per-account local calendar state and cache', () => {
  it('M5A-R21-001 scopes the write-target calendar by uid and never migrates the installation value', async () => {
    process.env.EXPO_PUBLIC_FEATURE_CALENDAR_WRITE = 'true';
    harness = await prepare();
    await AsyncStorage.multiSet([
      [ENROLLED, '2030-03-20T08:00:00.000Z'],
      ['calendar.calendarId.v1', 'legacy-calendar'],
    ]);
    await showCalendar(harness);
    await waitFor(() => expect(screen.queryByTestId('calendar-write-toggle')).not.toBeNull());
    await changeSwitch('calendar-write-toggle', true);
    await waitFor(() => expect(AsyncStorage.getItem(`calendar.calendarId.v1:${ACCOUNT_A.uid}`)).resolves.toBe('write-a'));

    expect(await AsyncStorage.getItem(`calendar.calendarId.v1:${ACCOUNT_B.uid}`)).toBeNull();
    expect(await AsyncStorage.getItem('calendar.calendarId.v1')).toBe('legacy-calendar');
  });

  it('M5A-R21-001 a failed uid-scoped write-target save reverts the picker and starts no device write', async () => {
    process.env.EXPO_PUBLIC_FEATURE_CALENDAR_WRITE = 'true';
    const originalSet = (AsyncStorage.setItem as jest.Mock).getMockImplementation() as
      ((key: string, value: string) => Promise<void>);
    const storageWrite = jest.spyOn(AsyncStorage, 'setItem').mockImplementation((key, value) => {
      if (key === `calendar.calendarId.v1:${ACCOUNT_A.uid}`) return Promise.reject(new Error('disk full'));
      return originalSet(key, value);
    });
    jest.spyOn(deviceCalendar, 'createEvent').mockResolvedValue('event-new');
    harness = await prepare();
    await AsyncStorage.setItem(ENROLLED, '2030-03-20T08:00:00.000Z');
    await showCalendar(harness);
    await waitFor(() => expect(screen.queryByTestId('calendar-write-toggle')).not.toBeNull());
    await changeSwitch('calendar-write-toggle', true);

    expect(storageWrite).toHaveBeenCalledWith(`calendar.calendarId.v1:${ACCOUNT_A.uid}`, 'write-a');
    expect(screen.getByTestId('calendar-write-toggle').props.accessibilityState).toMatchObject({ checked: false });
    expect(await AsyncStorage.getItem(`calendar.calendarId.v1:${ACCOUNT_A.uid}`)).toBeNull();
    expect(deviceCalendar.createEvent).not.toHaveBeenCalled();
  });

  it('M5A-R20-004 scopes written event ids by uid', async () => {
    process.env.EXPO_PUBLIC_FEATURE_CALENDAR_WRITE = 'true';
    harness = await prepare();
    await AsyncStorage.multiSet([
      [ENROLLED, '2030-03-20T08:00:00.000Z'],
      [INCLUDED, JSON.stringify(['work'])],
      [`calendar.writtenEventIds.v1:${ACCOUNT_A.uid}`, JSON.stringify(['event-a'])],
      [`calendar.writtenEventIds.v1:${ACCOUNT_B.uid}`, JSON.stringify([])],
    ]);
    await showCalendar(harness);
    await waitFor(() => expect(deviceCalendar.fetchBusyBlocks).not.toHaveBeenCalledTimes(0));

    const options = (deviceCalendar.fetchBusyBlocks as jest.Mock).mock.calls.at(-1)?.[0] as { ownEventIds?: Set<string> };
    expect([...(options.ownEventIds ?? [])]).toEqual(['event-a']);
  });

  it('M5A-R20-004 B treats A legacy written-event ids as busy rather than its own', async () => {
    harness = await prepare();
    await AsyncStorage.multiSet([
      [`calendar.choiceEnrolledAt.v1:${ACCOUNT_B.uid}`, '2030-03-20T08:00:00.000Z'],
      [`calendar.includedCalendarIds.v1:${ACCOUNT_B.uid}`, JSON.stringify(['work'])],
      ['calendar.writtenEventIds.v1', JSON.stringify(['event-a'])],
      [`calendar.writtenEventIds.v1:${ACCOUNT_A.uid}`, JSON.stringify(['event-a'])],
    ]);
    await act(async () => { harness!.repository.emit(ACCOUNT_B); });
    await showCalendar(harness);
    await waitFor(() => expect(deviceCalendar.fetchBusyBlocks).toHaveBeenCalled());

    const options = (deviceCalendar.fetchBusyBlocks as jest.Mock).mock.calls.at(-1)?.[0] as { ownEventIds?: Set<string> };
    expect([...(options.ownEventIds ?? [])]).toEqual([]);
  });

  it('M5A-R8-004 rejects a cached generation that does not match the current inclusion generation', async () => {
    harness = await prepare();
    jest.mocked(deviceCalendar.fetchBusyBlocks).mockRejectedValue(new Error('native calendar unavailable'));
    await AsyncStorage.multiSet([
      [ENROLLED, '2030-03-20T08:00:00.000Z'],
      [INCLUDED, JSON.stringify(['work'])],
      [BUSY_BLOCKS_KEY, JSON.stringify({
        owner: ACCOUNT_A.uid,
        inclusionGeneration: 3,
        blocks: [{ nativeId: 'stale', startAt: '2030-03-29T10:00:00.000Z', endAt: '2030-03-29T11:00:00.000Z', allDay: false }],
        coverage: { startAt: '2030-03-29T00:00:00.000Z', endAt: '2030-04-26T00:00:00.000Z' },
        syncedAt: NOW.getTime(),
      })],
      [`calendar.inclusionGeneration.v1:${ACCOUNT_A.uid}`, '4'],
    ]);

    function BusyProbe() {
      const blocks = useBusyBlocks();
      return <Text testID="busy-probe">{blocks.length}</Text>;
    }
    await render(<Providers harness={harness}><BusyCalendarHost /><BusyProbe /></Providers>);
    await waitForRequest(harness, 'GET', /\/capabilities\/m5a$/);
    await waitFor(() => expect(screen.queryByTestId('busy-probe')).not.toBeNull());
    expect(screen.getByTestId('busy-probe')).toHaveTextContent('0');
  });
});

describe('M5a request trust header', () => {
  it('M5A-R10-001 / M5A-R12-003 sends X-MaybeSitter-Calendar-Choice: 1 on every request including trust', async () => {
    await showEnrolled();
    await waitForRequest(harness!, 'GET', /\/pilot\/trust$/);
    await waitForRequest(harness!, 'GET', /\/capabilities\/m5a$/);

    const requests = harness!.server.requests.filter(request => request.path.startsWith('/api/mobile/'));
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request.headers['x-maybesitter-calendar-choice']).toBe('1');
    }
  });
});

