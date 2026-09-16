import { beforeEach, describe, expect, it } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  EMPTY_HARD_RECEIPTS,
  HARD_RECEIPT_MAX_AGE_MS,
  clearHardReceipts,
  hardReceiptStorageKey,
  loadHardReceipts,
  markHardReceiptsUploaded,
  parseHardReceiptQueue,
  recordHardReceipts,
  withReceipts,
  withUploaded,
  type HardReceipt,
} from '../hardReceiptQueue';

/**
 * The Must-reminder receipts waiting for the server (UC-3.12a, #197).
 *
 * No date literal is asserted: every instant is NOW plus an offset, so the
 * file means the same thing in any zone and on any day.
 */

const NOW = new Date(Date.UTC(2026, 8, 15, 9, 0));
const A = 'account-a';
const B = 'account-b';

function receipt(id: string, minutes = 120, exact = true): HardReceipt {
  return {
    commitmentId: id,
    notificationId: `${id}:strong`,
    fireAt: new Date(NOW.getTime() + minutes * 60_000).toISOString(),
    exact,
  };
}

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('round trip', () => {
  it('comes back off the device as it went in', async () => {
    await recordHardReceipts(A, [receipt('m1'), receipt('m2', 300, false)], NOW);
    const loaded = await loadHardReceipts(A);
    expect(loaded.pending).toEqual([receipt('m1'), receipt('m2', 300, false)]);
    expect(loaded.sent).toEqual({});
  });

  it('holds ids, instants and a boolean, and nothing else', async () => {
    await recordHardReceipts(A, [{ ...receipt('m1'), title: 'Dentist' } as unknown as HardReceipt], NOW);
    // A key nobody put in the type — a title, say — is not written through
    // parsing, because a parsed receipt is rebuilt field by field.
    const reread = parseHardReceiptQueue(await AsyncStorage.getItem(hardReceiptStorageKey(A)));
    for (const entry of reread.pending) {
      expect(Object.keys(entry).sort()).toEqual(['commitmentId', 'exact', 'fireAt', 'notificationId']);
    }
  });
});

describe('keyed by account', () => {
  it('never shows one account s receipts to another', async () => {
    await recordHardReceipts(A, [receipt('m1')], NOW);
    expect((await loadHardReceipts(B)).pending).toEqual([]);
    await clearHardReceipts(A);
    expect((await loadHardReceipts(A)).pending).toEqual([]);
  });
});

describe('a sync report replaces what is pending', () => {
  it('withdraws a receipt for a Must stage that is no longer pending', () => {
    const queue = withReceipts(EMPTY_HARD_RECEIPTS, [receipt('m1'), receipt('m2')]);
    // m2 was acknowledged, moved out of range, or cut: the phone will not ring.
    expect(withReceipts(queue, [receipt('m1')]).pending).toEqual([receipt('m1')]);
  });

  it('keeps one receipt per commitment, the one the engine reported', () => {
    const moved = withReceipts(withReceipts(EMPTY_HARD_RECEIPTS, [receipt('m1', 120)]), [receipt('m1', 180)]);
    expect(moved.pending).toEqual([receipt('m1', 180)]);
    expect(withReceipts(EMPTY_HARD_RECEIPTS, [receipt('m1', 120), receipt('m1', 180)]).pending)
      .toEqual([receipt('m1', 120)]);
  });
});

describe('uploaded once', () => {
  it('does not queue a receipt identical to the one the server acknowledged', async () => {
    await recordHardReceipts(A, [receipt('m1')], NOW);
    await markHardReceiptsUploaded(A, [receipt('m1')]);
    expect((await loadHardReceipts(A)).pending).toEqual([]);

    // The next sync reports the kept stage again: nothing to upload.
    await recordHardReceipts(A, [receipt('m1')], NOW);
    expect((await loadHardReceipts(A)).pending).toEqual([]);
  });

  it('queues it again when the permission changed', async () => {
    await recordHardReceipts(A, [receipt('m1', 120, false)], NOW);
    await markHardReceiptsUploaded(A, [receipt('m1', 120, false)]);
    await recordHardReceipts(A, [receipt('m1', 120, true)], NOW);
    expect((await loadHardReceipts(A)).pending).toEqual([receipt('m1', 120, true)]);
  });

  it('keeps a receipt that was replaced while its upload was in flight', () => {
    const inFlight = [receipt('m1', 120)];
    const replaced = withReceipts(withReceipts(EMPTY_HARD_RECEIPTS, inFlight), [receipt('m1', 180)]);
    // The 2xx for the old one arrives now.
    const after = withUploaded(replaced, inFlight);
    expect(after.pending).toEqual([receipt('m1', 180)]);
  });

  it('removes nothing that was not acknowledged', () => {
    const queue = withReceipts(EMPTY_HARD_RECEIPTS, [receipt('m1'), receipt('m2')]);
    expect(withUploaded(queue, []).pending).toEqual(queue.pending);
  });
});

describe('what a damaged file reads as', () => {
  it('reads as empty, never as a partial claim', () => {
    for (const raw of [null, '', 'not json', '[]', '{"version":2,"pending":[]}', '{"version":1,"pending":"x"}']) {
      expect(parseHardReceiptQueue(raw).pending).toEqual([]);
    }
  });

  it('drops a row it cannot read and keeps the rest', () => {
    const raw = JSON.stringify({
      version: 1,
      pending: [receipt('m1'), { commitmentId: 'm2', notificationId: 'm2:strong', fireAt: 'soon', exact: true },
        { ...receipt('m3'), exact: 'true' }],
      sent: { m4: receipt('m4'), m5: receipt('not-m5') },
    });
    const parsed = parseHardReceiptQueue(raw);
    expect(parsed.pending).toEqual([receipt('m1')]);
    // A `sent` row filed under the wrong commitment is not trusted either.
    expect(Object.keys(parsed.sent)).toEqual(['m4']);
  });

  it('forgets receipts for reminders more than a day gone', async () => {
    const old = receipt('old', -(HARD_RECEIPT_MAX_AGE_MS / 60_000) - 1);
    await AsyncStorage.setItem(hardReceiptStorageKey(A), JSON.stringify({ version: 1, pending: [], sent: { old } }));
    const queue = await recordHardReceipts(A, [receipt('m1')], NOW);
    expect(queue.sent).toEqual({});
    expect(queue.pending).toEqual([receipt('m1')]);
  });
});
