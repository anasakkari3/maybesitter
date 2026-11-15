/**
 * A `notify` watcher's firing, delivered to the phone (QA audit de7fcb8, CA6.1).
 *
 * The watcher engine writes `watcherNotifications/wtn_…` with `state: 'queued'`
 * inside its firing transaction, and nothing used to read it: a watch with
 * «نبّهني» fired and the person was never told. This is the reader. The
 * scheduled watcher tick (`lib/jobs/internalJobs.ts`) calls it once per
 * committed `notify` firing, and it sends one push through `sendToUser`, so
 * the rules every push obeys — access, quiet hours, no device, the dedupe
 * lock — are the same ones here.
 *
 * ── Content-free by construction ─────────────────────────────────
 *
 * The title and body are fixed per language and name nothing: not the watch,
 * not the reading, not a team. `data` carries the kind and the dedupe key, and
 * the tap opens Background activity, where the firing is listed with its
 * attribution. A watcher label is user text; it never goes to Google or Apple.
 *
 * ── Once per firing ──────────────────────────────────────────────
 *
 * The dedupe key is derived from the notification id, which is derived from
 * the fire event id, so a retried tick that reaches this again for the same
 * firing gets `duplicate` from the push lock. A suppressed push (quiet hours,
 * no device) leaves the notification `queued`; it is not retried later — a
 * stale "something changed" is noise, and the firing stays visible in the app.
 */
import { createHash } from 'node:crypto';
import { getStorage, userSubDoc, WATCHER_NOTIFICATIONS, type StorageAdapter } from '../storage';
import type { WatcherNotification } from '../../src/contracts/v1/watcherContracts';
import { listPushableDevices, type DeviceLocale } from './deviceRegistry';
import { sendToUser, type MessagingClient, type PushMessage, type PushResult } from './pushService';

export const WATCHER_ALERT_COPY: Readonly<Record<DeviceLocale, { title: string; body: string }>> = Object.freeze({
  ar: { title: 'في إشي بتتابعه تغيّر', body: 'افتح MaybeSitter تشوف شو صار.' },
  he: { title: 'משהו שבמעקב השתנה', body: 'פתח את MaybeSitter כדי לראות מה קרה.' },
  en: { title: 'Something you’re watching changed', body: 'Open MaybeSitter to see what happened.' },
});

/** 48 characters, inside the 64 APNs and FCM allow for a collapse id. */
export function watcherAlertDedupeKey(notificationId: string): string {
  return `watcher:${createHash('sha256').update(notificationId).digest('hex').slice(0, 40)}`;
}

export function watcherAlertMessage(uid: string, notificationId: string, locale: DeviceLocale): PushMessage {
  const copy = WATCHER_ALERT_COPY[locale] ?? WATCHER_ALERT_COPY.ar;
  const dedupeKey = watcherAlertDedupeKey(notificationId);
  return {
    kind: 'watcher_alert',
    uid,
    dedupeKey,
    data: { kind: 'watcher_alert', dedupeKey },
    title: copy.title,
    body: copy.body,
    urgency: 'normal',
    respectQuietHours: true,
  };
}

export interface WatcherAlertOptions {
  storage?: StorageAdapter;
  messaging?: MessagingClient;
}

/**
 * Pushes one queued watcher notification and marks it `sent` when FCM took it
 * for at least one device. A notification that is gone (the account or the
 * watcher was deleted) or already sent is left alone.
 */
export async function deliverWatcherAlert(
  uid: string,
  notificationId: string,
  now: Date,
  options: WatcherAlertOptions = {},
): Promise<PushResult | null> {
  const storage = options.storage ?? getStorage();
  const path = userSubDoc(uid, WATCHER_NOTIFICATIONS, notificationId);
  const queued = await storage.get<WatcherNotification>(path);
  if (!queued || queued.state !== 'queued') return null;

  // The newest device's language; Arabic when nobody has said.
  const devices = await listPushableDevices(uid, { storage });
  const newest = [...devices].sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))[0];
  const message = watcherAlertMessage(uid, notificationId, newest?.locale ?? 'ar');

  const result = await sendToUser(message, now, {
    storage,
    ...(options.messaging ? { messaging: options.messaging } : {}),
  });
  if (result.status === 'sent') {
    await storage.runTransaction(async (tx) => {
      const current = await tx.get<WatcherNotification>(path);
      if (!current || current.state !== 'queued') return;
      tx.set(path, { ...current, state: 'sent' });
    });
  }
  return result;
}
