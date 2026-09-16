/**
 * "This phone will ring for that Must reminder" — received (UC-3.12b, #198).
 *
 * ── The dedupe contract, the half that lives here ────────────────
 *
 * A Must reminder must reach the person once. The phone schedules it locally
 * (#197) and the server can push a backup (#198); the two are kept from both
 * happening by five rules, and this module holds the first two:
 *
 *  1. **A receipt names one reminder exactly.** It is stored only on the index
 *     row whose `fireAt` is the receipt's `fireAt` and whose status is still
 *     `pending`. A receipt for a start that has since moved is ignored — it is
 *     a claim about a reminder that no longer exists — and so is one for a row
 *     already sent or suppressed.
 *  2. **An exact claim is never downgraded by another phone's inexact one.** If
 *     one phone will ring on time, a second phone saying it may ring late does
 *     not re-open the backup.
 *
 * The job (`hardReminderJob.ts`) holds the other three: an exact receipt from a
 * phone that is still registered and allowed to show notifications suppresses
 * the push; an inexact one delays it to `fireAt + 3 min`; and the push that
 * does go out carries the local reminder's identifier as its collapse id and
 * tag, so a phone that shows both shows one.
 *
 * ── What is stored ───────────────────────────────────────────────
 *
 * The installation id, the notification identifier, a boolean and an instant.
 * Nothing the phone sends is stored beyond those, and a body with anything else
 * in it is refused rather than partly read.
 */
import { isInstallationId } from '../../push/deviceRegistry';
import { getStorage, requireUserId, type StorageAdapter } from '../../storage';
import {
  hardReminderPath,
  reconcileHardReminderIndex,
  type HardReminderEntry,
  type HardReminderReceipt,
} from './hardReminderIndex';

/** The phone caps its own pending set at 50, so a body can never honestly be larger. */
export const MAX_RECEIPTS_PER_UPLOAD = 50;
const MAX_COMMITMENT_ID_LENGTH = 128;

export interface HardReceiptInput {
  readonly commitmentId: string;
  readonly notificationId: string;
  readonly fireAt: string;
  readonly exact: boolean;
}

export interface HardReceiptUpload {
  readonly installationId: string;
  readonly receipts: readonly HardReceiptInput[];
}

export class HardReceiptValidationError extends Error {
  constructor(message: string, readonly reason: string) {
    super(`hard reminder receipts: ${message}`);
    this.name = 'HardReceiptValidationError';
  }
}

function fail(message: string, reason: string): never {
  throw new HardReceiptValidationError(message, reason);
}

const UPLOAD_FIELDS = new Set(['installationId', 'receipts']);
const RECEIPT_FIELDS = new Set(['commitmentId', 'notificationId', 'fireAt', 'exact']);

/** Validates a body into an upload. Refuses rather than coerces. */
export function parseHardReceiptUpload(value: unknown): HardReceiptUpload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('body must be an object', 'invalid_body');
  const raw = value as Record<string, unknown>;
  const unknown = Object.keys(raw).find((key) => !UPLOAD_FIELDS.has(key));
  if (unknown) fail(`unknown field ${JSON.stringify(unknown)}`, 'unknown_field');
  if (!isInstallationId(raw.installationId)) fail('installationId must be a uuid', 'invalid_installation_id');
  if (!Array.isArray(raw.receipts)) fail('receipts must be an array', 'invalid_receipts');
  if (raw.receipts.length > MAX_RECEIPTS_PER_UPLOAD) {
    fail(`at most ${MAX_RECEIPTS_PER_UPLOAD} receipts`, 'too_many_receipts');
  }

  const receipts = raw.receipts.map((entry): HardReceiptInput => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('a receipt must be an object', 'invalid_receipt');
    const row = entry as Record<string, unknown>;
    const extra = Object.keys(row).find((key) => !RECEIPT_FIELDS.has(key));
    if (extra) fail(`unknown receipt field ${JSON.stringify(extra)}`, 'unknown_field');
    if (typeof row.commitmentId !== 'string' || row.commitmentId === '' || row.commitmentId.length > MAX_COMMITMENT_ID_LENGTH) {
      fail('commitmentId must be an id', 'invalid_commitment_id');
    }
    // The identifier is not free: it is the one the phone holds the Must stage
    // under, and it is what the backup push collapses into. Anything else is
    // not a receipt for this reminder.
    if (row.notificationId !== `${row.commitmentId}:strong`) {
      fail('notificationId must be the commitment s strong-stage identifier', 'invalid_notification_id');
    }
    if (typeof row.fireAt !== 'string' || Number.isNaN(Date.parse(row.fireAt))) {
      fail('fireAt must be an ISO-8601 instant', 'invalid_fire_at');
    }
    if (typeof row.exact !== 'boolean') fail('exact must be a boolean', 'invalid_exact');
    return {
      commitmentId: row.commitmentId,
      notificationId: row.notificationId,
      fireAt: new Date(Date.parse(row.fireAt)).toISOString(),
      exact: row.exact,
    };
  });
  return { installationId: raw.installationId, receipts };
}

export interface HardReceiptResult {
  /** Stored on a pending row at exactly that instant. */
  accepted: number;
  /** A reminder that has moved, been sent, been cancelled, or never existed. */
  ignored: number;
}

/**
 * Stores what the phone reported, after bringing the index up to date.
 *
 * The reconcile first is what lets a commitment written before this feature, or
 * before the account turned Must reminders on, still get a row for the receipt
 * to land on. Every receipt is then decided inside one transaction against the
 * rows it reads, so a job claiming a row concurrently either sees the receipt
 * or commits first and makes this transaction retry against `sent`.
 */
export async function recordHardReceipts(
  uid: string,
  upload: HardReceiptUpload,
  now: Date,
  options: { storage?: StorageAdapter } = {},
): Promise<HardReceiptResult> {
  requireUserId(uid);
  const storage = options.storage ?? getStorage();
  await reconcileHardReminderIndex(uid, now, { storage });

  return storage.runTransaction(async (tx) => {
    const rows = await Promise.all(
      upload.receipts.map((receipt) => tx.get<HardReminderEntry>(hardReminderPath(uid, receipt.commitmentId))),
    );
    const result: HardReceiptResult = { accepted: 0, ignored: 0 };
    const written = new Set<string>();
    upload.receipts.forEach((receipt, index) => {
      const row = rows[index];
      if (!row || row.status !== 'pending' || row.fireAt !== receipt.fireAt || row.commitmentId !== receipt.commitmentId) {
        result.ignored += 1;
        return;
      }
      // Rule 2: another phone's exact claim stands.
      const existing = row.localReceipt;
      if (existing && existing.exact && !receipt.exact && existing.installationId !== upload.installationId) {
        result.ignored += 1;
        return;
      }
      const path = hardReminderPath(uid, receipt.commitmentId);
      if (written.has(path)) {
        result.ignored += 1;
        return;
      }
      written.add(path);
      const localReceipt: HardReminderReceipt = {
        installationId: upload.installationId,
        notificationId: receipt.notificationId,
        exact: receipt.exact,
        scheduledAt: now.toISOString(),
      };
      tx.merge<HardReminderEntry>(path, { localReceipt, updatedAt: now.toISOString() });
      result.accepted += 1;
    });
    return result;
  });
}
