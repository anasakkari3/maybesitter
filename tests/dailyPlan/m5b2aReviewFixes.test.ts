/**
 * M5b-2a Task A inspection r1, server half (Codex M5B2A-REV-004, REV-007).
 * Built on the M5b-2a Gate B harness.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorageRuntimeMemoryStore } from '../../lib/runtimeMemory/runtimeMemoryStore.ts';
import { readPlanMemoryProjection } from '../../lib/services/dailyPlan/planMemoryBasis.ts';
import { composeDailyPlan } from '../../lib/services/dailyPlan/dailyPlanService.ts';
import { setPersonalizationConsent, PERSONALIZATION_CONSENT_VERSION } from '../../lib/consents/personalizationConsentService.ts';
import { userDoc } from '../../lib/storage/paths.ts';
import {
  NOW, TODAY, TZ, begin, buildPlan, call, currentStorage, end, grantPersonalization, outcomeObservation, show, storedPlan, threeTasks,
} from '../acceptance/m5b2a/support.ts';

test.afterEach(() => end());

async function keptFocusPlan(): Promise<string> {
  const uid = await begin();
  await grantPersonalization(uid);
  await threeTasks(uid);
  await createStorageRuntimeMemoryStore(undefined, currentStorage() as any).put({
    scopeId: uid, kind: 'preference', content: 'You often finish things between 09:00 and 12:00.', language: 'en',
    source: 'deterministic_rule', confidence: 0.7, observedAt: NOW(), evidenceIds: ['ev1', 'ev2'],
    provenance: { origin: 'behaviour_rule', originRef: 'R1_focus_window:09:00-12:00', confirmedByUserAt: NOW() },
  } as any, NOW());
  const built = await buildPlan(uid);
  assert.ok(built.memoryBasis, 'fixture: no basis');
  return uid;
}

test('REV-004: a purge that begins between the two reads of the projection shows no basis', async () => {
  const uid = await keptFocusPlan();
  const stored = await storedPlan(uid);
  const real = currentStorage() as any;
  let userReads = 0;
  const racing = new Proxy(real, {
    get(target, key) {
      if (key !== 'get') return Reflect.get(target, key);
      return async (path: string) => {
        const value = await target.get(path);
        if (path !== userDoc(uid)) return value;
        userReads += 1;
        // The second read of the user document sees a purge that began after the first.
        return userReads >= 2 ? { ...(value ?? {}), personalizationPurge: { state: 'purging', epoch: 1, startedAt: NOW() } } : value;
      };
    },
  });
  const projection = await readPlanMemoryProjection(uid, stored, NOW(), racing);
  assert.ok(userReads >= 2, 'fixture: the projection read the user document once');
  assert.equal(projection.memoryBasis, null, show(projection));
});

test('REV-007: an outcome whose title spans lines still gets its signal and title', async () => {
  const uid = await begin();
  const multi = await outcomeObservation(uid, 'Completed: First line\nsecond line', '0e0e0e0e-0000-4000-8000-000000000099');
  const inbox = await call(uid, 'intelligence', 'GET');
  assert.equal(inbox.status, 200, show(inbox.body));
  const row = inbox.body.observations.find((item: any) => item.id === multi.id);
  assert.deepEqual(row.outcome, { signal: 'completed', title: 'First line\nsecond line' });
});

test('R2-001: withdrawing personalization consent moves the fence, so a plan that read the window before it writes no memory marker', async () => {
  const uid = await keptFocusPlan();
  const before = ((await currentStorage().get<Record<string, any>>(userDoc(uid))) ?? {}).personalizationPurge?.epoch ?? 0;
  let fired = false;
  const stored = await composeDailyPlan(uid, TODAY, { timezone: TZ }, 2, {
    storage: currentStorage() as any,
    now: () => new Date(),
    busyBlocks: async () => {
      if (!fired) {
        fired = true;
        await setPersonalizationConsent(uid, { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, { storage: currentStorage() as any });
      }
      return [];
    },
  } as any);
  assert.ok(fired, 'fixture: the busy read never ran');
  const after = ((await currentStorage().get<Record<string, any>>(userDoc(uid))) ?? {}).personalizationPurge?.epoch ?? 0;
  assert.equal(after, before + 1, 'the withdrawal did not move the fence');
  assert.equal((stored as any).focusFromMemory, false, show((stored as any).focusFromMemory));
});
