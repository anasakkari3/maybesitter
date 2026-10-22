/**
 * M5b-2a Task A inspection r1, server half (Codex M5B2A-REV-004, REV-007).
 * Built on the M5b-2a Gate B harness.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorageRuntimeMemoryStore } from '../../lib/runtimeMemory/runtimeMemoryStore.ts';
import { readPlanMemoryProjection } from '../../lib/services/dailyPlan/planMemoryBasis.ts';
import { assemblePlanResponse } from '../../lib/services/dailyPlan/planDto.ts';
import { buildDailyPlanOnDemand, composeDailyPlan, memoryFocusForPlan, personalizationPurgeMatches } from '../../lib/services/dailyPlan/dailyPlanService.ts';
import { acceptPlan } from '../../lib/services/dailyPlan/planActions.ts';
import { processStateChangesForUser } from '../../lib/services/dailyPlan/continuousReplanService.ts';
import { PlanWriteGuardRejected, planPath } from '../../lib/services/dailyPlan/planStore.ts';
import { acceptWeekDay, composeWeek } from '../../lib/services/dailyPlan/weekPlan.ts';
import { createStoragePersonalizationConsentStore } from '../../lib/personalizationControls/consentStore.ts';
import { fencedPersonalizationConsentStore, setPersonalizationConsent, PersonalizationWithdrawalBusyError, PERSONALIZATION_CONSENT_VERSION } from '../../lib/consents/personalizationConsentService.ts';
import { readFileSync } from 'node:fs';
import { POST as personalizationControlsPost } from '../../src/app/api/personalization/route.ts';
import { userDoc } from '../../lib/storage/paths.ts';
import { setStorageForTests } from '../../lib/storage/index.ts';
import {
  AUTO_APPLY, NOW, REVIEW, TODAY, TZ, addFloating, begin, buildPlan, call, currentStorage, end,
  getPlan, grantPersonalization, meetingLands, outcomeObservation, replan, setAccount, show, storedPlan, threeTasks, touchPlan,
} from '../acceptance/m5b2a/support.ts';

test.afterEach(() => end());

async function keptFocusPlan(): Promise<string> {
  const uid = await begin();
  await grantPersonalization(uid);
  await threeTasks(uid);
  await storeKeptFocus(uid);
  const built = await buildPlan(uid);
  assert.ok(built.memoryBasis, 'fixture: no basis');
  return uid;
}

async function storeKeptFocus(uid: string, originRef = 'R1_focus_window:09:00-12:00'): Promise<void> {
  await createStorageRuntimeMemoryStore(undefined, currentStorage() as any).put({
    scopeId: uid, kind: 'preference', content: 'You often finish things between 09:00 and 12:00.', language: 'en',
    source: 'deterministic_rule', confidence: 0.7, observedAt: NOW(), evidenceIds: ['ev1', 'ev2'],
    provenance: { origin: 'behaviour_rule', originRef, confirmedByUserAt: NOW() },
  } as any, NOW());
}

async function offModeFocusAccount(originRef?: string): Promise<string> {
  const uid = await begin({ on: false });
  await grantPersonalization(uid);
  await threeTasks(uid);
  await storeKeptFocus(uid, originRef);
  return uid;
}

function workingWindows(stored: any): number[][] {
  return stored.constraints.workingWindows.map((window: any) => [window.startMinute, window.endMinute]);
}

async function makeSuppressedWindowMatchKeptWindow(uid: string): Promise<void> {
  await setAccount(uid, { profile: { routine: {
    schemaVersion: 1,
    updatedAt: NOW(),
    timezone: TZ,
    sleepWindow: { start: '12:00', end: '09:00' },
    focusWindows: [],
    fixedCommitmentWindows: [],
    preferredReminderIntensity: 'followUp',
    quietHours: null,
    surveySkipped: false,
  } } });
}

async function replanWithWithdrawalAtWrite(
  uid: string,
  policyConfig: Record<string, unknown>,
  interval: { startsAt: string; endsAt: string },
  blockId: string,
): Promise<any> {
  const change = await meetingLands(uid, interval, blockId);
  const real = currentStorage() as any;
  let armed = false;
  let withdrew = false;
  const storage = new Proxy(real, {
    get(target, key) {
      if (key === 'runTransaction') {
        return async (fn: (tx: any) => Promise<unknown>) => {
          return target.runTransaction((tx: any) => fn(new Proxy(tx, {
            get(inner, property) {
              const member = Reflect.get(inner, property);
              if (property === 'get' && typeof member === 'function') {
                return async (path: string, ...rest: unknown[]) => {
                  if (path === planPath(uid, TODAY)) armed = true;
                  const value = await member.call(inner, path, ...rest);
                  if (path === userDoc(uid) && armed && !withdrew) {
                    withdrew = true;
                    const epoch = (value?.personalizationPurge?.epoch ?? 0) + 1;
                    return { ...(value ?? {}), personalizationPurge: { state: 'withdrawing', epoch } };
                  }
                  return value;
                };
              }
              return typeof member === 'function' ? member.bind(inner) : member;
            },
          })));
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const report = await processStateChangesForUser(uid, {
    storage,
    now: new Date(),
    date: TODAY,
    changes: [change],
    entityFactsByChangeId: new Map([[change.changeId, { interval, blocking: true }]]) as any,
    policyConfig: policyConfig as any,
  });
  assert.ok(withdrew, 'fixture: withdrawal never landed at the replan write');
  return report;
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
  assert.notEqual(raced, undefined, 'fixture: the racing plan never ran');
  // Since R7-001 the closed fence gives it no window at all; either way, a
  // plan shaped by the withdrawn window is never written.
  const user = await currentStorage().get(userDoc(uid));
  assert.ok(raced === null || !personalizationPurgeMatches(user, raced!.purgeEpoch), 'a plan shaped by the withdrawn window would still be written');
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

test('R7-001: between the phases of a withdrawal nothing reads the kept window, shows its basis, or writes with the old epoch', async () => {
  const uid = await keptFocusPlan();
  const storage = currentStorage() as any;
  const stored = await storedPlan(uid);
  const oldEpoch = ((await storage.get(userDoc(uid))) ?? {}).personalizationPurge?.epoch ?? 0;
  const base = createStoragePersonalizationConsentStore(storage);
  const seen: Record<string, unknown> = {};
  const consent = {
    ...base,
    read: base.read.bind(base),
    write: async (...args: Parameters<typeof base.write>) => {
      if (args[1] !== 'disabled') return base.write(...args);
      // Just before the store is disabled: consent still reads on.
      seen.focusBefore = await memoryFocusForPlan(uid, NOW(), { storage });
      seen.basisBefore = (await readPlanMemoryProjection(uid, stored, NOW(), storage)).memoryBasis;
      const written = await base.write(...args);
      // Just after it, before the fence reopens: a plan that read the window
      // earlier tries its guarded write.
      seen.oldEpochWrites = personalizationPurgeMatches(await storage.get(userDoc(uid)), oldEpoch);
      return written;
    },
  };
  await setPersonalizationConsent(uid, { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, { storage, consent: consent as any });
  assert.equal(seen.focusBefore, null, 'a plan read the kept window during the withdrawal');
  assert.equal(seen.basisBefore, null, 'a basis was shown during the withdrawal');
  assert.equal(seen.oldEpochWrites, false, 'a plan that read the window before the withdrawal could still write');
  const fence = ((await storage.get(userDoc(uid))) ?? {}).personalizationPurge;
  assert.equal(fence?.state, 'active', 'the fence did not reopen');
  assert.equal(fence?.epoch, oldEpoch + 1);
});

test('R7-001: a withdrawal whose store write fails still reopens the fence at the moved epoch', async () => {
  const uid = await keptFocusPlan();
  const storage = currentStorage() as any;
  const oldEpoch = ((await storage.get(userDoc(uid))) ?? {}).personalizationPurge?.epoch ?? 0;
  const base = createStoragePersonalizationConsentStore(storage);
  const consent = { ...base, read: base.read.bind(base), write: async () => { throw new Error('store unavailable'); } };
  await assert.rejects(setPersonalizationConsent(uid, { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, { storage, consent: consent as any }));
  const fence = ((await storage.get(userDoc(uid))) ?? {}).personalizationPurge;
  assert.deepEqual([fence?.state, fence?.epoch], ['active', oldEpoch + 1]);
});

/** The same storage, with every read of the runtime-memory collection failing: only the optional projection reads it on these paths. */
function memoryUnreadable(storage: any): any {
  const failing = (path: unknown) => typeof path === 'string' && /\/memory(\/|$)/.test(path);
  return new Proxy(storage, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (key === 'list' || key === 'listGroup') {
        return async (path: unknown, ...rest: unknown[]) => {
          if (failing(path) || key === 'listGroup') throw new Error('memory unreadable');
          return value.call(target, path, ...rest);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

test('R7-003: GET and building over an existing plan answer the plan without a basis when the memory projection cannot be read', async () => {
  const uid = await keptFocusPlan();
  const storage = currentStorage() as any;
  const before = await storedPlan(uid);
  setStorageForTests(memoryUnreadable(storage));
  try {
    const read = await call(uid, 'plans/[date]', 'GET', { params: { date: TODAY } });
    assert.equal(read.status, 200, show(read.body));
    assert.equal(read.body.plan.memoryBasis, undefined);
    assert.equal(read.body.plan.date, TODAY);
    const built = await call(uid, 'plans/[date]/build', 'POST', { params: { date: TODAY } });
    assert.equal(built.status, 200, show(built.body));
    assert.equal(built.body.plan.memoryBasis, undefined);
  } finally {
    setStorageForTests(storage);
  }
  assert.equal((await storedPlan(uid)).generation, before.generation, 'an unreadable projection rebuilt the plan');
});

/** Sets the personalization fence as a purge's own transaction would. */
async function setFence(storage: any, uid: string, fence: { state: string; epoch: number }): Promise<void> {
  await storage.runTransaction(async (tx: any) => { tx.merge(userDoc(uid), { personalizationPurge: fence }); });
}

test('R8-003: a withdrawal behind a running purge waits for it and takes its own epoch, refusing a plan that read the window under the purge epoch', async () => {
  const uid = await keptFocusPlan();
  const storage = currentStorage() as any;
  const prior = ((await storage.get(userDoc(uid))) ?? {}).personalizationPurge?.epoch ?? 0;
  const purgeEpoch = prior + 1;
  await setFence(storage, uid, { state: 'purging', epoch: purgeEpoch });
  let underPurgeEpoch: Awaited<ReturnType<typeof memoryFocusForPlan>> = null;
  const withdrawal = setPersonalizationConsent(uid, { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, {
    storage, purgeWait: { attempts: 50, delayMs: 5 },
  });
  // The purge finishes while the withdrawal waits; a plan then reads the window under its epoch.
  await new Promise((resolve) => setTimeout(resolve, 12));
  await setFence(storage, uid, { state: 'active', epoch: purgeEpoch });
  underPurgeEpoch = await memoryFocusForPlan(uid, NOW(), { storage });
  await withdrawal;
  const fence = ((await storage.get(userDoc(uid))) ?? {}).personalizationPurge;
  assert.deepEqual([fence?.state, fence?.epoch], ['active', purgeEpoch + 1], 'the withdrawal did not take its own epoch');
  assert.ok(underPurgeEpoch, 'fixture: no plan read the window between the purge and the withdrawal');
  assert.equal(personalizationPurgeMatches({ personalizationPurge: fence }, underPurgeEpoch!.purgeEpoch), false, 'a plan read under the purge epoch would still be written');
});

test('R8-003: a purge that outlasts the wait fails the withdrawal before anything changes', async () => {
  const uid = await keptFocusPlan();
  const storage = currentStorage() as any;
  const prior = ((await storage.get(userDoc(uid))) ?? {}).personalizationPurge?.epoch ?? 0;
  await setFence(storage, uid, { state: 'purging', epoch: prior + 1 });
  const base = createStoragePersonalizationConsentStore(storage);
  let writes = 0;
  const consent = { ...base, read: base.read.bind(base), write: async (...args: Parameters<typeof base.write>) => { writes += 1; return base.write(...args); } };
  await assert.rejects(
    setPersonalizationConsent(uid, { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, { storage, consent: consent as any, purgeWait: { attempts: 3, delayMs: 1 } }),
    PersonalizationWithdrawalBusyError,
  );
  assert.equal(writes, 0, 'the store was disabled although the withdrawal failed');
  assert.equal((await base.read(uid)).state, 'enabled');
});

test('R10-001: off-mode build retries without the kept window when withdrawal lands between read and write', async () => {
  const uid = await offModeFocusAccount();
  const real = currentStorage() as any;
  let armed = false;
  let withdrew = false;
  const storage = new Proxy(real, {
    get(target, key) {
      if (key === 'runTransaction') {
        return async (fn: (tx: any) => Promise<unknown>) => {
          if (armed && !withdrew) {
            withdrew = true;
            await setPersonalizationConsent(
              uid,
              { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() },
              { storage: real },
            );
          }
          return target.runTransaction(fn);
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const built = await buildDailyPlanOnDemand(uid, TODAY, {
    storage,
    now: () => new Date(),
    busyBlocks: async () => {
      armed = true;
      return [];
    },
  });
  assert.ok(withdrew, 'fixture: withdrawal never landed between the solve and its write');
  assert.equal(built.created, true);
  assert.equal(built.stored.memoryUse, undefined, 'the suppressed retry still claims memory use');
  assert.equal(built.stored.focusFromMemory, undefined, 'off-mode wire provenance leaked into storage');
  assert.notDeepEqual(workingWindows(built.stored), [[540, 720]], 'the stored plan still uses the withdrawn window');
});

test('R10-001 (Claude review): an off-mode account whose fence has already moved still plans with its kept window', async () => {
  const uid = await offModeFocusAccount();
  // An earlier purge or withdrawal-and-regrant left the fence at a later epoch.
  await setFence(currentStorage() as any, uid, { state: 'active', epoch: 3 });
  const built = await buildDailyPlanOnDemand(uid, TODAY, { storage: currentStorage() as any, now: () => new Date(), busyBlocks: async () => [] });
  assert.equal(built.created, true);
  assert.deepEqual(built.stored.memoryUse, { epoch: 3 }, 'the off-mode read did not record the real fence');
  assert.deepEqual(workingWindows(built.stored), [[540, 720]], 'a moved fence silently dropped the kept window');
});

test('R10-001: an off-mode proposal is stale and withdrawn after consent withdrawal', async () => {
  const uid = await offModeFocusAccount();
  await buildPlan(uid);
  await replan(uid, REVIEW);
  const offered = await storedPlan(uid);
  assert.ok(offered.proposal?.memoryUse, 'fixture: the off-mode offer has no internal memory provenance');

  await setPersonalizationConsent(
    uid,
    { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() },
    { storage: currentStorage() as any },
  );
  const response = await call(uid, 'plans/[date]/actions', 'POST', {
    params: { date: TODAY },
    body: { action: 'accept_proposal', proposalId: offered.proposal.proposalId },
  });
  assert.equal(response.status, 422, show(response.body));
  assert.equal(response.body.reason, 'stale_proposal');
  const after = await storedPlan(uid);
  assert.equal(after.generation, offered.generation, 'the stale offer was installed');
  assert.equal(after.proposal, null, 'the stale offer was not withdrawn');
});

test('R10-001: a legacy proposal with no provenance fails closed after the fence moves', async () => {
  const uid = await offModeFocusAccount();
  await buildPlan(uid);
  await replan(uid, REVIEW);
  const stored = await storedPlan(uid);
  assert.ok(stored.proposal, 'fixture: no offer');
  const {
    memoryUse: _memoryUse,
    focusFromMemory: _focusFromMemory,
    personalizationPurgeEpoch: _purgeEpoch,
    storedPurgeEpoch: _storedPurgeEpoch,
    ...legacyProposal
  } = stored.proposal;
  await currentStorage().set(planPath(uid, TODAY), { ...stored, proposal: legacyProposal });

  await setPersonalizationConsent(
    uid,
    { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() },
    { storage: currentStorage() as any },
  );
  const response = await call(uid, 'plans/[date]/actions', 'POST', {
    params: { date: TODAY },
    body: { action: 'accept_proposal', proposalId: legacyProposal.proposalId },
  });
  assert.equal(response.status, 422, show(response.body));
  assert.equal(response.body.reason, 'stale_proposal');
  assert.equal((await storedPlan(uid)).proposal, null, 'the unknowable legacy offer was not withdrawn');
});

test('R10-001/R10-003: off-mode week acceptance and an ordinary accept both refuse a withdrawn memory-shaped plan', async () => {
  const uid = await begin({ on: false });
  await grantPersonalization(uid);
  await addFloating(uid, 'Write the weekly report');
  await storeKeptFocus(uid);
  const real = currentStorage() as any;
  const layout = await composeWeek(uid, { moves: [], drops: [] }, { storage: real, now: () => new Date() });
  const day = layout.days.find((candidate) => candidate.kind === 'proposed' && candidate.plan.scheduled.length > 0);
  assert.ok(day?.kind === 'proposed' && day.memoryUse, 'fixture: no proposed day used the kept window');
  const targetDate = day.date;

  let ordinaryAcceptRefused = false;
  let raced = false;
  const storage = new Proxy(real, {
    get(target, key) {
      if (key === 'runTransaction') {
        return async (fn: (tx: any) => Promise<unknown>) => {
          let createdPlan = false;
          const result = await target.runTransaction((tx: any) => fn(new Proxy(tx, {
            get(inner, property) {
              const member = Reflect.get(inner, property);
              if ((property === 'set' || property === 'create') && typeof member === 'function') {
                return (path: string, ...rest: unknown[]) => {
                  if (path === planPath(uid, targetDate)) createdPlan = true;
                  return member.call(inner, path, ...rest);
                };
              }
              return typeof member === 'function' ? member.bind(inner) : member;
            },
          })));
          if (createdPlan && !raced) {
            raced = true;
            await setPersonalizationConsent(
              uid,
              { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() },
              { storage: real },
            );
            try {
              await acceptPlan(uid, targetDate, { storage: real, now: () => new Date() });
            } catch (error) {
              if (!(error instanceof PlanWriteGuardRejected)) throw error;
              ordinaryAcceptRefused = true;
            }
          }
          return result;
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  const outcome = await acceptWeekDay(
    uid,
    targetDate,
    { moves: [], drops: [] },
    day.assignment.include,
    { storage, now: () => new Date() },
  );
  assert.ok(raced, 'fixture: the plan was never stored');
  assert.equal(ordinaryAcceptRefused, true, 'ordinary accept bypassed the stored provenance fence');
  assert.equal(outcome.outcome, 'week_changed');
  assert.equal(await real.get(planPath(uid, targetDate)), null, 'the refused week plan was left behind');
});

test('R10-002: a withdrawn pending offer is freshly re-solved and replaced without memory', async () => {
  const uid = await offModeFocusAccount();
  await makeSuppressedWindowMatchKeptWindow(uid);
  await buildPlan(uid);
  const slot = (await storedPlan(uid)).plan.scheduled[0].interval;
  const inside = {
    startsAt: new Date(Date.parse(slot.startsAt) + 5 * 60_000).toISOString(),
    endsAt: new Date(Date.parse(slot.startsAt) + 15 * 60_000).toISOString(),
  };
  await replan(uid, REVIEW, slot, 'busy-first');
  const before = await storedPlan(uid);
  assert.ok(before.proposal?.memoryUse, 'fixture: the pending offer has no memory provenance');

  const report = await replanWithWithdrawalAtWrite(uid, REVIEW, inside, 'busy-second');
  assert.equal(report.pipelineResult.policyDecision?.action, 'propose_for_review');
  const after = await storedPlan(uid);
  assert.ok(after.proposal, 'the still-conflicted day has no fresh offer');
  assert.notEqual(after.proposal.proposalId, before.proposal.proposalId, 'the stale pending solve was reused');
  assert.equal(after.proposal.memoryUse, undefined, 'the replacement offer kept stale memory provenance');
});

test('R10-002: auto-apply writes the fresh suppressed solve, not the withdrawn pending solve', async () => {
  const uid = await offModeFocusAccount();
  await makeSuppressedWindowMatchKeptWindow(uid);
  await buildPlan(uid);
  const slot = (await storedPlan(uid)).plan.scheduled[0].interval;
  const inside = {
    startsAt: new Date(Date.parse(slot.startsAt) + 5 * 60_000).toISOString(),
    endsAt: new Date(Date.parse(slot.startsAt) + 15 * 60_000).toISOString(),
  };
  await replan(uid, REVIEW, slot, 'busy-first-auto');
  const before = await storedPlan(uid);
  assert.ok(before.proposal?.memoryUse, 'fixture: the pending offer has no memory provenance');

  const report = await replanWithWithdrawalAtWrite(uid, AUTO_APPLY, inside, 'busy-second-auto');
  assert.equal(report.pipelineResult.policyDecision?.action, 'auto_apply');
  const after = await storedPlan(uid);
  assert.ok(after.generation > before.generation, 'the fresh auto-apply was not stored');
  assert.equal(after.memoryUse, undefined, 'the auto-applied generation kept stale memory provenance');
});

test('R11-001: the control-centre disable goes through the fence, so a plan that read the window before it is refused', async () => {
  const uid = await keptFocusPlan();
  const storage = currentStorage() as any;
  const before = await memoryFocusForPlan(uid, NOW(), { storage });
  assert.ok(before, 'fixture: no plan read the kept window');
  await fencedPersonalizationConsentStore({ storage }).write(uid, 'disabled', new Date().toISOString());
  const user = await storage.get(userDoc(uid));
  assert.equal(personalizationPurgeMatches(user, before!.purgeEpoch), false, 'a plan that read the window before the disable could still be written');
  assert.equal(await memoryFocusForPlan(uid, NOW(), { storage }), null);
  // And the legacy route wires that store, not the raw one.
  const route = readFileSync(new URL('../../src/app/api/personalization/route.ts', import.meta.url), 'utf8');
  assert.match(route, /consent: fencedPersonalizationConsentStore\(\)/);
  assert.doesNotMatch(route, /createStoragePersonalizationConsentStore/);
});

test('R11-002: an ordinary accept of a plan shaped by since-withdrawn memory answers 409 plan_changed and accepts nothing', async () => {
  const uid = await keptFocusPlan();
  const before = await storedPlan(uid);
  assert.ok(before.memoryUse || before.focusFromMemory === true, 'fixture: the plan used no memory');
  await setPersonalizationConsent(uid, { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, { storage: currentStorage() as any });
  const accepted = await call(uid, 'plans/[date]/actions', 'POST', { params: { date: TODAY }, body: { action: 'accept' } });
  assert.equal(accepted.status, 409, show(accepted.body));
  assert.equal(accepted.body.reason, 'plan_changed');
  assert.equal((await storedPlan(uid)).status, before.status, 'the withdrawn plan was accepted');
});

test('R12-001: the control-centre delete, through the fenced consent store, answers its receipt and leaves consent at the default', async () => {
  const uid = await keptFocusPlan();
  const storage = currentStorage() as any;
  const fenceBefore = ((await storage.get(userDoc(uid))) ?? {}).personalizationPurge?.epoch ?? 0;
  const post = (body: Record<string, unknown>) => personalizationControlsPost(new Request('http://localhost/api/personalization', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
  assert.equal((await post({ scopeId: uid, now: new Date().toISOString(), action: 'enable' })).status, 200);
  const deleted = await post({ scopeId: uid, now: new Date().toISOString(), action: 'delete' });
  const body = await deleted.json() as any;
  assert.equal(deleted.status, 200, JSON.stringify(body));
  assert.equal(body.kind, 'deleted');
  const consent = await createStoragePersonalizationConsentStore(storage).read(uid);
  assert.deepEqual([consent.state, consent.changedAt], ['disabled', null], 'the consent record survived the delete');
  const fenceAfter = ((await storage.get(userDoc(uid))) ?? {}).personalizationPurge?.epoch ?? 0;
  assert.ok(fenceAfter > fenceBefore, 'the deletion did not move the personalization fence');
});

test('R13-001: after a withdrawal and a quick re-grant, an untouched memory plan is re-solved under the new fence and can be accepted', async () => {
  const uid = await keptFocusPlan();
  const before = await storedPlan(uid);
  const solvedAt = before.memoryUse?.epoch ?? before.personalizationPurgeEpoch;
  assert.notEqual(solvedAt, undefined, 'fixture: the plan records no solve epoch');
  await setPersonalizationConsent(uid, { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, { storage: currentStorage() as any });
  await grantPersonalization(uid);
  await getPlan(uid);
  const after = await storedPlan(uid);
  assert.notEqual(after.memoryUse?.epoch ?? after.personalizationPurgeEpoch, solvedAt, 'the stale plan was offered again');
  const accepted = await call(uid, 'plans/[date]/actions', 'POST', { params: { date: TODAY }, body: { action: 'accept' } });
  assert.equal(accepted.status, 200, show(accepted.body));
});

test('R13-001: a touched memory plan after a withdrawal and re-grant shows no basis and says it changed', async () => {
  const uid = await keptFocusPlan();
  await touchPlan(uid);
  await setPersonalizationConsent(uid, { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, { storage: currentStorage() as any });
  await grantPersonalization(uid);
  const read = await getPlan(uid);
  assert.equal(read.plan.memoryBasis ?? null, null, show(read.plan.memoryBasis));
  assert.equal(read.plan.memoryBasisChanged, true);
});

test('R13-001: off mode too — after a withdrawal and a re-grant, an untouched memory plan is re-solved and can be accepted', async () => {
  const uid = await offModeFocusAccount();
  await buildPlan(uid);
  const before = await storedPlan(uid);
  assert.ok(before.memoryUse, 'fixture: the off-mode plan records no memory use');
  await setPersonalizationConsent(uid, { state: 'declined', version: PERSONALIZATION_CONSENT_VERSION, at: new Date() }, { storage: currentStorage() as any });
  await grantPersonalization(uid);
  await getPlan(uid);
  const after = await storedPlan(uid);
  assert.notEqual(after.memoryUse?.epoch, before.memoryUse.epoch, 'the stale off-mode plan was offered again');
  const accepted = await call(uid, 'plans/[date]/actions', 'POST', { params: { date: TODAY }, body: { action: 'accept' } });
  assert.equal(accepted.status, 200, show(accepted.body));
});
