/**
 * One way to push, for every feature that ever wants to (UC-3.0b, #184).
 *
 * The morning plan (UC-3.10a, #194) and the Must reminder (UC-3.12b, #198) are
 * the callers; neither exists yet. What exists here is the one payload shape,
 * the one dedupe rule and the one quiet-hours rule, so that the second caller
 * cannot invent a different answer to "may we interrupt this person".
 *
 * ── The order of the four gates is the contract ──────────────────
 *
 *   1. the payload guard    — throws, before anything is read or written
 *   2. may we interrupt     — suppresses, and consumes nothing
 *   3. quiet hours          — suppresses, and consumes nothing
 *   4. is anybody reachable — answers `no_devices`, and consumes nothing
 *   5. the dedupe lock      — `create`, which is the idempotency
 *   6. the send             — once per device that may be pushed to
 *
 * Each order is chosen against a specific failure:
 *
 * **The payload guard is first** because "throws before any network call" is
 * the property #184 asks for, and a guard that runs after the Firestore read
 * has already made a network call. It is also a pure function of its argument,
 * so putting it anywhere else would only make it later.
 *
 * **Everything that can suppress precedes the lock**, so a push that did not
 * happen does not consume its key. `plan_ready:2026-09-15` suppressed at 06:00
 * must still be sendable at 08:00; if the lock were taken first, the quiet
 * window would silently cancel the day's plan rather than delay it, and the
 * caller would see `duplicate` for a push that never happened.
 *
 * **The device list is read before the lock too**, for the same reason and
 * because it used not to be. An account with no reachable device consumed the
 * key on the way to answering `no_devices`, so a phone that registered five
 * minutes later got `duplicate` and never saw that morning's plan.
 *
 * **The lock precedes the send**, which is what makes it a lock. A send-then-
 * record would let two workers both send and then both record.
 *
 * ── The lock is taken even if the send then fails ────────────────
 *
 * Deliberately, with one carve-out. This is an idempotency lock, not a delivery
 * guarantee: releasing the key when FCM errors turns every transient FCM
 * failure into permission to send the same notification again, which is the
 * duplicate-push bug this exists to prevent. A caller that genuinely needs a
 * retry after a partial failure mints a new key.
 *
 * The carve-out is **nothing was delivered anywhere and every device was
 * reaped**. A dead token is not a transient failure, it is proof that phone can
 * never receive this; if that was true of every device then no notification
 * exists on any handset, so sending again is the first delivery rather than a
 * second one. Without it, Firebase rotating a token overnight permanently lost
 * that morning's `plan_ready:<date>` — the key was spent on a push that reached
 * nobody, and the phone that registered a fresh token got `duplicate`.
 *
 * ── Text never carries a commitment ──────────────────────────────
 *
 * `title` and `body` pass through Google and Apple, so they are generic and
 * localised by the caller ("Your plan for today is ready"). `data` carries
 * identifiers only, and `assertPushData` is what keeps that true rather than
 * remembered.
 */
import { getAdminApp } from '../firebase/admin';
import { docIdForKey, getStorage, PUSH_LOG, requireUserId, userSubDoc, type StorageAdapter } from '../storage';
import { deleteDevice, listPushableDevices, type DeviceRecord } from './deviceRegistry';
import { isInQuietHours, readQuietHours } from './quietHours';
import { readPushAccess } from './pushAccess';

export type PushKind = 'plan_ready' | 'hard_reminder';

export const PUSH_KINDS: readonly PushKind[] = ['plan_ready', 'hard_reminder'];

/**
 * Every key `data` may carry. Identifiers and nothing else.
 *
 * An FCM payload is written to the OS notification store, where it outlives
 * the app and is readable by the platform's own tooling. A commitment title in
 * there is the same leak as a title in the device log.
 */
export const PUSH_DATA_KEYS: readonly string[] = [
  'kind',
  'planDate',
  'commitmentId',
  'notificationId',
  'dedupeKey',
];

/**
 * The Android channel each kind lands on.
 *
 * Android drops a notification whose `channel_id` does not exist on the
 * device — it does not fall back to the default — so a row here may only name
 * a channel `mobile/src/notifications/channels.ts` actually creates, and
 * `tests/push/pushService.test.ts` reads that file to check it.
 *
 * `hard_reminder` lands on `maybesitter_hard`, the HIGH-importance channel with
 * alarm audio that UC-3.12a (#197) creates — a channel of its own, because a
 * channel's importance is fixed once it exists.
 */
export const CHANNEL_FOR: Readonly<Record<PushKind, string>> = Object.freeze({
  plan_ready: 'maybesitter_general',
  hard_reminder: 'maybesitter_hard',
});

/**
 * The iOS category each kind lands on, which is what draws its buttons.
 *
 * A category the app has not registered is not an error on iOS — the
 * notification simply arrives without buttons — so this is safe ahead of
 * UC-3.14 (#200), which defines what the buttons do.
 */
export const CATEGORY_FOR: Readonly<Record<PushKind, string>> = Object.freeze({
  plan_ready: 'com.maybesitter.notification.category.plan',
  // The Must reminder's own category, registered by the app in #197 and given
  // its buttons by #200 — the same id a locally scheduled Must reminder uses.
  hard_reminder: 'com.maybesitter.notification.category.hard',
});

/**
 * `apns-collapse-id` is capped at 64 bytes by APNs, and `collapse_key` at 64
 * by FCM. A longer key is not truncated for us; the request is refused. So the
 * cap is checked here, where the caller can still be told which key was wrong.
 */
export const MAX_DEDUPE_KEY_LENGTH = 64;
const DEDUPE_KEY = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/;

/**
 * The size caps, in **bytes**, because that is the unit both platforms refuse in.
 *
 * APNs rejects an alert payload over 4096 bytes and FCM rejects a `data` map
 * over 4096. Neither counts characters, and Arabic is three bytes a character —
 * which is how a caller could build a message FCM refused, and why that refusal
 * used to delete every device the account had (see `DEAD_TOKEN_CODES`).
 *
 * There is a per-value cap and no total cap, and that is deliberate rather than
 * an omission: `PUSH_DATA_KEYS` is a closed list of five, so the whole map is
 * bounded at 5 × 256 bytes plus about 60 bytes of key names — a little over
 * 1.3 KB — and with 512 bytes each of title and body the largest message this
 * guard permits is roughly 2.4 KB against a 4 KB limit. A total cap on top of
 * that could never fire, and a guard that cannot fail is the thing this lane
 * has already had to delete twice.
 *
 * 256 bytes per value is generous for what actually goes in one: a uuid is 36,
 * a `YYYY-MM-DD` is 10, a `${uuid}:soft` notification id is 41.
 */
export const MAX_PUSH_TEXT_BYTES = 512;
export const MAX_PUSH_DATA_VALUE_BYTES = 256;

export const PUSH_URGENCIES: readonly PushMessage['urgency'][] = ['normal', 'time_sensitive'];

/** UTF-8 bytes, which is what APNs and FCM count. */
function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/** Seven days, as UC-3.0b specifies. The TTL field is `expiresAt`. */
export const PUSH_LOG_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface PushMessage {
  readonly kind: PushKind;
  readonly uid: string;
  readonly dedupeKey: string;
  /** Identifiers only; see `PUSH_DATA_KEYS`. */
  readonly data: Record<string, string>;
  /** Generic and already localised. Never a commitment title. */
  readonly title: string;
  readonly body: string;
  readonly urgency: 'normal' | 'time_sensitive';
  readonly respectQuietHours: boolean;
}

export type PushStatus =
  | 'sent'
  | 'duplicate'
  | 'suppressed_quiet_hours'
  /** The account has told us to stop, or to stop for now. See `pushAccess`. */
  | 'suppressed_no_access'
  /** Nobody to push to: no device, every device said no, or every token was dead. */
  | 'no_devices';

export interface PushResult {
  readonly status: PushStatus;
  /** How many devices FCM accepted the message for. */
  readonly delivered: number;
  /** Device documents removed because FCM said the token is gone. */
  readonly removed: number;
}

/** A payload that must never reach the network. Thrown, not returned. */
export class PushPayloadError extends Error {
  constructor(message: string, readonly reason: string) {
    super(`push: ${message}`);
    this.name = 'PushPayloadError';
  }
}

/** What `firebase-admin/messaging` is used for, narrowed so a test can be it. */
export interface MessagingClient {
  send(message: FcmMessage): Promise<string>;
}

export interface FcmMessage {
  token: string;
  data: Record<string, string>;
  notification: { title: string; body: string };
  apns: {
    headers: Record<string, string>;
    payload: { aps: Record<string, unknown> };
  };
  android: {
    priority: 'high' | 'normal';
    collapseKey: string;
    notification: { channelId: string };
  };
}

export interface SendToUserOptions {
  storage?: StorageAdapter;
  messaging?: MessagingClient;
}

/**
 * The payload guard, as a pure function of the message.
 *
 * Exported so a caller can check a payload it is building without sending it,
 * and so the test can prove the throw happens with no messaging client and no
 * storage in scope at all — which is a stronger statement than "the fake was
 * not called".
 */
export function assertPushData(message: PushMessage): void {
  if (!PUSH_KINDS.includes(message.kind)) {
    throw new PushPayloadError(`kind must be one of ${PUSH_KINDS.join(', ')}`, 'invalid_kind');
  }
  if (typeof message.dedupeKey !== 'string' || !DEDUPE_KEY.test(message.dedupeKey)) {
    throw new PushPayloadError('dedupeKey must be an identifier', 'invalid_dedupe_key');
  }
  if (message.dedupeKey.length > MAX_DEDUPE_KEY_LENGTH) {
    throw new PushPayloadError(
      `dedupeKey must be at most ${MAX_DEDUPE_KEY_LENGTH} characters; APNs refuses a longer collapse id`,
      'dedupe_key_too_long',
    );
  }
  if (typeof message.title !== 'string' || message.title.trim() === '') {
    throw new PushPayloadError('title must be non-empty', 'invalid_title');
  }
  if (byteLength(message.title) > MAX_PUSH_TEXT_BYTES) {
    throw new PushPayloadError(
      `title must be at most ${MAX_PUSH_TEXT_BYTES} bytes`,
      'title_too_long',
    );
  }
  if (typeof message.body !== 'string' || message.body.trim() === '') {
    throw new PushPayloadError('body must be non-empty', 'invalid_body');
  }
  if (byteLength(message.body) > MAX_PUSH_TEXT_BYTES) {
    throw new PushPayloadError(
      `body must be at most ${MAX_PUSH_TEXT_BYTES} bytes`,
      'body_too_long',
    );
  }
  /*
   * The two fields the gates below read, checked here with the rest.
   *
   * `respectQuietHours` decides gate 2, and gate 2 was `if (respect…)` — so a
   * message that simply *omitted* the field walked past quiet hours with no
   * error at all, as did `0`, `''` and `null`. Absent must not mean interrupt.
   * A caller reading a job payload back out of Firestore holds `any`, so this
   * is a route somebody reaches without trying.
   *
   * `urgency` decides the APNs interruption level, and an unrecognised value
   * was silently downgraded to `active` — which turns a Must reminder into a
   * notification that does not break through a Focus mode, quietly and with
   * nothing logged.
   */
  if (typeof message.respectQuietHours !== 'boolean') {
    throw new PushPayloadError(
      'respectQuietHours must be a boolean; absent would mean interrupt',
      'invalid_respect_quiet_hours',
    );
  }
  if (!PUSH_URGENCIES.includes(message.urgency)) {
    throw new PushPayloadError(
      `urgency must be one of ${PUSH_URGENCIES.join(', ')}`,
      'invalid_urgency',
    );
  }
  if (!message.data || typeof message.data !== 'object' || Array.isArray(message.data)) {
    throw new PushPayloadError('data must be an object', 'invalid_data');
  }
  for (const [key, value] of Object.entries(message.data)) {
    if (!PUSH_DATA_KEYS.includes(key)) {
      throw new PushPayloadError(
        `data key ${JSON.stringify(key)} is not one of ${PUSH_DATA_KEYS.join(', ')}`,
        'data_key_not_allowed',
      );
    }
    // FCM's own contract: `data` is a string map. A number here becomes
    // "undefined" on the device, which is worse than a refusal.
    if (typeof value !== 'string') {
      throw new PushPayloadError(`data.${key} must be a string`, 'data_value_not_string');
    }
    if (byteLength(value) > MAX_PUSH_DATA_VALUE_BYTES) {
      throw new PushPayloadError(
        `data.${key} must be at most ${MAX_PUSH_DATA_VALUE_BYTES} bytes; FCM refuses the message, not the field`,
        'data_value_too_long',
      );
    }
  }
}

/** The stored lock. Keys and instants; never the text that was sent. */
export interface PushLogEntry {
  dedupeKey: string;
  kind: PushKind;
  createdAt: string;
  /** Firestore TTL. `expiresAt` — `expireAt` is a field nothing deletes. */
  expiresAt: string;
}

let cachedMessaging: MessagingClient | null = null;

/**
 * The real client, resolved on first use.
 *
 * Lazy for the same reason `lib/firebase/admin` is: importing this module must
 * not bind a Google project, because `npm test` imports it against the
 * in-memory adapter with no credentials anywhere.
 */
async function defaultMessaging(): Promise<MessagingClient> {
  if (cachedMessaging) return cachedMessaging;
  const { getMessaging } = await import('firebase-admin/messaging');
  const messaging = getMessaging(getAdminApp());
  cachedMessaging = {
    send: (message: FcmMessage) => messaging.send(message as unknown as Parameters<typeof messaging.send>[0]),
  };
  return cachedMessaging;
}

export function resetMessagingForTests(): void {
  cachedMessaging = null;
}

/**
 * FCM's way of saying this token belongs to an app that is no longer there.
 *
 * `messaging/invalid-argument` used to be in here and is not any more. FCM
 * returns it for a malformed **message** as well as for a malformed token, and
 * this loop reads a code in this set as proof the phone is gone. So one
 * oversized push deleted *every* device row the account had — the reviewer's
 * probe: three devices registered, one send with a 5000-character Arabic
 * `data.commitmentId`, and the answer was
 * `{ status: 'no_devices', delivered: 0, removed: 3 }`. The account was then
 * unreachable until it next opened the app, and because the dedupe key had
 * already been taken the corrected retry answered `duplicate`.
 *
 * The two codes left are token-specific by name and cannot be provoked by a
 * payload. The payload half of that defect is fixed at the other end, by the
 * size caps in `assertPushData` — a message big enough to be refused by FCM
 * can no longer be built.
 */
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

function errorCodeOf(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const code = (error as { code?: unknown; errorInfo?: { code?: unknown } }).code
    ?? (error as { errorInfo?: { code?: unknown } }).errorInfo?.code;
  return typeof code === 'string' ? code : null;
}

export function buildFcmMessage(message: PushMessage, device: DeviceRecord): FcmMessage {
  return {
    token: device.fcmToken,
    data: { ...message.data },
    notification: { title: message.title, body: message.body },
    apns: {
      headers: {
        'apns-priority': '10',
        'apns-collapse-id': message.dedupeKey,
        // Alert pushes need this; a background push would need '5'/'background'.
        'apns-push-type': 'alert',
      },
      payload: {
        aps: {
          'interruption-level': message.urgency === 'time_sensitive' ? 'time-sensitive' : 'active',
          category: CATEGORY_FOR[message.kind],
          sound: 'default',
        },
      },
    },
    android: {
      priority: 'high',
      collapseKey: message.dedupeKey,
      notification: { channelId: CHANNEL_FOR[message.kind] },
    },
  };
}

/**
 * Sends one message to every device this account can be reached on.
 *
 * `now` is a parameter rather than a clock read here, so the quiet-hours
 * decision, the lock's `createdAt` and its `expiresAt` are all the same
 * instant — and so a test of a DST morning is a test rather than a wait.
 */
export async function sendToUser(
  message: PushMessage,
  now: Date,
  options: SendToUserOptions = {},
): Promise<PushResult> {
  // 1. Before a read, before a write, before a client is even resolved.
  assertPushData(message);
  requireUserId(message.uid);

  const storage = options.storage ?? getStorage();

  // 2. May we interrupt this person at all. Deleted, revoked, quiet mode — the
  //    states where they have told us to stop, which outrank a schedule.
  const access = await readPushAccess(message.uid, { storage });
  if (!access.allowed) {
    return { status: 'suppressed_no_access', delivered: 0, removed: 0 };
  }

  // 3. Quiet hours, which suppress without consuming the key.
  if (message.respectQuietHours) {
    const quietHours = await readQuietHours(message.uid, { storage });
    if (isInQuietHours(quietHours, now)) {
      return { status: 'suppressed_quiet_hours', delivered: 0, removed: 0 };
    }
  }

  // 4. Is anybody reachable. Before the lock, so an account with no device does
  //    not spend the key on the way to saying so.
  const devices = await listPushableDevices(message.uid, { storage });
  if (devices.length === 0) return { status: 'no_devices', delivered: 0, removed: 0 };

  // 5. The lock. `create` inside a transaction, so two workers racing over one
  //    key cannot both win — and a read-then-create outside one could.
  const lockPath = userSubDoc(message.uid, PUSH_LOG, docIdForKey(message.dedupeKey));
  const claimed = await storage.runTransaction(async (tx) => {
    const existing = await tx.get<PushLogEntry>(lockPath);
    if (existing) return false;
    const entry: PushLogEntry = {
      dedupeKey: message.dedupeKey,
      kind: message.kind,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + PUSH_LOG_TTL_MS).toISOString(),
    };
    tx.create<PushLogEntry>(lockPath, entry);
    return true;
  });
  if (!claimed) return { status: 'duplicate', delivered: 0, removed: 0 };

  // 6. The send.
  const messaging = options.messaging ?? (await defaultMessaging());
  let delivered = 0;
  let removed = 0;
  for (const device of devices) {
    try {
      await messaging.send(buildFcmMessage(message, device));
      delivered += 1;
    } catch (error) {
      const code = errorCodeOf(error);
      if (code && DEAD_TOKEN_CODES.has(code)) {
        // The app was uninstalled, or the token was reissued and this document
        // is the stale half. Leaving it would make every future push to this
        // account do a doomed round trip for ever.
        await deleteDevice(message.uid, device.installationId, { storage });
        removed += 1;
        continue;
      }
      // Anything else is this account's problem for the other devices too —
      // an auth failure, a quota — and swallowing it would report `sent`.
      throw error;
    }
  }

  if (delivered === 0) {
    // Every device was reaped — that is the only way out of the loop above with
    // nothing delivered and nothing thrown. No notification exists on any
    // handset, so the key is released and the next attempt is a first delivery
    // rather than a duplicate. See the header for why this is the one release.
    await storage.delete(lockPath);
    return { status: 'no_devices', delivered, removed };
  }

  return { status: 'sent', delivered, removed };
}
