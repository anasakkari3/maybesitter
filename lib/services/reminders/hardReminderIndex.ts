/**
 * Which Must reminders the server may have to back up (UC-3.12b, #198).
 *
 * ── The index, and where it is written from ──────────────────────
 *
 * `users/{uid}/hardReminders/{sha256(commitmentId)}` holds one row per Must
 * commitment that would ring on this account: the commitment id, the instant
 * the reminder is *for* (start − 10 minutes), a status, and the receipt a phone
 * uploaded saying it will ring locally. Never a title.
 *
 * #198 asks for it to be maintained "from every commitment write path". There
 * is exactly one: every command, capture confirmation and state persist ends in
 * `writeDomainDiff` (`lib/services/mobile/participantState.ts`), inside the
 * transaction that writes the commitment. So the index is written there, in the
 * same commit, and a path added next month cannot forget it. That transaction
 * may issue no further reads, which is why `hardSettingsOfUser` is pure and the
 * diff below needs only the before and after states it is handed.
 *
 * ── What a row's identity is ─────────────────────────────────────
 *
 * The pair (commitmentId, fireAt). A row whose commitment keeps its start is
 * left alone by every later write — a title edit must not wipe a receipt. A row
 * whose start moved is *replaced* with a fresh `pending` one and no receipt:
 * the receipt was a claim about a reminder that no longer exists (#198: "any
 * start change resets status to pending and clears localReceipt"). A commitment
 * that stops qualifying — completed, dropped, postponed off a time, no longer
 * Must, or an account that lowered its ceiling — loses its row, which is how
 * "completing, postponing or cancelling before fireAt → no push" holds without
 * the job having to know about any of them.
 *
 * ── Rows the write path never saw ────────────────────────────────
 *
 * A commitment written before this shipped, or before the account turned Must
 * reminders on, has no row. `reconcileHardReminderIndex` rebuilds the index
 * from the commitments themselves; it runs when the settings are saved and when
 * a phone uploads receipts, which is every sync of every phone that has the
 * feature.
 */
import type { Commitment, DomainState } from '../../../src/domain/stateMachine';
import {
  COMMITMENTS,
  docIdForKey,
  getStorage,
  HARD_REMINDERS,
  requireDocId,
  requireUserId,
  userCol,
  userDoc,
  userSubDoc,
  type StorageAdapter,
  type StorageTransaction,
} from '../../storage';
import { hardSettingsOfUser, ringsForMust, type HardReminderSettings } from '../mobile/reminderSettingsService';

/** Ten minutes before the start, as #197 rings locally. */
export const HARD_LEAD_MS = 10 * 60_000;

/** How long a row outlives its reminder before the TTL policy removes it. */
export const HARD_REMINDER_RETENTION_MS = 2 * 24 * 60 * 60 * 1000;

export type HardReminderStatus = 'pending' | 'sent' | 'suppressed' | 'cancelled';

export type HardReminderReason =
  | 'local_receipt'
  | 'quiet_hours'
  | 'acknowledged'
  | 'completed'
  | 'ceiling'
  /** The account had no device that could be pushed to. */
  | 'no_devices'
  /** The account is deleted, revoked or in quiet mode (`pushAccess`). */
  | 'no_access'
  /** FCM refused the send for a reason that was not a dead token. */
  | 'send_failed';

export interface HardReminderReceipt {
  readonly installationId: string;
  /** `${commitmentId}:strong`, the identifier the phone holds the request under. */
  readonly notificationId: string;
  readonly exact: boolean;
  /** When the server accepted it. */
  readonly scheduledAt: string;
}

export interface HardReminderEntry {
  readonly commitmentId: string;
  /** ISO-8601, the commitment's start minus ten minutes. */
  readonly fireAt: string;
  /** The start the row was computed from. */
  readonly startFingerprint: string;
  readonly status: HardReminderStatus;
  readonly localReceipt?: HardReminderReceipt;
  readonly reason?: HardReminderReason;
  readonly updatedAt: string;
  /** Firestore TTL. A Date, because a TTL policy on a string never deletes. */
  readonly expiresAt: Date | string;
}

export function hardReminderPath(uid: string, commitmentId: string): string {
  return userSubDoc(uid, HARD_REMINDERS, docIdForKey(commitmentId));
}

/** `users/{uid}/hardReminders/{id}` → uid, or null for anything else. */
export function uidOfHardReminderPath(path: string): string | null {
  const parts = path.split('/');
  if (parts.length !== 4 || parts[0] !== 'users' || parts[2] !== HARD_REMINDERS) return null;
  try {
    return requireUserId(parts[1]);
  } catch {
    return null;
  }
}

/**
 * The instant this commitment's Must reminder is for, or null when it has none.
 *
 * The same four conditions the phone applies in `stagesFor`/`planFor`: an
 * active commitment, marked Must, with a time, on an account that opted in at
 * the hard ceiling. And one the phone applies too, for the same reason: an
 * all-day commitment has no hour anybody chose (`TimeSpec.allDay`), so ten
 * minutes before its "start" is ten to midnight the night before.
 */
export function hardFireAtFor(commitment: Commitment, settings: HardReminderSettings): string | null {
  if (!ringsForMust(settings)) return null;
  if (commitment.status !== 'active') return null;
  if (commitment.priority?.level !== 'high') return null;
  if (commitment.timeSpec?.allDay) return null;
  const dueAt = commitment.timeSpec?.dueAt;
  if (!dueAt) return null;
  const start = Date.parse(dueAt);
  if (Number.isNaN(start)) return null;
  const fireAt = start - HARD_LEAD_MS;
  if (!mustRingsDespitePostpone(fireAt, commitment.postponedUntil ?? null)) return null;
  return new Date(fireAt).toISOString();
}

/**
 * Whether a Must ring at `fireAt` survives a postponement (council verdict B, #198).
 *
 * The phone's `mustRingsDespitePostpone` (`mobile/src/features/reminders/
 * policy.ts`), line for line, and both are held to the one table in
 * `mobile/src/features/reminders/__fixtures__/postponedHardRing.json`. A ring
 * before `postponedUntil` is not owed; one at or after it is. Time-free, so a
 * stale postponement is no postponement. Because `hardFireAtFor` is also what
 * the job rechecks at send time, a postpone that lands after the row was
 * written still cancels the backup.
 */
export function mustRingsDespitePostpone(fireAt: number, postponedUntil: string | null): boolean {
  if (postponedUntil === null) return true;
  const until = Date.parse(postponedUntil);
  if (Number.isNaN(until)) return true;
  return fireAt >= until;
}

function freshEntry(commitment: Commitment, fireAt: string, at: string): HardReminderEntry {
  return {
    commitmentId: commitment.id,
    fireAt,
    startFingerprint: commitment.timeSpec.dueAt as string,
    status: 'pending',
    updatedAt: at,
    expiresAt: new Date(Date.parse(fireAt) + HARD_REMINDER_RETENTION_MS),
  };
}

/**
 * The index writes one domain transition implies. Called from `writeDomainDiff`.
 *
 * Writes nothing for a commitment whose reminder instant did not change, so an
 * edit to anything else leaves the row — and the receipt on it — untouched.
 */
export function writeHardReminderIndexDiff(
  tx: StorageTransaction,
  uid: string,
  before: DomainState['commitments'],
  after: DomainState['commitments'],
  user: unknown,
  at: string,
): void {
  const settings = hardSettingsOfUser(user);
  const ids = new Set([...Object.keys(before), ...Object.keys(after)]);
  ids.forEach((id) => {
    const previous = before[id] ? hardFireAtFor(before[id], settings) : null;
    const next = after[id] ? hardFireAtFor(after[id], settings) : null;
    if (previous === next) return;
    const path = hardReminderPath(uid, after[id]?.id ?? before[id]!.id);
    if (next === null) tx.delete(path);
    else tx.set<HardReminderEntry>(path, freshEntry(after[id]!, next, at));
  });
}

export interface ReconcileResult {
  created: number;
  replaced: number;
  removed: number;
  kept: number;
}

/**
 * Makes the index match the commitments and the settings, in one transaction.
 *
 * A row already at the right instant is kept exactly as it is — status and
 * receipt included — so running this is always safe, which is what lets it run
 * on every receipt upload.
 */
export async function reconcileHardReminderIndex(
  uid: string,
  at: Date,
  options: { storage?: StorageAdapter } = {},
): Promise<ReconcileResult> {
  requireUserId(uid);
  const storage = options.storage ?? getStorage();
  return storage.runTransaction(async (tx) => {
    const [user, commitments, rows] = await Promise.all([
      tx.get<unknown>(userDoc(uid)),
      tx.list<Commitment>(userCol(uid, COMMITMENTS)),
      tx.list<HardReminderEntry>(userCol(uid, HARD_REMINDERS)),
    ]);
    const settings = hardSettingsOfUser(user);
    const wanted = new Map<string, { commitment: Commitment; fireAt: string }>();
    for (const { data } of commitments) {
      const fireAt = hardFireAtFor(data, settings);
      if (fireAt) wanted.set(docIdForKey(data.id), { commitment: data, fireAt });
    }

    const result: ReconcileResult = { created: 0, replaced: 0, removed: 0, kept: 0 };
    const iso = at.toISOString();
    for (const row of rows) {
      const id = requireDocId(row.id);
      const want = wanted.get(id);
      if (!want) {
        tx.delete(userSubDoc(uid, HARD_REMINDERS, id));
        result.removed += 1;
        continue;
      }
      wanted.delete(id);
      if (row.data.fireAt === want.fireAt && row.data.commitmentId === want.commitment.id) {
        result.kept += 1;
        continue;
      }
      tx.set<HardReminderEntry>(userSubDoc(uid, HARD_REMINDERS, id), freshEntry(want.commitment, want.fireAt, iso));
      result.replaced += 1;
    }
    wanted.forEach((want, id) => {
      tx.set<HardReminderEntry>(userSubDoc(uid, HARD_REMINDERS, id), freshEntry(want.commitment, want.fireAt, iso));
      result.created += 1;
    });
    return result;
  });
}
