/**
 * Telling the server which Must reminders this phone will ring (UC-3.12b, #198).
 *
 * The queue (`hardReceiptQueue`) holds what the last engine sync left pending.
 * This drains it: one request with every pending receipt, and only a 2xx moves
 * them to "sent". Anything else leaves them where they are, and the next drain
 * — after the next sync, or when the app comes back to the foreground — tries
 * again. There is no retry loop inside a drain: a request that failed because
 * the phone is offline will fail again a second later, and a 400 would fail for
 * ever.
 *
 * ── What the server does with a receipt that goes stale ──────────
 *
 * Nothing needs withdrawing. A receipt is filed on the server's index row for
 * one reminder at one instant; when that reminder goes away — completed,
 * cancelled, no longer Must, ceiling lowered, opt-in off — the row goes with it
 * and the receipt cannot be read as a reason to do anything. When the start
 * moves, the row is replaced and the old receipt is dropped. A receipt only
 * ever *stands a push down*, so a stale one can at worst describe a push that
 * no longer exists. `hardReminderJob.test.ts` proves each case.
 */
import { postHardReceipts, type HardReceiptUpload } from '../../api/endpoints/reminders';
import { installationId } from '../../lib/installationId';
import {
  loadHardReceipts,
  markHardReceiptsUploaded,
  type HardReceipt,
  type HardReceiptQueue,
} from '../../lib/deviceSettings/hardReceiptQueue';

export type DrainOutcome = 'nothing' | 'uploaded' | 'failed' | 'no_installation';

export interface DrainDeps {
  post(upload: HardReceiptUpload): Promise<unknown>;
  installationId(): Promise<string | null>;
  load(accountId: string): Promise<HardReceiptQueue>;
  markUploaded(accountId: string, receipts: readonly HardReceipt[]): Promise<unknown>;
}

export const defaultDrainDeps: DrainDeps = {
  post: postHardReceipts,
  installationId,
  load: loadHardReceipts,
  markUploaded: markHardReceiptsUploaded,
};

const inFlight = new Map<string, Promise<DrainOutcome>>();

/** Single-flight per account: a second call while one is running joins it. */
export function drainHardReceipts(accountId: string, deps: DrainDeps = defaultDrainDeps): Promise<DrainOutcome> {
  const running = inFlight.get(accountId);
  if (running) return running;
  const run = drain(accountId, deps).finally(() => inFlight.delete(accountId));
  inFlight.set(accountId, run);
  return run;
}

async function drain(accountId: string, deps: DrainDeps): Promise<DrainOutcome> {
  const queue = await deps.load(accountId);
  if (queue.pending.length === 0) return 'nothing';
  const id = await deps.installationId();
  if (!id) return 'no_installation';
  const receipts = [...queue.pending];
  try {
    await deps.post({ installationId: id, receipts });
  } catch {
    return 'failed';
  }
  // Exactly what was sent. A receipt replaced while this was in flight stays
  // pending, and goes on the next drain.
  await deps.markUploaded(accountId, receipts);
  return 'uploaded';
}
