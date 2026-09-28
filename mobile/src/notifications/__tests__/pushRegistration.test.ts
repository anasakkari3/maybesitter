import { describe, expect, it, jest } from '@jest/globals';
import {
  deregisterDeviceForPush,
  refreshPushAfterPrompt,
  registerDeviceForPush,
  reportablePermission,
  type PushRegistrationDeps,
} from '../pushRegistration';
import { permissionFrom, IOS_STATUS_PROVISIONAL } from '../permission';
import type { DeviceRegistration } from '../../api/endpoints/devices';

/**
 * Registering a device, and the four times it must not (UC-3.0b, #184).
 *
 * Every dependency is injected, which is what makes "mock mode registers
 * nothing" and "a device with no keychain registers nothing" testable at all.
 * Both are paths that would otherwise be discovered in production — the first
 * by a developer finding real device rows from fixture runs, the second by a
 * user with one row per launch.
 */

const INSTALLATION = '55555555-5555-4555-8555-555555555555';

interface Recorder extends PushRegistrationDeps {
  readonly registered: DeviceRegistration[];
  readonly forgotten: string[];
  readonly order: string[];
}

function deps(overrides: Partial<PushRegistrationDeps> = {}): Recorder {
  const registered: DeviceRegistration[] = [];
  const forgotten: string[] = [];
  const order: string[] = [];
  return {
    registered,
    forgotten,
    order,
    fcmToken: async () => 'a-real-looking-fcm-token',
    permission: async () => 'granted',
    installationId: async () => INSTALLATION,
    register: async (registration: DeviceRegistration) => {
      registered.push(registration);
      order.push('register');
    },
    forget: async (id: string) => {
      forgotten.push(id);
      order.push('forget');
    },
    deleteToken: async () => {
      order.push('deleteToken');
    },
    mode: () => 'api',
    platform: () => 'ios',
    locale: () => 'ar',
    timezone: () => 'Asia/Jerusalem',
    version: () => '1.2.3',
    ...overrides,
  } as Recorder;
}

describe('registering', () => {
  it('sends exactly the fields the route accepts, and no uid', async () => {
    const recorder = deps();
    expect(await registerDeviceForPush(recorder)).toBe('registered');
    expect(Object.keys(recorder.registered[0] as object).sort()).toEqual([
      'appVersion', 'fcmToken', 'installationId', 'locale', 'platform', 'pushPermission', 'timezone',
    ]);
    // The uid is the token's. There is no field here for a client to claim one.
    expect('uid' in (recorder.registered[0] as object)).toBe(false);
  });

  it('never reports a device model or anything else about the hardware', async () => {
    const recorder = deps();
    await registerDeviceForPush(recorder);
    const body = JSON.stringify(recorder.registered[0]);
    for (const banned of ['iPhone', 'model', 'osVersion', 'deviceName', 'email']) {
      expect(body).not.toContain(banned);
    }
  });
});

describe('when it must not register', () => {
  it('does nothing in mock mode', async () => {
    const recorder = deps({ mode: () => 'mock' });
    expect(await registerDeviceForPush(recorder)).toBe('skipped_mock_mode');
    expect(recorder.registered).toEqual([]);
  });

  it('does nothing without a stable installation id', async () => {
    // A device whose keychain refused. Registering under a fresh uuid would
    // leave one device row per launch, and push once per row.
    const recorder = deps({ installationId: async () => null });
    expect(await registerDeviceForPush(recorder)).toBe('skipped_no_installation_id');
    expect(recorder.registered).toEqual([]);
  });

  it('does nothing without a token', async () => {
    const recorder = deps({ fcmToken: async () => null });
    expect(await registerDeviceForPush(recorder)).toBe('skipped_no_token');
    expect(recorder.registered).toEqual([]);
  });

  it('reports a failure rather than throwing into a sign-in', async () => {
    const recorder = deps({ register: async () => { throw new Error('offline'); } });
    expect(await registerDeviceForPush(recorder)).toBe('failed');
  });
});

describe('the permission it reports', () => {
  it('sends granted and provisional as themselves', () => {
    expect(reportablePermission('granted')).toBe('granted');
    // Provisional delivers quietly to Notification Centre; the server must
    // push to it, and it is the only state a simulator can reach.
    expect(reportablePermission('provisional')).toBe('provisional');
  });

  it('sends a device nobody has asked yet as denied', () => {
    // It shows nothing, so a send and a dedupe key spent on it are both wasted.
    expect(reportablePermission('undetermined')).toBe('denied');
    expect(reportablePermission('denied')).toBe('denied');
  });

  it('reads the SDK answer in each of the three shapes it comes in', () => {
    expect(permissionFrom({ ios: { status: IOS_STATUS_PROVISIONAL }, granted: true })).toBe('provisional');
    expect(permissionFrom({ granted: true })).toBe('granted');
    expect(permissionFrom({ status: 'granted' })).toBe('granted');
    expect(permissionFrom({ status: 'denied', granted: false })).toBe('denied');
    expect(permissionFrom({ status: 'undetermined', granted: false })).toBe('undetermined');
    expect(permissionFrom(null)).toBe('undetermined');
  });
});

describe('signing out', () => {
  it('deletes the device row before it deletes the token', async () => {
    const recorder = deps();
    await deregisterDeviceForPush(recorder, true);
    // The DELETE needs a valid session, and the token is the thing that would
    // still be pointed at this row if the order were reversed.
    expect(recorder.order).toEqual(['forget', 'deleteToken']);
    expect(recorder.forgotten).toEqual([INSTALLATION]);
  });

  it('still drops the token when the row could not be deleted', async () => {
    const recorder = deps({ forget: async () => { throw new Error('offline'); } });
    await deregisterDeviceForPush(recorder, true);
    expect(recorder.order).toEqual(['deleteToken']);
  });

  /*
   * The case the whole second argument exists for.
   *
   * `session_expired`, `revoked` and `deleted` all mean the credential is
   * already refused, so the `DELETE` could only 401 or 403 — a revoked account
   * is refused by `requireMobileUser` by name. But the FCM token is issued to
   * the *installation*, not to the account, and the installation id outlives a
   * sign-out on purpose. Leaving the token alive leaves `users/alice/devices/{id}`
   * pointing at a handset that is about to be Bob's, and every push addressed
   * to Alice arrives on his screen carrying her `commitmentId`.
   *
   * Deleting the token needs no credential, so it happens either way, and the
   * stale row reaps itself on the next push.
   */
  it('deletes the token but not the row when the credential is already refused', async () => {
    const recorder = deps();
    await deregisterDeviceForPush(recorder, false);
    expect(recorder.order).toEqual(['deleteToken']);
    expect(recorder.forgotten).toEqual([]);
  });

  it('does nothing at all in mock mode, whichever way the session ended', async () => {
    for (const credentialIsGood of [true, false]) {
      const recorder = deps({ mode: () => 'mock' });
      await deregisterDeviceForPush(recorder, credentialIsGood);
      expect(recorder.order).toEqual([]);
    }
  });
});

describe('after the prompt (first iPhone run, L7 review)', () => {
  it('registers once when the phone just said yes', async () => {
    const recorder = deps();
    expect(await refreshPushAfterPrompt('undetermined', 'granted', recorder)).toBe('registered');
    expect(recorder.registered).toHaveLength(1);
    expect(recorder.registered[0]!.pushPermission).toBe('granted');
  });

  it('registers nothing after a no', async () => {
    const recorder = deps({ permission: async () => 'denied' });
    expect(await refreshPushAfterPrompt('undetermined', 'denied', recorder)).toBeNull();
    expect(recorder.registered).toHaveLength(0);
  });

  it('registers nothing when the answer did not change', async () => {
    const recorder = deps();
    expect(await refreshPushAfterPrompt('granted', 'granted', recorder)).toBeNull();
    expect(recorder.registered).toHaveLength(0);
  });

  it('registers nothing while the phone still has not answered', async () => {
    const recorder = deps({ permission: async () => 'undetermined' });
    expect(await refreshPushAfterPrompt(null, 'undetermined', recorder)).toBeNull();
    expect(recorder.registered).toHaveLength(0);
  });
});

describe('what the module may import', () => {
  it('never reaches a native module at load', () => {
    // Every native module in this file is resolved at use, because the module
    // is reachable from a component tree that unit tests render. A static
    // `@react-native-firebase/messaging` import would fail those on load.
    jest.isolateModules(() => {
      // `jest.requireActual` rather than a bare `require`: it is the same
      // synchronous load — which is the point, a dynamic `import()` would not
      // prove that requiring the module raises nothing — through an API that
      // is not the banned CommonJS form.
      expect(() => jest.requireActual('../pushRegistration')).not.toThrow();
    });
  });
});
