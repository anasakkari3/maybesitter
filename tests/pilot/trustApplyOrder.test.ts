/**
 * Codex M6B-R12-004: two quick trust changes that commit in reverse request
 * order. The later-started one commits first; the earlier-started one, applied
 * after it, is a current action and must not be refused as backdated when the
 * caller asks for apply-time stamping (the mobile trust route does).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { applyTrustAction } from '../../lib/pilot/pilotTrustStore.ts';

const UID = 'trust-order-user';

test.afterEach(() => resetStorageForTests());

test('R12-004: an action whose request began earlier but commits later is applied, stamped at apply time', async () => {
  setStorageForTests(createMemoryStorage());
  const started = '2030-03-29T08:00:00.000Z';
  // The later-started change commits first…
  await applyTrustAction(UID, { type: 'set_calendar_consent', granted: true, at: '2030-03-29T08:00:01.000Z' } as never);
  // …and the earlier-started one, applied now, is not refused.
  const after = await applyTrustAction(UID, { type: 'set_calendar_consent', granted: false, at: started } as never, {
    stampAtApply: true, now: () => new Date('2030-03-29T08:00:02.000Z'),
  });
  assert.equal(after.calendarConsent, false);
  assert.equal(after.updatedAt, '2030-03-29T08:00:02.000Z');
});

test('R12-004 parity: without apply-time stamping, an older action is still refused as backdated', async () => {
  setStorageForTests(createMemoryStorage());
  await applyTrustAction(UID, { type: 'set_calendar_consent', granted: true, at: '2030-03-29T08:00:01.000Z' } as never);
  await assert.rejects(
    applyTrustAction(UID, { type: 'set_calendar_consent', granted: false, at: '2030-03-29T08:00:00.000Z' } as never),
    /backdated/,
  );
});
