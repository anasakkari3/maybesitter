import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { screen, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { deviceCalendar } from '../../features/calendar/deviceCalendar';
import {
  ACCOUNT_A,
  NOW,
  addedItem,
  initialState,
  prepare,
  runningScan,
  showCalendar,
  showIntelligence,
  teardown,
  type M5aHarness,
} from './harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: jest.fn(() => ({ width: 390, height: 844, scale: 3, fontScale: 3.12 })),
}));

const LANGUAGES = ['ar', 'en', 'he'] as const;
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

function unclipped(testID: string): void {
  const node = screen.getByTestId(testID);
  expect(node.props.numberOfLines).not.toBe(1);
  expect(node.props.ellipsizeMode).toBeUndefined();
}

describe('M5a ar/en/he and AX5', () => {
  it.each(LANGUAGES)('R1.2 %s keeps all four calendar sections, switches, and actions present at AX5', async language => {
    harness = await prepare(language);
    await AsyncStorage.setItem(`calendar.choiceEnrolledAt.v1:${ACCOUNT_A.uid}`, '2030-03-20T08:00:00.000Z');
    await showCalendar(harness);
    await waitFor(() => expect(screen.queryByTestId('calendar-perm-section')).not.toBeNull());

    for (const id of ['calendar-perm-section', 'calendar-use-section', 'calendar-list-section', 'calendar-google-section']) {
      unclipped(id);
    }
    expect(screen.getByTestId('calendar-use-toggle').props.accessibilityRole).toBe('switch');
    expect(screen.getByTestId('calendar-use-toggle').props.accessibilityState).toMatchObject({ checked: true });
    expect(screen.getByTestId('calendar-include-work').props.accessibilityRole).toBe('switch');
    expect(screen.getByTestId('calendar-include-work').props.accessibilityState).toMatchObject({ checked: false });
  });

  it.each(LANGUAGES)('R2.3 / R3.5 / R4.1 %s status, added row, and upgrade notice remain operable and unclamped at AX5', async language => {
    harness = await prepare(language, initialState({
      scanManual: runningScan(),
      added: [addedItem()],
      monitor: { enabled: true, lastSuccessAt: null, error: null, m5Enrolled: false, waiting: null },
    }));
    await showIntelligence(harness);
    await waitFor(() => expect(screen.queryByTestId('email-scan-status')).not.toBeNull());

    for (const id of ['email-scan-status', 'added-row-auto-1', 'monitor-upgrade-notice']) unclipped(id);
    expect(screen.getByTestId('added-remove-auto-1').props.accessibilityRole).toBe('button');
    expect(screen.getByTestId('monitor-upgrade-yes').props.accessibilityRole).toBe('button');
    expect(screen.getByTestId('monitor-upgrade-no').props.accessibilityRole).toBe('button');
  });
});

