import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, screen, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { BusyCalendarHost, resetBusySyncForTests } from '../../features/calendar/useBusyCalendar';
import { deviceCalendar } from '../../features/calendar/deviceCalendar';
import { BUSY_BLOCKS_KEY } from '../../lib/deviceSettings/calendarBusy';
import {
  ACCOUNT_A,
  ACCOUNT_B,
  NOW,
  Providers,
  captureAppState,
  initialState,
  prepare,
  showBusyHost,
  showCalendar,
  teardown,
  waitForRequest,
  type M5aHarness,
} from './harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

const INCLUDED_A = `calendar.includedCalendarIds.v1:${ACCOUNT_A.uid}`;
const INCLUDED_B = `calendar.includedCalendarIds.v1:${ACCOUNT_B.uid}`;
const ENROLLED_A = `calendar.choiceEnrolledAt.v1:${ACCOUNT_A.uid}`;
const PENDING_A = `calendar.choicePending.v1:${ACCOUNT_A.uid}`;

let harness: M5aHarness | undefined;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  jest.spyOn(deviceCalendar, 'getAccess').mockResolvedValue('granted');
  jest.spyOn(deviceCalendar, 'requestAccess').mockResolvedValue('granted');
  jest.spyOn(deviceCalendar, 'listWritableCalendars').mockResolvedValue([]);
  jest.spyOn(deviceCalendar, 'listEventCalendars').mockResolvedValue([
    { id: 'work', title: 'Work', color: null, sourceName: 'work@example.com' },
    { id: 'home', title: 'Home', color: null, sourceName: 'iCloud' },
  ]);
  jest.spyOn(deviceCalendar, 'fetchBusyBlocks').mockResolvedValue([]);
});

afterEach(async () => {
  await teardown(harness);
  harness = undefined;
  jest.useRealTimers();
});

describe('M5a calendar capability and enrolment', () => {
  it('M5A-R2-002 unknown capability blocks every native calendar read on a never-enrolled device', async () => {
    harness = await prepare('en', initialState(), request => {
      if (request.path === '/api/mobile/capabilities/m5a') return new Promise(() => undefined);
      return undefined;
    });
    await showBusyHost(harness);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(harness.server.matching('GET', /\/capabilities\/m5a$/)).toHaveLength(1);
    expect(deviceCalendar.fetchBusyBlocks).not.toHaveBeenCalled();
  });

  it('M5A-R2-002 a probe error remains unknown and starts zero native reads', async () => {
    harness = await prepare('en', initialState(), request => {
      if (request.path === '/api/mobile/capabilities/m5a') {
        return { status: 503, body: { success: false, error: 'unavailable', reason: 'unavailable' } };
      }
      return undefined;
    });
    await showBusyHost(harness);
    await waitForRequest(harness, 'GET', /\/capabilities\/m5a$/);
    await act(async () => { await Promise.resolve(); });

    expect(deviceCalendar.fetchBusyBlocks).not.toHaveBeenCalled();
  });

  it('Release known false preserves the legacy screen and exclusion read without any M5a mutation', async () => {
    harness = await prepare('en', initialState({ calendarChoice: false }));
    await AsyncStorage.setItem('calendar.excludedCalendarIds.v1', JSON.stringify(['home']));
    await showCalendar(harness);
    await waitForRequest(harness, 'GET', /\/capabilities\/m5a$/);
    await waitFor(() => expect(deviceCalendar.fetchBusyBlocks).toHaveBeenCalled());

    expect(screen.queryByTestId('calendar-read-toggle')).not.toBeNull();
    expect(screen.queryByTestId('calendar-perm-section')).toBeNull();
    expect(harness.server.matching('POST', /\/calendar\/choice$/)).toHaveLength(0);
    expect(harness.server.matching('POST', /\/calendar\/busy\/intent$/)).toHaveLength(0);
    const options = (deviceCalendar.fetchBusyBlocks as jest.Mock).mock.calls.at(-1)?.[0] as { excludedCalendarIds?: Set<string> };
    expect([...(options.excludedCalendarIds ?? [])]).toEqual(['home']);
  });

  it('R1.1 / M5A-R9-004 persists choicePending before enrolment and reads only after the server answers active', async () => {
    const order: string[] = [];
    const originalSet = (AsyncStorage.setItem as jest.Mock).getMockImplementation() as
      ((key: string, value: string) => Promise<void>);
    jest.spyOn(AsyncStorage, 'setItem').mockImplementation(async (key, value) => {
      if (key === PENDING_A) order.push('pending');
      if (key === ENROLLED_A) order.push('enrolled');
      return originalSet(key, value);
    });
    const originalMultiRemove = (AsyncStorage.multiRemove as jest.Mock).getMockImplementation() as
      ((keys: readonly string[]) => Promise<void>);
    jest.spyOn(AsyncStorage, 'multiRemove').mockImplementation(async keys => {
      if (keys.includes(BUSY_BLOCKS_KEY)) order.push('cache-cleared');
      await originalMultiRemove(keys);
    });
    (deviceCalendar.fetchBusyBlocks as jest.Mock).mockImplementation(async () => {
      order.push('read');
      return [];
    });
    harness = await prepare('en', initialState({ calendarEnrolled: false }), async request => {
      if (request.path === '/api/mobile/calendar/choice' && request.method === 'POST') {
        expect(await AsyncStorage.getItem(PENDING_A)).not.toBeNull();
        expect(deviceCalendar.fetchBusyBlocks).not.toHaveBeenCalled();
        order.push('post');
      }
      return undefined;
    });
    await AsyncStorage.setItem(BUSY_BLOCKS_KEY, JSON.stringify({ owner: ACCOUNT_A.uid, blocks: ['stale'] }));
    await showBusyHost(harness);
    await waitForRequest(harness, 'POST', /\/calendar\/choice$/);
    await waitFor(() => expect(deviceCalendar.fetchBusyBlocks).toHaveBeenCalledTimes(1));

    expect(order.indexOf('pending')).toBeLessThan(order.indexOf('post'));
    expect(order.indexOf('post')).toBeLessThan(order.indexOf('enrolled'));
    expect(order.indexOf('cache-cleared')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('cache-cleared')).toBeLessThan(order.indexOf('read'));
    expect(order.indexOf('enrolled')).toBeLessThan(order.indexOf('read'));
    expect(await AsyncStorage.getItem(PENDING_A)).toBeNull();
    expect(await AsyncStorage.getItem(ENROLLED_A)).not.toBeNull();
  });

  it('M5A-R9-004 purging keeps choicePending and retries on the next pass without reading', async () => {
    const fireAppState = captureAppState();
    harness = await prepare('en', initialState({ calendarChoiceState: 'purging', calendarEnrolled: false }));
    await showBusyHost(harness);
    await waitForRequest(harness, 'POST', /\/calendar\/choice$/);

    expect(await AsyncStorage.getItem(PENDING_A)).not.toBeNull();
    expect(await AsyncStorage.getItem(ENROLLED_A)).toBeNull();
    expect(deviceCalendar.fetchBusyBlocks).not.toHaveBeenCalled();

    await act(async () => {
      fireAppState('active');
    });
    await waitFor(() => expect(harness!.server.matching('POST', /\/calendar\/choice$/).length).toBeGreaterThanOrEqual(2));
    expect(deviceCalendar.fetchBusyBlocks).not.toHaveBeenCalled();
  });

  it('M5A-R51-005 a restart with choicePending finishes from GET active after a lost POST response', async () => {
    harness = await prepare('en', initialState({ calendarEnrolled: true }), request => {
      if (request.path === '/api/mobile/calendar/choice' && request.method === 'POST') {
        return { status: 503, body: { success: false, error: 'unavailable', reason: 'unavailable' } };
      }
      return undefined;
    });
    await AsyncStorage.setItem(PENDING_A, '2030-03-29T08:00:00.000Z');
    await showBusyHost(harness);
    await waitForRequest(harness, 'GET', /\/calendar\/choice$/);
    await waitFor(() => expect(AsyncStorage.getItem(ENROLLED_A)).resolves.not.toBeNull());

    expect(harness.server.matching('POST', /\/calendar\/choice$/)).toHaveLength(0);
    expect(await AsyncStorage.getItem(PENDING_A)).toBeNull();
    expect(deviceCalendar.fetchBusyBlocks).toHaveBeenCalledTimes(1);
  });

  it('M5A-R2-003 capability loss keeps an enrolled M5a screen and inclusion-only native reads', async () => {
    harness = await prepare('en', initialState({ calendarChoice: false }));
    await AsyncStorage.multiSet([
      [ENROLLED_A, '2030-03-20T08:00:00.000Z'],
      [INCLUDED_A, JSON.stringify(['work'])],
      ['calendar.excludedCalendarIds.v1', JSON.stringify(['work'])],
    ]);
    await showCalendar(harness);
    await waitFor(() => expect(screen.queryByTestId('calendar-list-section')).not.toBeNull());
    await waitFor(() => expect(deviceCalendar.fetchBusyBlocks).toHaveBeenCalled());

    expect(screen.queryByTestId('calendar-perm-section')).not.toBeNull();
    expect(screen.getByTestId('calendar-include-work').props.accessibilityState).toMatchObject({ checked: true });
    const options = (deviceCalendar.fetchBusyBlocks as jest.Mock).mock.calls.at(-1)?.[0] as { includedCalendarIds?: Set<string> };
    expect([...(options.includedCalendarIds ?? [])]).toEqual(['work']);
  });

  it('M5A-R2-001 A to B on one phone starts with empty per-account inclusion and enrolment', async () => {
    harness = await prepare('en', initialState({ calendarChoice: false }));
    await AsyncStorage.multiSet([
      [ENROLLED_A, '2030-03-20T08:00:00.000Z'],
      [INCLUDED_A, JSON.stringify(['work'])],
    ]);
    const view = await showCalendar(harness);
    await waitFor(() => expect(screen.queryByTestId('calendar-include-work')).not.toBeNull());
    expect(screen.getByTestId('calendar-include-work').props.accessibilityState).toMatchObject({ checked: true });

    resetBusySyncForTests();
    await act(async () => { harness!.repository.emit(ACCOUNT_B); });
    await act(async () => {
      await view.rerender(
        <Providers harness={harness!}>
          <BusyCalendarHost key={ACCOUNT_B.uid} />
        </Providers>,
      );
    });

    expect(await AsyncStorage.getItem(INCLUDED_B)).toBeNull();
    expect(await AsyncStorage.getItem(`calendar.choiceEnrolledAt.v1:${ACCOUNT_B.uid}`)).toBeNull();
  });

  it('M5A-R53-002 a uid change while a pass is paused sends no calendar request as B', async () => {
    let releaseRead: ((value: []) => void) | undefined;
    (deviceCalendar.fetchBusyBlocks as jest.Mock).mockImplementation(() => new Promise<[]>(resolve => { releaseRead = resolve; }));
    harness = await prepare('en', initialState({ calendarChoice: false }));
    await AsyncStorage.multiSet([
      [ENROLLED_A, '2030-03-20T08:00:00.000Z'],
      [INCLUDED_A, JSON.stringify(['work'])],
    ]);
    await showBusyHost(harness);
    await waitForRequest(harness, 'GET', /\/capabilities\/m5a$/);
    await waitFor(() => expect(deviceCalendar.fetchBusyBlocks).toHaveBeenCalledTimes(1));
    await act(async () => { harness!.repository.emit(ACCOUNT_B); });
    await act(async () => { releaseRead?.([]); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const writes = harness.server.requests.filter(request =>
      request.method !== 'GET' && request.path.startsWith('/api/mobile/calendar/'));
    expect(writes).toHaveLength(0);
  });
});

