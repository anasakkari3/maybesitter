/**
 * Runs `step` just before the storage's Nth transaction from now, outside it
 * (review of QA wave B8, CA10.5). A request that read consent and then writes
 * is "in flight"; `step` is what lands in between -- a disconnect, a consent
 * flip, an account deletion. Transactions `step` opens itself are not counted.
 */
import { getStorage } from '../../lib/storage/index.ts';

export function beforeTransaction(nth: number, step: () => Promise<void>): () => void {
  const storage = getStorage() as unknown as { runTransaction: (fn: unknown) => Promise<unknown> };
  const original = storage.runTransaction.bind(storage);
  let seen = 0;
  let running = false;
  storage.runTransaction = async (fn: unknown) => {
    if (!running) {
      seen += 1;
      if (seen === nth) {
        running = true;
        try { await step(); } finally { running = false; }
      }
    }
    return original(fn);
  };
  return () => { storage.runTransaction = original; };
}
