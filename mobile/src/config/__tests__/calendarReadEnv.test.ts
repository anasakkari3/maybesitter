/**
 * The switch busy-time reading is behind (UC-3.2, #186 step 9).
 *
 * It reads the opposite way round from every other flag in this file's
 * neighbourhood, and that is the whole point of testing it. `shareIntakeEnabled`
 * and `calendarWriteEnabled` are *enable* flags: off unless the value is exactly
 * `true`, so a typo leaves a feature that has never been proven on a device
 * switched off. This is a *kill switch*: on unless the value is exactly `false`,
 * so a typo leaves a feature that is already working switched on.
 *
 * Both readings are right for what they gate and each is a bug for the other,
 * which is why neither can be left to a glance at the source.
 *
 * Reading is the milder of the two calendar powers: writing puts an entry into
 * a place somebody shares with other people, while reading puts nothing
 * anywhere, cannot begin until the Trust Center's calendar consent is on, and
 * keeps four fields per event with the titles dropped on the phone. So the one
 * that ships off by default is the write.
 */
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { calendarReadEnabled, calendarWriteEnabled, configProblems } from '../env';

const KEY = 'EXPO_PUBLIC_FEATURE_CALENDAR_READ';
const WRITE_KEY = 'EXPO_PUBLIC_FEATURE_CALENDAR_WRITE';
const ENV_KEY = 'EXPO_PUBLIC_APP_ENV';
const original = {
  read: process.env[KEY],
  write: process.env[WRITE_KEY],
  env: process.env[ENV_KEY],
};

afterEach(() => {
  for (const [key, value] of [
    [KEY, original.read], [WRITE_KEY, original.write], [ENV_KEY, original.env],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('calendarReadEnabled', () => {
  it('is on when nothing is set', () => {
    delete process.env[KEY];
    expect(calendarReadEnabled()).toBe(true);
  });

  it('is off only for the literal string false', () => {
    for (const [value, expected] of [
      ['false', false],
      [' false ', false],
      ['true', true],
      ['0', true],
      ['no', true],
      ['FALSE', true],
      ['', true],
    ] as const) {
      process.env[KEY] = value;
      expect({ value, on: calendarReadEnabled() }).toEqual({ value, on: expected });
    }
  });

  it('reads the opposite way round from the write flag, which is the point', () => {
    delete process.env[KEY];
    delete process.env[WRITE_KEY];
    expect({ read: calendarReadEnabled(), write: calendarWriteEnabled() })
      .toEqual({ read: true, write: false });
  });
});

describe('the build refuses a value it cannot read', () => {
  // `configProblems` checks the whole configuration, so it needs an app
  // environment before it will get as far as this flag.
  beforeEach(() => { process.env[ENV_KEY] = 'development'; });

  it('names the variable rather than silently leaving the feature on', () => {
    process.env[KEY] = 'flase';
    expect(configProblems().join('\n')).toContain(KEY);
  });

  it('is happy with true, with false and with nothing at all', () => {
    for (const value of ['true', 'false', undefined]) {
      if (value === undefined) delete process.env[KEY];
      else process.env[KEY] = value;
      expect(configProblems().filter((problem) => problem.includes(KEY))).toEqual([]);
    }
  });
});
