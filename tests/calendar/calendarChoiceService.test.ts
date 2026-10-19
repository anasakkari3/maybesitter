import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { BUSY_BLOCKS, BUSY_SOURCE_FENCES, CALENDAR_CHOICE, REGISTERED_DEVICE_SOURCES, docIdForKey, userSubDoc } from '../../lib/storage/paths.ts';
import { replaceBusyBlocks, type BusyBlock } from '../../lib/calendar/busyBlocks.ts';
import {
  CalendarChoiceError,
  enrollCalendarChoice,
  registerDeviceSource,
  retireDeviceSource,
  startSelectionIntent,
  validateSelectionContinuationInTransaction,
} from '../../lib/calendar/calendarChoice.ts';

function configured() {
  process.env.MAYBESITTER_ENV = 'test';
  process.env.MAYBESITTER_FEATURE_CALENDAR_CHOICE = 'true';
  process.env.MAYBESITTER_KILL_SWITCH_CALENDAR_CHOICE = 'false';
  const storage = createMemoryStorage();
  return storage;
}

test('calendar enrollment purges orphan device rows, then registration and retirement are permanent', async () => {
  const storage = configured();
  const uid = 'choice_unit';
  await storage.set(`users/${uid}`, { schemaVersion: 1 });
  await storage.set('system/m5aControls', { email: { epoch: 0, enabled: false }, calendar: { epoch: 0, enabled: true } });
  const orphanBlockId = 'a'.repeat(64);
  await storage.set(userSubDoc(uid, BUSY_BLOCKS, docIdForKey(`device:orphan\u001f${orphanBlockId}`)), {
    blockId: orphanBlockId, sourceId: 'device:orphan', sourceKind: 'device',
    startAt: '2026-10-20T10:00:00.000Z', endAt: '2026-10-20T11:00:00.000Z', allDay: false,
  });
  assert.equal((await enrollCalendarChoice(uid, storage)).state, 'active');
  assert.equal((await storage.list(`users/${uid}/${BUSY_BLOCKS}`)).length, 0);
  const installation = randomUUID();
  const secret = `${randomUUID()}${randomUUID()}`;
  const sourceId = await registerDeviceSource(uid, { sourceInstallationId: installation, sourceSecret: secret, registrationId: randomUUID() }, storage);
  await retireDeviceSource(uid, sourceId, storage);
  await assert.rejects(
    registerDeviceSource(uid, { sourceInstallationId: installation, sourceSecret: secret, registrationId: randomUUID() }, storage),
    (error) => error instanceof CalendarChoiceError && error.code === 'source_revoked',
  );
});

test('a paused upload chunk cannot commit after a newer selection fence wins', async () => {
  const storage = configured();
  const uid = 'choice_race';
  const sourceId = 'device:race';
  const secret = `${randomUUID()}${randomUUID()}`;
  await storage.set(`users/${uid}`, { schemaVersion: 1 });
  await storage.set('system/m5aControls', { email: { epoch: 0, enabled: false }, calendar: { epoch: 0, enabled: true } });
  await storage.set(userSubDoc(uid, CALENDAR_CHOICE, 'state'), { v: 1, generation: 1, state: 'active', enrolledAt: new Date().toISOString(), purge: null });
  await storage.set(userSubDoc(uid, REGISTERED_DEVICE_SOURCES, docIdForKey(sourceId)), {
    sourceId, sourceInstallationId: randomUUID(), secretHash: createHash('sha256').update(secret).digest('hex'),
    secretVersion: 1, state: 'active', registeredAt: new Date().toISOString(),
  });
  const old = await startSelectionIntent(uid, { sourceId, intentId: randomUUID(), operation: 'upload', selectionDigest: 'a'.repeat(64), choiceVersion: 1 }, secret, storage);
  let fired = false;
  storage.setBeforeCommitHookForTests(async () => {
    if (fired) return;
    fired = true;
    await storage.set(userSubDoc(uid, BUSY_SOURCE_FENCES, docIdForKey(sourceId)), {
      generation: 1, currentEpoch: old.epoch + 1, intentId: randomUUID(), opId: randomUUID(),
      operation: 'upload', selectionDigest: 'b'.repeat(64), leaseUntil: new Date(Date.now() + 120_000).toISOString(),
    });
  });
  const block: BusyBlock = { blockId: 'c'.repeat(64), sourceId, sourceKind: 'device', startAt: '2026-10-20T10:00:00.000Z', endAt: '2026-10-20T11:00:00.000Z', allDay: false };
  await assert.rejects(replaceBusyBlocks(uid, sourceId, { startsAt: '2026-10-20T00:00:00.000Z', endsAt: '2026-10-21T00:00:00.000Z' }, [block], {
    storage,
    transactionGuard: async (tx) => { await validateSelectionContinuationInTransaction(tx, uid, sourceId, secret, 'upload', old.opId, old.epoch); },
  }), (error) => error instanceof CalendarChoiceError && error.code === 'selection_stale');
  storage.setBeforeCommitHookForTests(null);
  assert.equal((await storage.list(`users/${uid}/${BUSY_BLOCKS}`)).length, 0);
});
