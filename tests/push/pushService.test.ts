/**
 * The one push path, held to its four gates (UC-3.0b, #184).
 *
 * `sendToUser` is the only way this product interrupts somebody who is not
 * looking at it, so each of its rules is tested for what it is *for* rather
 * than for the code it happens to run:
 *
 *   - the payload guard throws with no storage and no client in scope at all,
 *     which is a stronger claim than "the fake was not called";
 *   - the dedupe lock is proved by counting FCM calls, not by reading a flag;
 *   - a suppressed push is proved not to have consumed its key, because a
 *     quiet morning must delay the day's plan rather than cancel it;
 *   - a dead token is proved gone from storage, not merely reported.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertPushData,
  buildFcmMessage,
  CHANNEL_FOR,
  PushPayloadError,
  PUSH_DATA_KEYS,
  sendToUser,
  type FcmMessage,
  type MessagingClient,
  type PushMessage,
} from '../../lib/push/pushService.ts';
import { upsertDevice, type DeviceRecord, type PushPermission } from '../../lib/push/deviceRegistry.ts';
import { saveRoutineProfile } from '../../lib/services/mobile/routineProfileService.ts';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { docIdForKey, PUSH_LOG, userCol, userDoc, userSubDoc } from '../../lib/storage/paths.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const UID = 'pushUser';
const NOW = new Date('2026-09-14T09:00:00.000Z');

function message(overrides: Partial<PushMessage> = {}): PushMessage {
  return {
    kind: 'plan_ready',
    uid: UID,
    dedupeKey: 'plan_ready:2026-09-14',
    data: { kind: 'plan_ready', planDate: '2026-09-14' },
    title: 'Your plan for today is ready',
    body: 'Open MaybeSitter when you have a minute.',
    urgency: 'normal',
    respectQuietHours: true,
    ...overrides,
  };
}

interface FakeMessaging extends MessagingClient {
  sent: FcmMessage[];
  failNext(code: string): void;
}

function fakeMessaging(): FakeMessaging {
  const sent: FcmMessage[] = [];
  let failure: string | null = null;
  return {
    sent,
    failNext: (code: string) => {
      failure = code;
    },
    async send(fcm: FcmMessage) {
      if (failure) {
        const code = failure;
        failure = null;
        throw Object.assign(new Error(code), { code });
      }
      sent.push(fcm);
      return `projects/x/messages/${sent.length}`;
    },
  };
}

/** Every method refuses. A test using this proves nothing was read or written. */
function hostileStorage(): StorageAdapter {
  const refuse = (name: string) => () => {
    throw new Error(`storage.${name} must not be reached`);
  };
  return {
    get: refuse('get'),
    list: refuse('list'),
    listGroup: refuse('listGroup'),
    set: refuse('set'),
    delete: refuse('delete'),
    runTransaction: refuse('runTransaction'),
    deleteTree: refuse('deleteTree'),
  } as unknown as StorageAdapter;
}

async function withDevice(
  storage: StorageAdapter,
  installationId: string,
  pushPermission: PushPermission = 'granted',
): Promise<DeviceRecord> {
  return upsertDevice(UID, {
    installationId,
    fcmToken: `token-${installationId.replace(/-/g, '')}`,
    platform: 'ios',
    appVersion: '1.0.0',
    locale: 'ar',
    timezone: 'Asia/Jerusalem',
    pushPermission,
  }, NOW.toISOString(), { storage });
}

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

async function seeded(): Promise<StorageAdapter> {
  const storage = createMemoryStorage();
  await storage.set(userDoc(UID), { timezone: 'Asia/Jerusalem' });
  await withDevice(storage, ID_A);
  return storage;
}

test('twice with one dedupeKey makes exactly one FCM call', async () => {
  const storage = await seeded();
  const messaging = fakeMessaging();

  const first = await sendToUser(message(), NOW, { storage, messaging });
  const second = await sendToUser(message(), NOW, { storage, messaging });

  assert.equal(first.status, 'sent');
  assert.equal(first.delivered, 1);
  assert.equal(second.status, 'duplicate');
  assert.equal(second.delivered, 0);
  assert.equal(messaging.sent.length, 1, 'the second call reached FCM');
});

test('a different dedupeKey sends again', async () => {
  const storage = await seeded();
  const messaging = fakeMessaging();
  await sendToUser(message(), NOW, { storage, messaging });
  await sendToUser(message({ dedupeKey: 'plan_ready:2026-09-15' }), NOW, { storage, messaging });
  assert.equal(messaging.sent.length, 2);
});

test('the lock holds the raw key in a field and the hash in the path', async () => {
  const storage = await seeded();
  await sendToUser(message(), NOW, { storage, messaging: fakeMessaging() });

  const key = 'plan_ready:2026-09-14';
  const stored = await storage.get<{ dedupeKey: string; expiresAt: string }>(
    userSubDoc(UID, PUSH_LOG, docIdForKey(key)),
  );
  assert.ok(stored, 'the lock was not written at the hashed id');
  assert.equal(stored.dedupeKey, key);
  // `expiresAt`, not `expireAt`: a TTL policy on the misspelling deletes nothing.
  assert.ok(Date.parse(stored.expiresAt) > NOW.getTime());
  assert.equal(Object.keys(stored).includes('expireAt'), false);
});

test('a data key outside the allowlist throws before any storage or network call', async () => {
  const messaging = fakeMessaging();
  await assert.rejects(
    () => sendToUser(
      message({ data: { kind: 'plan_ready', commitmentTitle: 'dentist' } }),
      NOW,
      { storage: hostileStorage(), messaging },
    ),
    (error: unknown) => error instanceof PushPayloadError && error.reason === 'data_key_not_allowed',
  );
  assert.equal(messaging.sent.length, 0);

  // And as a pure check, with nothing else in scope at all.
  assert.throws(
    () => assertPushData(message({ data: { title: 'dentist' } })),
    (error: unknown) => error instanceof PushPayloadError,
  );
  for (const key of PUSH_DATA_KEYS) {
    assertPushData(message({ data: { [key]: 'x' } }));
  }
});

test('a dedupeKey APNs would refuse is rejected before anything happens', async () => {
  const messaging = fakeMessaging();
  for (const dedupeKey of ['x'.repeat(65), 'has space', '', 'has/slash']) {
    await assert.rejects(
      () => sendToUser(message({ dedupeKey }), NOW, { storage: hostileStorage(), messaging }),
      (error: unknown) => error instanceof PushPayloadError,
      `accepted ${JSON.stringify(dedupeKey)}`,
    );
  }
  assert.equal(messaging.sent.length, 0);
});

test('inside quiet hours: zero FCM calls, and the key is not consumed', async () => {
  const storage = await seeded();
  const messaging = fakeMessaging();
  await saveRoutineProfile(UID, {
    timezone: 'Asia/Jerusalem',
    sleepWindow: null,
    focusWindows: [],
    fixedCommitmentWindows: [],
    preferredReminderIntensity: 'softAwareness',
    quietHours: { start: '22:00', end: '07:00' },
    surveySkipped: false,
  }, NOW.toISOString(), { storage });

  // 23:30 in Jerusalem, on both sides of a clock change, computed rather than
  // written down: 20:30Z is 23:30 at +03:00 and 21:30Z is 23:30 at +02:00.
  const insideSummer = new Date('2026-08-14T20:30:00.000Z');
  const insideWinter = new Date('2026-12-14T21:30:00.000Z');

  for (const at of [insideSummer, insideWinter]) {
    const result = await sendToUser(message({ dedupeKey: `plan_ready:${at.toISOString().slice(0, 10)}` }), at, {
      storage,
      messaging,
    });
    assert.equal(result.status, 'suppressed_quiet_hours', `not suppressed at ${at.toISOString()}`);
  }
  assert.equal(messaging.sent.length, 0);

  // The whole point of suppressing before the lock: the same key still sends
  // once the window is over.
  const later = new Date('2026-08-15T05:00:00.000Z'); // 08:00 Jerusalem
  const sent = await sendToUser(message({ dedupeKey: 'plan_ready:2026-08-14' }), later, { storage, messaging });
  assert.equal(sent.status, 'sent');
  assert.equal(messaging.sent.length, 1);
});

test('respectQuietHours false pushes inside the window', async () => {
  const storage = await seeded();
  const messaging = fakeMessaging();
  await saveRoutineProfile(UID, {
    timezone: 'Asia/Jerusalem',
    sleepWindow: null,
    focusWindows: [],
    fixedCommitmentWindows: [],
    preferredReminderIntensity: 'softAwareness',
    quietHours: { start: '22:00', end: '07:00' },
    surveySkipped: false,
  }, NOW.toISOString(), { storage });

  const result = await sendToUser(
    message({ respectQuietHours: false, urgency: 'time_sensitive', kind: 'hard_reminder' }),
    new Date('2026-08-14T20:30:00.000Z'),
    { storage, messaging },
  );
  assert.equal(result.status, 'sent');
  assert.equal(messaging.sent[0]?.apns.payload.aps['interruption-level'], 'time-sensitive');
});

test('an unregistered token deletes that device document and leaves the others', async () => {
  const storage = await seeded();
  await withDevice(storage, ID_B);
  const messaging = fakeMessaging();
  messaging.failNext('messaging/registration-token-not-registered');

  const result = await sendToUser(message(), NOW, { storage, messaging });

  assert.equal(result.removed, 1);
  assert.equal(result.delivered, 1);
  const remaining = await storage.list<DeviceRecord>(userCol(UID, 'devices'));
  assert.deepEqual(remaining.map((row) => row.id), [ID_B]);
});

test('an FCM failure that is not a dead token is not swallowed', async () => {
  const storage = await seeded();
  const messaging = fakeMessaging();
  messaging.failNext('messaging/server-unavailable');
  await assert.rejects(() => sendToUser(message(), NOW, { storage, messaging }));
  // The device is still there: a transient outage is not a reason to forget a phone.
  assert.equal((await storage.list(userCol(UID, 'devices'))).length, 1);
});

test('a denied device is skipped and a provisional one is not', async () => {
  const storage = createMemoryStorage();
  await storage.set(userDoc(UID), { timezone: 'Asia/Jerusalem' });
  await withDevice(storage, ID_A, 'denied');
  const messaging = fakeMessaging();

  const denied = await sendToUser(message(), NOW, { storage, messaging });
  assert.equal(denied.status, 'no_devices');
  assert.equal(messaging.sent.length, 0);

  await withDevice(storage, ID_B, 'provisional');
  const provisional = await sendToUser(message({ dedupeKey: 'plan_ready:2026-09-15' }), NOW, { storage, messaging });
  assert.equal(provisional.status, 'sent');
  assert.equal(messaging.sent.length, 1);
});

test('the FCM message collapses on the dedupe key and carries no title in data', async () => {
  const storage = await seeded();
  const device = await withDevice(storage, ID_A);
  const fcm = buildFcmMessage(message({ kind: 'hard_reminder', urgency: 'time_sensitive' }), device);

  assert.equal(fcm.apns.headers['apns-collapse-id'], 'plan_ready:2026-09-14');
  assert.equal(fcm.android.collapseKey, 'plan_ready:2026-09-14');
  assert.equal(fcm.android.priority, 'high');
  assert.equal(fcm.apns.headers['apns-priority'], '10');
  for (const key of Object.keys(fcm.data)) assert.ok(PUSH_DATA_KEYS.includes(key), `data carried ${key}`);
});

test('every channel a push names is one the app actually creates', () => {
  // Android drops a notification whose channel does not exist on the device;
  // it does not fall back. So this table may only name channels
  // mobile/src/notifications/channels.ts creates at startup.
  const source = readFileSync(join(repoRoot, 'mobile/src/notifications/channels.ts'), 'utf8');
  const created = Array.from(source.matchAll(/id: '([a-z_]+)'/g), (match) => match[1]!);
  assert.ok(created.length >= 2, 'read no channels out of the app, so this check would be vacuous');
  for (const channel of Object.values(CHANNEL_FOR)) {
    assert.ok(created.includes(channel), `${channel} is pushed to but never created`);
  }
});

test('nothing under lib/push logs', () => {
  // An FCM token in Cloud Logging is a device identifier in a place with a
  // different retention policy and a different audience.
  const files = sourceFiles(join(repoRoot, 'lib/push'));
  assert.ok(files.length >= 3, 'scanned too few files');
  const offenders = files.filter((file) => /\bconsole\.\w+\(/.test(readFileSync(file, 'utf8')));
  assert.deepEqual(offenders, []);
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}
