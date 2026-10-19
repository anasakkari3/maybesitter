/**
 * M5a Gate B — every new user-scoped collection is registered, exported and
 * classified for personalization deletion exactly as the plan says (PLAN-M5a
 * R3.4, R1.1b; M5A-R3-007, M5A-R9-005, M5A-R40-004, M5A-R55-002,
 * M5A-R56-003, M5A-R57-001, M5A-R59-001, M5A-R48-001, M5A-R49-002).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../../lib/storage/memoryAdapter.ts';
import { createStorageFeedbackEventStore } from '../../../lib/feedback/feedbackEventStore.ts';
import { createStorageRuntimeMemoryStore } from '../../../lib/runtimeMemory/runtimeMemoryStore.ts';

function purgeInput(scopeId: string, storage: ReturnType<typeof createMemoryStorage>) {
  return { scopeId, now: '2026-10-07T07:00:00.000Z', storage, feedbackEvents: createStorageFeedbackEventStore(storage), runtimeMemory: createStorageRuntimeMemoryStore(undefined, storage) } as any;
}

const NEW_COLLECTIONS = {
  INTELLIGENCE_AUTO_ADDS: 'intelligenceAutoAdds',
  CALENDAR_CHOICE: 'calendarChoice',
  BUSY_SOURCE_FENCES: 'busySourceFences',
  REGISTERED_DEVICE_SOURCES: 'registeredDeviceSources',
  RETIRED_DEVICE_SOURCES: 'retiredDeviceSources',
  DEVICE_STALE_STATE: 'deviceStaleState',
} as const;

/** PURGED by personalization deletion vs KEPT (content-free), per the plan. */
const PURGED = ['intelligenceAutoAdds'];
const KEPT = ['calendarChoice', 'busySourceFences', 'registeredDeviceSources', 'retiredDeviceSources', 'deviceStaleState'];

test('R3.4 / R1.1b: each new collection has its named constant and is in USER_SCOPED_COLLECTIONS', async () => {
  const paths = await import('../../../lib/storage/paths.ts') as Record<string, unknown>;
  const scoped = paths.USER_SCOPED_COLLECTIONS as readonly string[];
  for (const [constant, name] of Object.entries(NEW_COLLECTIONS)) {
    assert.equal(paths[constant], name, `${constant} is not exported as '${name}'`);
    assert.ok(scoped.includes(name), `${name} is not in USER_SCOPED_COLLECTIONS`);
  }
});

test('R3.4 / M5A-R57-001: personalization deletion purges auto-add records and keeps the content-free calendar state', async () => {
  const { deletePersonalizationScope } = await import('../../../lib/personalization/deletion.ts');
  const storage = createMemoryStorage();
  const uid = 'user_m5a_purge';
  for (const name of [...PURGED, ...KEPT]) {
    await storage.set(`users/${uid}/${name}/doc1`, { marker: name });
  }
  await deletePersonalizationScope(purgeInput(uid, storage));
  for (const name of PURGED) {
    assert.equal((await storage.list(`users/${uid}/${name}`)).length, 0, `${name} survived the personalization purge`);
  }
  for (const name of KEPT) {
    assert.equal((await storage.list(`users/${uid}/${name}`)).length, 1, `${name} was purged but the plan keeps it`);
  }
});

test('M5A-R49-002: the purge holds a durable purging barrier and ends active', async () => {
  const { deletePersonalizationScope } = await import('../../../lib/personalization/deletion.ts');
  const storage = createMemoryStorage();
  const uid = 'user_m5a_barrier';
  await storage.set(`users/${uid}`, { schemaVersion: 1 });
  await deletePersonalizationScope(purgeInput(uid, storage));
  const user = await storage.get<any>(`users/${uid}`);
  assert.equal(user?.personalizationPurge?.state, 'active', 'no active post-purge barrier state');
  assert.ok(Number.isSafeInteger(user?.personalizationPurge?.epoch) && user.personalizationPurge.epoch >= 1, 'the purge epoch did not advance');
});

test('M5A-R55-002: account export never includes a device secret hash', async () => {
  const exportModule = await import('../../../lib/account/accountExport.ts') as Record<string, any>;
  const storage = createMemoryStorage();
  const uid = 'user_m5a_export';
  await storage.set(`users/${uid}`, { schemaVersion: 1 });
  await storage.set(`users/${uid}/registeredDeviceSources/abc`, { sourceInstallationId: 'inst-1', secretHash: 'deadbeef', secretVersion: 1, state: 'active' });
  const exported = await exportModule.buildAccountExport(uid, { storage });
  assert.match(JSON.stringify(exported), /inst-1/, 'registeredDeviceSources is not exported at all');
  assert.doesNotMatch(JSON.stringify(exported), /deadbeef/, 'the export contains a secret hash');
});
