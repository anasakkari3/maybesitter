/**
 * The device registry: which phones this account can be reached on (UC-3.0b, #184).
 *
 * ── The uid is a parameter, never a field ────────────────────────
 *
 * `DeviceRegistration` has no `uid`. That is the whole security property of
 * this file expressed as a type: there is no member for a caller's claim about
 * whose device this is to be read out of, so `upsertDevice(uid, …)` can only
 * write into the tree its caller named — and its only caller names the uid out
 * of the verified token.
 *
 * A body that carries `uid` anyway is *ignored*, with the field named
 * explicitly in `IGNORED_FIELDS` so the decision is visible. Every other
 * unknown key is refused: a client sending something this schema does not know
 * is a client whose expectation is about to be silently disappointed, and the
 * one field where that is worth tolerating is the one the issue's own table
 * told clients to send.
 *
 * ── The field list is closed, and short on purpose ───────────────
 *
 * No email, no display name, no device model. A registration is: which install
 * this is, the token to push to, and the four facts a push needs in order to
 * be correctly shaped and correctly worded. Anything else would be a second
 * copy of the person, kept somewhere nobody would think to look for it.
 *
 * ── Nothing here is logged ───────────────────────────────────────
 *
 * Not the token, not a prefix of it, not the installation id.
 * `tests/push/pushService.test.ts` asserts no `console.*` under `lib/push`,
 * because a token in Cloud Logging is a device identifier in a place with a
 * different retention policy and a different audience.
 */
import { isValidTimezone } from '../../src/contracts/v1/routineContracts';
import {
  DEVICES,
  getStorage,
  requireUserId,
  userCol,
  userSubDoc,
  type StorageAdapter,
} from '../storage';

export type DevicePlatform = 'ios' | 'android';
export type DeviceLocale = 'ar' | 'he' | 'en';
/**
 * `provisional` is a real third state, not a nicety. iOS provisional
 * authorisation delivers quietly to Notification Centre without ever asking,
 * which is what makes a simulator and a first-run device testable at all —
 * and a device in that state must still be pushed to.
 */
export type PushPermission = 'granted' | 'provisional' | 'denied';

export const DEVICE_PLATFORMS: readonly DevicePlatform[] = ['ios', 'android'];
export const DEVICE_LOCALES: readonly DeviceLocale[] = ['ar', 'he', 'en'];
export const PUSH_PERMISSIONS: readonly PushPermission[] = ['granted', 'provisional', 'denied'];

/** Read off the body and thrown away, rather than refused. See the header. */
export const IGNORED_FIELDS: readonly string[] = ['uid'];

export interface DeviceRegistration {
  readonly installationId: string;
  readonly fcmToken: string;
  readonly platform: DevicePlatform;
  readonly appVersion: string;
  readonly locale: DeviceLocale;
  readonly timezone: string;
  readonly pushPermission: PushPermission;
}

/** The stored document. `updatedAt`/`lastSeenAt` are the server's, never the body's. */
export interface DeviceRecord extends DeviceRegistration {
  readonly updatedAt: string;
  readonly lastSeenAt: string;
}

export class DeviceValidationError extends Error {
  constructor(message: string, readonly reason: string) {
    super(`device: ${message}`);
    this.name = 'DeviceValidationError';
  }
}

/**
 * A uuid, which is what `mobile/src/lib/installationId.ts` mints.
 *
 * Narrower than `requireDocId` on purpose: this string becomes a document id,
 * and the set of shapes the phone can produce is exactly one.
 */
const INSTALLATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** FCM tokens are long opaque strings; the cap is generous and the charset is not. */
const FCM_TOKEN = /^[A-Za-z0-9_:.~%-]{32,4096}$/;
/** `1.4.2`, `1.4.2-staging.3`. Long enough for a real version, short enough not to be a note. */
const APP_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/;

const FIELDS: readonly (keyof DeviceRegistration)[] = [
  'installationId',
  'fcmToken',
  'platform',
  'appVersion',
  'locale',
  'timezone',
  'pushPermission',
];

function fail(message: string, reason: string): never {
  throw new DeviceValidationError(message, reason);
}

/**
 * Validates a client body into a registration.
 *
 * Rejects rather than coerces. A registration written from a half-understood
 * body is a device the server thinks it can reach and cannot, which surfaces
 * as "my phone stopped getting reminders" weeks later with nothing to read.
 */
export function parseDeviceRegistration(value: unknown): DeviceRegistration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('body must be an object', 'invalid_body');
  const raw = value as Record<string, unknown>;

  const known = new Set<string>([...FIELDS, ...IGNORED_FIELDS]);
  const unknown = Object.keys(raw).filter((key) => !known.has(key));
  if (unknown.length > 0) fail(`unknown field ${JSON.stringify(unknown[0])}`, 'unknown_field');

  if (typeof raw.installationId !== 'string' || !INSTALLATION_ID.test(raw.installationId)) {
    fail('installationId must be a uuid', 'invalid_installation_id');
  }
  if (typeof raw.fcmToken !== 'string' || !FCM_TOKEN.test(raw.fcmToken)) {
    fail('fcmToken must be an FCM registration token', 'invalid_token');
  }
  if (!DEVICE_PLATFORMS.includes(raw.platform as DevicePlatform)) {
    fail(`platform must be one of ${DEVICE_PLATFORMS.join(', ')}`, 'invalid_platform');
  }
  if (typeof raw.appVersion !== 'string' || !APP_VERSION.test(raw.appVersion)) {
    fail('appVersion must be a version string', 'invalid_app_version');
  }
  if (!DEVICE_LOCALES.includes(raw.locale as DeviceLocale)) {
    fail(`locale must be one of ${DEVICE_LOCALES.join(', ')}`, 'invalid_locale');
  }
  if (!isValidTimezone(raw.timezone)) fail('timezone must be an IANA zone id', 'invalid_timezone');
  if (!PUSH_PERMISSIONS.includes(raw.pushPermission as PushPermission)) {
    fail(`pushPermission must be one of ${PUSH_PERMISSIONS.join(', ')}`, 'invalid_permission');
  }

  return Object.freeze({
    installationId: raw.installationId,
    fcmToken: raw.fcmToken,
    platform: raw.platform as DevicePlatform,
    appVersion: raw.appVersion,
    locale: raw.locale as DeviceLocale,
    timezone: raw.timezone,
    pushPermission: raw.pushPermission as PushPermission,
  });
}

export interface DeviceRegistryOptions {
  storage?: StorageAdapter;
}

function storageOf(options: DeviceRegistryOptions): StorageAdapter {
  return options.storage ?? getStorage();
}

export function devicePath(uid: string, installationId: string): string {
  return userSubDoc(requireUserId(uid), DEVICES, installationId);
}

/**
 * Records the device, or updates the one already there.
 *
 * A `set` rather than a `merge`: the phone sends the whole registration every
 * time, so a merge could only ever preserve a field the phone has stopped
 * sending — which for `pushPermission` means remembering `granted` after the
 * user revoked it in iOS Settings, and pushing at somebody who said no.
 */
export async function upsertDevice(
  uid: string,
  registration: DeviceRegistration,
  at: string,
  options: DeviceRegistryOptions = {},
): Promise<DeviceRecord> {
  // No `requireUserId` here: `devicePath` below runs it, and a second call
  // could only ever be a guard that cannot fail.
  const record: DeviceRecord = { ...registration, updatedAt: at, lastSeenAt: at };
  await storageOf(options).set(devicePath(uid, registration.installationId), record);
  return record;
}

/** Returns whether there was one, so a sign-out can be honest about it. */
export async function deleteDevice(
  uid: string,
  installationId: string,
  options: DeviceRegistryOptions = {},
): Promise<boolean> {
  requireUserId(uid);
  if (!INSTALLATION_ID.test(installationId)) fail('installationId must be a uuid', 'invalid_installation_id');
  const storage = storageOf(options);
  const path = devicePath(uid, installationId);
  const existing = await storage.get<DeviceRecord>(path);
  await storage.delete(path);
  return existing !== null;
}

export async function listDevices(
  uid: string,
  options: DeviceRegistryOptions = {},
): Promise<DeviceRecord[]> {
  requireUserId(uid);
  const rows = await storageOf(options).list<DeviceRecord>(userCol(uid, DEVICES));
  return rows.map((row) => row.data).filter((record): record is DeviceRecord => isDeviceRecord(record));
}

/** Everywhere a push may actually go: `denied` is excluded, `provisional` is not. */
export async function listPushableDevices(
  uid: string,
  options: DeviceRegistryOptions = {},
): Promise<DeviceRecord[]> {
  return (await listDevices(uid, options)).filter((device) => device.pushPermission !== 'denied');
}

/** A document written by a future schema, or by hand, reads as absent. */
function isDeviceRecord(value: unknown): value is DeviceRecord {
  if (!value || typeof value !== 'object') return false;
  const raw = value as Record<string, unknown>;
  return typeof raw.installationId === 'string'
    && typeof raw.fcmToken === 'string'
    && DEVICE_PLATFORMS.includes(raw.platform as DevicePlatform)
    && PUSH_PERMISSIONS.includes(raw.pushPermission as PushPermission);
}
