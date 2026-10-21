import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, screen, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { deviceCalendar } from '../../calendar/deviceCalendar';
import {
  ACCOUNT_A, NOW, changeSwitch, initialState, prepare, showCalendar, teardown, trustResponse,
  type M5aHarness, type RouteReply,
} from '../../../__acceptance__/m5a/harness';

/**
 * M6b BB-08 with Codex M6B-R02: the phone-calendar switches follow the master
 * «MaybeSitter uses your calendar» switch itself, not enrollment, and say so.
 */
let harness: M5aHarness | undefined;
const ENROLLED = `calendar.choiceEnrolledAt.v1:${ACCOUNT_A.uid}`;

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

const PENDING = `calendar.pendingSelection.v1:${ACCOUNT_A.uid}`;

async function calendarWith(consent: boolean, handler?: Parameters<typeof prepare>[2]) {
  harness = await prepare('en', { ...initialState(), trustConsent: consent }, handler);
  await AsyncStorage.setItem(ENROLLED, '2030-03-20T08:00:00.000Z');
  await showCalendar(harness);
  await waitFor(() => expect(screen.queryByTestId('calendar-include-work')).not.toBeNull());
}

describe('the calendar switches follow «uses your calendar»', () => {
  it('an enrolled account with the master switch off: switches disabled, and the hint says why', async () => {
    await calendarWith(false);
    expect(screen.getByTestId('calendar-include-work').props.accessibilityState).toMatchObject({ disabled: true });
    expect(screen.queryByTestId('calendar-list-needs-use')).not.toBeNull();
  });

  it('with the master switch on: switches usable and no hint', async () => {
    await calendarWith(true);
    await waitFor(() => expect(screen.getByTestId('calendar-include-work').props.accessibilityState).toMatchObject({ disabled: false }));
    expect(screen.queryByTestId('calendar-list-needs-use')).toBeNull();
  });

  it('turning the master switch off disables the list at once, before the server answers (Codex M6B-R3-001)', async () => {
    let answer: ((reply: RouteReply) => void) | undefined;
    await calendarWith(true, (request) => {
      if (request.method !== 'POST' || request.path !== '/api/mobile/pilot/trust') return undefined;
      return new Promise<RouteReply>((resolve) => { answer = resolve; });
    });
    await waitFor(() => expect(screen.getByTestId('calendar-include-work').props.accessibilityState).toMatchObject({ disabled: false }));

    await changeSwitch('calendar-use-toggle', false);
    await waitFor(() => expect(answer).toBeDefined());
    // The trust query still says on: the list must not.
    expect(screen.getByTestId('calendar-include-work').props.accessibilityState).toMatchObject({ disabled: true });
    expect(screen.queryByTestId('calendar-list-needs-use')).not.toBeNull();
    await changeSwitch('calendar-include-work', true);
    expect(await AsyncStorage.getItem(PENDING)).toBeNull();

    harness!.server.state.trustConsent = false;
    await act(async () => { answer!({ status: 200, body: trustResponse(false) }); });
    await waitFor(() => expect(screen.getByTestId('calendar-use-toggle').props.value).toBe(false));
    expect(screen.getByTestId('calendar-include-work').props.accessibilityState).toMatchObject({ disabled: true });
    expect(await AsyncStorage.getItem(PENDING)).toBeNull();
  });

  it('a refused switch-off leaves the list usable again', async () => {
    await calendarWith(true, (request) => (
      request.method === 'POST' && request.path === '/api/mobile/pilot/trust' ? { status: 503, body: { success: false } } : undefined
    ));
    await waitFor(() => expect(screen.getByTestId('calendar-include-work').props.accessibilityState).toMatchObject({ disabled: false }));
    await changeSwitch('calendar-use-toggle', false);
    await waitFor(() => expect(screen.getByTestId('calendar-include-work').props.accessibilityState).toMatchObject({ disabled: false }));
    expect(screen.getByTestId('calendar-use-toggle').props.value).toBe(true);
  });
});
