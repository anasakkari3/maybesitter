/**
 * "This phone will ring for that one" — waiting to be told to the server
 * (UC-3.12a #197, uploaded by UC-3.12b #198).
 *
 * ── What a receipt is ────────────────────────────────────────────
 *
 * After the engine schedules a Must reminder it records which commitment, which
 * pending request, the instant the reminder is *for* (start − 10 minutes) and
 * whether the OS will fire it exactly. The server's backup push (#198) stands
 * down for a reminder it holds an exact receipt for, so a receipt is a claim,
 * and only the engine — which has just confirmed the request is pending — makes
 * one.
 *
 * ── What it is not ───────────────────────────────────────────────
 *
 * Nothing about what the commitment is. An id, a notification identifier (which
 * is that id plus `:strong`), an instant and a boolean. The same rule as the
 * awareness store beside it, and the same reason this may live on the device.
 *
 * ── Two lists, so an unchanged receipt is uploaded once ──────────
 *
 * The engine reports every pending Must stage on every sync, kept ones
 * included, because a kept request is how a permission that changed since it
 * was scheduled reaches the server. Uploading all of them on every sync would
 * be a write per Must commitment per commitment edit. So `sent` remembers what
 * the server last acknowledged for each commitment, `withReceipts` drops a
 * receipt identical to it, and only `withUploaded` — called on a 2xx — moves a
 * receipt from `pending` to `sent`.
 *
 * ── Keyed by account ─────────────────────────────────────────────
 *
 * A receipt tells a server to *not* send something to an account. Filed under
 * the wrong account it silences somebody else's backup, which is the #148
 * shared-cache mistake with the worst symptom it has had yet. Cleared on
 * sign-out with the awareness record.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export const HARD_RECEIPT_QUEUE_VERSION = 1;

/**
 * A receipt whose reminder is this far in the past is dropped. The server's job
 * only looks five minutes back (#198), so a day is generous, and it bounds the
 * file for somebody who is offline for a week.
 */
export const HARD_RECEIPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function hardReceiptStorageKey(accountId: string): string {
  return `hardReceipts.v1.${accountId}`;
}

export interface HardReceipt {
  readonly commitmentId: string;
  /** The pending request's identifier, `${commitmentId}:strong`. */
  readonly notificationId: string;
  /** ISO-8601: the commitment's start minus ten minutes. */
  readonly fireAt: string;
  /** Whether the OS will fire it at `fireAt` rather than some minutes after. */
  readonly exact: boolean;
}

export interface HardReceiptQueue {
  readonly version: number;
  /** Not yet acknowledged by the server, one per commitment, newest wins. */
  readonly pending: readonly HardReceipt[];
  /** The last receipt the server acknowledged, per commitment. */
  readonly sent: Readonly<Record<string, HardReceipt>>;
}

export const EMPTY_HARD_RECEIPTS: HardReceiptQueue = Object.freeze({
  version: HARD_RECEIPT_QUEUE_VERSION,
  pending: Object.freeze([]) as readonly HardReceipt[],
  sent: Object.freeze({}),
});

function readReceipt(value: unknown): HardReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.commitmentId !== 'string' || row.commitmentId === '') return null;
  if (typeof row.notificationId !== 'string' || row.notificationId === '') return null;
  if (typeof row.fireAt !== 'string' || Number.isNaN(Date.parse(row.fireAt))) return null;
  if (typeof row.exact !== 'boolean') return null;
  // Rebuilt field by field, so a key a future version adds — or a title
  // somebody's bug put there — is not carried forward into an upload.
  return {
    commitmentId: row.commitmentId,
    notificationId: row.notificationId,
    fireAt: row.fireAt,
    exact: row.exact,
  };
}

/**
 * A stored blob, if this version understands it; otherwise an empty queue.
 *
 * Empty is the right failure. A lost receipt means the server sends a backup
 * the phone did not need — one extra notification, which the phone's own
 * duplicate handling exists for. A *wrong* receipt means the server stays
 * silent for a reminder the phone will not ring, which is the miss this whole
 * feature is here to prevent.
 */
export function parseHardReceiptQueue(raw: string | null): HardReceiptQueue {
  if (!raw) return EMPTY_HARD_RECEIPTS;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return EMPTY_HARD_RECEIPTS;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return EMPTY_HARD_RECEIPTS;
  const blob = value as Record<string, unknown>;
  if (blob.version !== HARD_RECEIPT_QUEUE_VERSION) return EMPTY_HARD_RECEIPTS;

  const pending: HardReceipt[] = [];
  if (Array.isArray(blob.pending)) {
    for (const entry of blob.pending) {
      const receipt = readReceipt(entry);
      if (receipt) pending.push(receipt);
    }
  }
  const sent: Record<string, HardReceipt> = {};
  if (blob.sent && typeof blob.sent === 'object' && !Array.isArray(blob.sent)) {
    for (const [commitmentId, entry] of Object.entries(blob.sent as Record<string, unknown>)) {
      const receipt = readReceipt(entry);
      if (receipt && receipt.commitmentId === commitmentId) sent[commitmentId] = receipt;
    }
  }
  return { version: HARD_RECEIPT_QUEUE_VERSION, pending, sent };
}

function sameReceipt(left: HardReceipt, right: HardReceipt): boolean {
  return left.commitmentId === right.commitmentId
    && left.notificationId === right.notificationId
    && Date.parse(left.fireAt) === Date.parse(right.fireAt)
    && left.exact === right.exact;
}

/** Drops receipts for reminders more than a day gone. Pure. */
export function pruneHardReceipts(queue: HardReceiptQueue, now: number): HardReceiptQueue {
  const fresh = (receipt: HardReceipt) => now - Date.parse(receipt.fireAt) <= HARD_RECEIPT_MAX_AGE_MS;
  const sent: Record<string, HardReceipt> = {};
  for (const [id, receipt] of Object.entries(queue.sent)) if (fresh(receipt)) sent[id] = receipt;
  return { version: HARD_RECEIPT_QUEUE_VERSION, pending: queue.pending.filter(fresh), sent };
}

/**
 * Replaces the pending receipts with what the engine just reported. Pure.
 *
 * A sync report is the *complete* set of Must stages pending on this device, so
 * it replaces rather than adds: a receipt for a commitment that is no longer in
 * it — moved out of the horizon, acknowledged, cut by the cap — is withdrawn
 * before it can be uploaded, because a receipt is a claim that the phone will
 * ring and that claim is no longer true.
 *
 * One pending receipt per commitment. A receipt identical to the one the server
 * already acknowledged is not queued again.
 *
 * Withdrawing a receipt the server has *already* acknowledged needs the server
 * to be told, which is UC-3.12b's (#198) contract and not a local operation;
 * `sent` is kept as it is here so that step has what it needs.
 */
export function withReceipts(queue: HardReceiptQueue, receipts: readonly HardReceipt[]): HardReceiptQueue {
  const pending: HardReceipt[] = [];
  const seen = new Set<string>();
  for (const receipt of receipts) {
    if (seen.has(receipt.commitmentId)) continue;
    seen.add(receipt.commitmentId);
    const sent = queue.sent[receipt.commitmentId];
    if (sent && sameReceipt(sent, receipt)) continue;
    pending.push(receipt);
  }
  return { version: HARD_RECEIPT_QUEUE_VERSION, pending, sent: queue.sent };
}

/**
 * Moves receipts the server acknowledged out of `pending`. Pure.
 *
 * Only an exact match leaves the queue: a receipt that was replaced by a newer
 * one while the upload was in flight stays pending, so the newer one is
 * uploaded next time rather than lost behind an acknowledgement for the old.
 */
export function withUploaded(queue: HardReceiptQueue, uploaded: readonly HardReceipt[]): HardReceiptQueue {
  const sent: Record<string, HardReceipt> = { ...queue.sent };
  const pending = queue.pending.filter(receipt => {
    const acknowledged = uploaded.find(candidate => sameReceipt(candidate, receipt));
    if (!acknowledged) return true;
    sent[receipt.commitmentId] = receipt;
    return false;
  });
  return { version: HARD_RECEIPT_QUEUE_VERSION, pending, sent };
}

export async function loadHardReceipts(accountId: string): Promise<HardReceiptQueue> {
  try {
    return parseHardReceiptQueue(await AsyncStorage.getItem(hardReceiptStorageKey(accountId)));
  } catch {
    return EMPTY_HARD_RECEIPTS;
  }
}

async function saveHardReceipts(accountId: string, queue: HardReceiptQueue): Promise<boolean> {
  try {
    await AsyncStorage.setItem(hardReceiptStorageKey(accountId), JSON.stringify(queue));
    return true;
  } catch {
    return false;
  }
}

/** Records a sync's receipts, pruning on the way through. */
export async function recordHardReceipts(
  accountId: string,
  receipts: readonly HardReceipt[],
  now: Date,
): Promise<HardReceiptQueue> {
  const next = withReceipts(pruneHardReceipts(await loadHardReceipts(accountId), now.getTime()), receipts);
  await saveHardReceipts(accountId, next);
  return next;
}

/** Called on a 2xx from the receipts endpoint, and only then (#198). */
export async function markHardReceiptsUploaded(
  accountId: string,
  uploaded: readonly HardReceipt[],
): Promise<HardReceiptQueue> {
  const next = withUploaded(await loadHardReceipts(accountId), uploaded);
  await saveHardReceipts(accountId, next);
  return next;
}

export async function clearHardReceipts(accountId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(hardReceiptStorageKey(accountId));
  } catch {
    // Signing out; an unremovable queue is not a reason to stay signed in.
  }
}
