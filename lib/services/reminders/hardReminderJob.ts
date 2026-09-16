/**
 * The Must reminder's server backup (UC-3.12b, #198).
 *
 * Cloud Scheduler calls `POST /api/internal/jobs/hard-reminders` every minute.
 * Each call reads the index rows whose reminder is due, decides each one inside
 * a transaction, and pushes at most once per row.
 *
 * ── Never twice: the three rules that live here ──────────────────
 *
 * (`hardReceipts.ts` holds the first two; its header lists all five.)
 *
 *  3. **An exact receipt stands the server down**, but only from a phone that
 *     is still this account's and still allowed to show a notification. A phone
 *     that signed out has no device row, and a phone that revoked notifications
 *     is `denied`; either way its receipt claims a ring nobody will hear, so it
 *     is disregarded and the push goes.
 *  4. **An inexact receipt delays the push to `fireAt + 3 min`.** Android with
 *     "Alarms & reminders" revoked fires the local reminder late by a few
 *     minutes, usually before then.
 *  5. **A push that does go out is shown under the local reminder's own
 *     identifier** (`collapseId: ${commitmentId}:strong`) — `apns-collapse-id`
 *     on iOS, the notification tag on Android, both of which *replace* a
 *     notification already showing under that identifier. So when rule 4's
 *     "usually" does not hold, the person sees one notification, not two.
 *
 * And at most one push per row, whatever runs concurrently: the row moves from
 * `pending` to `sent` in the same transaction that decided to send, so a second
 * job invocation reads `sent` and does nothing; and `sendToUser`'s own lock on
 * `dedupeKey` is a second, independent barrier. If the process dies between the
 * claim and the send, the reminder is not sent — at most once, deliberately,
 * because the phone may well be ringing anyway.
 *
 * ── One stage, no follow-up ──────────────────────────────────────
 *
 * #198 step 5 and the #107 policy (#199): nothing here sends a second push for
 * a row, repeats one, or sends anything because the user did not respond. A
 * row leaves `pending` exactly once and nothing ever puts it back — only a
 * *new* reminder (the start moved) gets a new `pending` row.
 */
import { createHash } from 'node:crypto';
import { normalizeStoredCommitment, type Commitment } from '../../../src/domain/stateMachine';
import {
  devicePath,
  listPushableDevices,
  type DeviceLocale,
  type DeviceRecord,
} from '../../push/deviceRegistry';
import { sendToUser, type MessagingClient, type PushMessage, type PushResult } from '../../push/pushService';
import { getStorage, HARD_REMINDERS, userDoc, type StorageAdapter } from '../../storage';
import { commitmentDocPath } from '../mobile/participantState';
import { mustRingIdentifier } from './mustRingIdentifier';
import { hardSettingsOfUser, ringsForMust, type HardReminderSettings } from '../mobile/reminderSettingsService';
import {
  HARD_LOOKBACK_MS,
  hardFireAtFor,
  isTooLate,
  uidOfHardReminderPath,
  type HardReminderEntry,
  type HardReminderReason,
} from './hardReminderIndex';

/**
 * No lookahead: a backup is sent at or after `fireAt`, never before (#198 review
 * F1). Sent early, it can reach the phone ahead of the local ring and be shown
 * first — and on Android in the foreground, the pair only collapses if the push
 * arrives second. A minute-granular tick makes it up to a minute late instead.
 *
 * Rows further back than `HARD_LOOKBACK_MS` are not sent: a Must reminder that
 * late is noise. That is in the query *and* in `decideHardReminder`, so a job
 * that runs late or a query that returns too much still cannot push a stale one.
 */
export { HARD_LOOKBACK_MS } from './hardReminderIndex';
/** Rule 4. */
export const INEXACT_GRACE_MS = 3 * 60_000;
export const HARD_REMINDER_BATCH = 100;

/**
 * The generic sentence, per language. Never the commitment's title: this text
 * passes through Google and Apple. It is the app's own `notifHardTitle` and
 * `notifHardBody`, and `hardReminderJob.test.ts` reads the locale bundles to
 * keep the two identical.
 */
export const HARD_REMINDER_COPY: Readonly<Record<DeviceLocale, { title: string; body: string }>> = Object.freeze({
  ar: { title: 'في إشي ضروري بيبلش قريب', body: 'افتح MaybeSitter تشوفه.' },
  he: { title: 'משהו חובה מתחיל בקרוב', body: 'פתח את MaybeSitter כדי לראות.' },
  en: { title: 'A Must item starts soon', body: 'Open MaybeSitter to see it.' },
});

export type HardDecision =
  | { readonly kind: 'skip' }
  | { readonly kind: 'wait' }
  | { readonly kind: 'cancel'; readonly reason: HardReminderReason }
  | { readonly kind: 'suppress'; readonly reason: HardReminderReason }
  | { readonly kind: 'send' };

export interface HardDecisionInput {
  readonly entry: HardReminderEntry;
  readonly commitment: Commitment | null;
  readonly settings: HardReminderSettings;
  /** The device row the receipt came from, if the receipt has one. */
  readonly receiptDevice: DeviceRecord | null;
  readonly now: Date;
}

/** Whether a receipt's phone can still ring: still registered, notifications not denied. */
export function receiptStillSpeaks(entry: HardReminderEntry, device: DeviceRecord | null): boolean {
  if (!entry.localReceipt || !device) return false;
  return device.installationId === entry.localReceipt.installationId && device.pushPermission !== 'denied';
}

/** What to do with one row. Pure; every instant comes in as an argument. */
export function decideHardReminder(input: HardDecisionInput): HardDecision {
  const { entry, commitment, settings, now } = input;
  if (entry.status !== 'pending') return { kind: 'skip' };
  if (!ringsForMust(settings)) return { kind: 'cancel', reason: 'ceiling' };
  const current = commitment ? hardFireAtFor(commitment, settings) : null;
  if (current === null) return { kind: 'cancel', reason: 'completed' };
  // The commitment has moved and the row has not caught up. The write that
  // moved it replaces the row; this one is not the reminder any more.
  if (current !== entry.fireAt) return { kind: 'skip' };

  const fireAt = Date.parse(entry.fireAt);
  if (fireAt > now.getTime()) return { kind: 'wait' };
  if (isTooLate(entry.fireAt, now.getTime())) return { kind: 'suppress', reason: 'too_late' };

  if (receiptStillSpeaks(entry, input.receiptDevice)) {
    if (entry.localReceipt!.exact) return { kind: 'suppress', reason: 'local_receipt' };
    // Strictly at `fireAt + 3 min`, not "due within the next tick": the late
    // local alarm this is waiting for usually lands inside those minutes, and
    // every minute taken off the grace is a minute a double can happen in.
    if (fireAt + INEXACT_GRACE_MS > now.getTime()) return { kind: 'wait' };
  }
  return { kind: 'send' };
}

/**
 * The lock key. #198 sketched `hard:<commitmentId>:<fireAt>`, which is 66
 * characters for a uuid and an ISO instant — over the 64 APNs and FCM allow,
 * so every send would have thrown in the payload guard. The pair is hashed
 * instead: the same pair always gives the same key, and a moved reminder a
 * different one.
 */
export function hardDedupeKey(commitmentId: string, fireAt: string): string {
  return `hard:${createHash('sha256').update(`${commitmentId}\n${fireAt}`).digest('hex').slice(0, 40)}`;
}

/** The newest device's language; Arabic when nobody has said. */
export function localeFor(devices: readonly DeviceRecord[]): DeviceLocale {
  const newest = [...devices].sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))[0];
  return newest?.locale ?? 'ar';
}

export function hardReminderMessage(
  uid: string,
  entry: HardReminderEntry,
  settings: HardReminderSettings,
  locale: DeviceLocale,
): PushMessage {
  const copy = HARD_REMINDER_COPY[locale];
  const notificationId = mustRingIdentifier(entry.commitmentId);
  return {
    kind: 'hard_reminder',
    uid,
    dedupeKey: hardDedupeKey(entry.commitmentId, entry.fireAt),
    collapseId: notificationId,
    // `tag` too: expo-notifications' Android FCM delegate names the notification
    // after `data.tag` (else the message id), so without it a foreground backup
    // would not replace the local ring (#198 review F1).
    data: { kind: 'hard_reminder', commitmentId: entry.commitmentId, notificationId, tag: notificationId },
    title: copy.title,
    body: copy.body,
    urgency: 'time_sensitive',
    respectQuietHours: !settings.mustThroughQuietHours,
  };
}

const RESULT_REASON: Readonly<Partial<Record<PushResult['status'], HardReminderReason>>> = Object.freeze({
  suppressed_quiet_hours: 'quiet_hours',
  suppressed_no_access: 'no_access',
  no_devices: 'no_devices',
});

export interface HardReminderTickTotals {
  due: number;
  sent: number;
  suppressed: number;
  cancelled: number;
  waiting: number;
  failed: number;
}

export interface HardReminderTickOptions {
  now?: () => Date;
  storage?: StorageAdapter;
  messaging?: MessagingClient;
  /** Injectable so a test can race two ticks through one fake. */
  send?: typeof sendToUser;
  limit?: number;
}

/** One minute's sweep. */
export async function runHardReminderTick(options: HardReminderTickOptions = {}): Promise<HardReminderTickTotals> {
  const now = (options.now ?? (() => new Date()))();
  const storage = options.storage ?? getStorage();
  const send = options.send ?? sendToUser;
  const totals: HardReminderTickTotals = { due: 0, sent: 0, suppressed: 0, cancelled: 0, waiting: 0, failed: 0 };

  const rows = await storage.listGroup<HardReminderEntry>(HARD_REMINDERS, {
    where: [
      ['status', '==', 'pending'],
      ['fireAt', '<=', now.toISOString()],
      ['fireAt', '>=', new Date(now.getTime() - HARD_LOOKBACK_MS).toISOString()],
    ],
    orderBy: { field: 'fireAt', direction: 'asc' },
    limit: options.limit ?? HARD_REMINDER_BATCH,
  });
  totals.due = rows.length;

  for (const row of rows) {
    const uid = uidOfHardReminderPath(row.path);
    if (!uid) continue;
    try {
      const outcome = await processRow(uid, row.path, now, storage, send, options.messaging);
      totals[outcome] += 1;
    } catch (error) {
      totals.failed += 1;
      // No uid and no commitment id in the log line; see dailyPlanService.
      console.error('[internal/jobs/hard-reminders] one reminder failed', error);
    }
  }
  return totals;
}

type RowOutcome = 'sent' | 'suppressed' | 'cancelled' | 'waiting';

async function processRow(
  uid: string,
  path: string,
  now: Date,
  storage: StorageAdapter,
  send: typeof sendToUser,
  messaging: MessagingClient | undefined,
): Promise<RowOutcome> {
  const at = now.toISOString();
  const claim = await storage.runTransaction(async (tx) => {
    const entry = await tx.get<HardReminderEntry>(path);
    if (!entry) return { decision: { kind: 'skip' } as HardDecision };
    const [user, stored, device] = await Promise.all([
      tx.get<unknown>(userDoc(uid)),
      tx.get<Commitment>(commitmentDocPath(uid, entry.commitmentId)),
      entry.localReceipt ? tx.get<DeviceRecord>(devicePath(uid, entry.localReceipt.installationId)) : null,
    ]);
    const settings = hardSettingsOfUser(user);
    const decision = decideHardReminder({
      entry,
      commitment: stored ? normalizeStoredCommitment(stored) : null,
      settings,
      receiptDevice: device,
      now,
    });
    if (decision.kind === 'cancel') {
      tx.merge<HardReminderEntry>(path, { status: 'cancelled', reason: decision.reason, updatedAt: at });
    } else if (decision.kind === 'suppress') {
      tx.merge<HardReminderEntry>(path, { status: 'suppressed', reason: decision.reason, updatedAt: at });
    } else if (decision.kind === 'send') {
      // The claim. Committed before anything is sent: a second invocation
      // reading this row now reads `sent` and skips it.
      tx.merge<HardReminderEntry>(path, { status: 'sent', updatedAt: at });
    }
    return { decision, entry, settings };
  });

  switch (claim.decision.kind) {
    case 'cancel':
      return 'cancelled';
    case 'suppress':
      return 'suppressed';
    case 'skip':
    case 'wait':
      return 'waiting';
    case 'send':
      break;
  }

  const entry = claim.entry as HardReminderEntry;
  const settings = claim.settings as HardReminderSettings;
  const locale = localeFor(await listPushableDevices(uid, { storage }));
  let result: PushResult;
  try {
    result = await send(hardReminderMessage(uid, entry, settings, locale), now, {
      storage,
      ...(messaging ? { messaging } : {}),
    });
  } catch (error) {
    // Not retried: the row stays out of `pending`, which is the at-most-once
    // half of the contract. The reason says what happened.
    await storage.runTransaction(async (tx) => {
      await tx.get(path);
      tx.merge<HardReminderEntry>(path, { status: 'suppressed', reason: 'send_failed', updatedAt: at });
    });
    throw error;
  }
  const reason = RESULT_REASON[result.status];
  if (reason) {
    await storage.runTransaction(async (tx) => {
      await tx.get(path);
      tx.merge<HardReminderEntry>(path, { status: 'suppressed', reason, updatedAt: at });
    });
    return 'suppressed';
  }
  return 'sent';
}
