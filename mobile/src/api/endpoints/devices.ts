import { apiRequest } from '../client';
import {
  deviceForgottenSchema,
  deviceRegisteredSchema,
  type DeviceForgotten,
  type DeviceRegistered,
} from '../schemas/devices';

/**
 * Registering this phone for push (UC-3.0b, #184).
 *
 * No uid is sent. The server takes it from the token and there is no field on
 * this body for one — the route ignores a `uid` if a client sends one anyway,
 * and refuses every other unknown key.
 */
export interface DeviceRegistration {
  installationId: string;
  fcmToken: string;
  platform: 'ios' | 'android';
  appVersion: string;
  locale: 'ar' | 'he' | 'en';
  timezone: string;
  pushPermission: 'granted' | 'provisional' | 'denied';
}

export function registerDevice(registration: DeviceRegistration): Promise<DeviceRegistered> {
  return apiRequest('POST', '/api/mobile/devices', {
    body: registration,
    schema: deviceRegisteredSchema,
  });
}

/**
 * Called on sign-out, *before* the session ends.
 *
 * It has to be: an expired token cannot delete its own device row. If this
 * fails the row is left behind, and the two things that eventually clear it are
 * the account-deletion cascade (UC-1.5, #149) and FCM answering
 * `registration-token-not-registered` after the app is removed.
 */
export function forgetDevice(installationId: string): Promise<DeviceForgotten> {
  return apiRequest('DELETE', `/api/mobile/devices/${encodeURIComponent(installationId)}`, {
    schema: deviceForgottenSchema,
  });
}
