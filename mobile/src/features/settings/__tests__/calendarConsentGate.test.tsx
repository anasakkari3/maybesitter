import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { screen, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { deviceCalendar } from '../../calendar/deviceCalendar';
import { ACCOUNT_A, NOW, initialState, prepare, showCalendar, teardown, type M5aHarness } from '../../../__acceptance__/m5a/harness';

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

async function calendarWith(consent: boolean) {
  harness = await prepare('en', { ...initialState(), trustConsent: consent });
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
});
