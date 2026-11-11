/**
 * The monthly spend ledger (owner direction, 2026-11-10).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import { monthKey, nextMonthStart, readMonthSpend, recordFeatureSpend } from '../../lib/features/spendLedger.ts';

const NOV = new Date('2026-11-10T21:00:00.000Z');

test('spend adds per feature and in total within one UTC month', async () => {
  const storage = createMemoryStorage();
  await recordFeatureSpend('u1', 'gmail_reading', 2_100_000, { storage, now: NOV });
  await recordFeatureSpend('u1', 'gmail_reading', 900_000, { storage, now: NOV });
  await recordFeatureSpend('u1', 'assistant', 500_000, { storage, now: NOV });
  const month = await readMonthSpend('u1', { storage, now: NOV });
  assert.equal(month.month, '2026-11');
  assert.equal(month.totalNanoUsd, 3_500_000);
  assert.deepEqual(month.features, { gmail_reading: 3_000_000, assistant: 500_000 });
  assert.equal(month.expireAt, '2027-01-01T00:00:00.000Z');
});

test('a new UTC month starts at zero and users never share a ledger', async () => {
  const storage = createMemoryStorage();
  await recordFeatureSpend('u1', 'assistant', 1_000, { storage, now: new Date('2026-11-30T23:59:59.000Z') });
  const december = await readMonthSpend('u1', { storage, now: new Date('2026-12-01T00:00:00.000Z') });
  assert.equal(december.totalNanoUsd, 0);
  assert.equal((await readMonthSpend('u2', { storage, now: NOV })).totalNanoUsd, 0);
  assert.equal(monthKey(new Date('2026-12-31T23:59:59.999Z')), '2026-12');
  assert.equal(nextMonthStart(new Date('2026-12-15T00:00:00.000Z')).toISOString(), '2027-01-01T00:00:00.000Z');
});

test('zero, negative and non-finite amounts write nothing', async () => {
  const storage = createMemoryStorage();
  for (const amount of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
    await recordFeatureSpend('u1', 'assistant', amount, { storage, now: NOV });
  }
  assert.equal((await readMonthSpend('u1', { storage, now: NOV })).totalNanoUsd, 0);
});

test('a failed write is swallowed; a failed read is not', async () => {
  const broken = {
    runTransaction: async () => { throw new Error('contention'); },
    get: async () => { throw new Error('offline'); },
  } as unknown as StorageAdapter;
  const original = console.error;
  const logged: string[] = [];
  console.error = (line: string) => { logged.push(line); };
  try {
    await recordFeatureSpend('u1', 'assistant', 1_000, { storage: broken, now: NOV });
  } finally {
    console.error = original;
  }
  assert.deepEqual(logged, ['[features/spend] record failed: Error']);
  await assert.rejects(readMonthSpend('u1', { storage: broken, now: NOV }), /offline/);
});
