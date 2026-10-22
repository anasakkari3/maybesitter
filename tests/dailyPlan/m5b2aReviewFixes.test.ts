/**
 * M5b-2a Task A inspection r1, server half (Codex M5B2A-REV-004, REV-007).
 * Built on the M5b-2a Gate B harness.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorageRuntimeMemoryStore } from '../../lib/runtimeMemory/runtimeMemoryStore.ts';
import { readPlanMemoryProjection } from '../../lib/services/dailyPlan/planMemoryBasis.ts';
import { assemblePlanResponse } from '../../lib/services/dailyPlan/planDto.ts';
import { composeDailyPlan, memoryFocusForPlan, personalizationPurgeMatches } from '../../lib/services/dailyPlan/dailyPlanService.ts';
import { createStoragePersonalizationConsentStore } from '../../lib/personalizationControls/consentStore.ts';
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

test('R4-001: a plan that resolves the window just as withdrawal begins is refused by the fence the withdrawal moves', async () => {
  const uid = await keptFocusPlan();
  const base = createStoragePersonalizationConsentStore(currentStorage() as any);
  let raced: Awaited<ReturnType<typeof memoryFocusForPlan>> | undefined;
  const consent = {
    ...base,
    read: base.read.bind(base),
    write: async (...args: Parameters<typeof base.write>) => {
      // The last moment a reader can still see consent on: just before the
      // store is disabled.
      if (args[1] === 'disabled' && raced === undefined) raced = await memoryFocusForPlan(uid, NOW(), { storage: currentStorage() as any });
      return base.write(...args);
    },
  };
  await setPersonalizationConsent(uid, { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, { storage: currentStorage() as any, consent: consent as any });
  assert.ok(raced, 'fixture: the racing plan saw no window');
  const user = await currentStorage().get(userDoc(uid));
  assert.equal(personalizationPurgeMatches(user, raced.purgeEpoch), false, 'a plan shaped by the withdrawn window would still be written');
  const later = await memoryFocusForPlan(uid, NOW(), { storage: currentStorage() as any });
  assert.equal(later, null, 'a plan begun after the withdrawal still reads the window');
});

test('R6-002: a memory projection that cannot be read omits the basis instead of failing the plan response', async () => {
  const uid = await keptFocusPlan();
  const stored = await storedPlan(uid);
  const storage = currentStorage() as any;
  const healthy = await assemblePlanResponse(uid, stored, NOW(), new Map(), { storage });
  assert.ok((healthy as any).memoryBasis, 'fixture: no basis to omit');
  const failing = new Proxy(storage, {
    get(target, key) {
      if (key === 'get') return async () => { throw new Error('projection read failed'); };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const dto = await assemblePlanResponse(uid, stored, NOW(), new Map(), { storage: failing });
  assert.equal((dto as any).memoryBasis, undefined);
  assert.equal((dto as any).memoryBasisChanged, undefined);
  assert.equal(dto.date, (healthy as any).date);
  assert.deepEqual(dto.scheduled, (healthy as any).scheduled);
});
