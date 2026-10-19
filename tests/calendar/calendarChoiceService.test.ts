import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import {
  BUSY_BLOCKS,
  BUSY_SOURCE_FENCES,
  CALENDAR_CHOICE,
  CALENDAR_SOURCES,
  DEVICE_STALE_STATE,
  PLANNING_STATE_CHANGES,
  PROVIDER_CONNECTIONS,
  REGISTERED_DEVICE_SOURCES,
  RETIRED_DEVICE_SOURCES,
  docIdForKey,
  userCol,
  userSubDoc,
} from '../../lib/storage/paths.ts';
import { BusyUploadError, readBusyBlocksForPlanning, replaceBusyBlocks, setBusyReplacementTestHookForTests, type BusyBlock, type CalendarSource } from '../../lib/calendar/busyBlocks.ts';
import {
  calendarChoiceProbe,
  CalendarChoiceError,
  enrollCalendarChoice,
  finishDeviceUpload,
  registerDeviceSource,
  retireDeviceSource,
  setCalendarChoiceTestHookForTests,
  startSelectionIntent,
  validateSelectionContinuationInTransaction,
} from '../../lib/calendar/calendarChoice.ts';
import { candidateClashes, readFreeSlotSchedule } from '../../lib/planning/freeSlots.ts';
import { newUserDocument } from '../../lib/storage/userDocument.ts';
import type { StorageTransaction } from '../../lib/storage/storageAdapter.ts';
import type { PlanningStateChange } from '../../src/contracts/v1/watcherContracts.ts';
import { GOOGLE_BUSY_SOURCE_ID, GOOGLE_FEATURE_SCOPES } from '../../lib/integrations/google/googleConfig.ts';
import { connectionIdFor } from '../../lib/integrations/providers/production/storedConnectionStore.ts';

function configured() {
  process.env.MAYBESITTER_ENV = 'test';
  process.env.MAYBESITTER_FEATURE_CALENDAR_CHOICE = 'true';
  process.env.MAYBESITTER_KILL_SWITCH_CALENDAR_CHOICE = 'false';
  const storage = createMemoryStorage();
  return storage;
}

async function activePhone(storage: ReturnType<typeof createMemoryStorage>, uid: string) {
  const at = '2026-10-20T00:00:00.000Z';
  await storage.set(`users/${uid}`, newUserDocument(at));
  await storage.set('system/m5aControls', { email: { epoch: 0, enabled: false }, calendar: { epoch: 0, enabled: true } });
  await storage.set(userSubDoc(uid, CALENDAR_CHOICE, 'state'), { v: 1, generation: 1, state: 'active', enrolledAt: at, purge: null });
  const secret = `${randomUUID()}${randomUUID()}`;
  const sourceId = await registerDeviceSource(uid, {
    sourceInstallationId: randomUUID(), sourceSecret: secret, registrationId: randomUUID(),
  }, storage);
  return { sourceId, secret };
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

test('source lifecycle hides a first upload, makes refresh coverage unknown, and activates atomically', async () => {
  const storage = configured();
  const uid = 'choice_lifecycle';
  const { sourceId, secret } = await activePhone(storage, uid);
  const intent = await startSelectionIntent(uid, {
    sourceId, intentId: randomUUID(), operation: 'upload', selectionDigest: 'a'.repeat(64), choiceVersion: 1,
  }, secret, storage);
  const window = { startsAt: '2026-10-20T00:00:00.000Z', endsAt: '2026-10-21T00:00:00.000Z' };
  const busy: BusyBlock = {
    blockId: 'd'.repeat(64), sourceId, sourceKind: 'device',
    startAt: '2026-10-20T10:00:00.000Z', endAt: '2026-10-20T11:00:00.000Z', allDay: false,
  };
  const guard = async (tx: StorageTransaction) => {
    await validateSelectionContinuationInTransaction(tx, uid, sourceId, secret, 'upload', intent.opId, intent.epoch);
  };
  await replaceBusyBlocks(uid, sourceId, window, [busy], { storage, platform: 'ios', transactionGuard: guard });
  const before = await storage.get<CalendarSource>(userSubDoc(uid, CALENDAR_SOURCES, docIdForKey(sourceId)));
  assert.equal(before?.status, 'uploading');
  assert.equal(before?.coverageStatus, 'refreshing');
  assert.deepEqual(await readBusyBlocksForPlanning(uid, window, { storage }), []);
  const unsettled = await readFreeSlotSchedule(uid, window, storage);
  assert.deepEqual(candidateClashes(unsettled, { dueAt: busy.startAt, endAt: busy.endAt, kind: 'scheduled_event' }), {
    state: 'unknown', reason: 'uncovered',
  });

  const completedSource: CalendarSource = {
    sourceId, kind: 'device', platform: 'ios', lastSyncedAt: '2026-10-20T01:00:00.000Z',
    windowStart: window.startsAt, windowEnd: window.endsAt,
  };
  await finishDeviceUpload(uid, sourceId, secret, intent.opId, intent.epoch, completedSource, storage);
  assert.equal((await readBusyBlocksForPlanning(uid, window, { storage })).length, 1);
  const changes = await storage.list<PlanningStateChange & { kind?: string }>(userCol(uid, PLANNING_STATE_CHANGES));
  assert.equal(changes.some(({ data }) => data.kind === 'busy_source_activated' && data.sourceId === sourceId), true);
  const stale = await storage.get<Record<string, unknown>>(userSubDoc(uid, DEVICE_STALE_STATE, docIdForKey(sourceId)));
  assert.equal(stale?.failureStartedAt, null);

  await startSelectionIntent(uid, {
    sourceId, intentId: randomUUID(), operation: 'upload', selectionDigest: 'b'.repeat(64), choiceVersion: 1,
  }, secret, storage);
  const refreshing = await storage.get<CalendarSource>(userSubDoc(uid, CALENDAR_SOURCES, docIdForKey(sourceId)));
  assert.equal(refreshing?.status, 'active');
  assert.equal(refreshing?.coverageStatus, 'refreshing');
  assert.ok(refreshing?.upload);
  const refreshingSchedule = await readFreeSlotSchedule(uid, window, storage);
  assert.equal(candidateClashes(refreshingSchedule, { dueAt: '2026-10-20T12:00:00.000Z', endAt: '2026-10-20T13:00:00.000Z', kind: 'scheduled_event' }).state, 'unknown');
});

test('retirement probe is O(1) and remains revoked beyond twenty-one tombstones', async () => {
  const storage = configured();
  const uid = 'choice_tombstones';
  const { sourceId } = await activePhone(storage, uid);
  await retireDeviceSource(uid, sourceId, storage);
  for (let index = 0; index < 30; index += 1) {
    await storage.set(userSubDoc(uid, RETIRED_DEVICE_SOURCES, `decoy_${String(index).padStart(2, '0')}`), {
      sourceId: `device:decoy-${index}`, retiredAt: new Date().toISOString(),
    });
  }
  assert.equal((await calendarChoiceProbe(uid, sourceId, storage)).sourceStatus, 'revoked');
});

test('enrollment purge lease takeover refuses the late owner and finishes the paged purge', async () => {
  const storage = configured();
  const uid = 'choice_purge_takeover';
  await storage.set(`users/${uid}`, newUserDocument('2026-10-20T00:00:00.000Z'));
  await storage.set('system/m5aControls', { email: { epoch: 0, enabled: false }, calendar: { epoch: 0, enabled: true } });
  await storage.set(userSubDoc(uid, CALENDAR_CHOICE, 'state'), {
    v: 1, generation: 1, state: 'purging', enrolledAt: '2026-10-20T00:00:00.000Z',
    purge: { owner: 'expired', leaseUntil: '2026-10-19T00:00:00.000Z', cursor: null, version: 1 },
  });
  const sourceId = 'device:purge-takeover';
  await storage.set(userSubDoc(uid, CALENDAR_SOURCES, docIdForKey(sourceId)), {
    sourceId, kind: 'device', platform: 'ios', lastSyncedAt: '2026-10-20T00:00:00.000Z',
    windowStart: '2026-10-20T00:00:00.000Z', windowEnd: '2026-10-21T00:00:00.000Z',
  });
  let takeover: Awaited<ReturnType<typeof enrollCalendarChoice>> | null = null;
  setCalendarChoiceTestHookForTests(async (point) => {
    if (point !== 'purge_page_deleted') return;
    setCalendarChoiceTestHookForTests(null);
    const current = await storage.get<any>(userSubDoc(uid, CALENDAR_CHOICE, 'state'));
    await storage.set(userSubDoc(uid, CALENDAR_CHOICE, 'state'), {
      ...current, purge: { ...current.purge, leaseUntil: '2026-10-19T00:00:00.000Z' },
    });
    takeover = await enrollCalendarChoice(uid, storage);
  });
  await assert.rejects(enrollCalendarChoice(uid, storage), (error) => error instanceof CalendarChoiceError && error.code === 'calendar_choice_purging');
  setCalendarChoiceTestHookForTests(null);
  assert.equal((takeover as { state: string } | null)?.state, 'active');
  assert.equal((await storage.list(userCol(uid, BUSY_BLOCKS))).length, 0);
});

test('retirement takeover rotates the delete owner; the former owner cannot finish', async () => {
  const storage = configured();
  const uid = 'choice_retire_takeover';
  const { sourceId } = await activePhone(storage, uid);
  let takeoverDeleted: number | null = null;
  setCalendarChoiceTestHookForTests(async (point) => {
    if (point !== 'retirement_claimed') return;
    setCalendarChoiceTestHookForTests(null);
    const path = userSubDoc(uid, BUSY_SOURCE_FENCES, docIdForKey(sourceId));
    const fence = await storage.get<any>(path);
    await storage.set(path, { ...fence, leaseUntil: '2026-10-19T00:00:00.000Z' });
    takeoverDeleted = await retireDeviceSource(uid, sourceId, storage);
  });
  await assert.rejects(retireDeviceSource(uid, sourceId, storage), (error) => error instanceof CalendarChoiceError && error.code === 'selection_stale');
  setCalendarChoiceTestHookForTests(null);
  assert.equal(takeoverDeleted, 0);
  assert.equal(await storage.get(userSubDoc(uid, REGISTERED_DEVICE_SOURCES, docIdForKey(sourceId))), null);
  assert.equal(await storage.get(userSubDoc(uid, DEVICE_STALE_STATE, docIdForKey(sourceId))), null);
});

test('plain clear marks Google coverage stale so candidateClashes fails closed', async () => {
  const storage = configured();
  const uid = 'choice_google_stale';
  const { sourceId, secret } = await activePhone(storage, uid);
  const window = { startsAt: '2026-10-20T00:00:00.000Z', endsAt: '2026-10-21T00:00:00.000Z' };
  await storage.set(userSubDoc(uid, BUSY_SOURCE_FENCES, docIdForKey(GOOGLE_BUSY_SOURCE_ID)), { generation: 7 });
  await storage.set(userSubDoc(uid, CALENDAR_SOURCES, docIdForKey(GOOGLE_BUSY_SOURCE_ID)), {
    sourceId: GOOGLE_BUSY_SOURCE_ID,
    kind: 'google',
    platform: null,
    lastSyncedAt: '2026-10-20T00:30:00.000Z',
    windowStart: window.startsAt,
    windowEnd: window.endsAt,
    coverageStatus: 'settled',
    m5Certificate: {
      v: 1, choiceGeneration: 1, providerAccountId: 'google-account', fenceGeneration: 7,
      refreshedAt: '2026-10-20T00:30:00.000Z',
    },
  });
  await storage.set(userSubDoc(uid, PROVIDER_CONNECTIONS, connectionIdFor('google')), {
    identity: { provider: 'google', providerAccountId: 'google-account' },
    state: 'connected', credentialRef: 'vault', capabilities: ['calendar_busy'],
    grantedScopes: [GOOGLE_FEATURE_SCOPES.calendar],
  });
  const candidate = { dueAt: '2026-10-20T10:00:00.000Z', endAt: '2026-10-20T11:00:00.000Z', kind: 'scheduled_event' as const };
  assert.deepEqual(candidateClashes(await readFreeSlotSchedule(uid, window, storage), candidate), { state: 'free' });
  await startSelectionIntent(uid, {
    sourceId, intentId: randomUUID(), operation: 'clear', selectionDigest: '0'.repeat(64), choiceVersion: 1,
  }, secret, storage);
  const google = await storage.get<CalendarSource>(userSubDoc(uid, CALENDAR_SOURCES, docIdForKey(GOOGLE_BUSY_SOURCE_ID)));
  assert.equal(google?.coverageStatus, 'stale');
  assert.equal(google?.m5Certificate, undefined);
  assert.equal(candidateClashes(await readFreeSlotSchedule(uid, window, storage), candidate).state, 'unknown');
});

test('revocation and enrollment purge also stale Google coverage before their deletes settle', async () => {
  const window = { startsAt: '2026-10-20T00:00:00.000Z', endsAt: '2026-10-21T00:00:00.000Z' };
  const candidate = { dueAt: '2026-10-20T10:00:00.000Z', endAt: '2026-10-20T11:00:00.000Z', kind: 'scheduled_event' as const };
  const seedGoogle = async (storage: ReturnType<typeof createMemoryStorage>, uid: string, choiceGeneration: number | null) => {
    await storage.set(userSubDoc(uid, BUSY_SOURCE_FENCES, docIdForKey(GOOGLE_BUSY_SOURCE_ID)), { generation: 7 });
    await storage.set(userSubDoc(uid, CALENDAR_SOURCES, docIdForKey(GOOGLE_BUSY_SOURCE_ID)), {
      sourceId: GOOGLE_BUSY_SOURCE_ID, kind: 'google', platform: null,
      lastSyncedAt: '2026-10-20T00:30:00.000Z', windowStart: window.startsAt, windowEnd: window.endsAt,
      coverageStatus: 'settled',
      m5Certificate: { v: 1, choiceGeneration, providerAccountId: 'google-account', fenceGeneration: 7, refreshedAt: '2026-10-20T00:30:00.000Z' },
    });
    await storage.set(userSubDoc(uid, PROVIDER_CONNECTIONS, connectionIdFor('google')), {
      identity: { provider: 'google', providerAccountId: 'google-account' },
      state: 'connected', credentialRef: 'vault', capabilities: ['calendar_busy'],
      grantedScopes: [GOOGLE_FEATURE_SCOPES.calendar],
    });
  };

  const revokeStorage = configured();
  const revokeUid = 'choice_google_stale_revoke';
  const { sourceId } = await activePhone(revokeStorage, revokeUid);
  await seedGoogle(revokeStorage, revokeUid, 1);
  assert.equal(candidateClashes(await readFreeSlotSchedule(revokeUid, window, revokeStorage), candidate).state, 'free');
  let sawRevokingUnknown = false;
  setCalendarChoiceTestHookForTests(async (point) => {
    if (point !== 'retirement_claimed') return;
    const google = await revokeStorage.get<CalendarSource>(userSubDoc(revokeUid, CALENDAR_SOURCES, docIdForKey(GOOGLE_BUSY_SOURCE_ID)));
    assert.equal(google?.coverageStatus, 'stale');
    assert.equal(google?.m5Certificate, undefined);
    sawRevokingUnknown = candidateClashes(await readFreeSlotSchedule(revokeUid, window, revokeStorage), candidate).state === 'unknown';
  });
  await retireDeviceSource(revokeUid, sourceId, revokeStorage);
  setCalendarChoiceTestHookForTests(null);
  assert.equal(sawRevokingUnknown, true);

  const purgeStorage = configured();
  const purgeUid = 'choice_google_stale_purge';
  await purgeStorage.set(`users/${purgeUid}`, newUserDocument('2026-10-20T00:00:00.000Z'));
  await purgeStorage.set('system/m5aControls', { email: { epoch: 0, enabled: false }, calendar: { epoch: 0, enabled: true } });
  await seedGoogle(purgeStorage, purgeUid, null);
  assert.equal(candidateClashes(await readFreeSlotSchedule(purgeUid, window, purgeStorage), candidate).state, 'free');
  await enrollCalendarChoice(purgeUid, purgeStorage);
  const google = await purgeStorage.get<CalendarSource>(userSubDoc(purgeUid, CALENDAR_SOURCES, docIdForKey(GOOGLE_BUSY_SOURCE_ID)));
  assert.equal(google?.coverageStatus, 'stale');
  assert.equal(google?.m5Certificate, undefined);
  assert.equal(candidateClashes(await readFreeSlotSchedule(purgeUid, window, purgeStorage), candidate).state, 'unknown');
});

test('shared replacement fence makes a late ICS refresh lose to the newer owner', async () => {
  const storage = configured();
  const uid = 'choice_ics_replace_fence';
  await storage.set(`users/${uid}`, newUserDocument('2026-10-20T00:00:00.000Z'));
  await storage.set('system/m5aControls', { email: { epoch: 0, enabled: false }, calendar: { epoch: 0, enabled: true } });
  const sourceId = 'ics:concurrent';
  const window = { startsAt: '2026-10-20T00:00:00.000Z', endsAt: '2026-10-21T00:00:00.000Z' };
  const first: BusyBlock = { blockId: '1'.repeat(64), sourceId, sourceKind: 'ics', startAt: '2026-10-20T08:00:00.000Z', endAt: '2026-10-20T09:00:00.000Z', allDay: false };
  const second: BusyBlock = { blockId: '2'.repeat(64), sourceId, sourceKind: 'ics', startAt: '2026-10-20T10:00:00.000Z', endAt: '2026-10-20T11:00:00.000Z', allDay: false };
  setBusyReplacementTestHookForTests(async () => {
    setBusyReplacementTestHookForTests(null);
    await replaceBusyBlocks(uid, sourceId, window, [second], { storage });
  });
  await assert.rejects(
    replaceBusyBlocks(uid, sourceId, window, [first], { storage }),
    (error) => error instanceof BusyUploadError && error.message === 'busy_source_replaced',
  );
  setBusyReplacementTestHookForTests(null);
  const stored = await storage.list<BusyBlock>(userCol(uid, BUSY_BLOCKS));
  assert.deepEqual(stored.map(({ data }) => data.blockId), [second.blockId]);
  const fence = await storage.get<any>(userSubDoc(uid, BUSY_SOURCE_FENCES, docIdForKey(sourceId)));
  assert.equal(fence.replace.version, 2);
});
