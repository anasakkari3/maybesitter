/**
 * Where this account's commitments are written, and the default that decides
 * it for everyone who never opens the screen (UC-3.1, #185).
 *
 * The acceptance criterion these cases carry is the first one: with the target
 * `off`, confirming writes no event. On a device that is the sync service's
 * job; here it is the fact that `off` is what an account that has never chosen
 * *reads back as*, whatever is or is not in its document.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { getStorage, resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { userDoc } from '../../lib/storage/paths.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import {
  GET as calendarSettingsGet,
  PUT as calendarSettingsPut,
} from '../../src/app/api/mobile/settings/calendar/route.ts';
import { readCalendarSettings } from '../../lib/services/calendar/calendarSettings.ts';

const BASE = 'http://127.0.0.1:4321';
const USER = uidFor('CalendarSettingsUser');

let auth: FakeAuthControls | null = null;

function setup(): () => void {
  setStorageForTests(createMemoryStorage());
  auth = installFakeAuth();
  return () => {
    auth?.restore();
    auth = null;
    resetStorageForTests();
  };
}

function get(uid = USER): Request {
  return new Request(`${BASE}/api/mobile/settings/calendar`, {
    headers: { authorization: `Bearer ${tokenFor(uid)}` },
  });
}

function put(body: unknown, uid = USER): Request {
  return new Request(`${BASE}/api/mobile/settings/calendar`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${tokenFor(uid)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

test('an account that has never chosen writes nowhere', async () => {
  const teardown = setup();
  try {
    const response = await calendarSettingsGet(get());
    assert.equal(response.status, 200);
    const body = await json(response) as { calendarSettings: { writeTarget: string } };
    assert.equal(body.calendarSettings.writeTarget, 'off');
  } finally {
    teardown();
  }
});

test('the target the user chose is what comes back', async () => {
  const teardown = setup();
  try {
    const saved = await calendarSettingsPut(put({ writeTarget: 'device' }));
    assert.equal(saved.status, 200);
    const read = await json(await calendarSettingsGet(get())) as { calendarSettings: { writeTarget: string } };
    assert.equal(read.calendarSettings.writeTarget, 'device');
    assert.equal((await readCalendarSettings(USER)).writeTarget, 'device');
  } finally {
    teardown();
  }
});

test('a target that is not one of the three is refused and changes nothing', async () => {
  const teardown = setup();
  try {
    await calendarSettingsPut(put({ writeTarget: 'device' }));
    for (const writeTarget of ['outlook', '', null, true, undefined]) {
      const response = await calendarSettingsPut(put({ writeTarget }));
      assert.equal(response.status, 400, `accepted ${JSON.stringify(writeTarget)}`);
      assert.equal((await json(response)).reason, 'invalid_write_target');
    }
    assert.equal((await readCalendarSettings(USER)).writeTarget, 'device');
  } finally {
    teardown();
  }
});

test('an unreadable stored target reads as off rather than as itself', async () => {
  const teardown = setup();
  try {
    // What a future schema, or a hand edit, could leave behind.
    await getStorage().set(userDoc(USER), { calendarSettings: { writeTarget: 'device-v2' } });
    assert.equal((await readCalendarSettings(USER)).writeTarget, 'off');
  } finally {
    teardown();
  }
});

test('saving the target leaves the rest of the user document alone', async () => {
  const teardown = setup();
  try {
    await getStorage().set(userDoc(USER), { locale: 'ar', timezone: 'Asia/Jerusalem', trust: { analyticsConsent: true } });
    await calendarSettingsPut(put({ writeTarget: 'device' }));
    const user = await getStorage().get<Record<string, unknown>>(userDoc(USER));
    assert.equal(user?.locale, 'ar');
    assert.equal(user?.timezone, 'Asia/Jerusalem');
    assert.deepEqual(user?.trust, { analyticsConsent: true });
  } finally {
    teardown();
  }
});

test('no credential reads and writes nothing', async () => {
  const teardown = setup();
  try {
    const anonymousGet = new Request(`${BASE}/api/mobile/settings/calendar`);
    assert.equal((await calendarSettingsGet(anonymousGet)).status, 401);
    const anonymousPut = new Request(`${BASE}/api/mobile/settings/calendar`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ writeTarget: 'device' }),
    });
    assert.equal((await calendarSettingsPut(anonymousPut)).status, 401);
    assert.equal((await readCalendarSettings(USER)).writeTarget, 'off');
  } finally {
    teardown();
  }
});
