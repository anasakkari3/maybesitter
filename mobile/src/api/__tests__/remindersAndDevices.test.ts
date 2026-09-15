import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { resetAuthForTests, setAuthRepository } from '../auth';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';
import { getReminderSettings, putReminderSettings } from '../endpoints/reminders';
import { forgetDevice, registerDevice } from '../endpoints/devices';

/**
 * The two new endpoints, against the fixtures their own routes produced
 * (UC-3.11 #196, UC-3.0b #184).
 *
 * The same discipline as `endpoints.test.ts`: not "does fetch work" but "does
 * this function send the request the route accepts, and does the answer parse
 * into the type the screen uses".
 */

const FIXTURES = join(__dirname, '..', '__fixtures__');
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));

let requests: { url: string; method: string; body: unknown }[] = [];

function serve(body: unknown, status = 200): void {
  (globalThis as { fetch: unknown }).fetch = jest.fn(async (url: string, init: RequestInit) => {
    requests.push({
      url,
      method: init.method as string,
      body: init.body === undefined ? undefined : JSON.parse(init.body as string),
    });
    return {
      status,
      text: async () => JSON.stringify(body),
      headers: { get: () => null },
    };
  }) as never;
}

beforeEach(() => {
  requests = [];
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://localhost:3000';
  setAuthRepository(createFakeAuthRepository({
    initialUser: { uid: 'u1', email: null, emailVerified: true, displayName: null, providerIds: ['password'] },
  }));
});

afterEach(() => {
  resetAuthForTests();
  jest.restoreAllMocks();
});

describe('reminder settings', () => {
  it('reads the account s answer, quiet hours included', async () => {
    serve(fixture('reminders.settingsDefault'));
    const response = await getReminderSettings();
    expect(requests[0]?.url).toBe('http://localhost:3000/api/mobile/settings/reminders');
    expect(requests[0]?.method).toBe('GET');
    expect(response.reminderSettings.quietHours?.timezone).toBeTruthy();
  });

  it('sends only the controls that moved', async () => {
    serve(fixture('reminders.settingsSaved'));
    await putReminderSettings({ softLeadMinutes: 30 });
    expect(requests[0]?.method).toBe('PUT');
    // Omitting a key means "leave it alone"; sending `quietHours: null` means
    // "clear it". A patch that always sent every field could not say the first.
    expect(requests[0]?.body).toEqual({ softLeadMinutes: 30 });
  });

  it('can clear the quiet window explicitly', async () => {
    serve(fixture('reminders.settingsSaved'));
    await putReminderSettings({ quietHours: null });
    expect(requests[0]?.body).toEqual({ quietHours: null });
  });
});

describe('devices', () => {
  it('registers without sending a uid', async () => {
    serve(fixture('devices.registered'));
    await registerDevice({
      installationId: '55555555-5555-4555-8555-555555555555',
      fcmToken: 'a-token',
      platform: 'ios',
      appVersion: '1.0.0',
      locale: 'ar',
      timezone: 'Asia/Jerusalem',
      pushPermission: 'granted',
    });
    expect(requests[0]?.url).toBe('http://localhost:3000/api/mobile/devices');
    expect(Object.keys(requests[0]?.body as object)).not.toContain('uid');
  });

  it('escapes the installation id in the path', async () => {
    serve(fixture('devices.forgotten'));
    await forgetDevice('55555555-5555-4555-8555-555555555555');
    expect(requests[0]?.method).toBe('DELETE');
    expect(requests[0]?.url).toBe(
      'http://localhost:3000/api/mobile/devices/55555555-5555-4555-8555-555555555555',
    );
  });
});
