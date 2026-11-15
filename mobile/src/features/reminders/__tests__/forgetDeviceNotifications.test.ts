import { describe, expect, it, jest } from '@jest/globals';
import * as notifications from 'expo-notifications';
import { forgetDeviceNotifications } from '../forgetDeviceNotifications';
import type { NotificationGateway } from '../../../notifications/gateway';

/**
 * The wipe must never reach the next account (C13.14 review).
 *
 * It runs as a session ends, and its steps are awaited one after another. If
 * account B is signed in by the time a step is reached, that step would cancel
 * or dismiss B's notifications — so each step asks first.
 */
function fakeGateway(): NotificationGateway & { cancelAll: jest.Mock } {
  return {
    getScheduled: async () => [],
    schedule: async () => {},
    cancel: async () => {},
    cancelAll: jest.fn(async () => {}),
  } as never;
}

describe('forgetDeviceNotifications', () => {
  it('does everything while the session it belongs to is still the one ending', async () => {
    const gateway = fakeGateway();
    const dismissAll = jest.spyOn(notifications, 'dismissAllNotificationsAsync');
    const clearLast = jest.spyOn(notifications, 'clearLastNotificationResponseAsync');
    await forgetDeviceNotifications(gateway, { onlyWhile: () => true });
    expect(gateway.cancelAll).toHaveBeenCalledTimes(1);
    expect(dismissAll).toHaveBeenCalledTimes(1);
    expect(clearLast).toHaveBeenCalledTimes(1);
    jest.restoreAllMocks();
  });

  it('touches nothing once another account has signed in', async () => {
    const gateway = fakeGateway();
    const dismissAll = jest.spyOn(notifications, 'dismissAllNotificationsAsync');
    const clearLast = jest.spyOn(notifications, 'clearLastNotificationResponseAsync');
    await forgetDeviceNotifications(gateway, { onlyWhile: () => false });
    expect(gateway.cancelAll).not.toHaveBeenCalled();
    expect(dismissAll).not.toHaveBeenCalled();
    expect(clearLast).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });

  it('stops at the step where B arrived', async () => {
    const gateway = fakeGateway();
    const dismissAll = jest.spyOn(notifications, 'dismissAllNotificationsAsync');
    let bSignedIn = false;
    gateway.cancelAll.mockImplementation(async () => { bSignedIn = true; });
    await forgetDeviceNotifications(gateway, { onlyWhile: () => !bSignedIn });
    expect(gateway.cancelAll).toHaveBeenCalledTimes(1);
    expect(dismissAll).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });
});
