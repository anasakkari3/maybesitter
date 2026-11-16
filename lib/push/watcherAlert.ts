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
 * ── Lost pushes, failed sends, quiet hours, no device ────────────
 *
 * A notification stays `queued` until FCM accepted its push for at least one
 * device; then it is `sent`. `redriveQueuedWatcherAlerts` re-tries queued
 * notifications for `WATCHER_ALERT_REDRIVE_MS` (30 minutes) after they were
 * queued, which covers a crash between the firing's commit and its push.
 *
 * The push lock (`pushLog`) is taken *before* the send, so a lock alone proves
 * nothing. `sendToUser` stamps `deliveredAt` on it when the first device takes
 * the message, and only that stamp is read as "already pushed": the retry
 * then marks the notification `sent` without a second send. A lock with no
 * stamp is a send in flight — left alone for two minutes — or one that threw,
 * which is cleared so the next attempt can send. When `sendToUser` throws
 * here (quota, auth, network) after a device took the message, it counts as
 * sent and keeps its budget; when none did, the budget is given back, the
 * unstamped lock is cleared at once, and the error is re-thrown to the log.
 *
 * The stamp is written after FCM answered, and best-effort, so there is a
 * small window this cannot close: a worker that dies — or whose stamp write
 * fails — between a successful send and the stamp leaves an unstamped lock,
 * and two minutes later a retry within the 30-minute window sends again.
 * That is accepted: it needs a crash in a window of milliseconds, the
 * per-watcher collapse id makes the second alert replace the first on the
 * phone rather than stand beside it, and the alternative — never retrying
 * an unstamped lock — loses every push FCM refused, which is the defect this
 * module was written to stop.
 *
 * Quiet hours are checked before anything is claimed: the alert stays
 * `queued`, claims no budget, and goes out on a later tick only if the quiet
 * window ends within 30 minutes of the firing. No device and no access also
 * stay `queued` under the same window. After it they are left for good —
 * never sent late; a stale "something changed" is noise, and the firing stays
 * visible in the app either way. An alert held by the gap or the daily cap is
 * settled at once as `suppressed`: it would not become sendable sooner by
 * being re-read every minute.
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
import { isInQuietHours, readQuietHours } from './quietHours';
import {
  PUSH_LOG_TTL_MS,
  sendToUser,
  type MessagingClient,
  type PushLogEntry,
  type PushMessage,
  type PushResult,
} from './pushService';

export const WATCHER_ALERT_MIN_GAP_MS = 60 * 60_000;
export const WATCHER_ALERT_DAILY_CAP = 6;
export const WATCHER_ALERT_REDRIVE_MS = 30 * 60_000;
/** The most queued notifications one tick re-drives. */
export const WATCHER_ALERT_REDRIVE_BATCH = 50;
/** How long one re-drive round may run; the scheduler gives the whole tick 60 s. */
export const WATCHER_ALERT_REDRIVE_BUDGET_MS = 15_000;
/**
 * A lock with no `deliveredAt` older than this is a send that threw (or a
 * worker that died mid-send), not one still in flight, and is cleared so the
 * next attempt can send.
 */
export const WATCHER_ALERT_STALE_LOCK_MS = 2 * 60_000;

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

export type WatcherAlertOutcome = PushResult['status'] | 'throttled' | 'capped' | 'expired' | 'gone' | 'in_flight';

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

  const settle = (state: 'sent' | 'suppressed') => storage.runTransaction(async (tx) => {
    const current = await tx.get<WatcherNotification>(path);
    if (!current || current.state !== 'queued') return;
    tx.set(path, { ...current, state });
  });

  const dedupeKey = watcherAlertDedupeKey(notificationId);
  const lockPath = userSubDoc(uid, PUSH_LOG, docIdForKey(dedupeKey));
  const lock = await storage.get<PushLogEntry>(lockPath);
  if (lock?.deliveredAt) {
    // Pushed already, and the process died before it could say so.
    await settle('sent');
    return 'duplicate';
  }
  if (lock) {
    // Taken and never delivered: still in flight, or a send that threw.
    if (now.getTime() - Date.parse(lock.createdAt) < WATCHER_ALERT_STALE_LOCK_MS) return 'in_flight';
    await storage.delete(lockPath);
  }

  // Quiet hours first, so a held alert claims nothing and stays queued.
  if (isInQuietHours(await readQuietHours(uid, { storage }), now)) return 'suppressed_quiet_hours';

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
  if (claim.status === 'throttled' || claim.status === 'capped') {
    // Settled, not queued: it will not be sendable any sooner on the next
    // tick, and re-reading it every minute for half an hour is the noise the
    // bounds exist to stop. The firing itself stays recorded.
    await settle('suppressed');
    return claim.status;
  }
  if (claim.status !== 'claimed') return claim.status;

  const release = () => storage.runTransaction(async (tx) => {
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

  const devices = await listPushableDevices(uid, { storage });
  // The newest device's language; Arabic when nobody has said.
  const newest = [...devices].sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))[0];
  const message = watcherAlertMessage(uid, queued, newest?.locale ?? 'ar');
  let result: PushResult;
  try {
    result = await sendToUser(message, now, {
      storage,
      ...(options.messaging ? { messaging: options.messaging } : {}),
    });
  } catch (error) {
    // FCM refused for a reason that is not this phone's (quota, auth, the
    // network). The lock is read first: if a device already took the message
    // it is a delivery — the budget stays spent and the notification is sent.
    // Otherwise the budget is given back and the unstamped lock cleared, so
    // the next tick sends rather than reading the lock as a delivery.
    const taken = await storage.get<PushLogEntry>(lockPath);
    if (taken?.deliveredAt) {
      await settle('sent');
    } else {
      await release();
      if (taken) await storage.delete(lockPath);
    }
    throw error;
  }

  if (result.status === 'sent') {
    await settle('sent');
    return result.status;
  }
  // Nothing reached a phone from this attempt — no device, no access, or
  // another worker holds the lock — so the budget is given back and the
  // notification stays queued.
  await release();
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
  options: WatcherAlertOptions & { limit?: number; budgetMs?: number } = {},
): Promise<{ scanned: number; sent: number; failed: number; stoppedEarly: boolean }> {
  const storage = options.storage ?? getStorage();
  const started = Date.now();
  const budgetMs = options.budgetMs ?? WATCHER_ALERT_REDRIVE_BUDGET_MS;
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
    // The rest wait for the next tick rather than push the job past its deadline.
    if (Date.now() - started >= budgetMs) return { scanned: rows.length, sent, failed, stoppedEarly: true };
    const uid = ownerOf(row.path);
    if (!uid) continue;
    try {
      if (await deliverWatcherAlert(uid, row.id, now, options) === 'sent') sent += 1;
    } catch {
      failed += 1;
    }
  }
  return { scanned: rows.length, sent, failed, stoppedEarly: false };
}
