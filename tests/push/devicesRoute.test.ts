/**
 * `POST /api/mobile/devices` writes the token's tree and no other (UC-3.0b, #184).
 *
 * The property worth testing is not "the handler ignores `body.uid`" — it is
 * that a body naming somebody else's account leaves that account untouched and
 * lands under the caller's. So every case here checks storage, not the reply.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { POST as devicesPost } from '../../src/app/api/mobile/devices/route.ts';
import { DELETE as deviceDelete } from '../../src/app/api/mobile/devices/[installationId]/route.ts';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { DEVICES, userCol } from '../../lib/storage/paths.ts';
import { getStorage } from '../../lib/storage/index.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import type { DeviceRecord } from '../../lib/push/deviceRegistry.ts';

const BASE = 'http://127.0.0.1:4321';
const OWNER = uidFor('DeviceOwner');
const VICTIM = uidFor('DeviceVictim');
const INSTALLATION = '33333333-3333-4333-8333-333333333333';

const VALID = {
  installationId: INSTALLATION,
  fcmToken: 'fGh1JkL2mNo3PqR4sTu5Vw6Xy7Za8Bc9De0FgH1IjK2LmN3OpQ4RsT5U',
  platform: 'ios',
  appVersion: '1.0.0',
  locale: 'ar',
  timezone: 'Asia/Jerusalem',
  pushPermission: 'granted',
};

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

function request(body: unknown, options: { uid?: string | null } = {}): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (options.uid !== null) headers.set('authorization', `Bearer ${tokenFor(options.uid ?? OWNER)}`);
  return new Request(`${BASE}/api/mobile/devices`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function devicesOf(uid: string): Promise<DeviceRecord[]> {
  const rows = await getStorage().list<DeviceRecord>(userCol(uid, DEVICES));
  return rows.map((row) => row.data);
}

test('a valid token writes users/{uid}/devices/{installationId}', async () => {
  const teardown = setup();
  try {
    const response = await devicesPost(request(VALID));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, ok: true });

    const devices = await devicesOf(OWNER);
    assert.equal(devices.length, 1);
    assert.equal(devices[0]!.installationId, INSTALLATION);
    assert.equal(devices[0]!.fcmToken, VALID.fcmToken);
    assert.ok(devices[0]!.updatedAt);
  } finally {
    teardown();
  }
});

test('a uid in the body does not choose the tree', async () => {
  const teardown = setup();
  try {
    const response = await devicesPost(request({ ...VALID, uid: VICTIM }));
    assert.equal(response.status, 200);
    assert.equal((await devicesOf(VICTIM)).length, 0, 'the body chose the account');
    assert.equal((await devicesOf(OWNER)).length, 1);
    // And the field is not stored either: a claim nobody honoured is still a
    // claim sitting in the document.
    assert.equal('uid' in (await devicesOf(OWNER))[0]!, false);
  } finally {
    teardown();
  }
});

test('no Authorization header is 401 and writes nothing', async () => {
  const teardown = setup();
  try {
    const response = await devicesPost(request(VALID, { uid: null }));
    assert.equal(response.status, 401);
    assert.equal((await devicesOf(OWNER)).length, 0);
  } finally {
    teardown();
  }
});

test('a token that does not verify is 401', async () => {
  const teardown = setup();
  try {
    auth!.refuse(OWNER, 'token_expired');
    const response = await devicesPost(request(VALID));
    assert.equal(response.status, 401);
    assert.equal((await devicesOf(OWNER)).length, 0);
  } finally {
    teardown();
  }
});

test('every field is validated, and an unknown one is refused', async () => {
  const teardown = setup();
  try {
    const cases: Array<[string, unknown, string]> = [
      ['installationId', 'not-a-uuid', 'invalid_installation_id'],
      ['fcmToken', 'short', 'invalid_token'],
      ['platform', 'web', 'invalid_platform'],
      ['appVersion', 'a note about the device, written by hand, which is far too long', 'invalid_app_version'],
      ['locale', 'fr', 'invalid_locale'],
      ['timezone', 'Mars/Olympus', 'invalid_timezone'],
      ['pushPermission', 'maybe', 'invalid_permission'],
    ];
    for (const [field, value, reason] of cases) {
      const response = await devicesPost(request({ ...VALID, [field]: value }));
      const body = await response.json() as { reason?: string };
      assert.equal(response.status, 400, `${field} was accepted`);
      assert.equal(body.reason, reason, `${field} gave ${body.reason}`);
    }

    const unknown = await devicesPost(request({ ...VALID, deviceModel: 'iPhone 17 Pro' }));
    assert.equal(unknown.status, 400);
    assert.equal((await unknown.json() as { reason?: string }).reason, 'unknown_field');
    assert.equal((await devicesOf(OWNER)).length, 0);
  } finally {
    teardown();
  }
});

/*
 * The same fields, in the two languages this product is actually used in.
 *
 * Every validator above is an ASCII character class, and a guard written as
 * `[A-Za-z0-9]` has shipped a bug in this repo twice by being widened later by
 * somebody who only ever tested it in English. Relaxing any one of these to
 * `\p{L}`/`\p{Nd}` left the suite green until this test existed.
 *
 * Each one matters for a different reason:
 *
 *  - `installationId` becomes a **Firestore document id** and a URL segment on
 *    the DELETE. Its shape being exactly one uuid is what makes both safe.
 *  - `fcmToken` is sent to Google verbatim; a token with Arabic in it is one
 *    FCM will refuse for the life of the row.
 *  - `appVersion` is the field somebody would eventually use as a notes box.
 *  - `locale` is `ar`/`he`/`en` — the *code*, not the endonym. «العربية» is the
 *    right word and the wrong value.
 */
test('every field refuses Arabic and Hebrew, which is not the same as refusing nonsense', async () => {
  const teardown = setup();
  try {
    const cases: [string, unknown, string][] = [
      // A uuid with Arabic-Indic digits: the same shape, a different alphabet.
      ['installationId', '٣٣٣٣٣٣٣٣-3333-4333-8333-333333333333', 'invalid_installation_id'],
      ['installationId', 'לללללללל-3333-4333-8333-333333333333', 'invalid_installation_id'],
      ['fcmToken', `${'a'.repeat(40)}رمز-الإشعار`, 'invalid_token'],
      ['fcmToken', `${'a'.repeat(40)}אסימון`, 'invalid_token'],
      ['appVersion', '١.٠.٠', 'invalid_app_version'],
      ['appVersion', 'نسخة-١', 'invalid_app_version'],
      ['appVersion', 'גרסה-1', 'invalid_app_version'],
      // The endonyms. A reader who assumed the locale field held a language
      // *name* would send exactly these.
      ['locale', 'العربية', 'invalid_locale'],
      ['locale', 'עברית', 'invalid_locale'],
      ['platform', 'آيفون', 'invalid_platform'],
      ['pushPermission', 'مسموح', 'invalid_permission'],
      ['pushPermission', 'מאושר', 'invalid_permission'],
      ['timezone', 'آسيا/القدس', 'invalid_timezone'],
    ];
    for (const [field, value, reason] of cases) {
      const response = await devicesPost(request({ ...VALID, [field]: value }));
      const body = await response.json() as { reason?: string };
      assert.equal(response.status, 400, `${field}=${String(value)} was accepted`);
      assert.equal(body.reason, reason, `${field}=${String(value)} gave ${body.reason}`);
    }
    assert.equal((await devicesOf(OWNER)).length, 0);
  } finally {
    teardown();
  }
});

/*
 * And the DELETE, which puts its argument into a document path.
 *
 * `deleteDevice` re-checks the shape rather than trusting the route's own
 * regex, because this is the one value that arrives as a URL segment.
 */
test('deleting with an installation id in Arabic digits is refused, not path-joined', async () => {
  const teardown = setup();
  try {
    await devicesPost(request(VALID));
    for (const bad of ['٣٣٣٣٣٣٣٣-3333-4333-8333-333333333333', 'מכשיר', '../../devices/x']) {
      const response = await deviceDelete(
        new Request(`${BASE}/api/mobile/devices/${encodeURIComponent(bad)}`, {
          method: 'DELETE',
          headers: new Headers({ authorization: `Bearer ${tokenFor(OWNER)}` }),
        }),
        { params: Promise.resolve({ installationId: bad }) },
      );
      assert.equal(response.status, 400, `${bad} was accepted`);
      assert.equal((await response.json() as { reason?: string }).reason, 'invalid_installation_id');
    }
    // The real row is still there: nothing was deleted on the way through.
    assert.equal((await devicesOf(OWNER)).length, 1);
  } finally {
    teardown();
  }
});

test('registering twice replaces the row rather than adding one', async () => {
  const teardown = setup();
  try {
    await devicesPost(request(VALID));
    await devicesPost(request({ ...VALID, pushPermission: 'denied' }));
    const devices = await devicesOf(OWNER);
    assert.equal(devices.length, 1);
    // A merge would have kept `granted` and pushed at somebody who said no.
    assert.equal(devices[0]!.pushPermission, 'denied');
  } finally {
    teardown();
  }
});

test('signing out deletes this account s device and nobody else s', async () => {
  const teardown = setup();
  try {
    await devicesPost(request(VALID));
    await devicesPost(request(VALID, { uid: VICTIM }));

    const response = await deviceDelete(
      new Request(`${BASE}/api/mobile/devices/${INSTALLATION}`, {
        method: 'DELETE',
        headers: new Headers({ authorization: `Bearer ${tokenFor(OWNER)}` }),
      }),
      { params: Promise.resolve({ installationId: INSTALLATION }) },
    );

    assert.equal(response.status, 200);
    assert.equal((await devicesOf(OWNER)).length, 0);
    assert.equal((await devicesOf(VICTIM)).length, 1, 'the delete reached another account');
  } finally {
    teardown();
  }
});

test('deleting without a token is 401 and removes nothing', async () => {
  const teardown = setup();
  try {
    await devicesPost(request(VALID));
    const response = await deviceDelete(
      new Request(`${BASE}/api/mobile/devices/${INSTALLATION}`, { method: 'DELETE' }),
      { params: Promise.resolve({ installationId: INSTALLATION }) },
    );
    assert.equal(response.status, 401);
    assert.equal((await devicesOf(OWNER)).length, 1);
  } finally {
    teardown();
  }
});
