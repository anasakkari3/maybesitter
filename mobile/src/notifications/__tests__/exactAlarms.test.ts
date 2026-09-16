import { describe, expect, it, jest } from '@jest/globals';
import { canScheduleExactAlarms, openExactAlarmSettings } from '../exactAlarms';
import type { ExactAlarmNativeModule } from '../../../modules/exact-alarm';

/**
 * The JS half of `modules/exact-alarm` (UC-3.12a, #197), against a mocked
 * native module. The native halves are a one-line `AlarmManager` read and a
 * settings intent; what is worth a test is what an unknown answer means.
 */

function native(answer: boolean | (() => boolean), opens = true): ExactAlarmNativeModule & {
  open: jest.Mock;
} {
  const open = jest.fn(() => opens);
  return {
    canScheduleExactAlarms: typeof answer === 'function' ? answer : () => answer,
    openExactAlarmSettings: open,
    open,
  };
}

describe('can a Must reminder fire on time', () => {
  it('is always yes on iOS, without asking anything native', () => {
    const asked = jest.fn(() => false);
    expect(canScheduleExactAlarms({ platform: 'ios', native: native(asked) })).toBe(true);
    expect(canScheduleExactAlarms({ platform: 'ios', native: null })).toBe(true);
    expect(asked).not.toHaveBeenCalled();
  });

  it('is what AlarmManager says on Android', () => {
    expect(canScheduleExactAlarms({ platform: 'android', native: native(true) })).toBe(true);
    expect(canScheduleExactAlarms({ platform: 'android', native: native(false) })).toBe(false);
  });

  it('is no when the answer is unknown, so the server sends its backup rather than nothing', () => {
    expect(canScheduleExactAlarms({ platform: 'android', native: null })).toBe(false);
    expect(canScheduleExactAlarms({
      platform: 'android',
      native: native(() => { throw new Error('native crash'); }),
    })).toBe(false);
    // Something that is not `true` is not a yes.
    expect(canScheduleExactAlarms({
      platform: 'android',
      native: native((() => 'true') as unknown as () => boolean),
    })).toBe(false);
    expect(canScheduleExactAlarms({ platform: 'web', native: native(true) })).toBe(false);
  });
});

describe('opening the Alarms & reminders page', () => {
  it('opens it on Android', () => {
    const module = native(false);
    expect(openExactAlarmSettings({ platform: 'android', native: module })).toBe(true);
    expect(module.open).toHaveBeenCalledTimes(1);
  });

  it('opens nothing on iOS, or without the module, and says so', () => {
    const module = native(true);
    expect(openExactAlarmSettings({ platform: 'ios', native: module })).toBe(false);
    expect(module.open).not.toHaveBeenCalled();
    expect(openExactAlarmSettings({ platform: 'android', native: null })).toBe(false);
    expect(openExactAlarmSettings({ platform: 'android', native: native(false, false) })).toBe(false);
  });
});
