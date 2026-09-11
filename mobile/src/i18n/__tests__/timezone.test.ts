import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { getCalendars } from 'expo-localization';
import { FALLBACK_TIME_ZONE, deviceTimeZone, isValidTimeZone, resolveTimeZone } from '../timezone';

// babel-plugin-jest-hoist lifts this above the imports, so expo-localization is
// already replaced by the time '../timezone' reaches for getCalendars.
jest.mock('expo-localization', () => ({ getCalendars: jest.fn(), getLocales: jest.fn(() => []) }));

const mockCalendars = getCalendars as unknown as jest.Mock;

describe('resolveTimeZone', () => {
  const cases: [unknown, string][] = [
    ['Asia/Jerusalem', 'Asia/Jerusalem'],
    ['America/New_York', 'America/New_York'],
    ['UTC', 'UTC'],
    // Anything Intl does not recognise is UTC, never a guessed region.
    ['Mars/Phobos', FALLBACK_TIME_ZONE],
    ['Asia/Jerusalem ', FALLBACK_TIME_ZONE],
    ['', FALLBACK_TIME_ZONE],
    [null, FALLBACK_TIME_ZONE],
    [undefined, FALLBACK_TIME_ZONE],
  ];
  for (const [raw, expected] of cases) {
    it(`maps ${JSON.stringify(raw)} to ${expected}`, () => {
      expect(resolveTimeZone(raw as string | null | undefined)).toBe(expected);
    });
  }
});

describe('isValidTimeZone', () => {
  it('accepts a real zone and rejects a made-up one', () => {
    expect(isValidTimeZone('Europe/Berlin')).toBe(true);
    expect(isValidTimeZone('Nowhere/Nothing')).toBe(false);
  });
});

describe('deviceTimeZone', () => {
  beforeEach(() => {
    mockCalendars.mockReset();
  });

  it('uses the device zone when it is valid', () => {
    mockCalendars.mockReturnValue([{ timeZone: 'America/New_York' }]);
    expect(deviceTimeZone()).toBe('America/New_York');
  });

  it('falls back to UTC when the device value is invalid', () => {
    mockCalendars.mockReturnValue([{ timeZone: 'Mars/Phobos' }]);
    expect(deviceTimeZone()).toBe(FALLBACK_TIME_ZONE);
  });

  it('falls back to UTC when the device reports nothing', () => {
    mockCalendars.mockReturnValue([]);
    expect(deviceTimeZone()).toBe(FALLBACK_TIME_ZONE);
    mockCalendars.mockReturnValue([{ timeZone: null }]);
    expect(deviceTimeZone()).toBe(FALLBACK_TIME_ZONE);
  });

  it('falls back to UTC when the native call throws', () => {
    mockCalendars.mockImplementation(() => {
      throw new Error('no native module');
    });
    expect(deviceTimeZone()).toBe(FALLBACK_TIME_ZONE);
  });
});
