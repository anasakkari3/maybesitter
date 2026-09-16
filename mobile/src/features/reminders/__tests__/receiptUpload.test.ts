import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NetworkError } from '../../../api/errors';
import {
  loadHardReceipts,
  markHardReceiptsUploaded,
  recordHardReceipts,
  type HardReceipt,
} from '../../../lib/deviceSettings/hardReceiptQueue';
import { drainHardReceipts, type DrainDeps } from '../receiptUpload';

/**
 * Draining the Must-reminder receipts to the server (UC-3.12b, #198): they
 * leave the queue on a 2xx and on nothing else.
 */
const ACCOUNT = 'drain-account';
const PHONE = '11111111-1111-4111-8111-111111111111';
const NOW = new Date(Date.UTC(2026, 8, 16, 6));

function receipt(id: string, exact = true): HardReceipt {
  return { commitmentId: id, notificationId: `${id}:strong`, fireAt: new Date(NOW.getTime() + 3_600_000).toISOString(), exact };
}

function deps(post: DrainDeps['post'], phone: string | null = PHONE): DrainDeps & { post: jest.Mock } {
  return {
    post: jest.fn(post) as unknown as jest.Mock & DrainDeps['post'],
    installationId: async () => phone,
    load: loadHardReceipts,
    markUploaded: markHardReceiptsUploaded,
  } as DrainDeps & { post: jest.Mock };
}

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('draining the receipt queue', () => {
  it('sends every pending receipt with this phone s installation id, and clears them on a 2xx', async () => {
    await recordHardReceipts(ACCOUNT, [receipt('m1'), receipt('m2', false)], NOW);
    const d = deps(async () => ({ success: true, accepted: 2, ignored: 0 }));
    expect(await drainHardReceipts(ACCOUNT, d)).toBe('uploaded');
    expect(d.post).toHaveBeenCalledWith({ installationId: PHONE, receipts: [receipt('m1'), receipt('m2', false)] });
    expect((await loadHardReceipts(ACCOUNT)).pending).toEqual([]);

    // The next sync reports the same stages: nothing new to send.
    await recordHardReceipts(ACCOUNT, [receipt('m1'), receipt('m2', false)], NOW);
    expect(await drainHardReceipts(ACCOUNT, d)).toBe('nothing');
    expect(d.post).toHaveBeenCalledTimes(1);
  });

  it('keeps them on a network error, and on a refusal', async () => {
    for (const failure of [new NetworkError('offline'), new Error('400')]) {
      await AsyncStorage.clear();
      await recordHardReceipts(ACCOUNT, [receipt('m1')], NOW);
      const d = deps(async () => {
        throw failure;
      });
      expect(await drainHardReceipts(ACCOUNT, d)).toBe('failed');
      expect((await loadHardReceipts(ACCOUNT)).pending).toEqual([receipt('m1')]);
    }
  });

  it('asks nothing of the server when there is nothing to say, or no installation to say it for', async () => {
    const empty = deps(async () => ({}));
    expect(await drainHardReceipts(ACCOUNT, empty)).toBe('nothing');
    expect(empty.post).not.toHaveBeenCalled();

    await recordHardReceipts(ACCOUNT, [receipt('m1')], NOW);
    const nobody = deps(async () => ({}), null);
    expect(await drainHardReceipts(ACCOUNT, nobody)).toBe('no_installation');
    expect(nobody.post).not.toHaveBeenCalled();
  });

  it('sends one request when drains overlap', async () => {
    await recordHardReceipts(ACCOUNT, [receipt('m1')], NOW);
    let release: () => void = () => {};
    const d = deps(() => new Promise(resolve => {
      release = () => resolve({});
    }));
    const first = drainHardReceipts(ACCOUNT, d);
    const second = drainHardReceipts(ACCOUNT, d);
    await new Promise(resolve => setTimeout(resolve, 0));
    release();
    await Promise.all([first, second]);
    expect(d.post).toHaveBeenCalledTimes(1);
  });
});
