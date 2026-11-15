/**
 * A `notify` watcher's firing, delivered to the phone (QA audit de7fcb8, CA6.1).
 *
 * The watcher engine writes `watcherNotifications/wtn_…` with `state: 'queued'`
 * inside its firing transaction. This module is what reads it and sends one
 * push through `sendToUser`, so the rules every push obeys — access, quiet
 * hours, reachable devices, the per-message dedupe lock — hold here too. It is
 * reached two ways from the scheduled watcher tick (`lib/jobs/internalJobs.ts`):
 * right after a firing commits, and from `redriveQueuedWatcherAlerts`, which
 * picks up anything still queued on the next ticks.
 *
 * ── Content-free by construction ─────────────────────────────────
 *
 * The title and body are fixed per language and name nothing: not the watch,
 * not the reading, not a team. `data` carries only `kind` and `dedupeKey`, and
 * the tap opens Background activity, where the firing is listed. A watcher
 * label is user text; it never goes to Google or Apple.
 *
 * ── Bounded ──────────────────────────────────────────────────────
 *
 * A readiness watch on `digest_changed` digests the band *and* the score, so
 * every recompute can fire — up to once a minute. Every firing is still
 * recorded; only the push is bounded:
 *
 *   - **one push per watcher per `WATCHER_ALERT_MIN_GAP_MS` (60 minutes).** An
 *     hour is the shortest interval at which "something you watch changed"
 *     still reads as news rather than noise, and it matches the readiness
 *     check-in cadence a person actually keeps; a change inside the hour is
 *     visible in the app the moment they open it.
 *   - **at most `WATCHER_ALERT_DAILY_CAP` (6) watcher alerts per account per
 *     UTC day**, across all their watchers, so many watches cannot add up to a
 *     stream.
 *   - **one collapse id per watcher** (`apns-collapse-id` / Android `tag`), so
 *     a newer alert replaces the older one on the device instead of stacking.
 *
 * The two counters live in the account's `pushLog` (with its TTL), are taken
 * in one transaction before the send, and are given back if the send is
 * suppressed — so quiet hours or a missing phone never spend the budget.
 *
 * ── Lost pushes, quiet hours, no device ──────────────────────────
 *
 * A notification stays `queued` until a push for it reaches FCM; then it is
 * `sent`. `redriveQueuedWatcherAlerts` re-tries queued notifications for
 * `WATCHER_ALERT_REDRIVE_MS` (30 minutes) after they were queued, which covers
 * a crash between the firing's commit and its push. The dedupe lock makes the
 * retry safe: a push that went out but was never marked is recognised by its
 * lock and marked `sent` without a second send.
 *
 * The same window decides everything held back. An alert suppressed by quiet
 * hours, by a missing device or by the gap is re-tried while it is younger
 * than 30 minutes, and then left `queued` for good — never sent late. So an
 * alert held by quiet hours goes out only if the quiet window ends within 30
 * minutes of the firing; a stale "something changed" is noise, and the firing
 * stays visible in the app either way.
 */
import { createHash } from 'node:crypto';
import {
  docIdForKey,
  getStorage,
  PUSH_LOG,
  userDoc,
  userSubDoc,
  WATCHER_NOTIFICATIONS,
  type StorageAdapter,
} from '../storage';
import type { WatcherNotification } from '../../src/contracts/v1/watcherContracts';
import { liveAccount } from '../account/accountLiveness';
import { listPushableDevices, type DeviceLocale } from './deviceRegistry';
import { PUSH_LOG_TTL_MS, sendToUser, type MessagingClient, type PushMessage, type PushResult } from './pushService';

export const WATCHER_ALERT_MIN_GAP_MS = 60 * 60_000;
export const WATCHER_ALERT_DAILY_CAP = 6;
export const WATCHER_ALERT_REDRIVE_MS = 30 * 60_000;
/** The most queued notifications one tick re-drives. */
export const WATCHER_ALERT_REDRIVE_BATCH = 50;

export const WATCHER_ALERT_COPY: Readonly<Record<DeviceLocale, { title: string; body: string }>> = Object.freeze({
  ar: { title: 'في إشي بتتابعه تغيّر', body: 'افتح MaybeSitter تشوف شو صار.' },
  he: { title: 'משהו שבמעקב השתנה', body: 'פתח את MaybeSitter כדי לראות מה קרה.' },
  en: { title: 'Something you’re watching changed', body: 'Open MaybeSitter to see what happened.' },
});

function hash40(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 40);
}

/** Per firing: 48 characters, inside the 64 APNs and FCM allow. */
export function watcherAlertDedupeKey(notificationId: string): string {
  return `watcher:${hash40(notificationId)}`;
}

/** Per watcher: the id a newer alert replaces an older one under. */
export function watcherAlertCollapseId(watcherId: string): string {
  return `watcher-thread:${hash40(watcherId)}`;
}

export function watcherAlertMessage(
  uid: string,
  notification: Pick<WatcherNotification, 'notificationId' | 'watcherId'>,
  locale: DeviceLocale,
): PushMessage {
  const copy = WATCHER_ALERT_COPY[locale] ?? WATCHER_ALERT_COPY.ar;
  const dedupeKey = watcherAlertDedupeKey(notification.notificationId);
  return {
    kind: 'watcher_alert',
    uid,
    dedupeKey,
    collapseId: watcherAlertCollapseId(notification.watcherId),
    data: { kind: 'watcher_alert', dedupeKey },
    title: copy.title,
    body: copy.body,
    urgency: 'normal',
    respectQuietHours: true,
  };
}

/** The bound counters, in `pushLog` beside the locks. Keys and instants only. */
interface WatcherAlertBudgetEntry {
  dedupeKey: string;
  kind: 'watcher_alert';
  createdAt: string;
  expiresAt: string;
  /** The day counter only: alerts sent on that UTC day. */
  count?: number;
}

export interface WatcherAlertOptions {
  storage?: StorageAdapter;
  messaging?: MessagingClient;
}

export type WatcherAlertOutcome = PushResult['status'] | 'throttled' | 'capped' | 'expired' | 'gone';

/**
 * Pushes one queued watcher notification, within the bounds above, and marks
 * it `sent` when FCM took it for at least one device. Returns what happened;
 * `null` when there is nothing queued under that id.
 */
export async function deliverWatcherAlert(
  uid: string,
  notificationId: string,
  now: Date,
  options: WatcherAlertOptions = {},
): Promise<WatcherAlertOutcome | null> {
  const storage = options.storage ?? getStorage();
  const path = userSubDoc(uid, WATCHER_NOTIFICATIONS, notificationId);
  const queued = await storage.get<WatcherNotification>(path);
  if (!queued || queued.state !== 'queued') return null;
  if (now.getTime() - Date.parse(queued.queuedAt) > WATCHER_ALERT_REDRIVE_MS) return 'expired';

  const markSent = () => storage.runTransaction(async (tx) => {
    const current = await tx.get<WatcherNotification>(path);
    if (!current || current.state !== 'queued') return;
    tx.set(path, { ...current, state: 'sent' });
  });

  // Pushed already, and the process died before it could say so.
  const dedupeKey = watcherAlertDedupeKey(notificationId);
  if (await storage.get(userSubDoc(uid, PUSH_LOG, docIdForKey(dedupeKey)))) {
    await markSent();
    return 'duplicate';
  }

  const gapKey = `watcher-gap:${hash40(queued.watcherId)}`;
  const dayKey = `watcher-day:${now.toISOString().slice(0, 10)}`;
  const gapPath = userSubDoc(uid, PUSH_LOG, docIdForKey(gapKey));
  const dayPath = userSubDoc(uid, PUSH_LOG, docIdForKey(dayKey));
  const at = now.toISOString();
  const expiresAt = new Date(now.getTime() + PUSH_LOG_TTL_MS).toISOString();

  const claim = await storage.runTransaction(async (tx) => {
    const [user, gap, day] = await Promise.all([
      tx.get<unknown>(userDoc(uid)),
      tx.get<WatcherAlertBudgetEntry>(gapPath),
      tx.get<WatcherAlertBudgetEntry>(dayPath),
    ]);
    if (!liveAccount(user)) return { status: 'gone' as const };
    if (gap && now.getTime() - Date.parse(gap.createdAt) < WATCHER_ALERT_MIN_GAP_MS) return { status: 'throttled' as const };
    if ((day?.count ?? 0) >= WATCHER_ALERT_DAILY_CAP) return { status: 'capped' as const };
    tx.set<WatcherAlertBudgetEntry>(gapPath, { dedupeKey: gapKey, kind: 'watcher_alert', createdAt: at, expiresAt });
    tx.set<WatcherAlertBudgetEntry>(dayPath, {
      dedupeKey: dayKey, kind: 'watcher_alert', createdAt: day?.createdAt ?? at, expiresAt, count: (day?.count ?? 0) + 1,
    });
    return { status: 'claimed' as const, gap, day };
  });
  if (claim.status !== 'claimed') return claim.status;

  const devices = await listPushableDevices(uid, { storage });
  // The newest device's language; Arabic when nobody has said.
  const newest = [...devices].sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))[0];
  const message = watcherAlertMessage(uid, queued, newest?.locale ?? 'ar');
  const result = await sendToUser(message, now, {
    storage,
    ...(options.messaging ? { messaging: options.messaging } : {}),
  });

  if (result.status === 'sent' || result.status === 'duplicate') {
    await markSent();
    return result.status;
  }
  // Suppressed — quiet hours, no device, no access: nothing reached a phone,
  // so the budget is given back and the notification stays queued.
  await storage.runTransaction(async (tx) => {
    const [gap, day] = await Promise.all([
      tx.get<WatcherAlertBudgetEntry>(gapPath),
      tx.get<WatcherAlertBudgetEntry>(dayPath),
    ]);
    if (gap?.createdAt === at) {
      if (claim.gap) tx.set(gapPath, claim.gap);
      else tx.delete(gapPath);
    }
    if (day && (day.count ?? 0) > 0) tx.set(dayPath, { ...day, count: (day.count ?? 1) - 1 });
  });
  return result.status;
}

/** `users/{uid}/watcherNotifications/{id}` → uid, from the path rather than the stored data. */
function ownerOf(path: string): string | null {
  const parts = path.split('/');
  return parts.length === 4 && parts[0] === 'users' && parts[2] === WATCHER_NOTIFICATIONS ? parts[1]! : null;
}

/**
 * Re-tries every notification still `queued` and younger than the re-drive
 * window, oldest first. One row failing never stops the rest.
 */
export async function redriveQueuedWatcherAlerts(
  now: Date,
  options: WatcherAlertOptions & { limit?: number } = {},
): Promise<{ scanned: number; sent: number; failed: number }> {
  const storage = options.storage ?? getStorage();
  const rows = await storage.listGroup<WatcherNotification>(WATCHER_NOTIFICATIONS, {
    where: [
      ['state', '==', 'queued'],
      ['queuedAt', '>=', new Date(now.getTime() - WATCHER_ALERT_REDRIVE_MS).toISOString()],
      ['queuedAt', '<=', now.toISOString()],
    ],
    orderBy: { field: 'queuedAt', direction: 'asc' },
    limit: options.limit ?? WATCHER_ALERT_REDRIVE_BATCH,
  });
  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    const uid = ownerOf(row.path);
    if (!uid) continue;
    try {
      if (await deliverWatcherAlert(uid, row.id, now, options) === 'sent') sent += 1;
    } catch {
      failed += 1;
    }
  }
  return { scanned: rows.length, sent, failed };
}
