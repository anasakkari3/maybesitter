/**
 * Asking for the notification permission on the phones that actually exist
 * (audit 2026-10-03, #7).
 *
 * On Android 13+ expo-notifications reports a POST_NOTIFICATIONS that has
 * never been asked as `denied`: `NotificationPermissionsModule` returns denied
 * whenever `areNotificationsEnabled()` is false, and on those versions it is
 * false until the permission is granted. `canAskAgain` is still true. The app
 * read that `denied` as an answer and never showed the system prompt, so the
 * audit's phone sat with POST_NOTIFICATIONS not granted and every reminder off.
 */
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { Platform } from 'react-native';
import * as notifications from 'expo-notifications';
import { canPromptFrom, requestNotificationPermission } from '../permission';

const ANDROID_NEVER_ASKED = { status: 'denied', granted: false, canAskAgain: true, expires: 'never', android: { importance: 3 } };
const ANDROID_BLOCKED = { status: 'denied', granted: false, canAskAgain: false, expires: 'never', android: { importance: 3 } };
const IOS_DENIED = { status: 'denied', granted: false, canAskAgain: false, expires: 'never', ios: { status: 1 } };
const GRANTED = { status: 'granted', granted: true, canAskAgain: true, expires: 'never' };

function onPlatform(os: 'ios' | 'android') {
  jest.replaceProperty(Platform, 'OS', os);
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('requestNotificationPermission', () => {
  it("shows Android 13's system prompt for a permission it reports as denied but askable", async () => {
    onPlatform('android');
    jest.spyOn(notifications, 'getPermissionsAsync').mockResolvedValue(ANDROID_NEVER_ASKED as never);
    const request = jest.spyOn(notifications, 'requestPermissionsAsync').mockResolvedValue(GRANTED as never);

    await expect(requestNotificationPermission()).resolves.toBe('granted');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not ask an Android phone that has blocked the prompt', async () => {
    onPlatform('android');
    jest.spyOn(notifications, 'getPermissionsAsync').mockResolvedValue(ANDROID_BLOCKED as never);
    const request = jest.spyOn(notifications, 'requestPermissionsAsync');

    await expect(requestNotificationPermission()).resolves.toBe('denied');
    expect(request).not.toHaveBeenCalled();
  });

  it('never asks iOS twice: a denial there is final', async () => {
    onPlatform('ios');
    jest.spyOn(notifications, 'getPermissionsAsync').mockResolvedValue({ ...IOS_DENIED, canAskAgain: true } as never);
    const request = jest.spyOn(notifications, 'requestPermissionsAsync');

    await expect(requestNotificationPermission()).resolves.toBe('denied');
    expect(request).not.toHaveBeenCalled();
  });

  it('still asks an undetermined phone, and nothing already granted', async () => {
    onPlatform('ios');
    jest.spyOn(notifications, 'getPermissionsAsync').mockResolvedValue({ status: 'undetermined', granted: false, canAskAgain: true } as never);
    const request = jest.spyOn(notifications, 'requestPermissionsAsync').mockResolvedValue(GRANTED as never);
    await expect(requestNotificationPermission()).resolves.toBe('granted');
    expect(request).toHaveBeenCalledTimes(1);

    request.mockClear();
    jest.spyOn(notifications, 'getPermissionsAsync').mockResolvedValue(GRANTED as never);
    await expect(requestNotificationPermission()).resolves.toBe('granted');
    expect(request).not.toHaveBeenCalled();
  });
});

describe('canPromptFrom', () => {
  it('reads each shape the SDK reports', () => {
    expect(canPromptFrom(ANDROID_NEVER_ASKED, 'android')).toBe(true);
    expect(canPromptFrom(ANDROID_BLOCKED, 'android')).toBe(false);
    expect(canPromptFrom({ ...IOS_DENIED, canAskAgain: true }, 'ios')).toBe(false);
    expect(canPromptFrom({ status: 'undetermined' }, 'ios')).toBe(true);
    expect(canPromptFrom(GRANTED, 'android')).toBe(false);
    // Provisional answers the one iOS prompt quietly; it is not asked over.
    expect(canPromptFrom({ granted: true, ios: { status: 3 } }, 'ios')).toBe(false);
    expect(canPromptFrom(null, 'android')).toBe(true);
  });
});
