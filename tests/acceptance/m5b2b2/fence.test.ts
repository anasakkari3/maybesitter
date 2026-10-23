/**
 * M5b-2b-2 Gate B, R1/R2 Server: the personalization fence and purges (the
 * epoch captured before any read and re-checked in each marker transaction,
 * a purge or a withdrawal racing the scan, a fence already closed, outcomes
 * from before the latest completed purge, and the purge removing markers).
 * PLAN-M5b-2b-2 R1 "Fence first", R2 "Purge and deletion", REV-001. See
 * support.ts for the harness and the gate rules.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { deletePersonalizationScope } from '../../../lib/personalization/deletion.ts';
import { createStorageFeedbackEventStore } from '../../../lib/feedback/feedbackEventStore.ts';
import { createStorageRuntimeMemoryStore } from '../../../lib/runtimeMemory/runtimeMemoryStore.ts';
import { listObservations } from '../../../lib/intelligence/observationStore.ts';
import {
  DAY_MS, NOW, begin, confirmAt, currentStorage, daysAgo, dropAt, droppedThenReadded, end, epochOf, inboxH, isMarker,
  learn, markerFor, markers, markersFor, plusMinutes, scan, setFence, show, spyStorage, withStorage,
} from './support.ts';

test.afterEach(() => end());

function purge(uid: string, now: string) {
  const storage = currentStorage() as any;
  return deletePersonalizationScope({
    scopeId: uid,
    now,
    storage,
    feedbackEvents: createStorageFeedbackEventStore(storage),
    runtimeMemory: createStorageRuntimeMemoryStore(undefined, storage),
  });
}

/**
 * A storage that runs `move` once, right after the scan's re-add outcome read
 * (the `observedAt >= now − 60 days` query: after the epoch was captured,
 * before any marker transaction), or failing that at the marker transaction's
 * first read of a marker path.
 */
function movingFenceAt(uid: string, move: () => Promise<void>): { proxy: any; fired: () => boolean } {
  let fired = false;
  const once = async () => { if (!fired) { fired = true; await move(); } };
  const proxy = spyStorage(currentStorage(), {
    afterRead: async (method, path, _result, options) => {
      if (!method.endsWith('list') || path !== `users/${uid}/intelligenceObservations`) return;
      const clause = (options?.where ?? []).find((where: any[]) => where[0] === 'observedAt' && where[1] === '>=');
      if (clause && Date.parse(clause[2]) <= Date.now() - 30 * DAY_MS) await once();
    },
    onRead: async (method, path) => {
      if (method === 'tx.get' && typeof path === 'string' && path.includes('/intelligenceObservations/')) {
        const row = await currentStorage().get<any>(path);
        if (row === null && /\/intelligenceObservations\/[a-f0-9]{64}$/.test(path)) {
          // The first read of an empty observation path inside a transaction:
          // the marker write's create-if-absent check.
          await once();
        }
      }
    },
  });
  return { proxy, fired: () => fired };
}

for (const [name, fence] of [
  ['a purge (the epoch raised and reopened)', (epoch: number) => ({ state: 'active', epoch: epoch + 1 })],
  ['a withdrawal (withdrawing)', (epoch: number) => ({ state: 'withdrawing', epoch })],
] as const) {
  test(`R1 fence: ${name} between the epoch capture and the marker write leaves no marker`, async () => {
    const uid = await begin();
    const control = await droppedThenReadded(uid, 'Pay the water bill');
    await scan(uid);
    await markerFor(uid, control.c, 'control: the scan wrote no re-add marker');
    const d = await dropAt(uid, 'Email the school', daysAgo(2));
    await learn(uid);
    const c = await confirmAt(uid, 'Email the school', plusMinutes(NOW(), -30));
    const epoch = await epochOf(uid);
    const { proxy, fired } = movingFenceAt(uid, () => setFence(uid, fence(epoch)));
    await withStorage(proxy, () => scan(uid, proxy));
    assert.ok(fired(), 'the scan never reached the re-add outcome read or a marker write');
    assert.deepEqual(await markersFor(uid, c), [], `a marker was written across ${name}`);
    assert.ok(d);
  });
}

for (const state of ['purging', 'withdrawing'] as const) {
  test(`R1 fence first: with the fence ${state} before the scan, the pass writes nothing; once active again at the same epoch it does`, async () => {
    const uid = await begin();
    const { c } = await droppedThenReadded(uid, 'Renew the gym card');
    const epoch = await epochOf(uid);
    await setFence(uid, { state, epoch });
    await scan(uid);
    const closed = await markersFor(uid, c);
    await setFence(uid, { state: 'active', epoch });
    await scan(uid);
    await markerFor(uid, c, 'control: with the fence active again the scan wrote no marker');
    assert.deepEqual(closed, [], `a marker was written while the fence was ${state}`);
  });
}

test('REV-001: an old event re-learned as an outcome after a purge supports no re-add; a drop after the purge does', async () => {
  const uid = await begin();
  await dropAt(uid, 'Call the old landlord', daysAgo(2));
  await learn(uid);
  await purge(uid, plusMinutes(NOW(), -30));
  await dropAt(uid, 'Call the new landlord', plusMinutes(NOW(), -20));
  const oldC = await confirmAt(uid, 'Call the old landlord', plusMinutes(NOW(), -10));
  const newC = await confirmAt(uid, 'Call the new landlord', plusMinutes(NOW(), -10));
  await inboxH(uid);
  const rows = await listObservations(uid, currentStorage() as any);
  assert.ok(rows.some((row) => row.evidence === 'Dropped: Call the old landlord'), 'fixture: the outcome pass did not re-create the old outcome after the purge');
  await markerFor(uid, newC, 'control: a drop after the purge supported no re-add');
  assert.deepEqual(await markersFor(uid, oldC), [], 'an outcome observed before the latest completed purge supported a re-add');
});

test('R2 purge: no marker remains after deletePersonalizationScope, and none comes back on the next read', async () => {
  const uid = await begin();
  const { c } = await droppedThenReadded(uid, 'Book the eye test');
  await scan(uid);
  await markerFor(uid, c);
  await purge(uid, NOW());
  assert.deepEqual(await markers(uid), [], `markers survived the purge: ${show(await markers(uid))}`);
  const body = await inboxH(uid);
  assert.equal((body.observations ?? []).some((row: any) => isMarker(row) || 'readd' in row), false, show(body.observations));
  assert.deepEqual(await markers(uid), [], 'the next read re-created a marker from an outcome observed before the purge');
});
